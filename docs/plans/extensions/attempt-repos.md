# Extension: a repository for each attempt

Branch `feat/attempt-repos`. Browser port `4403`. Read `README.md` in this folder first.

## What it is

Every attempt gets its own Artifacts repository in the `ATTEMPTS` namespace, with a branch
`refs/heads/attempt` holding `transcript.jsonl`, `ops.json` and `premises.json`, so anyone can read with
plain git what an agent did, including work that never landed. Today `features.attempt_repos` is false
and `src/worker/workflows/attempt-repo.ts` is a 10-line placeholder.

## The specification

`docs/spec/01-core.md` AG5 (checkpoints are asynchronous and never awaited by a tool call or a landing),
S3 (S3a to S3c: at most `MAX_FORKS_IN_FLIGHT` provisioning calls in flight, `FORK_RETRIES`, tokens minted
with an explicit scope), SE22 (attempt repositories live in their own namespace and no route serves
them), the note's `attempt.repo`; `docs/spec/04-build-plan.md` 2.5 (Slice 4) acceptance item 7 (track
4D) and the Option table row S3; risk RR3; About's line on attempt repositories.

## Stages

**Stage 1, the probe (first).** Write `scripts/measure/fork-probe.ts`, offline-testable with fakes, that
answers on a live deployment the question of item 7: can `fork()` place the fork in the `ATTEMPTS`
namespace? Hand the command to the owner for the lead to run early (it creates one or two repositories).
Build the provisioner behind its port with both options: B, `fork()` off the landing path; A,
`create()` plus a push of the checkpoint. A constant chooses; until the lead reports the probe's answer,
default to A, because SE22 wins when a fork cannot be placed.

**Stage 2 (must).** The provisioner, `AttemptRepoWorkflow` (archive), the asynchronous checkpoints of
AG5, the `attempt.repo` event, and the Why card's link to the attempt repository if the specification
gives one. Acceptance: item 7 in workerd: `attempt.repo` with `ok: true` and the three files on
`refs/heads/attempt`; with a provisioner that always fails, the landing still lands and `attempt.repo`
has `ok: false`; with 12 attempts opened at once, at most `MAX_FORKS_IN_FLIGHT` calls are in flight;
each token has an explicit scope, never taken from `fork()`.

## Paths

`src/worker/workflows/attempt-repo.ts`, `src/worker/adapters/attempt-repo/**` (new),
`src/worker/adapters/index.ts` and the agent and trunk wiring for the port, `src/worker/agent/**` for
the checkpoints, `scripts/measure/fork-probe.ts`, `test/workerd/agent/**`, the About and Why parts in
`src/floor/components/about/**` and `src/floor/components/why/**`, and the shared files of `README.md`'s
list.

## The lead's live checks

The probe; then, with the switch on in `test`, one real-agent attempt whose repository holds the three
files, read with `git clone` and a scoped token; and 12 scripted attempts at once (RR3: more than 5%
failures after retries, or ready p90 above 10 s, keeps the switch off).
