# Attempt repositories: extension stage 2 handback

Prepared 2026-10-10 UTC for the 2026-10-11 integration checkpoint.

## State and boundaries

Implemented locally on `feat/attempt-repos`, based on `9176a2a6dbf32dac9b70671d5079d745a8567000`.
The default remains `FEATURES.attempt_repos: false`. Nothing was pushed, deployed, or tested against
the live service. The lead must review and integrate the patch, run the live checks below on `test`,
and decide whether the feature can be enabled. Local fake binding results do not prove Artifacts
reliability, latency, production permissions, or billed usage.

The environment refused writes to this clone's Git lock files. A local commit returned exit 128
(`.git/index.lock: Operation not permitted`). `git fetch origin` succeeded and fetched
`origin/main` first at `74cbbf5a656ef3b22a9a5e1c5590800d694a7283`, then at
`aea1de767f749ef2a897f648c6e0bf45821b87be` after the lead merged the MCP extension. The requested merge returned exit 128
(`.git/ORIG_HEAD.lock: Operation not permitted`), leaving HEAD unchanged. The authorized fallback
is `.tmp-test/attempt-repos.patch`, including new files. No permission restriction was bypassed.

The fetched lead commit contains the separate fork probe. Its committed JSON reports a fork in
`pools` and a successful empty create. That is the lead's recorded evidence, not a live check run
by this builder. The dated specification amendment records the owner's option-A decision; the lead
still owns adding the measured probe conclusion to the specification.

## Implementation and impact

- The adapter receives only `ATTEMPTS`. Option A creates an empty, deterministically named repository.
  The option-B adapter path forks only a source already in `ATTEMPTS`; it rejects a missing safe source.
  Current production wiring selects A. B is tested adapter code, not a wired cross-namespace pool fork.
- The existing singleton `ModelGate` named `premise` owns a durable provisioning queue. It coordinates
  all pools, separately from model reservations. Four actual binding calls can run at once. Slots stay
  occupied until the call settles; a timer cannot release a still-running call.
- Provisioning makes one initial call and at most three retries. The gate alarm applies 2,000, 4,000,
  and 8,000 ms delays after failed calls. Result delivery retries do not provision again.
- The Agent persists exactly one `attempt.repo` event through its existing durable event outbox.
  An independent internal call tells Trunk the successful repository name. An accepted note is never
  rewritten by a later receipt. Synthetic agents and a disabled switch produce neither provisioning
  calls nor repository events.
- Submit and terminal-state transitions persist archive triggers. Background capture and push jobs
  run independently of model calls, tools, submission, and landing. One push per attempt runs at a
  time, with the latest pending snapshot replacing an older pending snapshot. A failed push retries
  the same snapshot. Git ref confirmation handles a lost push response without duplicating a commit.
- Checkpoint pushes use the existing pool `receivePackPusher` implementation. Every push attempt mints
  a repository-scoped `createToken("write", 3600)` token. Neither `create()` nor `fork()` tokens are used.
  Tokens are not persisted. Remote metadata is checked before token use. Transcript, operation,
  premise, path, and file strings are redacted before checkpoint persistence and before git serialization.
- Trunk exposes the checkpoint view and repository receipt only through internal Durable Object calls.
  No public repository or token route was added. Completed landings use their historical file view;
  reopened attempts use their current view. Registration after a Trunk rebuild repeats the receipt.
- `AttemptRepoWorkflow` succeeds as a documented no-op while enabled. While disabled it preserves the
  previous `not_built` result. Gate and Agent alarms supply the required work. Nothing is deleted.
- About already followed the feature switch and reducer events. Added tests cover off, unknown,
  success, and failure states, plus removal from the limits list while on. The specification gives no
  Why-card repository link, so none was added. Submission wording remains valid with the switch off.

A scratch checkout at fetched `origin/main` (`aea1de7`) was prepared under `/private/tmp` to
check integration without changing the lead's checkout. Three-way application needed only generated
rule-coverage and feature-comment conflict resolution. The generated file was regenerated. The limits
fixture now enables the other boolean switches before testing the attempt-repository switch, so MCP's
new disabled-feature wording cannot change this test's subject. Its expected wording is unchanged.
Agent and gate changes applied cleanly. Independent source review traced outside MCP submits through
the shared archive trigger; a combined feature-on MCP/archive live run is not claimed.

The affected path is real intent → Agent open → singleton gate → ATTEMPTS provisioning → Agent event
and internal Trunk receipt. The checkpoint path is submit/end → durable Agent timer → internal Trunk
view → durable snapshot → shared git pusher → `refs/heads/attempt`. Existing event reduction drives
About. Shared protocol types, bindings, dependencies, and the default switch were not changed.

