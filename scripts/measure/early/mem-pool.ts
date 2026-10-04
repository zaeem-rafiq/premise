// The in-memory pool of ME3: the seed files as text, the seven tools answered with the argument
// names, result shapes and error codes of 01-core 4.3 to 4.9. `premises` is empty in every response
// and `relied_on_by` is always {} (there is no reference table). Entities come from the script's
// own acorn pass (entities.ts). `submit` runs non_empty, parse and imports_resolve on the tree.

import { gitObjectId, utf8, H } from "../../../src/core/sync/index.ts";
import {
  MAX_CHANGE_BYTES,
  MAX_FILE_BYTES,
  MAX_HEADS_UPS_PER_RESPONSE,
  MAX_LIST_ENTRIES,
  MAX_OPS,
  MAX_PATHS,
  MAX_QUERY_LEN,
  MAX_SEARCH_LINES,
  RESPONSE_HEADS_UP_MAX_BYTES,
} from "../../../src/protocol/constants.ts";
import { PATH_PATTERN } from "../../../src/protocol/premise.ts";
import type { AttemptState } from "../../../src/protocol/attempt.ts";
import type { ErrorCode, ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { entityByName, importsOf, parseModule, resolveSpecifier } from "./entities.ts";

function oidOf(content: string): string {
  return gitObjectId("blob", utf8(content));
}

function byteLen(s: string): number {
  return utf8(s).byteLength;
}

/** The operation record the pool keeps for its own bookkeeping (the protocol `Operation` is richer). */
export type MemOp =
  | { op_seq: number; kind: "write"; path: string; content: string | null; base_oid: string }
  | { op_seq: number; kind: "replace"; path: string; old: string; new: string; targets: string[] };

export type MemPool = ReturnType<typeof newMemPool>;

/**
 * `head` = the seed plus what landed outside the attempt (the scripted energy change writes there);
 * the attempt view = head overlaid by this attempt's accepted operations.
 */
export function newMemPool(opts: { attemptId: string; head: Map<string, string> }) {
  const head = new Map(opts.head);
  const edits = new Map<string, string | null>(); // path -> content (null = deleted) in the attempt view
  const ops: MemOp[] = [];
  const wholeFileReads = new Map<string, string>(); // path -> head oid shown (W1)
  const pending: Array<{ heads_up: HeadsUp; resolved: boolean }> = [];
  let state: AttemptState = "opened";
  let goArouds = 0;
  let pullBacks = 0;
  let opSeq = 0;
  let headSeq = 0; // the seed is head 0; every `landHead` lands one more
  const revision = 1; // a fresh attempt's revision (RS1); no resume exists in the early variant
  let resolvedHns: number[] = [];
  let lastSubmitId: string | null = null;

  const view = (): Map<string, string> => {
    const files = new Map(head);
    for (const [path, content] of edits) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    return files;
  };
  const viewOf = (path: string): string | null => {
    if (edits.has(path)) return edits.get(path) ?? null;
    return head.get(path) ?? null;
  };

  const respond = (
    req: ToolRequest,
    body: { ok: boolean; result?: object; code?: ErrorCode; detail?: object },
  ): ToolResponse => {
    // TA8: pending heads-ups ride every response, lowest first, no gap after `ack`, bounded.
    const shown: HeadsUp[] = [];
    let bytes = 0;
    let expected = req.ack + 1;
    let more = false;
    for (const p of pending.filter((p) => !p.resolved).sort((a, b) => a.heads_up.hn - b.heads_up.hn)) {
      const hn = p.heads_up.hn;
      if (hn < expected) continue;
      if (hn !== expected) {
        more = true; // HU6a: a gap ends the run
        break;
      }
      const size = JSON.stringify(p.heads_up).length;
      if (shown.length >= MAX_HEADS_UPS_PER_RESPONSE || bytes + size > RESPONSE_HEADS_UP_MAX_BYTES) {
        more = true;
        break;
      }
      shown.push(p.heads_up);
      bytes += size;
      expected = hn + 1;
    }
    if (!more) more = pending.some((p) => !p.resolved && p.heads_up.hn >= expected);
    const response: ToolResponse = {
      call_id: req.call_id,
      ok: body.ok,
      head_seq: headSeq,
      premises: [],
      heads_ups: shown,
      heads_ups_more: more,
      attempt: { state, go_arounds: goArouds, pull_backs: pullBacks },
    };
    if (body.ok) {
      response.result = body.result ?? {};
    } else {
      response.error = {
        code: body.code ?? "invalid_args",
        message: "",
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
      };
    }
    return response;
  };

  const err = (req: ToolRequest, code: ErrorCode, detail?: object) => respond(req, { ok: false, code, detail });

  /** TA3: write, replace and submit fail with `heads_up_first` while a heads-up sits above `ack`. */
  const blocked = (req: ToolRequest): ToolResponse | null => {
    const waiting = pending.some((p) => !p.resolved && p.heads_up.hn > req.ack);
    if (!waiting) return null;
    return err(req, "heads_up_first");
  };

  const opsBytes = () =>
    ops.reduce((sum, op) => {
      if (op.kind === "write") return sum + (op.content === null ? 0 : byteLen(op.content));
      return sum + byteLen(op.old) + byteLen(op.new);
    }, 0);

  const countPaths = () => new Set(ops.map((o) => o.path)).size;
  const pathTouched = (path: string) => ops.some((o) => o.path === path);

  /** `added` / `altered` / `removed` compare the attempt view after the call with head, by hash (4.7). */
  const diffEntities = (path: string, after: string | null) => {
    const added: string[] = [];
    const altered: string[] = [];
    const removed: string[] = [];
    const headText = head.get(path) ?? null;
    const headMod = headText === null || !path.endsWith(".js") ? null : parseModule(path, headText);
    const afterMod = after === null || !path.endsWith(".js") ? null : parseModule(path, after);
    const headNames = new Map<string, string>();
    if (headMod !== null && headMod.ok) for (const e of headMod.entities) headNames.set(e.name, e.hash);
    if (afterMod !== null && afterMod.ok) {
      const newNames = new Set<string>();
      for (const e of afterMod.entities) {
        newNames.add(e.name);
        const key = `${path}#${e.name}`;
        if (!headNames.has(e.name)) added.push(key);
        else if (headNames.get(e.name) !== e.hash) altered.push(key);
      }
      for (const name of headNames.keys()) if (!newNames.has(name)) removed.push(`${path}#${name}`);
    } else {
      for (const name of headNames.keys()) removed.push(`${path}#${name}`);
    }
    return { added, altered, removed };
  };

  /** R4: the entities whose region holds the matched span, or `[path]` for an opaque file. */
  const entityTargets = (path: string, content: string, start: number, end: number): string[] => {
    const mod = parseModule(path, content);
    if (!mod.ok) return [path];
    const targets = mod.entities
      .filter((e) => e.regions.some(([rs, re]) => start < re && end > rs))
      .map((e) => `${path}#${e.name}`);
    return targets.length > 0 ? targets : [path];
  };

  const bump = () => ++opSeq;
  const touch = (path: string): ToolResponse | null => {
    if (state === "validated") {
      state = "working"; // T22: an accepted edit clears a passing submit
      lastSubmitId = null;
    }
    return null;
  };

  const tools: Record<string, (req: ToolRequest, args: Record<string, unknown>) => ToolResponse> = {
    outline(req, args) {
      const path = String(args.path ?? "");
      const content = viewOf(path);
      if (content === null) return err(req, "not_found", { path });
      const mod = parseModule(path, content);
      if (!mod.ok) return err(req, "not_a_module", { path });
      return respond(req, {
        ok: true,
        result: {
          path,
          oid: oidOf(content),
          entities: mod.entities.map((e) => ({
            name: e.name,
            kind: e.kind,
            exports: e.exports,
            signature: e.signature,
            lines: e.lines,
          })),
        },
      });
    },

    read(req, args) {
      const path = String(args.path ?? "");
      const entity = typeof args.entity === "string" ? args.entity : undefined;
      const content = viewOf(path);
      if (content === null) return err(req, "not_found", { path });
      if (entity === undefined) {
        if (byteLen(content) > MAX_FILE_BYTES) return err(req, "too_large", { path, bytes: byteLen(content) });
        // W1's `shown` is the head oid; a created file's read does not unlock another's write.
        wholeFileReads.set(path, head.has(path) ? oidOf(head.get(path) as string) : "absent");
        return respond(req, {
          ok: true,
          result: { path, oid: oidOf(content), content, edited_by_you: edits.has(path) },
        });
      }
      const mod = parseModule(path, content);
      if (!mod.ok) return err(req, "not_a_module", { path });
      const found = entityByName(mod, entity);
      if (found === null) return err(req, "not_found", { key: `${path}#${entity}` });
      return respond(req, {
        ok: true,
        result: {
          key: `${path}#${entity}`,
          kind: found.kind,
          exports: found.exports,
          source: found.source,
          lines: found.lines,
          edited_by_you: edits.has(path),
        },
      });
    },

    list(req, args) {
      const dir = String(args.path ?? "");
      if (!(dir === "/" || dir.endsWith("/")))
        return err(req, "invalid_args", { argument: "path", problem: "not_a_directory_key" });
      const files = view();
      const names = new Map<string, "file" | "dir">();
      const prefix = dir === "/" ? "" : dir;
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest === "") continue;
        const slash = rest.indexOf("/");
        names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "dir");
      }
      const entries = [...names.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, type]) => {
          const entry: { name: string; type: "file" | "dir"; bytes?: number; yours?: true } = {
            name: type === "dir" ? `${name}/` : name,
            type,
          };
          if (type === "file") {
            entry.bytes = byteLen(files.get(prefix + name) as string);
            if (edits.has(prefix + name)) entry.yours = true;
          }
          return entry;
        });
      const truncated = entries.length > MAX_LIST_ENTRIES;
      return respond(req, { ok: true, result: { path: dir, entries: entries.slice(0, MAX_LIST_ENTRIES), truncated } });
    },

    search(req, args) {
      const query = String(args.query ?? "");
      if (query === "" || query.includes("\n"))
        return err(req, "invalid_args", { argument: "query", problem: "empty" });
      if (query.length > MAX_QUERY_LEN) return err(req, "too_large", { argument: "query", limit: MAX_QUERY_LEN });
      const scope = typeof args.path === "string" && args.path !== "" ? args.path : "/";
      if (!(scope === "/" || scope.endsWith("/") || PATH_PATTERN.test(scope)))
        return err(req, "invalid_path", { path: scope });
      const files = view();
      const lines: Array<{ path: string; line: number; text: string; entity: string | null }> = [];
      const containers = new Set<string>();
      let total = 0;
      const scoped = [...files.keys()]
        .filter((path) => (scope === "/" ? true : scope.endsWith("/") ? path.startsWith(scope) : path === scope))
        .sort();
      for (const path of scoped) {
        const content = files.get(path) as string;
        const mod = parseModule(path, content);
        const textLines = content.split("\n");
        let offset = 0;
        for (let i = 0; i < textLines.length; i++) {
          const text = textLines[i] ?? "";
          const lineOffset = offset;
          offset += text.length + 1;
          if (!text.includes(query)) continue;
          total++;
          if (lines.length >= MAX_SEARCH_LINES) continue;
          let entity: string | null = null;
          if (mod.ok) {
            const at = mod.entities.find((e) => e.regions.some(([rs, re]) => lineOffset >= rs && lineOffset < re));
            entity = at ? at.name : null;
          }
          lines.push({ path, line: i + 1, text, entity });
          containers.add(entity === null ? path : `${path}#${entity}`);
        }
      }
      return respond(req, {
        ok: true,
        result: { query, in: scope, lines, containers: [...containers].sort(), truncated: total > lines.length },
      });
    },

    write(req, args) {
      const refused = blocked(req);
      if (refused !== null) return refused;
      const path = String(args.path ?? "");
      if (!PATH_PATTERN.test(path)) return err(req, "invalid_path", { path });
      const hasContent = typeof args.content === "string";
      const isDelete = args.delete === true;
      if (!hasContent && !isDelete) return err(req, "invalid_args", { argument: "content", problem: "missing" });
      const headHas = head.has(path);
      const current = viewOf(path);
      // W1: an existing head path needs a whole-file read that showed the current head bytes.
      if (headHas) {
        const headOid = oidOf(head.get(path) as string);
        if (wholeFileReads.get(path) !== headOid) return err(req, "read_first", { path });
      }
      if (ops.length >= MAX_OPS) return err(req, "limit_reached", { which: "max_ops" });
      if (!pathTouched(path) && countPaths() >= MAX_PATHS) return err(req, "limit_reached", { which: "max_paths" });
      if (isDelete) {
        if (current === null) return err(req, "not_found", { path });
        touch(path);
        edits.set(path, null);
        ops.push({
          op_seq: bump(),
          kind: "write",
          path,
          content: null,
          base_oid: headHas ? oidOf(head.get(path) as string) : "absent",
        });
        const d = diffEntities(path, null);
        return respond(req, {
          ok: true,
          result: {
            path,
            op_seq: opSeq,
            created: false,
            bytes: 0,
            added: d.added,
            altered: d.altered,
            removed: d.removed,
            relied_on_by: {},
          },
        });
      }
      const content = args.content as string;
      if (byteLen(content) > MAX_FILE_BYTES) return err(req, "too_large", { path, bytes: byteLen(content) });
      if (current === content) return err(req, "no_change", { path });
      if (opsBytes() + byteLen(content) > MAX_CHANGE_BYTES) return err(req, "too_large", { which: "max_change_bytes" });
      if (path.endsWith(".js")) {
        const mod = parseModule(path, content);
        if (!mod.ok)
          return err(req, "parse_error", {
            message: mod.error.message,
            line: mod.error.line,
            column: mod.error.column,
          });
      }
      touch(path);
      const created = !headHas && !edits.has(path);
      edits.set(path, content);
      ops.push({
        op_seq: bump(),
        kind: "write",
        path,
        content,
        base_oid: headHas ? oidOf(head.get(path) as string) : "absent",
      });
      const d = diffEntities(path, content);
      return respond(req, {
        ok: true,
        result: {
          path,
          op_seq: opSeq,
          created,
          bytes: byteLen(content),
          added: d.added,
          altered: d.altered,
          removed: d.removed,
          relied_on_by: {},
        },
      });
    },

    replace(req, args) {
      const refused = blocked(req);
      if (refused !== null) return refused;
      const path = String(args.path ?? "");
      const oldText = String(args.old ?? "");
      const newText = String(args.new ?? "");
      const current = viewOf(path);
      if (current === null) return err(req, "not_found", { path });
      if (oldText === "" || oldText === newText) return err(req, "no_change", { path });
      const occurrences: number[] = [];
      let at = current.indexOf(oldText);
      while (at !== -1) {
        occurrences.push(at);
        at = current.indexOf(oldText, at + 1);
      }
      if (occurrences.length === 0) return err(req, "no_match", { path });
      if (occurrences.length > 1) {
        return err(req, "ambiguous", {
          k: occurrences.length,
          lines: occurrences.map((o) => current.slice(0, o).split("\n").length),
        });
      }
      if (ops.length >= MAX_OPS) return err(req, "limit_reached", { which: "max_ops" });
      if (!pathTouched(path) && countPaths() >= MAX_PATHS) return err(req, "limit_reached", { which: "max_paths" });
      if (opsBytes() + byteLen(oldText) + byteLen(newText) > MAX_CHANGE_BYTES)
        return err(req, "too_large", { which: "max_change_bytes" });
      const start = occurrences[0] as number;
      const after = current.slice(0, start) + newText + current.slice(start + oldText.length);
      if (path.endsWith(".js")) {
        const mod = parseModule(path, after);
        if (!mod.ok)
          return err(req, "parse_error", {
            message: mod.error.message,
            line: mod.error.line,
            column: mod.error.column,
          });
      }
      touch(path);
      const targets = entityTargets(path, current, start, start + oldText.length);
      edits.set(path, after);
      ops.push({ op_seq: bump(), kind: "replace", path, old: oldText, new: newText, targets });
      const d = diffEntities(path, after);
      return respond(req, {
        ok: true,
        result: {
          path,
          op_seq: opSeq,
          targets,
          altered: d.altered,
          added: d.added,
          removed: d.removed,
          relied_on_by: {},
        },
      });
    },

    submit(req, args) {
      const refused = blocked(req);
      if (refused !== null) return refused;
      const acknowledge = Array.isArray(args.acknowledge)
        ? (args.acknowledge as unknown[]).filter((n): n is number => typeof n === "number")
        : [];
      // CK1: each number must be a heads-up of this attempt with hn <= ack.
      for (const hn of acknowledge) {
        const p = pending.find((x) => x.heads_up.hn === hn);
        if (p === undefined || hn > req.ack)
          return err(req, "invalid_args", { argument: "acknowledge", problem: "unknown_heads_up", hn });
      }
      const files = view();
      // CK3: at least one path's oid differs from head.
      let nonEmpty = files.size !== head.size;
      if (!nonEmpty) {
        for (const [path, content] of files) {
          if (head.get(path) !== content) {
            nonEmpty = true;
            break;
          }
        }
      }
      if (!nonEmpty) {
        return respond(req, {
          ok: true,
          result: { status: "rejected", errors: [{ code: "empty_change", detail: {} }] },
        });
      }
      const errors: Array<{ code: string; detail: object }> = [];
      // CK4: every resulting module parses.
      for (const [path, content] of files) {
        if (!path.endsWith(".js")) continue;
        const mod = parseModule(path, content);
        if (!mod.ok)
          errors.push({
            code: "parse_error",
            detail: { path, message: mod.error.message, line: mod.error.line, column: mod.error.column },
          });
      }
      // CK5: every import and re-export in a touched file, and every import of a touched file, resolves.
      if (errors.length === 0) {
        const touched = new Set(ops.map((o) => o.path));
        const importers = new Set<string>();
        for (const [path, content] of files) {
          if (!path.endsWith(".js")) continue;
          for (const imp of importsOf(path, content)) {
            const target = resolveSpecifier(path, imp.specifier);
            if (target !== null && touched.has(target)) importers.add(path);
          }
        }
        const checkFiles = new Set([...touched, ...importers]);
        for (const path of checkFiles) {
          const content = files.get(path);
          if (content === undefined || !path.endsWith(".js")) continue;
          for (const imp of importsOf(path, content)) {
            const target = resolveSpecifier(path, imp.specifier);
            if (target === null) {
              errors.push({ code: "banned_import", detail: { path, specifier: imp.specifier } });
              continue;
            }
            const targetContent = files.get(target);
            if (targetContent === undefined) {
              errors.push({ code: "import_unresolved", detail: { path, specifier: imp.specifier, missing: target } });
              continue;
            }
            const mod = parseModule(target, targetContent);
            if (!mod.ok) continue;
            for (const name of imp.names) {
              if (name === "*") continue;
              if (!mod.exports.includes(name)) {
                errors.push({ code: "import_unresolved", detail: { path, specifier: imp.specifier, name } });
              }
            }
          }
        }
      }
      if (errors.length > 0) {
        return respond(req, { ok: true, result: { status: "rejected", errors } });
      }
      // CK1 resolution and the submit_id formula of 4.9.
      for (const hn of acknowledge) {
        const p = pending.find((x) => x.heads_up.hn === hn);
        if (p !== undefined) p.resolved = true;
      }
      resolvedHns = [...new Set([...resolvedHns, ...acknowledge])].sort((a, b) => a - b);
      const submitId = `s_${H(`${opts.attemptId}|${revision}|${opSeq}|${resolvedHns.join(",")}`).slice(0, 16)}`;
      const duplicate = submitId === lastSubmitId;
      lastSubmitId = submitId;
      state = "validated";
      const result: Record<string, unknown> = {
        status: "validated",
        submit_id: submitId,
        tier: "auto",
        checks: [
          { name: "non_empty", ok: true },
          { name: "parse", ok: true },
          { name: "imports_resolve", ok: true },
        ],
      };
      if (duplicate) result.duplicate = true;
      return respond(req, { ok: true, result });
    },
  };

  return {
    /** One tool call (a `ToolRequest` in, the `ToolResponse` out). */
    call(req: ToolRequest): ToolResponse {
      const tool = tools[req.tool];
      if (tool === undefined) return err(req, "invalid_args", { argument: "tool", problem: "unknown" });
      if (state === "stopped") return err(req, "attempt_closed", {});
      if (state === "opened") state = "working"; // T1
      return tool(req, (req.args ?? {}) as Record<string, unknown>);
    },
    /** The scripted landing of ME5 step 2: overwrite `path` at head (no op, no read flag change). */
    landHead(path: string, content: string): void {
      head.set(path, content);
      headSeq += 1;
    },
    /** ME5 step 4: enqueue the heads-up and send the attempt around (T8). */
    pushHeadsUp(headsUp: HeadsUp): void {
      pending.push({ heads_up: headsUp, resolved: false });
      state = "going_around";
      goArouds += 1;
    },
    /** The text of `path` in the attempt view (the run's "resulting tree"). */
    fileAt(path: string): string | null {
      return viewOf(path);
    },
    /** The whole resulting tree, as `path -> text` (ME2: a run never sees another run's). */
    files(): Map<string, string> {
      return view();
    },
    ops(): MemOp[] {
      return [...ops];
    },
    pendingHeadsUps(): HeadsUp[] {
      return pending.filter((p) => !p.resolved).map((p) => p.heads_up);
    },
    state(): AttemptState {
      return state;
    },
  };
}
