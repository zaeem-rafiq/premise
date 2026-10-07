// src/core/trunk/tools-read.ts — the four read tools of 01-core.md 4.3 to 4.6: `outline`,
// `read`, `list`, `search`. Each shows the attempt view (TA6) and pins its premise at head,
// recording `shown` (3.2). A failed call records no premise except `not_found` (TA5), which
// pins `absent`.

import type { PremiseRef } from "../../protocol/premise.ts";
import type {
  ListResult,
  OutlineResult,
  ReadResult,
  SearchLine,
  SearchResult,
  ToolError,
} from "../../protocol/tools.ts";
import type { Attempt, Pool, Premise } from "./sets.ts";
import {
  an,
  entityAt,
  isModule,
  listingOf,
  occurrences,
  pathOf,
  replayOps,
  sourceOf,
  curOps,
  textCounts,
} from "./sets.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { parseModule } from "../entities/entities.ts";
import { matchContainers } from "../keys/search.ts";
import { pin, ref } from "./premises.ts";
import { MAX_FILE_BYTES, MAX_LIST_ENTRIES, MAX_QUERY_LEN, MAX_SEARCH_LINES } from "../../protocol/constants.ts";

export type ToolOut =
  { ok: true; result: object; premises: PremiseRef[] } | { ok: false; error: ToolError; premises: PremiseRef[] };

const ok = (result: object, premises: Premise[] | PremiseRef[]): ToolOut => ({
  ok: true,
  result,
  premises: premises.map((p) => ("status" in p ? ref(p) : p)),
});
const err = (
  code: ToolError["code"],
  message: string,
  premises: Premise[] | PremiseRef[] = [],
  detail?: object,
): ToolOut => ({
  ok: false,
  error: detail === undefined ? { code, message } : { code, message, detail },
  premises: premises.map((p) => ("status" in p ? ref(p) : p)),
});

const view = (pool: Pool, a: Attempt): Map<string, string> =>
  replayOps(curOps(a), pool.files, {}, pool.languages).files;

const utf8Bytes = (s: string): number => utf8(s).length;

/** 4.3 `outline`: one module's entities. */
export function toolOutline(pool: Pool, a: Attempt, args: { path: string }): ToolOut {
  const v = view(pool, a);
  const content = v.get(args.path);
  if (content === undefined) {
    const p = pin(pool, a, "file", args.path, { read: true, repin: true });
    return err("not_found", `no such path: ${args.path}`, [p]);
  }
  // RB4: an imported blob over MAX_FILE_BYTES is stored without content — `too_large`, never
  // an empty parse.
  if (pool.opaque.has(args.path) && !curOps(a).some((o) => o.op === "write" && o.path === args.path)) {
    const p = pin(pool, a, "file", args.path, { read: true, repin: true });
    return err("too_large", `file exceeds ${MAX_FILE_BYTES} bytes`, [p]);
  }
  if (!isModule(args.path, pool.languages)) return err("not_a_module", `not a module: ${args.path}`);
  const mod = an(v, pool.languages).modules.get(args.path);
  if (mod === undefined) return err("not_a_module", `opaque module: ${args.path}`);
  const p = pin(pool, a, "query", `outline:${args.path}`, { read: true, repin: true });
  const lines = content.split("\n");
  const result: OutlineResult = {
    path: args.path,
    oid: blobId(utf8(content)),
    entities: mod.entities.map((e) => ({
      name: e.name,
      kind: e.kind,
      exports: [...e.exports],
      signature: e.canonical.split("\n")[0] ?? e.name,
      lines: linesRange(content, mod.regions, e.name, lines.length),
    })),
  };
  return ok(result, [p]);
}

function linesRange(
  content: string,
  regions: readonly { start: number; end: number; names: readonly string[] }[],
  name: string,
  total: number,
): [number, number] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let start = 0;
  let end = 0;
  for (const r of regions) {
    if (r.names.includes(name)) {
      if (start === 0 || r.start < start) start = r.start;
      if (r.end > end) end = r.end;
    }
  }
  if (end === 0) return [1, Math.max(1, total)];
  return [lineOf(start), lineOf(Math.max(start, end - 1))];
}

