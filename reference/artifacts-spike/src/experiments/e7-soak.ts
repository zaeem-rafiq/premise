/** e7-soak: latency and reliability of K sequential commit+push cycles from one warm in-memory repo. */
import {
  commitFiles,
  pushRef,
  type AuthStyle,
} from "../gitops";
import {
  intParam,
  randomSuffix,
  summarize,
  type HttpEntry,
} from "../recorder";
import {
  pushSummary,
  seedRepo,
  target,
  waitBindingHead,
  type Experiment,
} from "./common";

export const e7: Experiment = async (deps, body, rec) => {
  const k = intParam(body.k, 100, 1, 500);
  const seedFiles = intParam(body.seed_files, 3, 0, 2000);
  const budgetMs = intParam(body.budget_ms, 480_000, 1000, 3_600_000);
  const reuse = body.reuse === true && deps.warm.e7 !== undefined;

  let warm = deps.warm.e7;
  if (!reuse || !warm) {
    if (body.reuse === true) rec.note("reuse was requested, but this Durable Object instance holds no warm repo (the instance was restarted or e7 has not run on it); creating a new repo");
    const seed = await seedRepo(rec, deps, "e7");
    warm = { repo: seed.repo, style: seed.style, local: seed.local, commits: 1 };
    if (seedFiles > 3) {
      const extra: Record<string, string> = {};
      for (let i = 0; i < seedFiles - 3; i++) extra[`bulk/dir${i % 20}/file${i}.txt`] = `bulk file ${i}\n${"x".repeat(200)}\n`;
      await commitFiles(warm.local, extra, `spike e7: ${seedFiles - 3} extra files`);
      const bulk = await pushRef(rec, "bulk-push", warm.local, target(warm.repo, warm.style), { ref: warm.repo.branch });
      rec.note(`bulk push of ${seedFiles - 3} extra files: ${pushSummary(bulk)}`);
      if (!bulk.ok) throw new Error(`bulk push failed: ${bulk.errorText}`);
      warm.commits++;
    }
    deps.warm.e7 = warm;
  } else {
    rec.addSecret(warm.repo.token);
    rec.note(`reusing the warm in-memory repo from an earlier call on this Durable Object instance (${warm.commits} commits so far)`);
  }
  const style: AuthStyle = body.auth === "bearer" ? "bearer" : body.auth === "basic" ? "basic" : warm.style;
  const gitTarget = target(warm.repo, style);
  const { local } = warm;
  rec.note(`soak: ${k} sequential commit+push cycles to ${warm.repo.name} with ${style} auth; the in-memory filesystem holds ${local.fs.fileCount()} files (work tree plus .git) before the run`);

  const pushMs: number[] = [];
  const discoverMs: number[] = [];
  const receivePackMs: number[] = [];
  const requestBytes: number[] = [];
  const failures: { iteration: number; statuses: number[]; error: string }[] = [];
  const aggregate = new Map<string, HttpEntry>();
  let consecutiveFailures = 0;
  let completed = 0;
  let lastOid: string | null = null;
  let lastPushedOid: string | null = null;
  const started = Date.now();
  for (let i = 1; i <= k; i++) {
    lastOid = await commitFiles(local, { "soak/counter.txt": `${warm.commits + 1}\n`, [`soak/slot${i % 5}.txt`]: `iteration ${i} ${randomSuffix()}\n` }, `spike e7: soak commit ${i}`);
    warm.commits++;
    const push = await pushRef(rec, "soak", local, gitTarget, { ref: warm.repo.branch, quiet: true });
    completed = i;
    pushMs.push(push.ms);
    for (const call of push.calls) {
      const key = `${call.step} -> ${call.status}`;
      const row = aggregate.get(key) ?? { step: call.step, status: call.status, ms: 0, count: 0 };
      row.count = (row.count ?? 0) + 1;
      row.ms = (row.ms ?? 0) + (call.ms ?? 0);
      aggregate.set(key, row);
      if (call.method === "GET") discoverMs.push(call.ms ?? 0);
      else {
        receivePackMs.push(call.ms ?? 0);
        requestBytes.push(call.requestBytes);
      }
    }
    if (push.ok) {
      consecutiveFailures = 0;
      lastPushedOid = lastOid;
    } else {
      consecutiveFailures++;
      failures.push({ iteration: i, statuses: push.statuses, error: push.errorText ?? JSON.stringify(push.refs) });
      if (consecutiveFailures >= 5) {
        rec.note(`stopped at iteration ${i}: 5 consecutive failures`);
        break;
      }
    }
    if (Date.now() - started > budgetMs) {
      rec.note(`stopped at iteration ${i}: time budget of ${budgetMs} ms used up`);
      break;
    }
  }
  const wallMs = Date.now() - started;
  // Aggregated HTTP rows: `ms` is the total across `count` requests.
  for (const row of aggregate.values()) rec.httpLog.push(row);
  rec.timing("soak_wall_ms", wallMs);
  rec.timings.push_ms = pushMs;

  const pushSummaryStats = summarize(pushMs);
  rec.data.push_ms_summary = pushSummaryStats;
  rec.data.discover_get_ms_summary = summarize(discoverMs);
  rec.data.receive_pack_post_ms_summary = summarize(receivePackMs);
  rec.data.receive_pack_request_bytes_summary = summarize(requestBytes);
  rec.data.failures = failures;
  rec.data.memory_fs = { files: local.fs.fileCount(), bytes: local.fs.totalBytes() };
  rec.note(`per-push latency ms (GET info/refs + POST git-receive-pack): ${JSON.stringify(pushSummaryStats)}`);
  rec.note(`of which GET info/refs: ${JSON.stringify(rec.data.discover_get_ms_summary)}; POST git-receive-pack: ${JSON.stringify(rec.data.receive_pack_post_ms_summary)}`);
  rec.note(`in-memory filesystem after the run: ${local.fs.fileCount()} files, ${local.fs.totalBytes()} bytes`);
  for (const f of failures.slice(0, 10)) rec.note(`failure at iteration ${f.iteration} (HTTP ${f.statuses.join(", ") || "none"}): ${f.error}`);

  let remoteMatches: boolean | null = null;
  if (lastPushedOid) {
    const fresh = await waitBindingHead(deps.artifacts, warm.repo.name, warm.repo.branch, lastPushedOid);
    remoteMatches = fresh.matched;
    rec.note(`binding head after the soak ${fresh.matched ? "matches" : "does NOT match"} the last pushed commit ${lastPushedOid} (checked for ${fresh.ms} ms)`);
  }
  Object.assign(rec.verdict, {
    cycles_requested: k,
    cycles_run: completed,
    failures: failures.length,
    first_failure_iteration: failures[0]?.iteration ?? null,
    push_ms_p50: pushSummaryStats?.p50 ?? null,
    push_ms_p95: pushSummaryStats?.p95 ?? null,
    push_ms_max: pushSummaryStats?.max ?? null,
    pushes_per_second: wallMs > 0 ? Math.round((completed / wallMs) * 1000 * 100) / 100 : null,
    remote_head_matches_last_push: remoteMatches,
  });
  rec.data.repo = { name: warm.repo.name };
  return failures.length === 0 && completed === k && remoteMatches === true;
};
