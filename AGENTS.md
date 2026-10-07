# AGENTS.md

Rules for coding agents that work in this repository. `CLAUDE.md` points here.

Premise is one Cloudflare Worker project in TypeScript. The specification is binding and lives in `docs/spec/`:
`01-core.md` (rules and protocol), `02-tidepool.md` (the demo codebase), `03-floor.md` (the web page),
`04-build-plan.md` (layout, toolchain, slices, lanes), `05-agent.md` (the agent's prompt, its tools and its
turn loop) and `06-repos.md` (pools made from real repositories, and the languages beyond JavaScript). Read the
sections your task names before you write code.

**Glossary.** Use the words of `docs/spec/01-core.md` section 1, one name for one thing: pool, intent, attempt,
premise, change, Trunk, heads-up, go-around, landing, green line, Floor, Swarm, Replay.

## Commands

Node 22.18 or later (`.nvmrc` says `22`), npm 10. Node runs the TypeScript files under `scripts/` directly, with no
build step.

| Purpose                           | Command                                                                                            | State            |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| Install                           | `npm ci`                                                                                           | works            |
| Generate binding types            | `npm run types` (after every change to `wrangler.jsonc`)                                           | works            |
| Typecheck, six programs           | `npm run typecheck`                                                                                | works            |
| Unit tests, offline               | `npm test` (`npm test -- <path filter>` narrows it)                                                | works            |
| Cases                             | `npm run test:cases` (`CASES=list` prints the counts)                                              | works            |
| Durable Objects in local workerd  | `npm run test:workerd`                                                                             | works            |
| Browser                           | `npm run test:e2e` (`-- --project=deployed` runs against `PREMISE_URL`)                            | no tests yet     |
| Integration                       | `npm run test:integration -- <names>`                                                              | works            |
| Build                             | `npm run build` (`npm run clean`, then `build:seeds`, `build:host`, `build:floor`, `build:worker`) | works            |
| One build step                    | `npm run build:seeds`, `npm run build:host`, `npm run build:floor`, `npm run build:worker`         | works            |
| Format                            | `npm run format`                                                                                   | works            |
| Everything offline                | `npm run check`                                                                                    | works            |
| Licences of bundled packages      | `npm run check:licenses` (after `npm run build`)                                                   | works            |
| Secrets in the tree and history   | `npm run check:secrets`                                                                            | works            |
| Lane boundary                     | `npm run check:lane -- <lane> <branch>`                                                            | works            |
| Rewrite the lane table below      | `npm run agents-md`                                                                                | works            |
| Local run, no Cloudflare          | `npm run dev:floor`                                                                                | placeholder page |
| Local run, real service           | `npm run dev`                                                                                      | lead only        |
| Deploy                            | `npm run deploy:test`, `npm run deploy`                                                            | lead only        |
| Pools                             | `npm run pool:create -- <pool> <seed>`                                                             | works            |
| Early model measurement           | `npm run measure:models -- --early`                                                                | not built        |
| Measurements                      | `npm run measure:models`, `npm run soak`, `npm run calibrate:clef`, `npm run rehearse:hero`        | not built        |
| Recordings                        | `npm run record:export -- --pool <pool> --id <id>`                                                 | not built        |
| Submission checks                 | `npm run check:submission`                                                                         | works            |
| Cleanup of the `test` environment | `npm run cleanup:test`                                                                             | not built        |
| Spend                             | `npm run spend`                                                                                    | not built        |

A command that is not built exits 1 and names the slice or step it arrives with. Before you report a task as
done, run `npm run check` and give its exit code.

Only the lead runs `npm run dev`, `npm run deploy:test` and `npm run deploy`. They call the real Cloudflare
service and spend the owner's budget.

## Lanes

A lane is a set of paths with one builder at a time (BP2). You write only inside the paths of your lane. A path
that no lane lists belongs to the lead. Work in your own git worktree on a branch `lane/<lane>/<slice>`. Commits
are `<type>: <description>`. Only the lead merges into `main`, and nothing is pushed to a remote.

