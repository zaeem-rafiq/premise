# Artifacts spike harness

Throwaway measurement harness. It answers one question with real numbers:
can code running inside a Durable Object create commits and push them to a
Cloudflare Artifacts repo quickly and reliably?

It is a Cloudflare Worker with one SQLite-backed Durable Object (`SpikeDO`).
The Durable Object does all the git work. Each experiment is one POST route
that returns JSON.

Nothing here has been deployed. The local checks at the end of this file need
no Cloudflare access.

## What each experiment answers

| Route | Question |
| --- | --- |
| `POST /run/e1-create-push` | Can the Durable Object create a repo, build a three-file commit in memory (isomorphic-git) and push it with the token `create()` returns? Does Basic auth work? Does Bearer auth work? How long does `create()` take until the repo is ready? |
| `POST /run/e2-minted-token` | Does a token from `createToken("write", 3600)` on the existing e1 repo work for a push from inside the Durable Object? This reproduces or clears workers-sdk issue 15429 (HTTP 403). It tries Bearer and Basic, probes every token with plain `GET info/refs` requests, waits up to 30 s (polling both auth styles) to see whether a refused token starts working, fetches with a read token, and checks that a read token cannot push. If no minted-token push lands, it pushes the same commits with the `create()` token as a control. With `{"outside_control": true}` it also answers: is a minted token refused only inside Workers, refused everywhere, or just not valid yet? See "Control from outside Workers". |
| `POST /run/e3-compare-and-swap` | Does the server reject an update whose old object id is stale? Two in-memory clones start at the same head. A pushes. Stale B pushes without force, then with force. Raw requests then send a wrong old id straight to the server, because isomorphic-git refuses a stale push on the client and never asks the server. Each raw probe is a fast-forward and has a control; see "How e3 and e8 test the old id". Also: is a force push allowed, can a branch be deleted, and can the default branch be deleted? |
| `POST /run/e4-refs` | Which ref namespaces can be pushed: `refs/notes/premise`, `refs/heads/green`, `refs/session/log`, a tag, `refs/agents/a1/head`? Can each be read back through the binding (`log({ref})`, `readFile({ref, path})`) and by fetch? Which refs does the server list? A push that fails with a transient status is retried up to three times. |
| `POST /run/e5-fork` | How long do N concurrent forks of the e1 repo take to become ready, and how many fail? Does `fork()` return a usable token? One commit is pushed to one fork. Each fork is compared with the source repo's current head, which e5 reads at the start. Body: `{"n": 10}` (max 50). |
| `POST /run/e6-read-by-ref` | How fast are `readFile`, `readTree`, `log`, `readCommit`, `readBlob` and `info`? After a push, how soon do `log` and `readFile` show the new head, and are there stale reads? Body: `{"reps": 5, "rounds": 5}`. |
| `POST /run/e7-soak` | Latency (p50, p95, max) and failures of K sequential commit+push cycles from one warm in-memory repo held by the Durable Object. Each failure is reported with its iteration number. Body: `{"k": 100}` (max 500). |
| `POST /run/e8-raw-pack` | Can a push be done without isomorphic-git, with a hand-built packfile and pkt-line commands? Single-ref update first. Then ONE request that updates `refs/heads/<default>` and `refs/notes/premise`, with the server's status for each ref. Then requests where one command has a wrong old id, to see whether the other command is still applied (atomicity), with and without the `atomic` capability. Then a control: the same kind of update with the correct old id. Last, a new branch that points at a commit the server already has, sent with an empty pack (the request the git CLI sends when no new objects are needed). |
| `POST /run/e9-workers-ai` | Can Workers AI models run a small tool-calling loop (tools `read_file` and `replace_in_file`; task: change a constant and one call site)? Latency per call, number of turns, and whether the final files are correct. Body: `{"models": ["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-5.3-flash"]}`. |
| `POST /run/cleanup` | Deletes every repo in the namespace whose name starts with `spike-`. Body `{"dry_run": true}` only lists them. |

