# Extension: Clef, the AI judge

Branch `feat/clef`. Browser port `4402`. Read `README.md` in this folder first.

## What it is

Where an agent read something that changed but its patch does not use it, Trunk today answers with a
blanket `confirm`. Clef gives a recorded probability instead, and a held card shows three risk answers.
The model is `@cf/cloudflare/clef` on Workers AI, with `@cf/cloudflare/clef-flash` as the fallback.
Today `features.clef` is false, the three switches `CLEF_TRIAGE`, `CLEF_RISK`, `CLEF_CONTRADICTION` are
`off`, and `src/worker/adapters/triage/**` and `adapters/risk/**` do not exist.

## The specification

`docs/spec/01-core.md` 7.3 (TR1 to TR9), S6 and S6a (the two ports), V7, V7a, 10.4 (RK1 to RK4), GL4
(only for `CLEF_CONTRADICTION`); `docs/spec/03-floor.md` row FR18 and the risk lines of 5.10;
`docs/spec/04-build-plan.md` 2.16 (Slice 15) with its four acceptance items; risk RR7.

## Stages

**Stage 1 (must).** `ClefTriage`, the asynchronous `Triage`, and the risk judge, as adapters over the
`AI` binding; `src/worker/trunk/triage-runner.ts`; the risk lines on the held sheet. Acceptance: item 1
(the cases `C06`, `C07`, `C12`, `C31`, `C38`, `C42`, `C52`, `C55` still pass with no Clef call) and
item 3 (workerd with a fake `AI` binding: TR1, TR2, JE1, TR4, TR7, TR8 each with a test). Hand back
after this stage.

**Stage 2.** `npm run calibrate:clef` (`scripts/calibrate/**`, replacing the not-built placeholder in
`package.json`, which this file allows): the labelled set of at least 48 cases (the `triage` vectors
plus at least 40 more, with QR4 cases and cases from the real runs in
`docs/measurements/models/*.events.jsonl`), run through the same adapters, writing the confusion table,
the thresholds, `CLEF_MAX_QUESTIONS`, `CLEF_INPUT_TOKEN_LIMIT` and the latency of `clef` and
`clef-flash` under `docs/measurements/calibration/`. Build it with an injectable model client and test
it offline; the lead runs it live, because it calls Workers AI and spends the owner's budget.

## Paths

`src/core/trunk/triage.ts`, `src/worker/trunk/triage-runner.ts`, `src/worker/adapters/triage/**`,
`src/worker/adapters/risk/**`, `src/worker/adapters/index.ts` and the trunk wiring for the two ports,
`scripts/calibrate/**`, `docs/measurements/calibration/**`, `test/workerd/triage/**`,
`src/floor/components/risk/**`, the held sheet's risk block in `src/floor/components/card-sheet/**`,
and the shared files of `README.md`'s list. Propose the values for `wrangler.jsonc` in your report; the
lead sets them.

## The lead's live checks

`npm run calibrate:clef` against Workers AI (about 50 to 100 model calls), then RR7's rule decides
whether the switches go on: any truly dependent case judged `holds`, fewer than half of the independent
cases judged `holds`, or p95 latency above `CLEF_TIMEOUT_MS` keeps Clef off.
