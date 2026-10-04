/**
 * rawgit: hand-built git objects, packfiles and smart-HTTP (protocol v1)
 * receive-pack messages.
 *
 * Pure module: no Cloudflare imports. It needs only node:crypto (SHA-1) and
 * node:zlib (deflate), which exist in Node and in Workers with nodejs_compat.
 * Unit tests check its output against real git.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ZERO_OID = "0".repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- bytes ----

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? enc.encode(data) : data;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha1").update(data).digest());
}

export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

// -------------------------------------------------------------- objects ----

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: GitObjectType;
  /** Object body, without the "<type> <size>\0" header. */
  content: Uint8Array;
  /** SHA-1 of header + body, as lowercase hex. */
  oid: string;
}

export function makeObject(type: GitObjectType, content: Uint8Array): GitObject {
  const header = enc.encode(`${type} ${content.byteLength}\0`);
  return { type, content, oid: sha1Hex(concatBytes([header, content])) };
}

export function makeBlob(content: string | Uint8Array): GitObject {
  return makeObject("blob", toBytes(content));
}

export type TreeMode = "100644" | "100755" | "120000" | "160000" | "40000";

export interface TreeEntry {
  mode: TreeMode;
  name: string;
  oid: string;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.byteLength - b.byteLength;
}

/**
 * Build a tree object. Entries are sorted the way git sorts them: by raw name
 * bytes, with directories compared as if their name ended in "/".
 */
export function makeTree(entries: readonly TreeEntry[]): GitObject {
  const seen = new Set<string>();
  const keyed = entries.map((e) => {
    if (e.name.length === 0 || e.name.includes("/") || e.name.includes("\0")) {
      throw new Error(`invalid tree entry name: ${JSON.stringify(e.name)}`);
    }
    if (e.name === "." || e.name === ".." || e.name === ".git") {
      throw new Error(`forbidden tree entry name: ${e.name}`);
    }
    if (!OID_RE.test(e.oid)) throw new Error(`invalid oid for tree entry ${e.name}: ${e.oid}`);
    if (seen.has(e.name)) throw new Error(`duplicate tree entry name: ${e.name}`);
    seen.add(e.name);
    return { e, key: enc.encode(e.mode === "40000" ? `${e.name}/` : e.name) };
  });
  keyed.sort((a, b) => compareBytes(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { e } of keyed) {
    parts.push(enc.encode(`${e.mode} ${e.name}\0`), hexToBytes(e.oid));
  }
  return makeObject("tree", concatBytes(parts));
}

export interface Ident {
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  /** Timezone as git prints it, for example "+0000". */
  tz?: string;
}

function formatIdent(i: Ident): string {
  if (/[<>\n]/.test(i.name) || /[<>\n]/.test(i.email)) throw new Error("invalid ident");
  return `${i.name} <${i.email}> ${Math.floor(i.timestamp)} ${i.tz ?? "+0000"}`;
}

export interface CommitInput {
  tree: string;
  parents: readonly string[];
  author: Ident;
  committer?: Ident;
  message: string;
}

export function makeCommit(input: CommitInput): GitObject {
  if (!OID_RE.test(input.tree)) throw new Error(`invalid tree oid: ${input.tree}`);
  for (const p of input.parents) if (!OID_RE.test(p)) throw new Error(`invalid parent oid: ${p}`);
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((p) => `parent ${p}`),
    `author ${formatIdent(input.author)}`,
    `committer ${formatIdent(input.committer ?? input.author)}`,
    "",
    message,
  ];
  return makeObject("commit", enc.encode(lines.join("\n")));
}

/** Modes a file entry can have: regular file, executable file, symbolic link. */
export type FileMode = "100644" | "100755" | "120000";

/** A file with an explicit mode. For a symbolic link (120000) the content is the link target. */
export interface FileSpec {
  content: string | Uint8Array;
  mode: FileMode;
}

export type FileMapValue = string | Uint8Array | FileSpec;