<!-- lanes:start -->
<!-- Generated from scripts/ops/lanes.json by `npm run agents-md`. Do not edit by hand. -->
<!-- prettier-ignore-start -->
| Lane | Paths | Except |
| --- | --- | --- |
| `lead` | Every path that no other lane lists. The plan names: `*`, `docs/**`, `public/**`, `src/protocol/*.ts`, `src/config/**`, `src/copy/index.ts`, `src/core/trunk/engine.ts`, `src/worker/index.ts`, `src/worker/env.ts`, `src/worker/trunk/effects.ts`, `src/worker/adapters/index.ts`, `src/worker/adapters/not-built.ts`, `src/floor/app/registry.ts`, `src/floor/app/bindings.tsx`, `scripts/build/**`, `scripts/ops/**`, `scripts/submission/**`, `test/arch/**`, `test/support/**`, `test/cases/load.ts`, `test/cases/required.json`, `test/cases/list.test.ts`, `test/workerd/cases-smoke.test.ts`, `test/e2e/lead/**` | |
| `leaf` | `src/core/sync/**`, `src/core/keys/**`, `src/core/entities/**`, `src/core/refs/**`, `src/core/replay/**`, `src/core/policy/**`, `src/core/diff/**`, `src/core/classify/**`, `src/core/plain/**`, `src/core/undo/**`, `test/tidepool/scenarios/**` |  |
| `git` | `src/core/git/**`, `src/core/outbox/**`, `src/core/rebuild/**`, `src/core/trunk/outbox-apply.*`, `src/core/trunk/restart.*`, `src/core/trunk/register.*`, `src/core/trunk/wiring/git.*`, `src/worker/adapters/pusher/**`, `src/worker/adapters/token-source/**`, `src/worker/adapters/notes-reader/**`, `src/worker/adapters/verifier/**`, `src/worker/trunk/push-runner.*`, `src/worker/trunk/reconcile.*`, `src/worker/trunk/rebuild-job.*`, `src/worker/trunk/plain-runner.*`, `src/worker/trunk/preview-runner.*`, `src/worker/trunk/wiring/git.*`, `src/worker/workflows/green-line.*`, `test/git/**`, `test/integration/landing/**`, `test/integration/green/**` | `src/worker/adapters/verifier/harness/**` |
| `engine` | `src/core/trunk/**`, `test/cases/driver.ts`, `test/cases/run.test.ts` | `src/core/trunk/engine.ts`, `src/core/trunk/outbox-apply.*`, `src/core/trunk/restart.*`, `src/core/trunk/register.*`, `src/core/trunk/wiring/git.*` |
| `trunk` | `src/worker/trunk/**`, `src/worker/routes/**`, `src/worker/security/**`, `test/workerd/trunk/**`, `test/workerd/landing/**`, `test/integration/**` | `src/worker/trunk/effects.ts`, `src/worker/trunk/push-runner.*`, `src/worker/trunk/reconcile.*`, `src/worker/trunk/rebuild-job.*`, `src/worker/trunk/plain-runner.*`, `src/worker/trunk/preview-runner.*`, `src/worker/trunk/wiring/git.*`, `src/worker/routes/swarm.*`, `test/integration/landing/**`, `test/integration/green/**`, `test/integration/collide/**`, `test/integration/hero/**` |
| `agent` | `src/core/agent/**`, `src/core/gate/**`, `src/worker/agent/**`, `src/worker/gate/**`, `src/worker/adapters/model/**`, `src/worker/adapters/attempt-repo/**`, `src/worker/adapters/triage/**`, `src/worker/adapters/risk/**`, `src/worker/workflows/attempt-repo.*`, `test/workerd/agent/**`, `test/workerd/gate/**`, `test/workerd/triage/**`, `scripts/calibrate/**`. On Day 1 and Day 2 `src/core/agent/loop/**` belongs to the measure lane. From Day 3 this lane also owns it and `scripts/measure/**`: the lead moves both globs here at IP1. | `src/core/agent/loop/**` |
| `measure` | `scripts/measure/**`, `src/core/agent/loop/**`. Used on Day 1 and Day 2 for the early model measurement (plan 2.2a). At IP1 the lead moves both globs to the agent lane. |  |
| `stream` | `src/protocol/reducer/**`, `src/worker/floor/**`, `test/workerd/floor/**`, `test/fixtures/streams/**`, `scripts/fixtures/**`, `scripts/recordings/**` |  |
| `floor-shell` | `src/floor/main.tsx`, `src/floor/app/**`, `src/floor/stream/**`, `src/floor/replay/**`, `src/floor/state/**`, `src/floor/styles/**`, `src/floor/keys/**`, `src/floor/components/strip/**`, `src/floor/components/banners/**`, `src/floor/components/owner-key/**`, `src/floor/components/kill-switch/**`, `src/floor/components/toast/**`, `src/floor/components/about/**`, `src/floor/components/swarm/**`, `src/floor/components/green/**`, `test/e2e/shell/**` | `src/floor/app/registry.ts`, `src/floor/app/bindings.tsx`, `src/floor/app/wiring/rail.*`, `src/floor/app/wiring/pool-area.*` |
| `floor-rail` | `src/floor/app/wiring/rail.*`, `src/floor/components/rail/**`, `src/floor/components/intent-box/**`, `src/floor/components/attempt-card/**`, `src/floor/components/lights/**`, `src/floor/components/heads-up/**`, `src/floor/components/tray/**`, `src/floor/components/card-sheet/**`, `src/floor/components/held-sheet/**`, `src/floor/components/race-sheet/**`, `src/floor/components/risk/**`, `test/e2e/rail/**` |  |
| `floor-pool` | `src/floor/app/wiring/pool-area.*`, `src/floor/components/pool-frame/**`, `src/floor/components/plain-frame/**`, `src/floor/components/compare/**`, `src/floor/components/tiles/**`, `src/floor/components/why/**`, `src/floor/components/git-drawer/**`, `src/floor/components/who-relies/**`, `src/floor/components/undo-sheet/**`, `test/e2e/pool-area/**` |  |
| `copy` | `src/copy/**`. Used on Day 1 and Day 2. From Day 3 these paths belong to the lead. | `src/copy/index.ts` |
| `pool` | `seeds/**`, `scripts/seeds/**`, `src/host/**`, `src/worker/app-server/**`, `src/worker/adapters/pool-source/**`, `src/worker/adapters/verifier/harness/**`, `test/tidepool/**` | `test/tidepool/scenarios/**` |
| `swarm` | `src/swarm/**`, `src/worker/routes/swarm.*`, `src/worker/workflows/swarm.*`, `scripts/soak/**`, `scripts/rehearse/**`, `test/integration/collide/**`, `test/integration/hero/**` |  |
<!-- prettier-ignore-end -->
<!-- lanes:end -->