## Choices where the specification was silent

1. Repository names are `attempt-` followed by the SHA-1 of the attempt id. This gives a stable,
   bounded name for retries. It is naming, not an authorization or cryptographic integrity boundary.
2. `transcript.jsonl` contains one JSON object per stored transcript row, in step order. `ops.json`
   and `premises.json` are arrays. Operations use operation order; premises use kind/key order.
3. Touched source files live at `files/<original path>` to avoid colliding with the three metadata
   files. Deleted files are absent, with the deletion retained in `ops.json`.
4. Capture reads the current attempt view asynchronously. Multiple requests coalesce to the newest
   pending snapshot. Snapshot number and timestamp remain stable across retries. A completed landing
   uses its exact landed view, even if later pool changes occur before capture.
5. Checkpoint tokens last 3,600 seconds, matching the existing pool write-token lifetime. Tokens are
   minted afresh per push attempt with explicit `write` scope.
6. Provisioning latency is measured from durable queue insertion to the final provisioning result,
   including queue time and retry delays. It excludes result-event delivery and checkpoint upload.
7. Fixed error codes keep provider exception text and credentials out of durable state and events.
8. Checkpoint push retries use the existing push-backoff maximum and survive terminal model states.
   Terminal attempts can finish archive-only work without restarting the model loop.
9. The archive Workflow has no extra retention or deletion job. No cleanup policy was invented.
10. Durable snapshots use 512 KiB UTF-8 byte chunks, leaving room below SQ2's 1 MiB row bound.
    Chunks are reassembled before decoding, including when a multibyte character crosses a boundary.
11. The environment-free adapter seam retains its fail-closed stub. The gate binds the concrete
    factory to `ATTEMPTS` only when the feature is enabled, following the existing adapter pattern.

The S3 amendment and checkpoint format are recorded in `docs/spec/01-core.md`. Two exact fabricated
credential fixtures were added to `scripts/ops/secrets-allow.json`, following the existing scanner's
policy. No scanner rule was weakened. `test/support/git.ts` gained a type assertion on its sanitized
environment so the shared helper compiles under Worker test types; its runtime behavior is unchanged.

## Acceptance evidence

Command: `npx vitest run --project workerd test/workerd/agent/attempt-repos.test.ts` after
`npm run build:worker`. Observed exit 0, one file and six tests passed. These tests execute the actual
Worker and Durable Objects in local workerd, with fake model/Artifacts bindings and a real git
smart-HTTP server. They inspect actual repository trees and commits, not mocked checkpoint results.

| Brief item | Test title | Observed result |
| --- | --- | --- |
| 1: success and checkpoint tree | `AG5 S3 S3b SE22: a real-agent landing archives the three metadata files and touched view with explicitly minted write tokens` | PASS: one successful agent event, all three metadata files, touched source content, accepted note receipt, and stock-git integrity check. |
| 2: failed provisioning does not block landing | `AG5 S3a S3c: a held failing provisioner cannot delay landing, then three alarm retries emit one failure and the accepted note keeps repo null` | PASS: landing while the provider is held, four total calls, 2/4/8-second retry schedule, one failure event, note repository null. |
| 3: deployment-wide bound | `S3a AG5: twelve real attempts across two pools share the deployment-wide maximum of four provisioning calls` | PASS: twelve real attempts, two pools, observed maximum four calls in flight. |
| 4: scoped tokens | Success test above; `S3, S3b, SE22: B forks only a source in ATTEMPTS and ignores its implicit token`; `AG5, S3, S3b: real git reads the three records and every touched file on refs/heads/attempt` | PASS: git authentication used only explicitly minted write tokens with TTL; implicit returned tokens were never used. |
| 5: disabled switch | `FJ1 S3 AG5: switch off makes no provisioning call or attempt.repo event while a real-agent landing remains unchanged` | PASS: no provisioning, no repository event, ordinary landing succeeds. |
| Additional asynchronous push check | `AG5 S3c: a blocked checkpoint push cannot delay landing and submit/end checkpoints coalesce to one in-flight push` | PASS: held git push did not delay landing, maximum one push per attempt, final snapshot drained. |
| Synthetic exclusion | `S3 AG5: synthetic scripted agents never provision an attempt repository even with the switch on` | PASS: no provisioning or repository event. |

Additional unit coverage exercises redaction, explicit scoped tokens, safe option-B behavior, retry
idempotency, a lost push reply, invalid remote targets, durable archive retries and coalescing, and
current versus historical Trunk views. Review-driven recovery and large-snapshot regressions are
included in the final suite results below.

