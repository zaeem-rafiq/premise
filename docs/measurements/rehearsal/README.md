# Hero rehearsal

The lead runs this command against an authorized deployment, from the checkout used to build it:

```sh
mkdir -p .tmp-test
TMPDIR="$PWD/.tmp-test" npm run rehearse:hero -- --runs 20
```

Set `PREMISE_URL` to the deployment's HTTP(S) origin and `PREMISE_OWNER_KEY` through the shell environment first. The installed Playwright package needs its Chromium browser available. The runner checks for Chromium before creating a pool. It never installs a browser, deploys, clones a remote, or invokes Cloudflare tooling. The owner key reaches owner HTTP routes only, in the Authorization header. Browser processes receive an environment allowlist without that key.

Each run creates a fresh, non-summary-only `tidepool` pool through `POST /api/pools`. It follows the shared soak stream reader and drives the existing hero conductor through Swarm start/hold/release requests and held-card Land requests. Returned attempt ids bind the cast to the stream. A stale card response refreshes the card and its submit echo before retrying.

The browser adapter mounts Compare's two sandboxed live frames in a minimal same-origin parent. It supplies actual frame statistics and the final self-test probe to the conductor. It does not exercise the Floor's Compare controls. Order 2 has no browser rows in the existing conductor. Both orders wait for all four landings and `plain.updated` through sequence 4.

The owner Replay export recovers events hidden by reconnect snapshots and supplies event sequence numbers for measurement. Immutable public pool-file routes read the three relevant files at the recorded main/plain commits. The runner reuses `httpService` from the existing model measurement for these reads: soak's git tree walk is private and is not copied. AST inspection checks the numeric expressions, excluding comments and quoted source. No downloaded pool code runs in Node. A final Replay read after the file reads and browser teardown rejects a moved main/plain head and includes any late heads-up.

`hero-20.json` is written after each completed or failed run, replacing the previous checkpoint. It contains local `git rev-parse HEAD` as `build`, the deployment's host only, the UTC start date, per-run duration, conductor completion, expected heads-up rule and event positions, landing order, commit/tree ids, extracted numeric values, plain skipped/interrupted sequences, J's heads-up count, fixed failure stage, and totals. The deployment does not expose its build commit; run from the matching checkout. No live measurement file is checked in by the offline tests.

Defaults and decisions:

- Runs are sequential, alternating order 1 then 2. `--runs` accepts 1–20; `--order 1|2` fixes the order for diagnostics. M4 and exit 0 require exactly 20 passes, 10 per order. A passing diagnostic run still exits 1 because it does not establish M4.
- The canned configuration uses seed 7, zero think delay, rate 1, collision dial 0 and rescale interval 0. SWR2 ignores the rate/dial/rescale fields when patterns are named. Four scripted agents launch per pool.
- Order 1 requires E2 repair heads-ups for both C and H before their landings. Order 2 requires the QR1 repair heads-up for S before its landing. Precedence uses stream `n`, not timestamps from different sources. J must receive no heads-up of any kind.
- Main must hold `ENERGY_MAX = 1`, `crab.energy < 0.3`, and `drain(shrimp, 0.05)`. Plain must hold `1`, `30`, and `5` respectively. `plain.updated.skipped` must be empty. Interrupted changes are recorded without failing: section 7.11 permits them in order 1.
- Each run has a 10-minute deadline, a 500 ms stream/reconnect poll, a 60-second browser-statistics wait, and a separate 5-second teardown bound. Failures are recorded and later runs continue. HTTP bodies and exception messages never enter reports.
- Successful default execution creates 20 pools, 40 main/plain repositories and 80 scripted agents. It makes no model calls. Cloudflare execution, Artifacts operations/storage and browser CPU still cost resources; no dollar estimate has been measured. Pools remain for inspection. A failed run can leave held attempts or partially created resources; the runner does not delete them.

Offline checks:

```sh
TMPDIR="$PWD/.tmp-test" npx vitest run scripts/rehearse
TMPDIR="$PWD/.tmp-test" npm run check
```

The tests inject HTTP, streams, git/build identity, browser frames, clock, output and logging. Browser adapter tests use fake transports and execute its parent-page listener against a mock browser environment. These checks do not establish live M4 or real Chromium execution.