`GET /` lists the experiment ids.

e2 and e5 use the repo that e1 created, so run e1 first. The other experiments
create their own repos. Every repo is named `spike-<experiment>-<random>` in the
Artifacts namespace `spike`.

## Result format

```json
{
  "experiment": "e3-compare-and-swap",
  "ok": true,
  "observations": ["plain-language notes, with exact server messages"],
  "timings_ms": { "create_call_ms": 120, "total_ms": 2300 },
  "http": [{ "step": "A-push POST /git-receive-pack", "status": 200, "ms": 180 }],
  "error": "only present when the experiment stopped early",
  "data": { "verdict": { "server_enforces_old_id": true } }
}
```

- `ok` means the experiment ran to the end and the capability it tests worked.
  e3 is the exception: its `ok` means the stale-old-id probe gave a clear answer,
  whichever way. The answer itself is in `data.verdict.server_enforces_old_id`.
- `data.verdict` holds the short answers. Read it first.
- `http` lists every git HTTP request with its exact status. Requests sent in a
  loop are listed as totals, one row per step and status, with `count` requests
  and their summed `ms`: the e7 soak cycles, the e2 token polls
  (`poll-minted-write:<style>`) and the e5 fork-token probes
  (`fork-token-probe:<style>`).
- Tokens never appear in a result. They are replaced with `<redacted-token>`.
  The one exception is the `disclosed` block that e2 returns when the request
  asks for it with `{"outside_control": true}`.
- The account label in an Artifacts remote URL is replaced with `<account>`.
- The Worker never returns a thrown error. A failure is a JSON result with
  `ok: false`.
- A verdict can be the text `inconclusive (...)` instead of true or false. It
  means the probe could not separate the tested cause from another one. The text
  says why.
- A true or false verdict about the server needs the server's own answer. A
  request that failed (no answer, HTTP 5xx, 429 or 408) is never counted as a
  refusal. Its verdict is `inconclusive (...)`. Run the experiment again.
- `ref_read_lagged_behind_push` (e3, e8) is true when the server reported "ok"
  for an update and the next read of the refs did not show it yet. The harness
  then reads the refs up to three more times, 300 ms apart.

### How e3 and e8 test the old id

A server can refuse an update for two different reasons: the old id in the
command is wrong, or the new commit is not a fast-forward. A probe that is both
at once cannot tell them apart. A request that fails (HTTP 503, a timeout) also
leaves the ref unchanged, exactly like a refusal. So:

1. Each probe sends a new commit that is a child of the ref's current value.
   The update is a fast-forward. Only its old id is wrong (stale, or zero).
2. If the ref moved to the probe's commit, the server does not check the old id.
   The verdict is false.
3. The verdict is true only when all of these hold: the server answered HTTP 200
   with a report-status `ng` line for the ref, the ref did not move, and the same
   update with the correct old id (the control) was then applied. The server's
   own reason is in `stale_old_id_refusal_reason` (e3) or
   `wrong_old_id_refusal_reason` (e8).
4. Everything else is `inconclusive (...)`: the probe got no `ng` (for example
   HTTP 503), the control was refused too, the refs could not be read, or the
   server reported "ok" but the refs do not show the change.

e8 also checks its precondition. Its second ref must exist at a known value
before the wrong-old-id command is sent. If the server refused
`refs/notes/premise`, e8 creates the branch `refs/heads/e8-probe` and uses that.
`wrong_old_id_probe_ref` names the ref that was used.

The e8 atomicity verdicts (`one_bad_command_fails_both_...`) follow the same
rule. A boolean needs HTTP 200, a report-status line for both refs, and refs
that agree with those lines.

The "allowed" verdicts of e3 (`force_push_allowed`, `branch_delete_allowed`,
`default_branch_delete_allowed`) are true when the change is visible in the
refs, false when the server said no (report-status `ng` or an HTTP 4xx) and the
refs confirm that nothing changed, and `inconclusive (...)` when the request or
the read-back failed. The force push and the creation of the temporary branch
are retried on a transient status; a delete is sent once.

