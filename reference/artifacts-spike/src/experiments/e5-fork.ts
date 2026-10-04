/** e5-fork: how fast and how reliable are N concurrent forks, and is the token fork() returns usable? */
import {
  authHeader,
  cloneRepo,
  commitFiles,
  pushRef,
  rawDiscover,
  type AuthStyle,
} from "../gitops";
import {
  errText,
  intParam,
  isAlreadyExists,
  isInProgress,
  randomSuffix,
  sleep,
  summarize,
} from "../recorder";
import {
  REPO_PREFIX,
  bindingHead,
  disposeQuietly,
  isTransientStatus,
  pollDelayMs,
  pushSummary,
  remoteRefValue,
  requireE1,
  target,
  waitBindingHead,
  waitReady,
  withRepo,
  type CreatedRepo,
  type Experiment,
  type ReadyOutcome,
} from "./common";

interface ForkRow {
  name: string;
  ok: boolean;
  fork_call_ms: number | null;
  /** Time from the fork() call until a get() + info() poll succeeded (upper bound of the time to ready). */
  ready_ms: number | null;
  /** Time from the fork() call until the last poll that found the fork NOT ready (lower bound). Equals fork_call_ms when no poll did. */
  ready_lower_bound_ms: number | null;
  fork_attempts: number;
  ready_attempts: number | null;
  token_returned: boolean;
  /** Auth style with which the fork() token was accepted, if any. */
  token_style: AuthStyle | null;
  token_probe_status: number | null;
  head_matches_source: boolean | null;
  source: string | null;
  error?: string;
}