/** 4.4 `read`: a whole file, or one entity. */
export function toolRead(pool: Pool, a: Attempt, args: { path: string; entity?: string }): ToolOut {
  const head = pool.files;
  const v = view(pool, a);
  if (args.entity === undefined) {
    const p = pin(pool, a, "file", args.path, { read: true, repin: true });
    const content = v.get(args.path);
    if (content === undefined) return err("not_found", `no such path: ${args.path}`, [p]);
    // RB4: an imported blob over MAX_FILE_BYTES has no stored content — `too_large`, unless the
    // attempt replaced it (then the view's content is its own write).
    const wroteIt = curOps(a).some((o) => o.op === "write" && o.path === args.path);
    if (pool.opaque.has(args.path) && !wroteIt) return err("too_large", `file exceeds ${MAX_FILE_BYTES} bytes`, [p]);
    if (utf8Bytes(content) > MAX_FILE_BYTES) return err("too_large", `file exceeds ${MAX_FILE_BYTES} bytes`, [p]);
    const headContent = head.get(args.path);
    const result: ReadResult = {
      path: args.path,
      oid: blobId(utf8(content)),
      content,
      edited_by_you: headContent === undefined ? true : blobId(utf8(headContent)) !== blobId(utf8(content)),
    };
    return ok(result, [p]);
  }
  const key = `${args.path}#${args.entity}`;
  const headHasPath = head.has(args.path);
  const viewHasPath = v.has(args.path);
  if (!headHasPath && !viewHasPath) {
    const p = pin(pool, a, "file", args.path, { read: true, repin: true });
    return err("not_found", `no such path: ${args.path}`, [p]);
  }
  if (!isModule(args.path, pool.languages)) return err("not_a_module", `not a module: ${args.path}`);
  const mod = an(v, pool.languages).modules.get(args.path);
  if (mod === undefined) return err("not_a_module", `opaque module: ${args.path}`);
  const p = pin(pool, a, "entity", key, { read: true, repin: true });
  const e = entityAt(v, key, pool.languages);
  if (e === null) return err("not_found", `no such entity: ${key}`, [p]);
  const headE = entityAt(head, key, pool.languages);
  const result: ReadResult = {
    key,
    kind: e.kind,
    exports: [...e.exports],
    source: sourceOf(v, key, pool.languages) ?? "",
    lines: linesRange(v.get(args.path) ?? "", mod.regions, args.entity, 1),
    edited_by_you: headE === null ? false : headE.hash !== e.hash,
  };
  return ok(result, [p]);
}

/** 4.5 `list`: one directory, not recursive; created files appear as `yours`. */
export function toolList(pool: Pool, a: Attempt, args: { path: string }): ToolOut {
  const dir = args.path.endsWith("/") || args.path === "/" ? args.path : `${args.path}/`;
  const head = pool.files;
  const p = pin(pool, a, "listing", dir, { read: true, repin: true });
  const v = view(pool, a);
  const headMembers = new Set(listingOf(head, dir));
  const entries = listingOf(v, dir).map((n) => {
    const isDir = n.endsWith("/");
    const path = `${dir === "/" ? "" : dir}${n}`;
    const yours = !headMembers.has(n);
    const size = isDir ? undefined : utf8Bytes(v.get(path) ?? "");
    return {
      name: n,
      type: isDir ? ("dir" as const) : ("file" as const),
      ...(isDir ? {} : { bytes: size }),
      ...(yours ? { yours: true as const } : {}),
    };
  });
  const result: ListResult = {
    path: dir,
    entries: entries.slice(0, MAX_LIST_ENTRIES),
    truncated: entries.length > MAX_LIST_ENTRIES,
  };
  return ok(result, [p]);
}

/** 4.6 `search`: a text search; scope is a directory key or a file path. */
export function toolSearch(pool: Pool, a: Attempt, args: { query: string; path?: string }): ToolOut {
  const scope = args.path ?? "/";
  if (args.query.length === 0 || args.query.length > MAX_QUERY_LEN || args.query.includes("\n")) {
    return err("invalid_args", `query must be 1..${MAX_QUERY_LEN} characters without a line break`);
  }
  const p = pin(pool, a, "query", `text:${scope}:${args.query}`, { read: true, repin: true });
  const v = view(pool, a);
  const counts = textCounts(v, scope, args.query, pool.languages);
  const lines: SearchLine[] = [];
  let truncated = false;
  for (const [path, content] of [...v.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (!(scope === "/" || path === scope || (scope.endsWith("/") && path.startsWith(scope)))) continue;
    const containers = matchContainers(path, content, args.query, pool.languages);
    if (containers.size === 0) continue;
    const contentLines = content.split("\n");
    for (const off of occurrences(content, args.query)) {
      const lineStart = content.lastIndexOf("\n", off - 1) + 1;
      const lineEnd = content.indexOf("\n", off);
      const lineNo = content.slice(0, off).split("\n").length;
      const container = [...containers.keys()].find((c) => {
        const ent = c.includes("#") ? entityAt(v, c, pool.languages) : null;
        return (
          c === path ||
          (ent !== null &&
            (() => {
              const mod = an(v, pool.languages).modules.get(path);
              return (
                mod !== undefined &&
                mod.regions.some((r) => r.names.includes(ent.name) && off >= r.start && off < r.end)
              );
            })())
        );
      });
      if (lines.length >= MAX_SEARCH_LINES) {
        truncated = true;
        break;
      }
      lines.push({
        path,
        line: lineNo,
        text: content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
        entity: container !== undefined && container.includes("#") ? container.slice(container.indexOf("#") + 1) : null,
      });
    }
    if (truncated) break;
    void contentLines;
  }
  const result: SearchResult = {
    query: args.query,
    in: scope,
    lines,
    containers: [...counts.keys()].sort(),
    truncated,
  };
  return ok(result, [p]);
}