`push_accepted` of e4 is true for a ref when the server reported "ok", or when
no answer came back but the server then advertises the ref at the pushed commit.
It is false when the server said no (report-status `ng` or an HTTP 4xx). It is
`inconclusive (...)` when the push still got no decision after three retries.

### How to read the e2 verdict

- `minted_write_token_refused_on` lists where the minted write token got 401 or
  403: `GET info/refs`, `POST git-receive-pack`, `POST git-upload-pack`. Every
  such request is in `data.minted_write_token_refusals`.
- `minted_write_token_got_403` is true when any of them was a 403.
- `bug_15429_reproduced` is true when no minted-token push landed, the minted
  write token was refused on at least one request, and the `create()` token
  still works (`create_token_still_accepted`, `create_token_control_push`).

### How to read the timings

- A Worker's clock only moves forward at I/O. A span with no network call reads
  as 0 ms. All timings therefore measure network round trips, plus the CPU time
  spent just before them.
- "Ready" times come from polling, so each one is a range. The true time lies
  between the lower bound (the last poll that found the repo not ready) and the
  reported time (the first poll that succeeded): `create_to_ready_lower_bound_ms`
  to `create_to_ready_ms`, and for each fork `ready_lower_bound_ms` to `ready_ms`.
  The gap between two polls is at most 10% of the time already waited, at least
  50 ms and at most 500 ms. With many forks the minimum grows by 5 ms per fork,
  to stay under 2,000 control-plane requests per 10 seconds.
- e7 uses a small repo. isomorphic-git walks the whole tree on each push, so
  larger repos cost more CPU. Pass `{"seed_files": 500}` to e7 to measure that.
- isomorphic-git makes two requests per push: `GET info/refs`, then
  `POST git-receive-pack`. e7 reports both. e8 shows the cost of the POST alone.
- A long soak is one long HTTP request. If the connection is cut before the
  result arrives, run it in parts: call e7 with `{"k": 100}`, then again with
  `{"k": 100, "reuse": true}`. The second call continues on the same warm repo
  as long as the Durable Object instance is still alive.

## Deploy and run

These steps create resources on Cloudflare. They have not been run. The account
needs the Workers Paid plan with Artifacts enabled.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a key and a secrets file. The key is never printed:

   ```sh
   export SPIKE_KEY="$(openssl rand -hex 32)"
   (umask 077 && printf 'SPIKE_KEY=%s\n' "$SPIKE_KEY" > spike.secrets.env)
   ```

