// The pkt-line codec and the receive-pack request/report/advertisement parsers of 01-core.md 9.5.
// Byte-level expected values are literals of the pkt-line format (a 4-hex length covering the whole
// packet, "0000" the flush); real-git samples come from `git http-backend` itself.

import { afterAll, describe, expect, it } from "vitest";
import { parseRefAdvertisement } from "../../src/core/git/advertisement.ts";
import { FLUSH_PKT, parsePktLines, pktLine } from "../../src/core/git/pkt-line.ts";
import {
  buildReceivePackRequest,
  parseReceivePackReport,
  RECEIVE_PACK_CAPABILITIES,
} from "../../src/core/git/receive-pack.ts";
import { text, utf8 } from "../../src/core/sync/bytes.ts";
import { createServerRepo, getInfoRefs, git, repoRoot, startGitServer, type GitHttpServer } from "./helpers.ts";

describe("pkt-line encoding (9.5)", () => {
  it("writes the 4-hex length of the whole packet before the payload", () => {
    expect(text(pktLine("a"))).toBe("0005a");
    expect(text(pktLine("want 0123456789abcdef\n"))).toBe("001awant 0123456789abcdef\n");
    expect(pktLine("")).toEqual(utf8("0004"));
  });

  it("the flush packet is exactly '0000'", () => {
    expect(FLUSH_PKT).toEqual(utf8("0000"));
  });

  it("parses a stream of packets and marks the flush packet", () => {
    const stream = new Uint8Array([...pktLine("first\n"), ...pktLine("second\n"), ...FLUSH_PKT, ...pktLine("tail\n")]);
    const lines = parsePktLines(stream);
    expect(lines.map((l) => l.kind)).toEqual(["data", "data", "flush", "data"]);
    expect(lines.filter((l) => l.kind === "data").map((l) => text(l.payload))).toEqual([
      "first\n",
      "second\n",
      "tail\n",
    ]);
  });

  it("refuses a truncated packet and a bad length", () => {
    expect(() => parsePktLines(utf8("0007ab"))).toThrow("truncated");
    expect(() => parsePktLines(utf8("zzzz"))).toThrow("malformed");
    expect(() => parsePktLines(utf8("0"))).toThrow("truncated");
  });
});

describe("the receive-pack request (9.5, LP4)", () => {
  const ZERO = "0".repeat(40);
  const ONE = "1".repeat(40);
  const TWO = "2".repeat(40);

  it("writes one pkt-line per command, capabilities after NUL on the first, then flush and pack", () => {
    const pack = utf8("PACKBYTES");
    const request = buildReceivePackRequest(
      [
        { ref: "refs/heads/main", oldOid: ZERO, newOid: ONE },
        { ref: "refs/notes/premise", oldOid: ZERO, newOid: TWO },
      ],
      ["report-status"],
      pack,
    );
    const head = request.subarray(0, request.byteLength - pack.byteLength);
    const lines = parsePktLines(head);
    expect(lines.map((l) => l.kind)).toEqual(["data", "data", "flush"]);
    expect(text((lines[0] as { payload: Uint8Array }).payload)).toBe(`${ZERO} ${ONE} refs/heads/main\0report-status\n`);
    expect(text((lines[1] as { payload: Uint8Array }).payload)).toBe(`${ZERO} ${TWO} refs/notes/premise\n`);
    expect(request.subarray(request.byteLength - pack.byteLength)).toEqual(pack);
  });

  it("carries the atomic capability only when the caller requests it (LP4)", () => {
    const request = buildReceivePackRequest(
      [{ ref: "refs/heads/main", oldOid: ZERO, newOid: ONE }],
      [...RECEIVE_PACK_CAPABILITIES, "atomic"],
      utf8("P"),
    );
    const first = parsePktLines(request.subarray(0, request.byteLength - 1))[0]!;
    expect(first.kind).toBe("data");
    if (first.kind === "data") expect(text(first.payload)).toContain("\0report-status atomic\n");
  });

  it("refuses an empty command list and a malformed oid", () => {
    expect(() => buildReceivePackRequest([], ["report-status"], utf8("P"))).toThrow();
    expect(() =>
      buildReceivePackRequest([{ ref: "r", oldOid: "abc", newOid: ONE }], ["report-status"], utf8("P")),
    ).toThrow("invalid oid");
  });
});

