# Extension: the green line, stage 1 (Slice 14 part 14a)

Branch `feat/green-line`, written 2026-10-10. Stage 2 (part 14b, the isolate self-test and the
take-back) is not started.

## What is built

After every landing push, Trunk's `green` timer verifies the newest landing on `main` with the static
runtime, moves `refs/heads/green` to it when it passes, and tells the stream. Nothing of it runs on
the landing path: a verification never blocks or slows a landing.

- **Engine half** (`src/core/trunk/green.ts`). `batch.pushed` arms the `green` timer (GR1). The
  `green` entry names the next commit (`landed_seq`, GR1a) with its files and the green commit's
  files; one run is in flight, the next starts no earlier than `GREEN_MIN_INTERVAL_MS` after the last
  start, and a run that never answers is abandoned after `GREEN_TIMEOUT_MS + GREEN_MIN_INTERVAL_MS`.
  The `green_done` entry emits `green.verified`; on a pass it sets `green_seq` and `green_commit` and
  emits `green.advanced` and `pool.state` (GR2). A first failure reruns the same commit; the second
  failure is confirmed (GR3). A result for a commit that is not its seq's landing, or older than
  `green_seq`, is discarded (GR4). A result whose checks break GR8 is refused whole. The log is kept
  in `meta.green_last`, redacted and cut to `GREEN_LOG_MAX_CHARS`, and never put in an event (GR7).
- **Static verifier** (`src/worker/adapters/verifier/static.ts`). Three checks in GR8's order:
  `parse`, `imports_resolve`, `policy_invariants`. It reuses Trunk's own analysis (6.2) and policy
  reader (10.1). Only findings that the green commit does not have count (GR5a).
- **Runner** (`src/worker/trunk/wiring/green.ts`). Verifies, then moves `refs/heads/green` with one
  receive-pack request: the ref command and an empty pack, old value `green_commit` or the zero id;
  on a refusal it reads the ref and tries once more with the value it read (GR2a). A run that cannot
  verify or cannot move the ref emits nothing, leaves a `trunk.error` with a fixed code, and is
  retried on the push backoff.
- **Page.** The strip cell and banner 8 already existed. Banner 8 now says "at landing 2" and names
  the failed checks by their labels of 03-floor 5.7 (it said "at 2: policy_invariants"). The About
  diagram no longer says the green line is a Workflow (box 2 names it under Trunk, box 5 names the
  Swarm only).
- **Switch.** `features.green` stays `"none"` in `src/config/features.ts`, as the extensions README
  requires. Every test of the feature turns it on for its own bundle only (`withFeatures`).

## Acceptance

Item 1 of 04-build-plan 2.15, plus unit tests per rule. All results below are from this branch after
`git merge origin/main` (main at `74cbbf5`).

| Item | Test | Result |
| --- | --- | --- |
| 2.15 item 1: after a landing, `git ls-remote` shows `refs/heads/green` at the head; the stream has `green.verified` with `runtime: "static"` and `green.advanced` | `test/integration/green/acceptance.test.ts` › "GR1, GR2, GR2a, GR5: after a landing, git ls-remote shows refs/heads/green at the head commit" (local workerd, real `git http-backend`, stock `git ls-remote`, `git fsck --strict`) | passed |
| A confirmed red: two `green.verified` (`confirmed` false, then true), no `green.advanced`, the ref stays, no revert (GR3, GR3b) | same file › "GR3, GR3b, GR5a: a landing that breaks the policy file fails twice and leaves the ref" | passed |
| 2.15 item 1: the strip says "static checks only" | `test/e2e/shell/green-static.spec.ts` › "2.15 item 1: after green.advanced the strip says static checks only" (port 4401) | passed |
| The page during a rerun and after a confirmed red | same file › "GR3: …checking again…" and "GR3b: …banner 8's first sentence only" | passed |
| GR1, GR1a, GR2, GR3, GR3b, GR4, GR5, GR7, GR8 in the engine | `src/core/trunk/green.test.ts`, 11 tests | passed |
| GR5a, GR7, GR8 in the verifier | `test/integration/green/static.test.ts`, 10 tests | passed |

Command for the acceptance (it starts the built Worker, so build first):

```bash
npm run build && npm run test:integration -- green
```

## Every suite