3. Deploy. `wrangler.jsonc` lists `SPIKE_KEY` under `secrets.required`, so the
   first deploy must pass the secrets file:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy --secrets-file spike.secrets.env
   rm spike.secrets.env
   ```

   Wrangler prints the `workers.dev` URL.

4. Run the experiments in the same shell (it still has `SPIKE_KEY`):

   ```sh
   ./run-spikes.sh https://artifacts-spike.<subdomain>.workers.dev
   ```

   The script calls e1 to e9 in order, saves each response under
   `results/<UTC timestamp>/<experiment>.json`, and prints one line per
   experiment. It exits 0 only when every experiment reports `ok: true`.

   Options:

   ```sh
   E5_N=25 E7_K=300 ./run-spikes.sh <url>            # bigger fork fan-out and soak
   ./run-spikes.sh <url> e3-compare-and-swap e8-raw-pack   # only these
   E9_MODELS='["@cf/zai-org/glm-5.3"]' ./run-spikes.sh <url> e9-workers-ai
   E2_OUTSIDE_CONTROL=1 ./run-spikes.sh <url> e1-create-push e2-minted-token
   ```

   To call one route by hand with other body options:

   ```sh
   printf 'header = "x-spike-key: %s"\n' "$SPIKE_KEY" | curl --config - \
     --request POST --header 'content-type: application/json' \
     --data '{"k": 50, "seed_files": 500}' <url>/run/e7-soak
   ```

### Control from outside Workers

Issue 15429 says a minted token got 403 from inside a Worker, while the same
token worked from a laptop. e2 alone cannot see that difference, because every
request it makes comes from inside the Durable Object. This control can:

```sh
E2_OUTSIDE_CONTROL=1 ./run-spikes.sh <url> e1-create-push e2-minted-token
```

One token is probed three times: inside, outside, inside again.

1. At its end, e2 mints one more token on the e1 repo: read scope, 60 seconds
   (the shortest lifetime the service allows).
2. Round 1, inside: e2 sends `GET info/refs` and one `POST git-upload-pack` (a
   fetch of the branch tip) with that token from inside the Durable Object.
   Each request goes out with Bearer and with Basic auth, with no User-Agent set
   and with `User-Agent: git/2.50.1`. That is 8 requests.
3. e2 returns the token under `disclosed` and keeps it in the Durable Object's
   memory. `run-spikes.sh` passes the saved file to `outside-probe.mjs`, which
   removes the token from the file first.
4. Round 2, outside: `outside-probe.mjs` sends the same 8 requests from this
   machine with curl.
5. Round 3, inside again: `outside-probe.mjs` calls e2 with
   `{"outside_control_recheck": true}`. e2 sends the 8 requests once more with
   the token it kept, then drops the token.
6. The script adds `outside_probe` to the saved file and prints two lines.

Round 3 is what makes the comparison fair. Round 2 is always later than round 1.
A new token that needs a moment to become valid is therefore also "refused
inside, accepted outside". That delay is plausible: the fact-check found that
the REST API reference describes token ids as "resolved through an eventually
consistent index" (about one second), and that tokens are tracked in KV.

How to read `outside_probe.minted_token_refused_only_inside_workers`:

- `true`: at least one request was refused (401 or 403) inside in round 1,
  accepted outside in round 2, and still refused inside in round 3. The refusal
  depends on where the request comes from. `conclusion` names the requests.
  The verdict does not say why. A token index that reaches the Durable Object's
  location later than the operator's location gives the same three statuses.
  The 30-second poll in e2 (`needed_token_propagation_wait`,
  `bug_15429_reproduced`) shows whether a refusal inside lasts.
- `false`: either every round gave the same status, or the token was refused in
  round 1 and accepted in rounds 2 and 3. The second case means a new token
  needs time to become valid. `conclusion` says which case it is.
- `"inconclusive"`: a request got no answer, the token expired during the
  rounds (round 3 must end at least 2 seconds before the expiry), or round 3
  could not run (`inside_recheck.reason` says why). A token
  that was refused in round 1 and accepted in round 2 is never reported as
  `true` without round 3.

`outside_probe.pairs` lists every request with `inside_status_before`,
`outside_status` and `inside_status_after`. The age of the token at each inside
request is in `data.outside_control.inside_durable_object[].ms_after_mint`.

The token is never printed. It reaches curl on stdin. After the run it is in no
file. It stays in the Durable Object's memory until round 3 or `cleanup`, and it
expires 60 seconds after it was minted.

`E2_OUTSIDE_CONTROL=write` does the same with a write token and
`git-receive-pack`. Its POST is a push with no commands (a lone flush-pkt),
which cannot change the repo. Use it when the read token is accepted inside but
the write token is not.

Do not call e2 with `{"outside_control": true}` by hand unless you send the
output to a file. The response contains a live token for up to 60 seconds.
To run the three rounds by hand:

```sh
node outside-probe.mjs <saved e2 result file> <url>   # needs SPIKE_KEY in the environment
```

A weaker manual check needs no harness support: mint a token with
`npx wrangler artifacts repos issue-token <repo> --namespace spike --scope read --ttl 60`
and run `git ls-remote` with it. That token is minted through the REST API, not
through `createToken()` on the binding, so it does not test the same thing.

### Limits

- The request body can be at most 16 KiB. A larger body gets HTTP 413 and
  nothing runs.
- e9 runs at most 6 models per request. e4 uses at most 20 `extra_refs`.
- One experiment runs at a time. A request that arrives while another experiment
  is running gets `ok: false` with an error that starts with `busy:`. Send it
  again when the first one has finished.
- When `deadline_ms` passes, the experiment is cancelled. Pending git requests
  are aborted and it starts no new request. The response says whether it has
  stopped. This matters because, with compatibility date 2026-10-01, pending
  I/O keeps a Durable Object running without a connected client.
- To stop an experiment before its deadline, deploy the Worker again. That
  restarts the Durable Object.

Body options (all optional):

| Experiment | Options |
| --- | --- |
| every experiment | `deadline_ms` (default 600000): cancel the run and return what was recorded so far if it takes longer |
| e2 | `token_wait_ms` (default 30000): how long to poll a refused minted token; `outside_control` (`true` or `"write"`) and `outside_control_recheck: true`: see "Control from outside Workers" |
| e4 | `extra_refs`: at most 20 more ref names to try, for example `["refs/pull/1/head"]` |
| e5 | `n` (default 10, max 50); `default_branch_only` (default true) |
| e6 | `reps` (default 5); `rounds` (default 5) |
| e7 | `k` (default 100, max 500); `seed_files` (default 3, max 2000); `auth` (`"basic"` or `"bearer"`); `reuse: true` keeps using the warm repo from the previous call; `budget_ms` (default 480000) |
| e8 | `auth`; `lf: true` ends each command with a newline; `try_unadvertised_atomic: false` skips the atomic probe when the server does not advertise `atomic` |
| e9 | `models` (at most 6); `max_turns` (default 8, max 20); `max_tokens` (default 2048); `reasoning_effort` (default `"low"`, `null` to omit) |
| cleanup | `dry_run: true` |

Auth is fail-closed. Every route needs the header `x-spike-key` with the value
of the `SPIKE_KEY` secret. A wrong or missing header gets 401. If the secret is
missing or shorter than 16 characters, every request gets 503.

## Clean up

1. Delete the repos:

   ```sh
   ./run-spikes.sh <url> cleanup
   ```

   The summary line shows how many repos matched and how many were deleted.

2. Delete the Worker, its Durable Object storage (which holds the e1 repo's
   token) and its secret:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler delete
   ```