## Verification record

Toolchain: Node `v22.22.3`, npm `10.9.8`. Evidence logs are local under
`.tmp-test/attempt-repos-evidence/`. They are excluded from Git.

| Command | Unchanged baseline | Final local result |
| --- | --- | --- |
| `npm run check` | Exit 0; 215 files, 2,608 tests passed, one existing expected failure | Exit 0; 218 files, 2,633 tests passed, one existing expected failure; all six typechecks, builds, licences, and secrets passed |
| `npm run test:workerd` | Exit 0; 49 files passed, one skipped; 249 tests passed, three skipped | Initial unrestricted run exited 1; rerun with `-- --maxWorkers=2` exited 0: 50 files passed, one skipped; 255 tests passed, three skipped |
| `npm run test:cases` | Exit 0; 11 files, 106 tests passed | Exit 0; 11 files, 106 tests passed |
| `CASES=required npm run test:cases` | Not separately required for initial baseline | Exit 0; 11 files, 106 tests passed |
| `npx vitest run --project integration` | Exit 0; 11 files, 716 tests passed | Exit 0; 11 files, 716 tests passed |
| `npm run check:submission` | Not part of initial baseline | Exit 0: README and all three submission texts pass |
| `node scripts/ops/rules-coverage.ts` | Not part of initial baseline | Exit 0: 303 required ids, zero uncovered |
| `PREMISE_E2E_PORT=4403 npm run test:e2e` | Exit 1: Chromium launch denied by macOS | Retry with `-- --max-failures=1` exited 1 with the same launch error |

The unrestricted final workerd run exited 1 after 324 seconds: seven failures in five existing
files (`agent-do`, `event-latency`, `push-table`, `rebuild`, and `retained-history`). Failures included
wait deadlines, missing delayed results, and a closed local socket. All six new acceptance tests passed
in that run. The complete suite then passed with two workers in 479 seconds. No assertion, test timeout,
or production behavior was changed for that rerun. Resource contention is a plausible explanation,
not a proven diagnosis; the initial failure is retained in `final-workerd.log`.

The browser failure is reproduced on the unchanged baseline. Its exact message is
`bootstrap_check_in ... Permission denied (1100)`, followed by Chromium `SIGTRAP`. No page or
interactive flow was exercised. The new About interaction test remains unverified in a browser.
The lead must rerun browser tests where Chromium can start.

An initial final `npm run check` passed typecheck, 2,631 tests, builds, and licences, then exited 1 on
the two fabricated credential fixtures. After exact fixture allowlisting, `npm run check:secrets`
exited 0. The final complete rerun above supersedes that intermediate attempt. The existing expected
failure is `CKL checks_failed_at_landing`; no test expectation was relaxed or disabled.

## Verification after combining with fetched main

Scratch checkout: `/private/tmp/premise-attempt-repos-main-0crafn81`, detached at
`aea1de767f749ef2a897f648c6e0bf45821b87be`, with this task's changes applied. The lead's actual
checkout was not changed. All production changes applied cleanly. Generated rule coverage and a
feature-comment conflict were resolved. The new limits fixture enables other boolean switches, and
the new About browser fixture fills default feature fields, so both accommodate MCP's added switch.
No existing assertion was relaxed. The adapter fixture uses Node's standard SHA-1 implementation for
expected repository names rather than deriving those expectations from the adapter under test.

| Command in the scratch checkout | Observed result |
| --- | --- |
| `npm run check` | Exit 0; 221 files, 2,653 tests passed, one existing expected failure; six typechecks, builds, licences, and secrets passed |
| `npm run test:workerd -- --maxWorkers=4` | Exit 0; 51 files passed, one skipped; 265 tests passed, three skipped |
| `npm run test:cases` | Exit 0; 11 files, 106 tests passed |
| `CASES=required npm run test:cases` | Exit 0; 11 files, 106 tests passed |
| `npx vitest run --project integration` | Exit 0; 11 files, 716 tests passed |
| `npm run check:submission` | Exit 0; README and all three submission texts pass |
| `node scripts/ops/rules-coverage.ts` | Exit 0; coverage up to date, 303 required ids and zero uncovered |
| Browser | Not repeated here: Chromium cannot launch in this sandbox, as reproduced before and after this change |

An earlier scratch typecheck caught the new About fixture's missing default `mcp` field. The fixture
was corrected before the successful check. The browser flow itself remains unverified.

## Lead-only live checks — NOT RUN by this builder