Where the handlers of several lanes meet, the meeting point is a seam: a file of the lead that imports one
wiring module per lane (plan 3.2). You edit your lane's wiring module, never the seam.

Ask the lead, and do not edit, when you need: a change to `src/protocol/*.ts`, a new field in a seam's table, a
new dependency, a new binding, a change to `wrangler.jsonc` or `package.json`, or a path that no lane owns.

## Rules of the build

The full text is `docs/spec/04-build-plan.md` section 0.

- **BP1.** Expected values in tests come from the specification, the brief and real git. Never from the
  implementation's own output. Do not edit `docs/spec/premise-cases.json`: report a suspected error in a vector
  to the lead with the rule ids.
- **BP2.** One builder per lane. `npm run check:lane -- <lane> <branch>` must exit 0 before a merge.
- **BP3.** A slice is complete when the lead has run its acceptance check on merged `main`. Your report is not
  evidence: give the commands and their exit codes.
- **BP4.** A feature that fails its acceptance check at the freeze is switched off in `features`. Nothing ships
  half-working.
- **BP5.** Dependencies are pinned to exact versions. A package in the Worker bundle or in a browser bundle must
  be MIT, Apache-2.0, BSD or Unlicense. Only the lead adds a dependency.
- **BP6.** No code is copied from another entry or from a GPL or FSL project. Nothing under `src/`, `test/` or
  `scripts/` imports from `reference/`.