Artifacts billing starts on 2026-10-14. Repos that are left in place cost
storage after that date.

## Local checks (no Cloudflare access)

```sh
npm install
npx wrangler types          # regenerates worker-configuration.d.ts
npx tsc --noEmit            # typecheck
npx vitest run              # all local tests
npx wrangler deploy --dry-run --outdir dist   # bundle only, nothing is uploaded
```

What the local tests prove:

- `test/rawgit.pack.test.ts`: the hand-built blob, tree and commit ids equal the
  ids real git computes, and the hand-built pack passes `git index-pack --strict`,
  `git verify-pack` and `git fsck --strict`.
- `test/pktline.test.ts`: pkt-line encoding, the receive-pack request body and
  the two response parsers, against the examples in the git protocol documents.
- `test/receive-pack.e2e.test.ts`: the raw push path against real git. A local
  Node server runs `git http-backend` as CGI with receive-pack enabled. It covers
  single-ref and two-ref pushes, a stale old id, the `atomic` capability, branch
  deletion, and a new ref at an existing commit (empty pack).
- `test/decisions.test.ts`: the rules that turn a push outcome into true, false
  or `inconclusive`.
- `test/experiments.local.test.ts`: every experiment, run against a fake
  Artifacts binding whose repos are real bare git repos behind that server.
- `test/experiments.scenarios.test.ts`: servers that do not behave like plain
  git, each with one known property (a git config value, a hook, or a small
  proxy). Examples: a server that ignores old ids but refuses non-fast-forwards;
  one HTTP 503 on a single probe request; one ref read that lags behind a push;
  a server that refuses minted tokens only on POST; a server that refuses
  `refs/notes/*`; a token that is accepted only after a delay. It also covers
  cancellation at the deadline, the one-experiment-at-a-time lock, and the
  bounds on "ready" times.
