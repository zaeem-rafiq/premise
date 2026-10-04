/** e4-refs: which ref namespaces can be pushed, and can they be read back through the binding and by fetch? */
import git from "isomorphic-git";
import {
  AUTHOR,
  authHeader,
  gitHttp,
  initRepo,
  newLocalRepo,
  pushDecision,
  rawDiscover,
  type Decision,
} from "../gitops";
import {
  errText,
} from "../recorder";
import {
  SEED_FILES,
  nowSeconds,
  pushSummary,
  pushWithRetry,
  seedRepo,
  target,
  withRepo,
  type Experiment,
} from "./common";

/** Most extra ref names one request may add. Each one costs a push, several binding reads and a fetch. */
export const MAX_EXTRA_REFS = 20;
const MAX_REF_LENGTH = 200;

function isUsableRefName(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("refs/") && value.length <= MAX_REF_LENGTH && !/[\s\0-\x1f\x7f]/.test(value);
}

interface RefCase {
  ref: string;
  /** Commit the ref points at. */
  oid: string;
  /** A file inside that commit and its expected text. */
  path: string;
  expected: string;
  /** Other spellings to try with the binding (short names). */
  aliases: string[];
}

export const e4: Experiment = async (deps, body, rec) => {
  const seed = await seedRepo(rec, deps, "e4");
  const { repo, local, style, head } = seed;
  const gitTarget = target(repo, style);
  const authorization = authHeader(repo.token, style);
  const fsArgs = { fs: local.fs, dir: local.dir };

  // Build the objects each ref will point at.
  const noteText = "premise: this commit was produced by the spike harness\n";
  const noteOid = await git.addNote({ ...fsArgs, ref: "refs/notes/premise", oid: head, note: noteText, author: AUTHOR, cache: local.cache });
  const logText = '{"event":"session-start"}\n{"event":"session-end"}\n';
  const logBlob = await git.writeBlob({ ...fsArgs, blob: new TextEncoder().encode(logText) });
  const logTree = await git.writeTree({ ...fsArgs, tree: [{ mode: "100644", path: "log.jsonl", oid: logBlob, type: "blob" }] });
  const who = { ...AUTHOR, timestamp: nowSeconds(), timezoneOffset: 0 };
  const logOid = await git.writeCommit({ ...fsArgs, commit: { message: "spike e4: orphan session log\n", tree: logTree, parent: [], author: who, committer: who } });

  const readme = SEED_FILES["README.md"]!;
  const cases: RefCase[] = [
    { ref: "refs/notes/premise", oid: noteOid, path: head, expected: noteText, aliases: ["notes/premise"] },
    { ref: "refs/heads/green", oid: head, path: "README.md", expected: readme, aliases: ["green"] },
    { ref: "refs/session/log", oid: logOid, path: "log.jsonl", expected: logText, aliases: ["session/log"] },
    { ref: "refs/tags/spike-v0", oid: head, path: "README.md", expected: readme, aliases: ["spike-v0"] },
    { ref: "refs/agents/a1/head", oid: head, path: "README.md", expected: readme, aliases: ["agents/a1/head"] },
  ];
  if (Array.isArray(body.extra_refs)) {
    const builtIn = new Set(cases.map((c) => c.ref));
    const usable = [...new Set(body.extra_refs.filter(isUsableRefName))].filter((ref) => !builtIn.has(ref));
    const used = usable.slice(0, MAX_EXTRA_REFS);
    for (const ref of used) cases.push({ ref, oid: head, path: "README.md", expected: readme, aliases: [] });
    if (used.length !== body.extra_refs.length) {
      rec.note(`extra_refs: ${body.extra_refs.length} given, ${used.length} used. Limits: at most ${MAX_EXTRA_REFS} distinct names, each starting with "refs/", at most ${MAX_REF_LENGTH} characters, no whitespace.`);
    }
  }

  // 1. Push each ref. The verdict per ref is the server's own decision: true (report-status
  //    "ok"), false (report-status "ng" or an HTTP 4xx), or "inconclusive (...)" when the
  //    push still got no decision after the retries (no answer, 5xx, 429). A failed request
  //    is not a refused namespace.
  const accepted: Record<string, Decision> = {};
  for (const c of cases) {
    rec.checkpoint();
    await git.writeRef({ ...fsArgs, ref: c.ref, value: c.oid, force: true });
    const push = await pushWithRetry(rec, `push ${c.ref}`, local, gitTarget, { ref: c.ref, remoteRef: c.ref });
    accepted[c.ref] = pushDecision(push, c.ref);
    rec.timing("ref_push_ms", push.ms);
    rec.note(`push ${c.ref} -> ${c.oid.slice(0, 8)}: ${pushSummary(push)}`);
  }

  // 2. What the server advertises afterwards.
  const forPush = await rawDiscover(rec, "advert-receive-pack", repo.remote, "git-receive-pack", authorization);
  const forFetch = await rawDiscover(rec, "advert-upload-pack", repo.remote, "git-upload-pack", authorization);
  for (const c of cases) {
    // A push whose answer was lost still counts as accepted when the ref is there with the pushed value.
    if (typeof accepted[c.ref] === "string" && forPush.adv?.refs[c.ref] === c.oid) {
      rec.note(`push ${c.ref}: no decision came back, but the server now advertises the ref at the pushed commit, so it was accepted`);
      accepted[c.ref] = true;
    }
  }
  rec.data.advertised_for_push = forPush.adv?.refs ?? null;
  rec.data.advertised_for_fetch = forFetch.adv?.refs ?? null;
  rec.data.upload_pack_capabilities = forFetch.adv?.capabilities ?? null;
  let v2Refs: Record<string, string> | null = null;
  try {
    const listed = await git.listServerRefs({ http: gitHttp(rec, "ls-refs-v2"), url: repo.remote, protocolVersion: 2, headers: { Authorization: authorization } });
    v2Refs = Object.fromEntries(listed.map((r) => [r.ref, r.oid]));
  } catch (e) {
    rec.checkpoint();
    rec.note(`protocol v2 ls-refs failed: ${errText(e)}`);
  }
  rec.data.listed_by_v2_ls_refs = v2Refs;

  // 3. Read back through the binding.
  const bindingLog: Record<string, unknown> = {};
  const bindingReadFile: Record<string, unknown> = {};
  await withRepo(deps.artifacts, repo.name, async (handle) => {
    for (const c of cases) {
      rec.checkpoint();
      for (const refArg of [c.ref, ...c.aliases]) {
        try {
          const log = await rec.time("binding_log_ms", () => handle.log({ ref: refArg, limit: 2 }));
          bindingLog[refArg] = log.length === 0 ? "unresolved (empty list)" : log[0]!.hash === c.oid ? "resolved" : `resolved to a different commit ${log[0]!.hash}`;
        } catch (e) {
          bindingLog[refArg] = `threw ${errText(e)}`;
        }
        try {
          const blob = await rec.time("binding_readFile_ms", () => handle.readFile({ ref: refArg, path: c.path }));
          bindingReadFile[refArg] = blob === null ? "null" : (await blob.text()) === c.expected ? "content matches" : "content differs";
        } catch (e) {
          bindingReadFile[refArg] = `threw ${errText(e)}`;
        }
      }
      // By commit id, which should work for any object the repo stores.
      try {
        const blob = await handle.readFile({ ref: c.oid, path: c.path });
        bindingReadFile[`${c.ref} by commit id`] = blob === null ? "null" : (await blob.text()) === c.expected ? "content matches" : "content differs";
      } catch (e) {
        bindingReadFile[`${c.ref} by commit id`] = `threw ${errText(e)}`;
      }
    }
  });
  rec.data.binding_log = bindingLog;
  rec.data.binding_readFile = bindingReadFile;

  // 4. Read back by fetch into a fresh repo.
  const fetched: Record<string, unknown> = {};
  for (const c of cases) {
    rec.checkpoint();
    const fresh = newLocalRepo();
    try {
      await initRepo(fresh, repo.branch);
      await git.addRemote({ fs: fresh.fs, dir: fresh.dir, remote: "origin", url: repo.remote });
      const result = await rec.time("fetch_ref_ms", () =>
        git.fetch({ fs: fresh.fs, http: gitHttp(rec, `fetch ${c.ref}`), dir: fresh.dir, url: repo.remote, remoteRef: c.ref, singleBranch: true, tags: false, headers: { Authorization: authorization }, cache: fresh.cache }),
      );
      if (result.fetchHead !== c.oid) {
        fetched[c.ref] = `fetched ${result.fetchHead}, expected ${c.oid}`;
        continue;
      }
      const { blob } = await git.readBlob({ fs: fresh.fs, dir: fresh.dir, oid: c.oid, filepath: c.path, cache: fresh.cache });
      fetched[c.ref] = new TextDecoder().decode(blob) === c.expected ? "fetched, content matches" : "fetched, content differs";
    } catch (e) {
      rec.checkpoint();
      fetched[c.ref] = `failed: ${errText(e)}`;
    }
  }
  rec.data.fetch = fetched;

  const namespaces = cases.map((c) => c.ref);
  Object.assign(rec.verdict, {
    push_accepted: accepted,
    advertised_for_push: Object.fromEntries(namespaces.map((r) => [r, forPush.adv ? forPush.adv.refs[r] !== undefined : null])),
    advertised_for_fetch_v1: Object.fromEntries(namespaces.map((r) => [r, forFetch.adv ? forFetch.adv.refs[r] !== undefined : null])),
    listed_by_v2_ls_refs: Object.fromEntries(namespaces.map((r) => [r, v2Refs ? v2Refs[r] !== undefined : null])),
    binding_log_full_ref: Object.fromEntries(namespaces.map((r) => [r, bindingLog[r]])),
    binding_readFile_full_ref: Object.fromEntries(namespaces.map((r) => [r, bindingReadFile[r]])),
    fetch: fetched,
  });
  rec.data.repo = { name: repo.name };
  return ["refs/notes/premise", "refs/heads/green", "refs/session/log"].every((r) => accepted[r] === true);
};