| Command | Result |
| --- | --- |
| `npm run check` | exit 0: 217 files, 2,622 passed, 1 expected failure |
| `npm run test:workerd` | 248 passed, 1 failed, 3 skipped, in each of two runs; each failure is a timing flake (below) |
| `npm run test:cases` and `CASES=required npm run test:cases` | 106 passed each |
| `npx vitest run --project integration` | 728 passed (716 before plus 12 new) |
| `PREMISE_E2E_PORT=4401 npm run test:e2e` | 357 passed (354 before plus 3 new) |
| `npm run check:submission` | exit 0 |
| `node scripts/ops/rules-coverage.ts` | 303 required ids, 0 uncovered; every GR rule I built is in a test title |
| `npm run check:lane -- git feat/green-line` | exit 1, expected: the feature crosses lanes (README rule 1); the files are listed below |

Flakes. Each full workerd run had one timing failure while other builder sessions ran their suites on
this Mac, a different test each time. Both bundles run with the green line off. Each file passed
twice in a row when run alone:

- `test/workerd/landing/push-table.test.ts` › "row old,old → repush" (first run).
- `test/workerd/undo/routes.test.ts` › "FJ1: both owner undo routes answer 404 feature_off and change
  nothing" (second run): the seed's own `plain.updated` arrived between the test's two snapshots of
  the stream. The test assumes the plain-merge timer has finished; it is a pre-existing race.

The baseline also had one load flake (`scale/session-hit-rate`, a socket closed); it passed in the
final integration run.

## Live checks the lead must run

1. Set `green: "static"` in `src/config/features.ts`. Run `npm run check:submission`: line 7 of the
   limits list changes, so the README's list must follow `limitsList(FEATURES)`.
2. `npm run deploy:test`. Create a pool from `tidepool` and land one change.
3. Check that `git ls-remote <pool remote> refs/heads/green` prints the head commit of `main`, the same
   way `refs/heads/main` was checked for Slice 1. The Floor's strip should read
   "landing N · static checks only".

Cost: no model call. One verification is one Durable Object alarm, a few milliseconds of parsing,
and one receive-pack request to Artifacts per landing (at most one every 2 seconds). It is not
measurable against the spend cap.

What only the live check can show: that real Artifacts accepts a receive-pack request whose pack has
no objects (the local `git http-backend` does).

## Choices where the specification was silent

Each is written into `docs/spec/01-core.md` 11.5, marked "added 2026-10-10":

- **GR5a.** What the static checks judge, where the files come from (Trunk's own record of the
  landing, not Artifacts reads), and that only findings new since the green commit count. Without
  that rule an imported repository with one file our parser cannot read would be red forever.
  `policy_invariants` covers a missing or invalid policy file and CK6's globals (not for imported
  pools, as CK6 itself skips them).
- **GR1a.** "Head" is `landed_seq`, the newest landing confirmed on `main`, because the green ref can
  only point at a commit the remote holds. Reruns also wait the interval. An abandoned run restarts.
  A run with no verdict emits nothing. A confirmed red commit is not verified again.
- **GR2a.** How the ref moves: one ref command with an empty pack, and one retry with the value read
  when the remote holds a different one.
- **GR3b.** Part 14a runs GR3's second run but queues no revert; banner 8 shows only its first
  sentence until a later verification passes.
- **The runner is Trunk's timer, not the `GreenLineWorkflow`.** GR2 makes Trunk the only token
  holder, 01-core 3.3 already lists a `green` timer, and the plain-merge pool runs the same way. The
  `GreenLineWorkflow` class stays a stub because `wrangler.jsonc` names it; the lead may remove the
  `GREEN` binding later. 03-floor 5.12 is amended to match.

## Files outside the paths the feature file names

Small edits, each needed to connect the feature:

- `src/core/trunk/tick.ts`: one call to `armGreen` in `pushOk`.
- `src/core/trunk/registry.ts`, `src/core/trunk/sets.ts`, `src/worker/trunk/engine-session.ts`: the
  pool learns `features.green`, and the `green` and `green_done` entries.
- `src/worker/trunk/alarm.ts`, `src/worker/trunk/trunk-do.ts`: the `green` timer's handler.
- `test/arch/seams.test.ts`: the engine table's entry list gains `green` and `green_done`.
- `src/floor/state/derive.ts` and its test: banner 8's wording (the test expected the raw name).
- `test/e2e/shell/green-static.spec.ts` (new), `src/copy/tables.test.ts`, `src/copy/strings.ts`,
  `docs/spec/03-floor.md` 5.12: the strip proof and the About diagram.
- `scripts/ops/secrets-allow.json`: the made-up token of the GR7 redaction test.

## Not done

- Stage 2 (part 14b): the Dynamic Worker isolate through `LOADER`, the revert of GR3, GR6, items 2
  to 4 of 2.15.
- No owner-facing view of the stored log (GR7 says it is shown to the owner; nothing on the page
  reads `meta.green_last` yet).
- The `"full"` value of `features.green` arms nothing in this build: setting it would show the green
  cell but never verify. Only `"static"` is ready.
