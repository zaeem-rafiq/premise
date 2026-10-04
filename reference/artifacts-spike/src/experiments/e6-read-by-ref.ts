/** e6-read-by-ref: how fast are the binding's read methods, and how soon do they reflect a push? */
import {
  commitFiles,
  pushRef,
} from "../gitops";
import {
  intParam,
  randomSuffix,
  sleep,
  summarize,
} from "../recorder";
import {
  bindingHead,
  seedRepo,
  target,
  waitBindingHead,
  withRepo,
  type Experiment,
} from "./common";

export const e6: Experiment = async (deps, body, rec) => {
  const reps = intParam(body.reps, 5, 1, 50);
  const rounds = intParam(body.rounds, 5, 1, 50);
  const seed = await seedRepo(rec, deps, "e6");
  const { repo, local, style } = seed;
  const gitTarget = target(repo, style);

  // A little history so that log() has something to walk.
  let head = seed.head;
  for (let i = 1; i <= 3; i++) head = await commitFiles(local, { "history.txt": `line ${i}\n` }, `spike e6: history commit ${i}`);
  const historyPush = await pushRef(rec, "history-push", local, gitTarget, { ref: repo.branch });
  if (!historyPush.ok) throw new Error(`history push failed: ${historyPush.errorText}`);
  const settled = await waitBindingHead(deps.artifacts, repo.name, repo.branch, head);
  rec.note(`after the history push the binding reported the new head after ${settled.ms} ms (${settled.staleReads} stale reads)`);

  const staleness: Record<string, unknown>[] = [];
  const getStarted = Date.now();
  await withRepo(deps.artifacts, repo.name, async (handle) => {
    rec.timing("get_ms", Date.now() - getStarted);
    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => rec.time(label, fn);

    // 1. Read latency.
    const commit = await handle.readCommit(head);
    if (!commit) throw new Error(`readCommit(${head}) returned null`);
    const tree = await handle.readTree(commit.treeHash);
    const readmeEntry = tree?.find((e) => e.name === "README.md");
    for (let i = 0; i < reps; i++) {
      rec.checkpoint();
      await timed("readFile_ms", async () => (await handle.readFile({ ref: repo.branch, path: "README.md" }))?.text());
      await timed("log_limit10_ms", () => handle.log({ ref: repo.branch, limit: 10 }));
      await timed("readCommit_ms", () => handle.readCommit(head));
      await timed("readTree_ms", () => handle.readTree(commit.treeHash));
      if (readmeEntry) await timed("readBlob_ms", async () => (await handle.readBlob(readmeEntry.hash))?.arrayBuffer());
      await timed("info_ms", () => handle.info());
    }
    const latency: Record<string, unknown> = {};
    for (const label of ["readFile_ms", "log_limit10_ms", "readCommit_ms", "readTree_ms", "readBlob_ms", "info_ms"]) {
      const values = rec.timings[label];
      latency[label] = summarize(Array.isArray(values) ? values : values === undefined ? [] : [values]);
    }
    rec.data.read_latency = latency;
    rec.note(`read latency over ${reps} repetitions (first call of each is the cold one): ${JSON.stringify(latency)}`);
    rec.note(`readTree(root) returned ${tree?.length ?? "null"} entries: ${tree?.map((e) => `${e.name}:${e.type}`).join(", ")}`);

    // 2. How soon do reads reflect a push?
    for (let round = 1; round <= rounds; round++) {
      rec.checkpoint();
      const content = `round ${round} ${randomSuffix()}\n`;
      const oid = await commitFiles(local, { "round.txt": content }, `spike e6: round ${round}`);
      const push = await pushRef(rec, `round${round}-push`, local, gitTarget, { ref: repo.branch });
      if (!push.ok) {
        rec.note(`round ${round}: push failed: ${push.errorText}`);
        staleness.push({ round, push_ok: false });
        continue;
      }
      const pushedAt = Date.now();
      const poll = async (check: () => Promise<boolean>) => {
        let staleReads = 0;
        for (;;) {
          rec.checkpoint();
          const fresh = await check();
          const ms = Date.now() - pushedAt;
          if (fresh) return { ms_to_fresh: ms, stale_reads: staleReads };
          staleReads++;
          if (ms > 15_000) return { ms_to_fresh: null, stale_reads: staleReads };
          await sleep(20);
        }
      };
      const [viaLog, viaReadFile] = await Promise.all([
        poll(async () => (await handle.log({ ref: repo.branch, limit: 1 }))[0]?.hash === oid),
        poll(async () => {
          const blob = await handle.readFile({ ref: repo.branch, path: "round.txt" });
          return blob !== null && (await blob.text()) === content;
        }),
      ]);
      staleness.push({ round, push_ok: true, push_ms: push.ms, log: viaLog, readFile: viaReadFile });
      head = oid;
    }
  });
  const freshHandleHead = await bindingHead(deps.artifacts, repo.name, repo.branch);
  rec.note(`a fresh get() handle reports head ${freshHandleHead} (${freshHandleHead === head ? "current" : `expected ${head}`})`);
  rec.data.staleness = staleness;

  const waits = staleness.flatMap((s) => {
    const log = s.log as { ms_to_fresh: number | null } | undefined;
    const file = s.readFile as { ms_to_fresh: number | null } | undefined;
    return [log?.ms_to_fresh, file?.ms_to_fresh].filter((v): v is number => typeof v === "number");
  });
  const staleCount = staleness.reduce((sum, s) => sum + ((s.log as { stale_reads?: number } | undefined)?.stale_reads ?? 0) + ((s.readFile as { stale_reads?: number } | undefined)?.stale_reads ?? 0), 0);
  const neverFresh = staleness.some((s) => s.push_ok === true && ((s.log as { ms_to_fresh: number | null }).ms_to_fresh === null || (s.readFile as { ms_to_fresh: number | null }).ms_to_fresh === null));
  Object.assign(rec.verdict, {
    read_latency_p50_ms: Object.fromEntries(Object.entries(rec.data.read_latency as Record<string, { p50: number } | null>).map(([k, v]) => [k, v?.p50 ?? null])),
    rounds,
    stale_reads_after_push: staleCount,
    ms_until_reads_reflect_push: summarize(waits),
    some_read_never_caught_up_within_15s: neverFresh,
  });
  rec.data.repo = { name: repo.name };
  return !neverFresh && staleness.some((s) => s.push_ok === true);
};