function isFileSpec(value: FileMapValue): value is FileSpec {
  return typeof value === "object" && !(value instanceof Uint8Array);
}

/**
 * Build the objects for a nested file map such as
 * { "README.md": "...", "src/index.ts": "...", "bin/run.sh": { content: "...", mode: "100755" } }.
 * A plain string or byte value is a regular file (100644).
 * Returns the root tree plus every blob and tree object that it needs.
 */
export function makeTreeFromFiles(files: Record<string, FileMapValue>): {
  root: GitObject;
  objects: GitObject[];
} {
  interface Dir {
    files: Map<string, { blob: GitObject; mode: FileMode }>;
    dirs: Map<string, Dir>;
  }
  const rootDir: Dir = { files: new Map(), dirs: new Map() };
  const objects: GitObject[] = [];
  for (const [path, value] of Object.entries(files)) {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (!fileName || segments.some((s) => s.length === 0)) throw new Error(`invalid path: ${path}`);
    const mode: FileMode = isFileSpec(value) ? value.mode : "100644";
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") throw new Error(`invalid file mode for ${path}: ${String(mode)}`);
    let dir = rootDir;
    for (const seg of segments) {
      let next = dir.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    const blob = makeBlob(isFileSpec(value) ? value.content : value);
    objects.push(blob);
    dir.files.set(fileName, { blob, mode });
  }
  const build = (dir: Dir): GitObject => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.blob.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: "40000", name, oid: build(sub).oid });
    const tree = makeTree(entries);
    objects.push(tree);
    return tree;
  };
  const root = build(rootDir);
  return { root, objects };
}

// ------------------------------------------------------------- packfile ----

const PACK_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: GitObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (PACK_TYPE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
}

/**
 * Build a version 2 packfile holding the given objects, each stored whole
 * (zlib deflate, no deltas), followed by the SHA-1 trailer.
 * Objects with the same id are written once.
 */
export function buildPack(objects: readonly GitObject[]): Uint8Array {
  const unique: GitObject[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    if (seen.has(o.oid)) continue;
    seen.add(o.oid);
    unique.push(o);
  }
  const header = new Uint8Array(12);
  header.set(enc.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, unique.length);
  const parts: Uint8Array[] = [header];
  for (const o of unique) {
    parts.push(packObjectHeader(o.type, o.content.byteLength));
    parts.push(new Uint8Array(deflateSync(o.content)));
  }
  const body = concatBytes(parts);
  return concatBytes([body, sha1(body)]);
}

// ------------------------------------------------------------- pkt-line ----

/** Largest pkt-line git allows, length prefix included. */
const PKT_MAX = 65520;

export const FLUSH_PKT: Uint8Array = enc.encode("0000");

export function pktLine(payload: string | Uint8Array): Uint8Array {
  const data = toBytes(payload);
  const length = data.byteLength + 4;
  if (length > PKT_MAX) throw new Error(`pkt-line too long: ${length} bytes`);
  const out = new Uint8Array(length);
  out.set(enc.encode(length.toString(16).padStart(4, "0")), 0);
  out.set(data, 4);
  return out;
}

export type Pkt =
  | { kind: "data"; payload: Uint8Array }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" };