Run these commands from the merged checkout after the lead's probe and authorized `test` deployment with `attempt_repos: true`. Use Node 22.18 or later, the installed Wrangler, and the lead's existing Cloudflare authentication. `PREMISE_URL` must be the `https://premise-test.<account-subdomain>.workers.dev` origin. `PREMISE_OWNER_KEY` must already be in the shell environment. Do not put either access token in a command, report, URL, or file. Run without another model workload on `test`, so its spend delta is attributable.

This command creates one smoke pool and one real-agent attempt. It waits for an actual landing and a successful `attempt.repo` event, then reads the repository through ordinary git. Only after that succeeds does it open 12 real attempts concurrently across two further pools. These are automated real agents, not scripted Swarm agents. After all provisioning results arrive, it stops unfinished load attempts through the existing owner stop route and waits for their terminal states. Already accepted work can still land.

Expected repository creation is up to three repositories for the successful smoke: one pool, its lazily created plain repository, and one attempt repository. The load creates up to 16 more: two pools, up to two plain repositories, and 12 attempt repositories. Nothing is deleted. Each real attempt has `MAX_ATTEMPT_USD = 1`; all 13 attempts therefore have a nominal allowance of $13 before the global cap. The current `test` cap is $10 **including prior test spend** and can stop agents earlier. The command refuses a reported cap above $10. Actual model cost and Artifacts/Worker charges remain unmeasured until the lead runs it. A spend-cap stop does not establish a model or landing failure, but the smoke must land to pass.

The token commands executed below are precisely these installed CLI operations, with stdout captured in memory:

```sh
npx --no-install wrangler artifacts repos get "$repo" --namespace premise-test-attempts --json
npx --no-install wrangler artifacts repos issue-token "$repo" --namespace premise-test-attempts --scope read --ttl 300 --json
```

**Do not run those two lines directly:** the second prints a token. The complete command below disables Wrangler disk logging and captures that output. The read token goes to git only through an ephemeral environment variable and `--config-env`, never through URL credentials, git configuration, or printed command arguments. The local clone contains checkpoint contents, not the token. Each token lasts five minutes. The command mints another read token only when fewer than 45 seconds remain before a git request. The command prints and saves only selected nonsecret measurements.

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { httpService } from './scripts/measure/engine/service.ts';
import { openPoolStream, parseReplayNdjson } from './scripts/soak/stream.ts';
import { attemptRepoName } from './src/worker/adapters/attempt-repo/index.ts';

const origin = new URL(process.env.PREMISE_URL ?? 'https://invalid.example');
assert(origin.protocol === 'https:' && /^premise-test\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname),
  'PREMISE_URL must identify the premise-test workers.dev host');
assert(!origin.username && !origin.password && !origin.port && origin.pathname === '/' && !origin.search && !origin.hash,
  'PREMISE_URL must be a credential-free test origin');
assert(process.env.PREMISE_OWNER_KEY, 'The lead must supply PREMISE_OWNER_KEY through the environment');
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options = {}) => nativeFetch(input, {
  ...options, signal: options.signal ?? AbortSignal.timeout(30_000),
});
const service = httpService({ origin: origin.origin, ownerKey: process.env.PREMISE_OWNER_KEY });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runId = Date.now().toString(36);
const active = [];
const summary = { run: runId, live: true, complete: false, smoke: null, load: null, cleanup: [] };
let stage = 'preflight';
const output = resolve(`.tmp-test/attempt-repos-live-${runId}.json`);
mkdirSync('.tmp-test', { recursive: true });
process.umask(0o077);