describe("the report parser (9.5)", () => {
  it("reads 'unpack ok' and one ok/ng line per ref", () => {
    const report = new Uint8Array([
      ...pktLine("unpack ok\n"),
      ...pktLine("ok refs/heads/main\n"),
      ...pktLine("ng refs/notes/premise stale info\n"),
      ...FLUSH_PKT,
    ]);
    const parsed = parseReceivePackReport(report);
    expect(parsed.unpackOk).toBe(true);
    expect(parsed.results).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/notes/premise", ok: false, error: "stale info" },
    ]);
  });

  it("reads an unpack failure", () => {
    const report = new Uint8Array([...pktLine("unpack index-pack abnormal exit\n"), ...FLUSH_PKT]);
    const parsed = parseReceivePackReport(report);
    expect(parsed.unpackOk).toBe(false);
    expect(parsed.unpackError).toBe("index-pack abnormal exit");
    expect(parsed.results).toEqual([]);
  });
});

describe("the ref advertisement parser (9.5, LP5/LP6)", () => {
  let server: GitHttpServer | undefined;
  afterAll(async () => {
    await server?.close();
  });

  it("parses a real git http-backend advertisement into refs, HEAD and capabilities", async () => {
    const repo = createServerRepo("premise-git-advert-");
    // One commit on refs/heads/main so the advertisement has a real ref.
    repo.git("commit", "--allow-empty", "-m", "seed");
    const head = repo.git("rev-parse", "refs/heads/main");
    server = server ?? (await startGitServer(repoRoot(repo)));
    const remote = server.remoteFor(repo);
    const body = await getInfoRefs(remote, "git-receive-pack");
    const parsed = parseRefAdvertisement(body);
    expect(parsed.refs.get("refs/heads/main")).toBe(head);
    // A real receive-pack advertisement lists refs only; HEAD is not among them.
    expect(parsed.head).toBeNull();
    expect(parsed.capabilities).toContain("report-status");
    // The upload-pack advertisement carries the symref=HEAD capability instead.
    const upload = parseRefAdvertisement(await getInfoRefs(remote, "git-upload-pack"));
    expect(upload.head).toBe("refs/heads/main");
    expect(upload.refs.get("refs/heads/main")).toBe(head);
  });

  it("parses a protocol-v0 advertisement literal with a zero-id first line", () => {
    // The first ref line of an empty repository's advertisement: the zero id, capabilities after NUL.
    const zero = "0".repeat(40);
    const bytes = new Uint8Array([
      ...pktLine(`# service=git-receive-pack\n`),
      ...pktLine(`${zero} capabilities^{}\0report-status ofs-delta\n`),
      ...FLUSH_PKT,
    ]);
    const parsed = parseRefAdvertisement(bytes);
    expect(parsed.capabilities).toEqual(["report-status", "ofs-delta"]);
    expect(parsed.refs.size).toBe(0);
    expect(parsed.head).toBeNull();
  });

  it("keeps peeled tags out of refs and reads the symref=HEAD capability", () => {
    const oid = "a".repeat(40);
    const bytes = new Uint8Array([
      ...pktLine(`${oid} HEAD\0report-status symref=HEAD:refs/heads/main\n`),
      ...pktLine(`${oid} refs/heads/main\n`),
      ...pktLine(`${oid} refs/tags/v1\n`),
      ...pktLine(`${"b".repeat(40)} refs/tags/v1^{}\n`),
      ...FLUSH_PKT,
    ]);
    const parsed = parseRefAdvertisement(bytes);
    expect(parsed.head).toBe("refs/heads/main");
    expect(parsed.refs.get("refs/heads/main")).toBe(oid);
    expect(parsed.refs.get("refs/tags/v1")).toBe(oid);
    expect(parsed.refs.has("refs/tags/v1^{}")).toBe(false);
  });
});