/** Parse a buffer made only of pkt-lines. Throws on a malformed length. */
export function parsePktLines(buf: Uint8Array): Pkt[] {
  const pkts: Pkt[] = [];
  let pos = 0;
  while (pos < buf.byteLength) {
    if (pos + 4 > buf.byteLength) throw new Error(`truncated pkt-line length at byte ${pos}`);
    const lenText = dec.decode(buf.subarray(pos, pos + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
      throw new Error(`bad pkt-line length ${JSON.stringify(lenText)} at byte ${pos}`);
    }
    const len = parseInt(lenText, 16);
    if (len === 0) {
      pkts.push({ kind: "flush" });
      pos += 4;
    } else if (len === 1) {
      pkts.push({ kind: "delim" });
      pos += 4;
    } else if (len === 2) {
      pkts.push({ kind: "response-end" });
      pos += 4;
    } else if (len === 3) {
      throw new Error(`invalid pkt-line length 3 at byte ${pos}`);
    } else {
      if (pos + len > buf.byteLength) throw new Error(`truncated pkt-line payload at byte ${pos}`);
      pkts.push({ kind: "data", payload: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return pkts;
}

function chomp(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// ---------------------------------------------------- ref advertisement ----

export interface RefAdvertisement {
  /** Service named in the "# service=" line, if the server sent one. */
  service: string | null;
  /** Ref name to object id, in the order the server listed them. Real refs only. */
  refs: Record<string, string>;
  /** Peeled values of annotated tags: "refs/tags/v1" maps to the object from the "refs/tags/v1^{}" line. */
  peeled: Record<string, string>;
  /** Object ids from ".have" lines (objects the server has through alternates; not refs). */
  haves: string[];
  /** Capability strings exactly as advertised. */
  capabilities: string[];
  /** True when the server advertised the "capabilities^{}" placeholder (no refs). */
  emptyRepo: boolean;
}

/**
 * Parse the body of GET <repo>/info/refs?service=git-(receive|upload)-pack (protocol v1,
 * with or without the "version 1" line in front). Throws on a v2 advertisement.
 */
export function parseRefAdvertisement(body: Uint8Array): RefAdvertisement {
  const pkts = parsePktLines(body);
  const adv: RefAdvertisement = { service: null, refs: {}, peeled: {}, haves: [], capabilities: [], emptyRepo: false };
  let sawCapabilities = false;
  for (const pkt of pkts) {
    if (pkt.kind !== "data") continue;
    const payload = pkt.payload;
    const text = dec.decode(payload);
    if (text.startsWith("# service=")) {
      adv.service = chomp(text).slice("# service=".length);
      continue;
    }
    // A server that was asked for protocol v1 puts "version 1" in front of the same advertisement.
    if (chomp(text) === "version 1") continue;
    if (text.startsWith("version ")) {
      throw new Error(`unexpected protocol line ${JSON.stringify(chomp(text))}; this parser handles protocol v1 only`);
    }
    if (text.startsWith("shallow ")) continue;
    let refPart = chomp(text);
    const nul = refPart.indexOf("\0");
    if (nul !== -1) {
      if (!sawCapabilities) {
        adv.capabilities = refPart
          .slice(nul + 1)
          .split(" ")
          .filter((c) => c.length > 0);
        sawCapabilities = true;
      }
      refPart = refPart.slice(0, nul);
    }
    const space = refPart.indexOf(" ");
    if (space !== 40) throw new Error(`unexpected ref advertisement line ${JSON.stringify(refPart)}`);
    const oid = refPart.slice(0, 40);
    const name = refPart.slice(41);
    if (name === "capabilities^{}") {
      adv.emptyRepo = true;
      continue;
    }
    if (name === ".have") {
      adv.haves.push(oid);
      continue;
    }
    if (name.endsWith("^{}")) {
      adv.peeled[name.slice(0, -3)] = oid;
      continue;
    }
    adv.refs[name] = oid;
  }
  return adv;
}

// ------------------------------------------------- receive-pack request ----

export interface RefCommand {
  /** Value the client believes the ref has now. ZERO_OID means "create". */
  oldOid: string;
  /** Value to set. ZERO_OID means "delete". */
  newOid: string;
  ref: string;
}

export interface ReceivePackRequestOptions {
  /**
   * End each command with "\n". The git CLI sends no newline; isomorphic-git
   * sends one. Real git accepts both.
   */
  trailingNewline?: boolean;
}

/**
 * Body for POST <repo>/git-receive-pack:
 * pkt-line commands (capabilities after a NUL on the first one), a flush-pkt,
 * then the packfile. The pack is left out when every command is a delete.
 */
export function buildReceivePackRequest(
  commands: readonly RefCommand[],
  capabilities: readonly string[],
  pack?: Uint8Array,
  options: ReceivePackRequestOptions = {},
): Uint8Array {
  if (commands.length === 0) throw new Error("at least one ref command is required");
  const nl = options.trailingNewline ? "\n" : "";
  const parts: Uint8Array[] = [];
  commands.forEach((c, index) => {
    if (!OID_RE.test(c.oldOid) || !OID_RE.test(c.newOid)) throw new Error(`invalid oid in command for ${c.ref}`);
    if (!c.ref.startsWith("refs/") || /[\s\0]/.test(c.ref)) throw new Error(`invalid ref name: ${JSON.stringify(c.ref)}`);
    const base = `${c.oldOid} ${c.newOid} ${c.ref}`;
    // The git CLI writes the capability list with a leading space after the NUL.
    parts.push(pktLine(index === 0 ? `${base}\0 ${capabilities.join(" ")}${nl}` : `${base}${nl}`));
  });
  parts.push(FLUSH_PKT);
  const allDeletes = commands.every((c) => c.newOid === ZERO_OID);
  if (!allDeletes) {
    if (!pack) throw new Error("a pack is required unless every command is a delete");
    parts.push(pack);
  }
  return concatBytes(parts);
}

// -------------------------------------------------- receive-pack result ----

export interface RefStatus {
  ref: string;
  ok: boolean;
  /** Reason the server gave for "ng". */
  message?: string;
}

export interface ReportStatus {
  /** True when the response used side-band framing. */
  sideband: boolean;
  /** Text after "unpack ", for example "ok". Null when the server sent no unpack line. */
  unpack: string | null;
  unpackOk: boolean;
  refs: RefStatus[];
  /** Side-band channel 2 (progress messages). */
  progress: string;
  /** Side-band channel 3 (fatal error messages). */
  errors: string;
}

/** Parse the body of the git-receive-pack response (report-status, with or without side-band). */
export function parseReportStatus(body: Uint8Array): ReportStatus {
  const outer = parsePktLines(body);
  const firstData = outer.find((p): p is Extract<Pkt, { kind: "data" }> => p.kind === "data");
  const firstByte = firstData && firstData.payload.byteLength > 0 ? firstData.payload[0]! : 0;
  // Plain report-status lines start with a letter ("unpack ..."); side-band frames start with 1, 2 or 3.
  const sideband = firstByte >= 1 && firstByte <= 3;
  let progress = "";
  let errors = "";
  let lines: Pkt[];
  if (sideband) {
    const band1: Uint8Array[] = [];
    for (const pkt of outer) {
      if (pkt.kind !== "data" || pkt.payload.byteLength === 0) continue;
      const band = pkt.payload[0];
      const rest = pkt.payload.subarray(1);
      if (band === 1) band1.push(rest);
      else if (band === 2) progress += dec.decode(rest);
      else if (band === 3) errors += dec.decode(rest);
      else throw new Error(`unexpected side-band channel ${band}`);
    }
    lines = parsePktLines(concatBytes(band1));
  } else {
    lines = outer;
  }
  const report: ReportStatus = { sideband, unpack: null, unpackOk: false, refs: [], progress, errors };
  for (const pkt of lines) {
    if (pkt.kind !== "data") continue;
    const text = chomp(dec.decode(pkt.payload));
    if (text.startsWith("unpack ")) {
      report.unpack = text.slice("unpack ".length);
      report.unpackOk = report.unpack === "ok";
    } else if (text.startsWith("ok ")) {
      report.refs.push({ ref: text.slice(3), ok: true });
    } else if (text.startsWith("ng ")) {
      const rest = text.slice(3);
      const space = rest.indexOf(" ");
      report.refs.push(
        space === -1
          ? { ref: rest, ok: false, message: "" }
          : { ref: rest.slice(0, space), ok: false, message: rest.slice(space + 1) },
      );
    }
  }
  return report;
}