async function post(path, body) {
  const result = await service.postJson(path, body);
  if (result.status < 200 || result.status >= 300 || result.body?.error)
    throw new Error(`HTTP request failed: ${result.status}`);
  return result.body;
}
async function exported(pool) {
  const response = await service.getAuthed(`/api/pools/${encodeURIComponent(pool)}/replay.ndjson`);
  assert.equal(response.status, 200, 'Replay export must be available');
  return parseReplayNdjson(response.text).events;
}
async function waitUntil(read, accept, ms) {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (accept(value)) return value;
    await sleep(1_000);
  } while (Date.now() < end);
  throw new Error('Live check deadline expired');
}
async function pool(name) {
  await post('/api/pools', { pool: name, seed: 'tidepool-auto', summary_only: false, request_id: `${name}-create` });
  const stream = openPoolStream(name, {
    probe: p => service.probe(p), socket: p => service.socket(p), now: Date.now, sleep,
  }, { deadlineMs: 60_000, giveUpDrops: 3 });
  const record = { pool: name, stream, intents: [] };
  active.push(record);
  let readyTimer;
  const ready = await Promise.race([stream.ready(), new Promise(resolve => {
    readyTimer = setTimeout(() => resolve(false), 60_000);
  })]);
  clearTimeout(readyTimer);
  assert(ready, 'Pool stream must be ready');
  const limits = await waitUntil(async () => stream.state()?.limits, value => value != null, 30_000);
  assert(limits.cap_usd > 0 && limits.cap_usd <= 10, 'Test cap must be positive and no greater than $10');
  assert(!limits.killed && !limits.refusing && limits.spend_usd + limits.reserved_usd < limits.cap_usd,
    'The test model gate must have budget and permit requests');
  record.spendBefore = limits.spend_usd;
  return record;
}
async function intent(record, index, text) {
  const body = await post(`/api/pools/${encodeURIComponent(record.pool)}/intents`, {
    text, race: false, prewritten: false, request_id: `${record.pool}-intent-${index}`,
  });
  assert.equal(typeof body.intent_id, 'string');
  record.intents.push(body.intent_id);
}
function landingFor(attemptId, events) {
  // landing.landed has no attempt_id: its seq joins the accepted event.
  const accepted = events.findLast(e => e.type === 'landing.accepted' && e.attempt_id === attemptId);
  return accepted === undefined ? null : events.find(e => e.type === 'landing.landed' && e.seq === accepted.seq) ?? null;
}
function observed(record, events) {
  const opened = events.filter(e => e.type === 'attempt.opened' && record.intents.includes(e.intent_id));
  assert(opened.every(e => e.agent === 'real' && e.race === false), 'Only real, non-race attempts qualify');
  return opened.map(open => {
    const results = events.filter(e => e.type === 'attempt.repo' && e.attempt_id === open.attempt_id);
    assert(results.length <= 1, 'Provisioning result must be emitted once');
    const result = results[0] ?? null;
    assert(result === null || result.src === 'agent', 'attempt.repo must come from the Agent');
    const transitions = events.filter(e => e.type === 'attempt.state' && e.attempt_id === open.attempt_id);
    const landing = landingFor(open.attempt_id, events);
    return {
      attempt_id: open.attempt_id, model: open.model, pool: record.pool,
      state: landing ? 'landed' : transitions.at(-1)?.to ?? 'opened',
      result: result === null ? null : { ok: result.ok, ms: result.ms, error: result.error },
      event_model_usd: events.filter(e => e.type === 'attempt.step' && e.attempt_id === open.attempt_id)
        .reduce((sum, e) => sum + (e.cost_usd ?? 0), 0),
    };
  });
}
async function stopPool(record) {
  // These newly created pools contain only this check's attempts. Stop even an attempt
  // whose POST reply was lost, by using the authoritative exported attempt.opened event.
  const events = await exported(record.pool);
  const ids = events.filter(e => e.type === 'attempt.opened' && e.agent === 'real').map(e => e.attempt_id);
  const answers = await Promise.allSettled(ids.map(id => post(
    `/api/pools/${encodeURIComponent(record.pool)}/attempts/${encodeURIComponent(id)}/stop`,
    { request_id: `${record.pool}-stop-${id}` },
  )));
  return answers.every(answer => answer.status === 'fulfilled');
}
async function terminalPool(record) {
  return waitUntil(async () => {
    const events = await exported(record.pool);
    // Include attempts whose intent POST reply was lost, as stopPool does.
    const intents = events.filter(e => e.type === 'attempt.opened' && e.agent === 'real').map(e => e.intent_id);
    return observed({ ...record, intents }, events);
  }, rows => rows.every(row => row.state === 'landed' || row.state === 'stopped'), 120_000);
}
async function readSmokeRepository(attemptId, smokeEvents, note) {
  const repo = attemptRepoName(attemptId);
  const cliEnv = {
    ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'error',
    WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false',
  };
  const cli = args => JSON.parse(execFileSync('npx', ['--no-install', 'wrangler', 'artifacts', 'repos', ...args], {
    env: cliEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }));
  const info = cli(['get', repo, '--namespace', 'premise-test-attempts', '--json']);
  assert.equal(info.name, repo);
  const remote = new URL(info.remote);
  assert(remote.protocol === 'https:' && !remote.username && !remote.password && !remote.search && !remote.hash);
  let issued = null;
  let expires = 0;
  let readTokens = 0;
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^GIT_/i.test(key) && !/^(PREMISE_OWNER_KEY|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|NODE_OPTIONS)$/.test(key)));
  Object.assign(gitEnv, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  });
  function ensureReadToken() {
    // A git request has a 30-second deadline. Refresh before that request can
    // outlive its credential; slow repository readiness never extends a token.
    if (expires > Date.now() + 45_000) return;
    if (issued !== null) issued.plaintext = '';
    issued = cli(['issue-token', repo, '--namespace', 'premise-test-attempts', '--scope', 'read', '--ttl', '300', '--json']);
    assert.equal(issued.scope, 'read');
    assert.equal(typeof issued.plaintext, 'string');
    expires = Date.parse(issued.expires_at);
    assert(Number.isFinite(expires) && expires > Date.now() + 45_000 && expires <= Date.now() + 360_000,
      'Expected a five-minute token with enough lifetime for one git request');
    gitEnv.PREMISE_GIT_AUTH = `Authorization: Bearer ${issued.plaintext}`;
    readTokens += 1;
  }
  const git = args => execFileSync('git', [
    '--config-env=http.extraHeader=PREMISE_GIT_AUTH', '-c', 'credential.helper=', '-c', 'http.followRedirects=false',
    ...args,
  ], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const remoteGit = args => { ensureReadToken(); return git(args); };
  const directory = resolve(`.tmp-test/attempt-repos-clone-${runId}`);
  const successful = new Set(['validated', 'submitted', 'held', 'accepted', 'landed']);
  const lastSubmit = smokeEvents.findLast(e => e.type === 'submit.result' && e.attempt_id === attemptId && successful.has(e.status));
  assert(lastSubmit, 'The landed smoke must have a successful submit result');
  const lastToolStep = Math.max(0, ...smokeEvents.filter(e =>
    e.type === 'attempt.step' && e.attempt_id === attemptId && e.tool !== null).map(e => e.step));
  const expectedPaths = [...new Set(note.ops.map(op => op.path))].sort();
  try {
    await waitUntil(async () => {
      try { return remoteGit(['ls-remote', '--exit-code', remote.href, 'refs/heads/attempt']).trim(); }
      catch { return ''; }
    }, value => value !== '', 90_000);
    remoteGit(['clone', '--no-checkout', '--single-branch', '--branch', 'attempt', remote.href, directory]);
    // The first ref may hold an earlier/rejected submit. Fetch until the
    // accepted run's successful submit and its terminal request are archived.
    const proof = await waitUntil(async () => {
      try {
        remoteGit(['-C', directory, 'fetch', '--no-tags', 'origin', 'refs/heads/attempt:refs/remotes/origin/attempt']);
        const commit = git(['-C', directory, 'rev-parse', 'refs/remotes/origin/attempt']).trim();
        const read = name => git(['-C', directory, 'show', `${commit}:${name}`]);
        const transcript = read('transcript.jsonl').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const ops = JSON.parse(read('ops.json'));
        const premises = JSON.parse(read('premises.json'));
        if (!transcript.length || !Array.isArray(ops) || !Array.isArray(premises) || !ops.length) return null;
        const submits = transcript.filter(row => row.role === 'tool' && row.tool === 'submit' && row.call_id !== null);
        const containsLastSubmit = submits.some(row => {
          const result = JSON.parse(row.content).message?.result;
          return result?.status === lastSubmit.status &&
            (lastSubmit.submit_id === null || result.submit_id === lastSubmit.submit_id);
        });
        const title = git(['-C', directory, 'show', '-s', '--format=%s', commit]).trim();
        const checkpoint = Number(/^Premise attempt checkpoint (\d+)$/.exec(title)?.[1]);
        // Every real Trunk submit requests one checkpoint. The extra request
        // proves the terminal snapshot, even when pushes were coalesced.
        if (!containsLastSubmit || Math.max(...transcript.map(row => row.step)) < lastToolStep ||
            !Number.isSafeInteger(checkpoint) || checkpoint <= submits.length) return null;
        const paths = [...new Set(ops.map(op => op.path))].sort();
        if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) return null;
        const archivedPaths = new Set(git(['-C', directory, 'ls-tree', '-r', '-z', '--name-only', commit, '--', 'files'])
          .split('\0').filter(Boolean));
        const finalOperations = new Map([...ops].sort((a, b) => a.op_seq - b.op_seq).map(op => [op.path, op]));
        let deleted = 0;
        for (const [path, operation] of finalOperations) {
          const absent = operation.op === 'write' && operation.content === null;
          if (archivedPaths.has(`files/${path}`) === absent) return null;
          if (absent) deleted += 1;
        }
        git(['-C', directory, 'fsck', '--strict']);
        return { repo, directory, transcript_entries: transcript.length, operations: ops.length,
          premises: premises.length, touched_files: paths.length, deleted_files: deleted,
          checkpoint_commit: commit, checkpoint_number: checkpoint, terminal_checkpoint_observed: true,
          last_successful_submit_id: lastSubmit.submit_id, read_tokens_minted: readTokens,
          ref: 'refs/heads/attempt' };
      } catch { return null; }
    }, value => value !== null, 180_000);
    return proof;
  } finally {
    delete gitEnv.PREMISE_GIT_AUTH;
    if (issued !== null) issued.plaintext = '';
  }
}

