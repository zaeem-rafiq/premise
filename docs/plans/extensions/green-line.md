# Extension: the green line

Branch `feat/green-line`. Browser port `4401`. Read `README.md` in this folder first.

## What it is

`refs/heads/green` follows the newest commit of `main` that passed verification after it landed. A
confirmed failure takes the breaking landing back and reopens its agents. Today the switch
`features.green` is `"none"` and `src/worker/workflows/green-line.ts` is a 10-line placeholder.

## The specification

`docs/spec/01-core.md` 11.5 (GR1 to GR8) and S4 (S4a to S4c, the verification runtime);
`docs/spec/02-tidepool.md` 5.4 (the self-test); `docs/spec/03-floor.md` row FR19, the green cell of
the strip, banner 8 (`banner.green_red`) and the revert heads-ups; `docs/spec/04-build-plan.md` 2.15
(Slice 14) with its four acceptance items; risk RR4.

## Stages

**Stage 1, part 14a (must).** Runtime `static`: after each landing the head is verified by the static
checks of GR5, `refs/heads/green` advances (GR1, GR2, GR4), the stream carries `green.verified` with
`runtime: "static"` and `green.advanced`, and the strip says "static checks only".
`features.green` becomes `"static"`. Acceptance: item 1 of 2.15 (`npm run test:integration -- green`
with `git ls-remote` showing `refs/heads/green` at head), plus unit tests per GR rule. Hand back after
this stage.

**Stage 2, part 14b (only after stage 1 is handed back).** The Dynamic Worker isolate through the
`LOADER` binding (S4a to S4c) runs the pool's self-test; a failure confirmed by a second run takes the
landing back as a landing of kind `revert` and reopens the attempts (GR3); the verifier has no binding
and no outbound network (GR6); checks carry only the names and codes of GR8 (GR7). Acceptance: items 2
and 3 of 2.15. Its first task is a local workerd spike that loads a pool commit into an isolate. If
that spike fails within two hours, stop at stage 1 and report. Item 4 (50 live verifications,
`GREEN_CPU_MS`, BP8) is the lead's live measurement: build the script, the lead runs it.

## Paths

`src/core/trunk/green.ts`, `src/worker/workflows/green-line.ts`, `src/worker/adapters/verifier/**`
(the harness included), the green wiring in `src/worker/trunk/wiring/**` and `src/core/trunk/wiring/**`,
`src/floor/components/strip/**` and `src/floor/components/banners/**` for the green cell and banner 8,
`src/floor/components/green/**` (new), `test/integration/green/**`, `test/workerd/green/**` (new), and
the shared files of `README.md`'s list.

## Risks

- The take-back changes landed history. Write its tests from GR3 and the hero's row A5 before the code.
- `LOADER` has never run in this project. Keep stage 2 off the landing path: a verification failure
  must never block or slow a landing.

## The lead's live checks

Deploy with `features.green = "static"`, land one change, and see `refs/heads/green` at the head with
`git ls-remote` and the strip reading "static checks only". For stage 2, the 50-run measurement of
item 4 and one forced red on a throwaway pool.