export const e5: Experiment = async (deps, body, rec) => {
  const state = await requireE1(deps);
  rec.addSecret(state.token);
  const n = intParam(body.n, 10, 1, 50);
  const defaultBranchOnly = body.default_branch_only !== false;
  const group = randomSuffix();
  const branchRef = `refs/heads/${state.branch}`;
  const credentials = new Map<string, { repo: CreatedRepo; style: AuthStyle }>();
  // Notes from the per-fork polling are dropped (up to 50 forks); the requests are still counted in `http`.
  const quiet = rec.quiet();

  // The head every fork must have is read from the source repo now. The head stored by e1/e2
  // can be stale (for example when e2 was cut off after a push).
  let sourceHead: string | null = await remoteRefValue(rec, "source-head", state.remote, state.token, branchRef);
  if (sourceHead === null) {
    sourceHead = await bindingHead(deps.artifacts, state.name, state.branch);
    rec.note(`the source head could not be read from the git advertisement; the binding reports ${sourceHead}`);
  }
  if (sourceHead === null) {
    sourceHead = state.head;
    rec.note(`the source head could not be read from the remote; using the stored head ${state.head}`);
  } else if (sourceHead !== state.head) {
    rec.note(`the stored head ${state.head} is stale: the source repo is at ${sourceHead}. Forks are compared with the current head.`);
  }
  const expectedHead = sourceHead;

  const forkOne = async (source: ArtifactsRepo, name: string): Promise<ForkRow> => {
    const row: ForkRow = { name, ok: false, fork_call_ms: null, ready_ms: null, ready_lower_bound_ms: null, fork_attempts: 0, ready_attempts: null, token_returned: false, token_style: null, token_probe_status: null, head_matches_source: null, source: null };
    const started = Date.now();
    let forked: ArtifactsCreateRepoResult | undefined;
    let existsWithoutToken = false;
    while (!forked && !existsWithoutToken) {
      rec.checkpoint();
      row.fork_attempts++;
      try {
        forked = await source.fork(name, { description: "throwaway spike fork; safe to delete", defaultBranchOnly });
      } catch (e) {
        rec.checkpoint();
        const elapsed = Date.now() - started;
        if (isAlreadyExists(e) && row.fork_attempts > 1) {
          // An earlier attempt threw but did start the fork. The token from that attempt is lost.
          existsWithoutToken = true;
          rec.note(`fork(${name}): attempt ${row.fork_attempts} threw ALREADY_EXISTS after an earlier failure; the fork exists but fork() never returned its token`);
        } else if (isInProgress(e) && elapsed < 120_000) {
          if (row.fork_attempts <= 2) rec.note(`fork(${name}): attempt ${row.fork_attempts} at ${elapsed} ms threw ${errText(e)}; retrying`);
          await sleep(pollDelayMs(elapsed, n));
        } else {
          row.error = `fork() threw ${errText(e)}`;
          row.fork_call_ms = elapsed;
          return row;
        }
      }
    }
    row.fork_call_ms = Date.now() - started;
    let ready: ReadyOutcome;
    try {
      ready = await waitReady(quiet, deps.artifacts, name, `fork(${name})`, 120_000, n);
    } catch (e) {
      rec.checkpoint();
      row.error = `fork never became ready: ${errText(e)}`;
      return row;
    }
    row.ready_ms = Date.now() - started;
    row.ready_lower_bound_ms = row.fork_call_ms + (ready.notReadyAtMs ?? 0);
    row.ready_attempts = ready.attempts;
    row.source = ready.info.source;
    if (forked) {
      row.token_returned = typeof forked.token === "string" && forked.token.length > 0;
      rec.addSecret(forked.token);
      const created: CreatedRepo = { name, remote: forked.remote || ready.info.remote, branch: forked.defaultBranch || ready.info.defaultBranch, token: forked.token };
      disposeQuietly(forked);
      if (row.token_returned) {
        // Is the token accepted by the git endpoint? Try basic, then bearer.
        for (const style of ["basic", "bearer"] as const) {
          // Listed in `http` as aggregated rows: one row per auth style and status, for all forks.
          const probeOnce = async () => {
            const outcome = await rawDiscover(quiet, "fork-token-probe", created.remote, "git-receive-pack", authHeader(created.token, style));
            rec.httpCount(`fork-token-probe:${style} GET /info/refs?service=git-receive-pack`, outcome.status, outcome.ms);
            return outcome;
          };
          let probe = await probeOnce();
          for (let attempt = 2; attempt <= 3 && isTransientStatus(probe.status); attempt++) {
            await sleep(300);
            probe = await probeOnce();
          }
          row.token_probe_status = probe.status;
          row.head_matches_source = probe.adv ? probe.adv.refs[branchRef] === expectedHead : null;
          if (probe.status === 200) {
            row.token_style = style;
            credentials.set(name, { repo: created, style });
            break;
          }
          rec.note(`fork(${name}): token probe with ${style} auth returned ${probe.message}`);
        }
      }
    }
    row.ok = row.token_probe_status === 200 && row.head_matches_source === true;
    return row;
  };

  const started = Date.now();
  const rows = await withRepo(deps.artifacts, state.name, (source) =>
    Promise.all(Array.from({ length: n }, (_, i) => forkOne(source, `${REPO_PREFIX}e5-${group}-${String(i).padStart(2, "0")}`))),
  );
  const wallMs = Date.now() - started;
  rec.timing("all_forks_wall_ms", wallMs);
  rec.data.forks = rows;
  const okRows = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);
  const readySummary = summarize(rows.flatMap((r) => (r.ready_ms === null ? [] : [r.ready_ms])));
  const readyLowerSummary = summarize(rows.flatMap((r) => (r.ready_lower_bound_ms === null ? [] : [r.ready_lower_bound_ms])));
  const callSummary = summarize(rows.flatMap((r) => (r.fork_call_ms === null ? [] : [r.fork_call_ms])));
  rec.data.ready_ms_summary = readySummary;
  rec.data.ready_lower_bound_ms_summary = readyLowerSummary;
  rec.data.fork_call_ms_summary = callSummary;
  rec.note(`${n} concurrent forks of ${state.name}: ${okRows.length} usable, ${failed.length} failed, wall time ${wallMs} ms; time to ready ${JSON.stringify(readySummary)}`);
  rec.note(
    `each fork's true time to ready lies between ready_lower_bound_ms (last poll that found it not ready) and ready_ms (first poll that succeeded); lower bounds ${JSON.stringify(readyLowerSummary)}. ` +
      `Polls are spaced by at most 10% of the time already waited (minimum ${pollDelayMs(0, n)} ms with ${n} forks).`,
  );
  rec.note(`fork() attempts per fork: ${rows.map((r) => r.fork_attempts).join(",")}; get() attempts until ready: ${rows.map((r) => r.ready_attempts ?? "-").join(",")}`);
  for (const row of failed.slice(0, 5)) rec.note(`failed fork ${row.name}: ${row.error ?? `token probe ${row.token_probe_status}, head matches ${row.head_matches_source}`}`);
  if (rows[0]?.source !== undefined) rec.note(`info().source of the first fork: ${JSON.stringify(rows[0]?.source)}`);

  // Push one commit to one fork from the Durable Object.
  let forkPushOk = false;
  let sourceUnchanged: boolean | null = null;
  const usable = okRows.map((r) => credentials.get(r.name)).find((c) => c !== undefined);
  if (usable) {
    const first = usable.repo;
    const forkTarget = target(first, usable.style);
    const clone = await cloneRepo(rec, "fork-clone", forkTarget, first.branch);
    if (clone.ok && clone.repo) {
      const oid = await commitFiles(clone.repo, { "fork.txt": "commit pushed to a fork with the token fork() returned\n" }, "spike e5: commit on a fork");
      const push = await pushRef(rec, "fork-push", clone.repo, forkTarget, { ref: first.branch });
      rec.timing("fork_push_ms", push.ms);
      rec.note(`push ${oid} to fork ${first.name} with the fork() token (${usable.style} auth): ${pushSummary(push)}`);
      if (push.ok) {
        const fresh = await waitBindingHead(deps.artifacts, first.name, first.branch, oid);
        forkPushOk = fresh.matched;
        rec.note(`binding sees the new head on the fork: ${fresh.matched} (after ${fresh.ms} ms)`);
        const sourceHeadAfter = (await remoteRefValue(rec, "source-head-after", state.remote, state.token, branchRef)) ?? (await bindingHead(deps.artifacts, state.name, state.branch));
        sourceUnchanged = sourceHeadAfter === expectedHead;
        rec.note(`source repo head after the fork push: ${sourceHeadAfter} (${sourceUnchanged ? "unchanged" : `expected ${expectedHead}`})`);
      }
    } else {
      rec.note(`could not clone fork ${first.name}: ${clone.errorText}`);
    }
  } else {
    rec.note("no fork returned a usable token, so the fork push was not attempted");
  }

  Object.assign(rec.verdict, {
    forks_requested: n,
    forks_usable: okRows.length,
    forks_failed: failed.length,
    fork_returns_usable_token: rows.length > 0 && rows.every((r) => r.token_returned && r.token_probe_status === 200),
    ready_ms: readySummary,
    ready_lower_bound_ms: readyLowerSummary,
    source_head_checked_against: expectedHead,
    any_fork_retry_needed: rows.some((r) => r.fork_attempts > 1 || (r.ready_attempts ?? 1) > 1),
    push_to_fork_ok: forkPushOk,
    source_unchanged_by_fork_push: sourceUnchanged,
  });
  return failed.length === 0 && forkPushOk;
};