try {
  const floor = await service.getJson('/floor.json');
  assert.equal(floor.status, 200);
  assert.equal(floor.body?.features?.attempt_repos, true, 'The test deployment must have attempt_repos enabled');
  stage = 'smoke';
  const smoke = await pool(`ar-smoke-${runId}`);
  await intent(smoke, 0, 'a jellyfish that drifts up and down');
  const smokeEvents = await waitUntil(() => exported(smoke.pool), events => {
    const rows = observed(smoke, events);
    return rows.length === 1 && landingFor(rows[0].attempt_id, events) !== null && rows[0].result !== null;
  }, 360_000);
  const smokeRow = observed(smoke, smokeEvents)[0];
  assert.equal(smokeRow.result.ok, true, 'Smoke provisioning must succeed');
  stage = 'smoke-git-read';
  const landing = landingFor(smokeRow.attempt_id, smokeEvents);
  assert(landing?.note_json != null, 'The non-summary smoke landing must expose its accepted note');
  const note = JSON.parse(landing.note_json);
  assert.equal(note.attempt?.id, smokeRow.attempt_id, 'The landed note must identify the smoke attempt');
  const gitProof = await readSmokeRepository(smokeRow.attempt_id, smokeEvents, note);
  const noteRepo = note.attempt.repo;
  assert(noteRepo === null || noteRepo === gitProof.repo, 'An accepted note may predate provisioning');
  summary.smoke = { ...smokeRow, ...gitProof, accepted_note_repo: noteRepo };
  console.log(JSON.stringify({ smoke: summary.smoke }));

  stage = 'load';
  const load = [await pool(`ar-load-a-${runId}`), await pool(`ar-load-b-${runId}`)];
  const launches = await Promise.allSettled(load.flatMap((record, p) => Array.from({ length: 6 }, (_, i) => intent(
    record, i, `Add a small jellyfish in creatures/probe-${p}-${i}.js that drifts up and down. Follow the guide.`,
  ))));
  assert(launches.every(result => result.status === 'fulfilled'), 'All 12 real intent requests must succeed');
  const rows = await waitUntil(async () => (await Promise.all(load.map(async record =>
    observed(record, await exported(record.pool))))).flat(),
    rows => rows.length === 12 && rows.every(row => row.result !== null), 120_000);
  const failures = rows.filter(row => !row.result.ok).length;
  const times = rows.filter(row => row.result.ok).map(row => row.result.ms).sort((a, b) => a - b);
  const p90 = times.length ? times[Math.ceil(times.length * 0.9) - 1] : null;
  const rr3Pass = failures / 12 <= 0.05 && p90 !== null && p90 <= 10_000;
  summary.load = { attempts: rows, provision_results: rows.length, failures, failure_rate: failures / 12,
    ready_p90_ms: p90, percentile: 'nearest rank among successful provisioning results', rr3_pass: rr3Pass };
  stage = 'load-stop';
  assert((await Promise.all(load.map(stopPool))).every(Boolean), 'Every load stop must be acknowledged');
  const terminal = await waitUntil(async () => (await Promise.all(load.map(async record =>
    observed(record, await exported(record.pool))))).flat(),
    rows => rows.length === 12 && rows.every(row => row.state === 'landed' || row.state === 'stopped'), 120_000);
  summary.load.terminal = terminal.map(row => ({ attempt_id: row.attempt_id, state: row.state, event_model_usd: row.event_model_usd }));
  const eventSpend = smokeRow.event_model_usd + terminal.reduce((sum, row) => sum + row.event_model_usd, 0);
  const finalLimits = await waitUntil(async () => (await exported(load.at(-1).pool)).findLast(e => e.type === 'limits'),
    value => value != null && value.reserved_usd === 0 && value.spend_usd + 1e-9 >= smoke.spendBefore + eventSpend, 30_000);
  summary.test_spend_delta_usd = finalLimits.spend_usd - smoke.spendBefore;
  summary.remaining_test_budget_usd = finalLimits.cap_usd - finalLimits.spend_usd - finalLimits.reserved_usd;
  assert(rr3Pass, 'RR3 failed: keep attempt_repos off for release');
  summary.complete = true;
} catch {
  summary.failed_stage = stage;
  process.exitCode = 1;
} finally {
  for (const record of active) {
    let stopped = false;
    try { stopped = await stopPool(record); } catch {}
    let terminal = false;
    if (stopped) {
      try { await terminalPool(record); terminal = true; } catch {}
    }
    summary.cleanup.push({ pool: record.pool, stop_requests_acknowledged: stopped, terminal_observed: terminal });
    record.stream.close();
    if (!stopped || !terminal) {
      summary.complete = false;
      summary.failed_stage ??= 'cleanup';
      process.exitCode = 1;
    }
  }
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, artifact: output }));
}
NODE
```

Pass requires the smoke landing, its successful Agent-source provisioning event, and its terminal checkpoint readable with the scoped read token. The command joins `landing.accepted` to `landing.landed` by `seq`, checks the actual note, and fetches until the transcript contains the successful submit. The checkpoint number must exceed the count of submitted tool calls, proving the additional terminal snapshot request. All three root metadata files must exist. Every final nondeleted touched file must exist under `files/`; each final deletion must be absent and remain in `ops.json`. A `null` repository in the already accepted landing note is allowed by S3c. The load must report all 12 provisioning results, at most 5% failures after retries, and successful-ready nearest-rank p90 at most 10,000 ms. With 12 attempts, even one provisioning failure exceeds 5%. Missing results, a failed smoke, or an incomplete stop/terminal observation leaves the check incomplete. Save the command exit status alongside the JSON artifact.

The command syntax, TypeScript imports, and extracted landing/git-proof functions passed offline checks. Those checks used fabricated fixtures and do not establish live service behavior.

The 12 live attempts exercise deployment-wide pressure but do not expose an independent live in-flight counter. The instrumented workerd test proves the maximum of four; the live run supplies RR3 failure and timing evidence. After a failed or incomplete live check, the lead keeps the feature disabled for release. The command does not deploy, change a cap, start Swarm, delete a repository, or publish the private clone.

## Remaining gates and recovery

- Chromium launch is blocked in this sandbox. Browser interaction and visual inspection remain unverified.
- No live Artifacts provisioning, scoped token clone, throughput, latency, or real billing was measured here.
- The protected Git metadata prevented a commit and merge in this clone. The patch is the delivery artifact.
- Option B cannot take a pool repository across namespaces with the present binding. Keep A selected.
- Keep the switch off when live provisioning failure rate exceeds 5%, ready p90 exceeds 10 seconds,
  or any acceptance check fails. Restoring the switch to false stops new archive activity. It does not
  delete repositories, rewrite existing landing notes, or revoke already minted tokens.
- There is no deletion or retention policy. The lead must account for retained repositories separately.

## Git delivery

- `.tmp-test/attempt-repos.patch` contains the task-owned changes against this clone's HEAD, `9176a2a`.
- `.tmp-test/attempt-repos-on-aea1de7.patch` contains the same feature integrated against fetched main,
  `aea1de7`, including the resolved comments and regenerated rule coverage. Use this second patch when
  the lead's target matches that commit. A newer target still needs integration review.
- Both patches include the new source files, tests, specification amendment, and this handback report.
- No commit, push, merge into main, deployment, or live check was completed in this clone.

`git log --oneline main..HEAD` exited 0 and produced no output. HEAD remains `9176a2a`.

`git status --short` exited 0 and produced:

```text
 M docs/measurements/rules.md
 M docs/spec/01-core.md
 M scripts/ops/secrets-allow.json
 M src/config/features.ts
 M src/config/floor-json.test.ts
 M src/floor/components/about/about.test.ts
 M src/worker/adapters/index.ts
 M src/worker/agent/agent-do.ts
 M src/worker/gate/gate-do.ts
 M src/worker/trunk/trunk-do.ts
 M src/worker/workflows/attempt-repo.ts
 M test/e2e/shell/review-about.spec.ts
 M test/support/git.ts
?? docs/measurements/integration/2026-10-11-attempt-repos.md
?? src/worker/adapters/attempt-repo/
?? src/worker/agent/attempt-repo.test.ts
?? src/worker/agent/attempt-repo.ts
?? src/worker/gate/attempt-repos.ts
?? src/worker/trunk/attempt-repo.test.ts
?? src/worker/trunk/attempt-repo.ts
?? test/workerd/agent/attempt-repos-fake.mjs
?? test/workerd/agent/attempt-repos-harness.ts
?? test/workerd/agent/attempt-repos.test.ts
```

Both delivered patches passed `git apply --check` with exit 0 against clean archived trees of
`9176a2a` and `aea1de7`, respectively. The exact bases, target directories, and results are retained
in `.tmp-test/attempt-repos-evidence/patch-check.json`. Neither application check changed the lead's checkout.