- **BP7.** Secrets (the `OWNER_KEY` value, Artifacts tokens, Cloudflare API tokens) never enter the repository,
  a log, a test report, a recording or a chat message. Tests read them from the shell environment.
- **BP8.** A calibrated constant changes only together with a measurement file under `docs/measurements/`.
- **BP9.** The sum of `SPEND_CAP_USD` over all deployed environments, plus what the early model measurement
  spent, is at most 40.
- **BP10.** The address of the `production` deployment is given to nobody until the kill-switch and spend-cap
  checks have passed.
- **BP11.** No text makes a priority claim or uses a phrase of `03-floor.md` FL6. `src/copy` does not use the
  words that CP4 lists. The README and the submission texts use "branch", "pull request" and "merge queue" only
  where they state what a change replaces.
- **BP12.** After the recording, the `production` deployment changes only for the reasons that BP12 names: new
  recordings under `public/replay/`, a fix the lead has verified on `test`, and the rotation of the owner key.

## Boundaries that tests enforce

`npm test` runs these. A failure names the file, the line and the rule.

- **Import allow list** (`test/arch/imports.test.ts`, plan 1.3). `src/protocol`, `src/copy`, `src/config`,
  `src/core` and `src/swarm` are pure: no Cloudflare import, no DOM. The table is `ZONES` in
  `test/arch/import-rules.ts`. A comment cannot bring types in either: `/// <reference … />` and `@ts-nocheck`
  are refused in every file under `src/`.
- **No waits, no clock, no chance** (`test/arch/sync.test.ts`). In `src/core/**`, `src/swarm/**` and
  `src/protocol/reducer/**`, test files included, these are forbidden: `async`, `await`, `Promise`, `.then(`,
  `fetch(`, `crypto.subtle`, `CompressionStream`, `setTimeout`, `Date.now(`, `new Date()` with no argument,
  `Math.random(`. Time, ids and random numbers are arguments.
- **No patterns built from input** (`test/arch/sql.test.ts`). No SQL text under `src/core/trunk/` contains
  `LIKE` or `GLOB`.
- **Separate compile** (`test/arch/programs.test.ts`). `tsconfig.core.json` compiles the pure paths with no
  Cloudflare types and no DOM library. `tsconfig.floor.json` and `tsconfig.host.json` compile the browser code
  with no types of Node. Every TypeScript file under `src/`, `test/` and `scripts/` is in at least one program.
- **Lanes** (`test/arch/lanes.test.ts`). `scripts/ops/lanes.json` matches the plan, and the table above matches
  `scripts/ops/lanes.json`.

## Conventions

- A relative import names the file that exists: `import { x } from "./x.ts"`. No `.js` extension, no missing
  extension.
- Node strips types and does nothing else: no `enum`, no `namespace`, no constructor parameter properties.
  Write `import type` for a type-only import.
- Unit tests sit next to the source as `<name>.test.ts`. The other kinds of test live under `test/` (plan 1.4).
- A test is compiled with the libraries of the code it tests: the Worker's unit tests by `tsconfig.worker.json`;
  the unit tests of the Floor and of the host and the specs of `test/e2e/` by `tsconfig.test-browser.json` (DOM
  and Node); every other test and script by `tsconfig.test.json` (Node). A Floor or host file that a unit test
  imports is therefore also compiled with Node's types present: write `window.setTimeout`, because a bare
  `setTimeout` returns a number only without them.
- A test that runs git creates its repository with `createScratchRepo` of `test/support/git.ts`. It never passes
  its own environment to git: under a git hook that environment names the hook's repository.
- `reference/`, `seeds/` and `docs/` are never formatted, compiled or collected as tests.
- When you add the first file to a directory, delete its `.gitkeep`.
- A stub answers `not_built`. Replace the stub, keep its file name and its exported name: `wrangler.jsonc` names
  the classes.