- `test/outside-control.test.ts`: the three rounds of the e2 outside control,
  end to end with the real `outside-probe.mjs`. One world delays every new
  token for every caller (verdict false). Two worlds refuse a minted token for
  one kind of caller only, on every request or on POST only (verdict true).
- `test/router-and-runner.test.ts`: fail-closed auth on every route, the body
  size limit, `run-spikes.sh` end to end against the real request handler on
  localhost, and each verdict of `outside-probe.mjs` against the local git
  server.
- `test/independent-checks.test.ts`: checks taken from the independent checker.
  What e2, e3 and e8 really put on the wire (a recording proxy), that nothing is
  logged and no key or token comes back through the real entry point, and that
  cleanup deletes only names that start with `spike-`.
- `test/bundle.smoke.test.ts`: builds the bundle with `wrangler deploy --dry-run`
  and runs e1 to e8 and cleanup through its real entry point (fetch handler,
  then the `SpikeDO` class) on Node.
- `test/auth-and-redaction.test.ts`: key check, token redaction, in-memory
  filesystem error codes.

Optional check on the real Workers runtime (local workerd through the Miniflare
API, offline, not part of `npx vitest run`):

```sh
npm run check:workerd
```

The script builds the bundle with `wrangler deploy --dry-run` and then runs
`checks/workerd.check.test.ts`. `miniflare` is a devDependency, pinned to the
version that wrangler 4.147.0 uses. `npx tsc --noEmit` typechecks `checks/` too.

It covers the one-experiment-at-a-time lock, cancellation at the deadline, the
body size limit, and the e2 outside control, including the second inside probe
with the token kept in the Durable Object's memory. It also shows that `fetch()`
on workerd sends no User-Agent header unless the code sets one.

What they do not prove:

- Nothing here says how the real Artifacts service or Workers AI behaves. That
  is what the experiments are for.
- `npx vitest run` runs the bundle on Node, not on the Workers runtime.
  `wrangler dev` was not used because it talks to the real Artifacts service.
  The optional check above runs the bundle on local workerd, with a fake
  binding. Local workerd is not the production edge.
- Local tests cannot place a request "inside Workers". The outside-control
  tests use a stand-in: the experiment code calls Node's `fetch`, which sends a
  `sec-fetch-mode` header, and `outside-probe.mjs` calls curl, which does not.
- The POST probe of the outside control with a write token is a push with no
  commands. Real git answers HTTP 200. The answer of Artifacts is not known. A
  status other than 200, 401 or 403 gives "inconclusive" or "same status".
- e8 measures whether the server accepts an empty pack. Local tests only show
  that real git does.
- Local tests cannot show whether the real service treats requests differently
  by User-Agent. Neither git path sets one: isomorphic-git 1.43.0 puts its name
  in the pkt-line `agent=` capability, not in an HTTP header. The outside
  control sends each request with and without a git User-Agent to measure it.

## Files

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry point and the `SpikeDO` Durable Object |
| `src/router.ts`, `src/auth.ts` | Routes and the fail-closed key check |
| `src/experiments/` | One file per experiment, `common.ts` for shared helpers, `index.ts` for the runner |
| `src/gitops.ts` | isomorphic-git helpers and raw smart-HTTP requests, with request recording |
| `src/rawgit.ts` | Pure module: git objects, packfile, pkt-line, receive-pack request and response |
| `src/memory-fs.ts` | In-memory filesystem for isomorphic-git |
| `src/recorder.ts` | Result shape, timings, token redaction |
| `run-spikes.sh` | Calls the experiments with curl and saves the results |
| `outside-probe.mjs` | Removes the e2 outside-control token from the saved file, sends its requests from this machine, asks e2 for the second inside probe, and writes the verdict |
| `test/` | Local tests and helpers (local git HTTP server, fake Artifacts binding, proxy, the request handler behind a local HTTP server) |
| `checks/` | Optional check of the bundle on local workerd |
| `.check/` | Scratch files of the independent checker; not part of the harness |
