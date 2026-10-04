# Premise build plan (04-build-plan)

Status: binding for the build. Revision 1, 2026-10-03. Read `01-core.md`, `02-tidepool.md` and `03-floor.md` before this file. They say what Premise is. This file says in what order it is built, who owns which paths, and what evidence closes each step.

Sources: the architecture brief (scope lists, engineering standards), the design brief (contest dates and platform limits), the concept panel (the three judges' must-fix lists; Appendix A maps every schedule and measurement item to a section of this file).

Not in this file: any rule of the product. Where this file needs a product rule it cites it by id.

Conventions:

- Words of the glossary of `01-core.md` section 1 keep their meaning. The plain-merge pool is the pool the brief's scope list calls the counterfactual pool.
- Roles. **Owner**: the person. Defines goals, drives the Floor, records the video, submits. Cannot read code. **Lead**: the lead agent. Owns the shared files, merges, deploys, verifies. **Builder**: one coding agent working in one lane.
- Ids in this file: `BP` (rules of the build), **Slice** 0 to 15 with tracks such as `1A`, `IP` (integration points), `M` (milestones), `PT` (plan thresholds), `VE` (verification), `RR` (risks), `SC` (submission checklist), `GP` (gaps in the specification).
- `S1` to `S6` are the spikes of `01-core.md` section 15. `PS` is the `PoolSource` spike of `02-tidepool.md` 4.9. A slice is never written `S<n>`.
- Days: D1 is Sunday 2026-10-04, D11 is Wednesday 2026-10-14. A day ends at the lead's integration run. "Behind" means the day's milestone check failed at that run.
- A **plan threshold** is a pass mark set by this file for a go or no-go decision. It is not a calibrated constant of the product.
- Authorizations already given by the owner (brief, 2026-10-03): deployment to the owner's Cloudflare account, and up to $50 of Cloudflare usage. Not yet given: making the repository public, deleting resources, any other paid commitment. Section 7 says where each is needed.
- This file makes no priority claim. Related work is named in `01-core.md`.

---

## 0. Rules of the build

| Id | Rule | How it is checked |
| --- | --- | --- |
| BP1 | Expected values in tests come from the specification files, the brief, and real git. Never from the implementation's own output. A builder does not edit `docs/spec/premise-cases.json`; a suspected error in a vector goes to the lead with the rule ids, and the lead changes the rule and the vector together. | Review of every test at the integration point; `git log -- docs/spec/` shows only lead commits. |
| BP2 | A lane has one builder at a time. A builder writes only inside the paths its lane owns (3.1). There is no exception: a seam is a lead file, and each lane reaches it through its own wiring module (3.2). | `npm run check:lane -- <lane> <branch>` at the integration point exits 0. It fails on any changed path outside the lane. |
| BP3 | A slice is complete when its acceptance check passed on merged `main`, run by the lead, on the deployed `test` environment where the check says so. A builder's report is not evidence. | The lead records commands and results in `docs/measurements/integration/ip<N>.md`. |
| BP4 | A feature that fails its acceptance check at the freeze (M5) is switched off in `features` (`/floor.json`) and listed under limits in About and in the README. Nothing ships half-working. | AC19 of `03-floor.md`; the rows of `03-floor.md` 1.4. |
| BP5 | Dependencies are pinned to exact versions (1.2). A package that ends up in the Worker bundle or in a browser bundle must be MIT, Apache-2.0, BSD or Unlicense. A new dependency is added by the lead only. | `npm run check:licenses` reads the bundlers' module lists and fails on any other licence. |
| BP6 | No code is copied from another entry or from a GPL or FSL project. Three scratch tools were made before the build and are not in the repository. (a) The core simulator checked `premise-cases.json`. It is never used as product code, so the vectors stay an independent check of the engine. (b) The spike harness's pack and pkt-line code and (c) the tide pool reference tree are the project's own work. The lead may hand them to a builder as a starting point. They then count as new code: the same tests and review apply, and the specification wins where they differ. | Review at the integration point. Tracks 1B and 1G pass their checks (2.2) whatever the starting point was. |
| BP7 | Secrets (the `OWNER_KEY` value, Artifacts tokens, Cloudflare API tokens) never enter the repository, a log, a test report, a recording or a chat message. Tests read them from the shell environment. | `npm run check:secrets` scans the work tree and the full history for the patterns of `redact()` (SE5a). |
| BP8 | A calibrated constant is changed only together with a measurement file under `docs/measurements/`, named in a comment next to the value (`01-core.md` conventions). | Unit test: every constant marked calibrated in Appendix C either has its starting value or cites an existing file. |
| BP9 | The sum of `SPEND_CAP_USD` over all deployed environments is 40 (`01-core.md` Appendix C). Start: `production` 30, `test` 10. The gate's ledger is never reset before the submission. | `wrangler.jsonc`; `npm run spend` prints both ledgers. |
| BP10 | The address of the `production` deployment is given to nobody until the kill-switch and spend-cap checks of Slice 4 have passed on `test`, and, on `production` itself, the kill-switch check has passed and `limits.cap_usd` shows the configured cap. | Milestones M3 and M6. |
| BP11 | The page text, the README and the submission texts contain none of the phrases of FL6 and none of the words of CP4. | `npm run check:submission` and AC20. |
| BP12 | After the recording (M7) the `production` deployment changes only for a fix the lead has verified on `test`, followed by the checks of SC9. Its pool repo, plain-merge repo and recordings are never deleted or rebuilt (RP10). | Deploy log in `docs/measurements/deploys.md`. |

### 0.1 Where the specification files disagree

`01-core.md` is at revision 2. Its section "Changes after review" records decisions on requests made by `02-tidepool.md` (Appendix C there) and `03-floor.md` (4.6 there). Those two files still show the earlier state in the places below. **Rule: `01-core.md` wins.** The lead corrects the other two files during Slice 0; until then builders follow the right-hand column.

| Where | It says | Build this instead |
| --- | --- | --- |
| `02` 4.1, 4.2, 4.6, 4.8, 4.9 option D | A source `a_<ULID>` serves a live attempt view through Trunk; held and race cards frame `a_<attempt>` | No route serves a live attempt view (PV4). "After" frames are preview commits in the plain-merge repository (PV1, PV2). |
| `02` 4.5, HO6 | Channel without `advance`, `highlight`, and `tapped` without `path` | The schema of SE16. |
| `02` 7.6 steps 6 and 7, Appendix A row A11, risk 19 | A blind-spot `confirm` for five references that the edited `update` functions already had | No blind spot (B1a). S's submit after its repair answers `held`. |
| `02` 8.3, 10.3 (row "sweep-colour before its first edit"), risk 8, Appendix C item 5 | A listing gain before the sweep's first edit is missed and counted as an escape | The late L1 check catches it at the operation that makes the attempt a sweep (`01-core.md` 7.2, vector `C41`). The Swarm's expected escape count is 0. |
| `03` 4.5 | `FrameAddress` has a `live_attempt` form; undo plan is public; undo body has no `expect_reverted` | `FrameAddress = { repo, commit }` (10.3); undo plan is an owner route; the body carries `expect_reverted` (13.6, UN5). |
| `03` 4.6, column "Until then" | Interim behaviour while N1 to N25 are open | Not built. All were decided in `01-core.md` 12.1 and 13.6. |
| `03` 8.2, 8.3, RP13 | Header `premise_replay: 1`; events without `ts`; playback spaced by `t` | Header `premise_replay: 2`; every event has `ts`; playback is spaced by `ts` (12.3). |

### 0.2 Gaps to close before the slice that needs them

None of these is decided here. Each needs one edit to a specification file by the lead. The proposal is the working assumption until then.

| Id | Gap | Needed by | Proposal |
| --- | --- | --- | --- |
| GP1 | `02` 4.1 has no source segment for a commit of the plain-merge repository. Preview commits (PV1) and Replay frames (`03` 8.6) need one. | Slice 6, Slice 11 | A source segment `p-<40 hex>`: that commit of the pool's plain-merge repository. |
| GP2 | `01-core.md` 13.6 has no way to launch a named scripted pattern or a canned cast on a named pool, and no way to release `hold_before_submit`. The conductor (`02` 7.11), the tracer and the integration tests need all three. | Slice 1 | `POST /api/swarm` takes the full `SwarmConfig` (`02` 10.1) plus `pool`, an optional `patterns: string[]` (launch exactly these, in order) and `release: string[]` (pattern ids that may now submit). |
| GP3 | Beat 5 of `03` 1.2 uses a sweep that changes a shared rule and edits every creature found by a search for `drain(`. `02` section 9 has no such seeded intent: P3a touches only `creatures/` (tier `auto`), so it does not wait on a card. | Slice 6, M6 | Add one seeded pair to `02` 9.3, or re-point beat 5 at pair P3 with the sweep held by `hold_before_submit`. |
| GP4 | `02` section 6 requires the seed policy to hold `world/**`. `03` 1.4 says shared-rule paths are `auto` when the held card is not in the build. | Slice 2 to Slice 10 | A generated seed variant `tidepool-auto` (the seed with the one-line policy variant of `02` section 6). The main pool is created from it while `features.held` is false. |
| GP5 | EV6 and FE4 leave out, for every synthetic attempt, `premise.recorded`, `op.recorded`, `attempt.step` and the `items` of `headsup.sent`. The canned casts are synthetic. So the conductor's first wait (`02` 7.11 step 1, `op.recorded`) never ends, and a canned hero run shows cards with no lights and no diff. | Slice 2 (`collide`), Slice 6, RR6 | EV6 and FE4 apply per pool, not per attempt. `POST /api/pools` takes `quiet: boolean` (default false) and `pool.state` carries it. Only quiet pools (the Swarm pool and the soak pools) leave those events out. A canned cast on a pool that is not quiet emits every event; its attempts are `agent: "synthetic"` and the SYNTHETIC banner is shown (FL4). |

---

## 1. Repository layout

### 1.1 Directories

One npm package, one Worker project. No workspaces.

| Path | Purpose | Pure (1.3) |
| --- | --- | --- |
| `AGENTS.md` | Rules for coding agents: the commands of 1.5, the lanes of 3.1, BP1 to BP12, the glossary pointer. | |
| `README.md` | What Premise is, run instructions, limits (built from `src/copy/limits.ts`, AC19), measured numbers with the file each came from. | |
| `LICENSE` | MIT. | |
| `docs/spec/` | The four specification files and `premise-cases.json`. | |
| `docs/measurements/` | Recorded evidence: `spikes/`, `models/`, `calibration/`, `soak/`, `integration/`, `rehearsal/`, `cases.md`, `rules.md`, `deploys.md`. | |
| `docs/reviews/` | `security.md`, `design.md`, `screens/`. | |
| `docs/submission/` | `vision.txt`, `cloudflare.txt`, `run.txt`, `checklist.md`. | |
| `src/protocol/` | The shared module: every event, tool request and response, record type, route, constant, `redact()`, port interface. `src/protocol/reducer/` holds `FloorState` and `reduce` (EV5). | yes |
| `src/copy/` | Every interface string of `03-floor.md` section 5 (CP1) and the limits list. | yes |
| `src/config/` | `features.ts`, `pools.ts`, `prewritten.ts` (seeded intents shown as pre-written requests), `model-plan.ts` (`ModelPlan` and the price table, SE6). Source of `/floor.json`. | yes |
| `src/core/sync/` | `H()`, SHA-1, git blob id, deflate. The only files that import `node:crypto` and `node:zlib` (SY1). | yes |
| `src/core/keys/` | Paths, premise keys, member sets, listing and query hashes (2.1, 2.2, 2.5, 2.6). | yes |
| `src/core/entities/` | acorn parse, entities, regions, entity hash, outline lines, module hash (2.3, 2.4, 2.7, KH1). | yes |
| `src/core/refs/` | `resolve`, reference extraction, `resolveExport`, globals (6.1, 6.2). | yes |
| `src/core/replay/` | Operations and replay, OP1 to OP5 (section 5). | yes |
| `src/core/policy/` | Policy file, globs, tiers (10.1). | yes |
| `src/core/diff/` | Entity and unified diffs, the size cut of HU10. | yes |
| `src/core/classify/` | The decision table of 7.2 as one pure function, sweeping, the triage mapping of 7.3, blast radius (11.6). | yes |
| `src/core/git/` | Blob, tree, commit and note bytes (3.5), notes tree, pack, pkt-line, receive-pack request and report, ref advertisement parser (9.5). | yes |
| `src/core/outbox/` | The table of LP5 as a pure function, backoff, the poison-batch rule, the command subset of LP6. | yes |
| `src/core/rebuild/` | Re-index and rebuild planning (3.6) over a reader port. | yes |
| `src/core/plain/` | The plain-merge replay (PM1 to PM5) and the preview tree (PV1). | yes |
| `src/core/undo/` | Undo and revert planning (UN1 to UN8). | yes |
| `src/core/agent/` | `inboxNext` (HU6a), the model tool message (4.10), budgets (AG4, AG6), journal decisions (AG2, AG3). | yes |
| `src/core/gate/` | Reservation arithmetic and the token bucket (SE6 to SE8). | yes |
| `src/core/trunk/` | The Trunk engine: schema (3.2), tools, premises, sets (6.3), submit, tick, heads-ups, transitions, cards, events. Synchronous, over the `Sql` port. `engine.ts` is a seam and `wiring/` holds its wiring modules (3.2). | yes |
| `src/swarm/` | Scripted patterns (`02` 10.2 to 10.4), canned casts, the conductor script (`02` 7.11), the oracle SW2. | yes |
| `src/worker/` | Cloudflare shells. `index.ts` (router), `trunk/`, `agent/`, `floor/`, `gate/` (the four Durable Objects), `routes/`, `app-server/`, `security/`, `workflows/`, `adapters/` (one directory per port of 1.7). | |
| `src/host/` | The pool host (`02` 4.5 to 4.7): browser code served as `~host.<build>.js`. | |
| `src/floor/` | The Floor (React): `app/`, `stream/`, `replay/`, `state/`, `styles/`, `components/<name>/`. | |
| `seeds/tidepool/` | The 21 seed files of `02` 2.1. Five are fixed character for character by `02` (`world/energy.js`, `creatures/fish.js`, `GUIDE.md`, `index.html`, `.premise/policy.json`). The other 16 implement `02` sections 2, 3 and 5. Variants `tidepool-swarm` and `tidepool-auto` are generated, never stored. | |
| `public/` | Static files: `floor.json` (generated), `replay/index.json`, `replay/*.ndjson`. | |
| `scripts/` | `build/`, `seeds/`, `fixtures/`, `measure/`, `soak/`, `calibrate/`, `rehearse/`, `recordings/`, `submission/`, `ops/` (pool create, cleanup, spend, and `lanes.json`, the one list of lane paths that `check:lane` and `AGENTS.md` are built from). | |
| `test/` | See 1.4. | |

### 1.2 Toolchain

Versions were checked against the npm registry on 2026-10-03. Each is the current release, except `@types/node`, which follows Node 22. Wrangler, vitest, TypeScript and isomorphic-git are the versions the spike harness ran.

| Tool | Version | Use |
| --- | --- | --- |
| Node.js | 22 LTS, 22.13 or later (`.nvmrc`: `22`) | Scripts and tests. `node:sqlite` backs the `Sql` port in tests. |
| npm | 10, lockfile committed, `.npmrc` `save-exact=true` | `npm ci` only. |
| TypeScript | 7.0.2 | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`. |
| wrangler | 4.147.0 | `wrangler types`, `wrangler dev`, `wrangler deploy`. Bundles the Worker. 4.145.0 is the minimum for the Artifacts read methods. |
| Vite | 8.3.2, with `@vitejs/plugin-react` 6.1.1 | Builds the Floor and the host. Nothing else. |
| React, React DOM | 19.3.0 | The Floor. |
| vitest | 5.0.3 | Unit, cases, git, architecture, workerd and integration tests. |
| miniflare | 5.20261001.0-alpha (the version wrangler 4.147.0 depends on) | Local workerd for Durable Object tests. |
| `@playwright/test` | 1.63.0, Chromium | Browser checks. |
| acorn | 8.18.0 | The only parser (2.3). The only runtime dependency of the Worker. |
| prettier | 3.9.9 | Formatting. |
| Types | `@types/node` 22.20.5, `@types/react` 19.3.0, `@types/react-dom` 19.3.0 | |
| git | 2.40 or later on the build machine | Expected object ids, `git index-pack`, `git fsck`, `git http-backend` in tests. |

Deliberately not used, with the reason:

| Not used | Reason |
| --- | --- |
| `@cloudflare/vite-plugin` | Wrangler bundles the Worker; Vite builds only browser code. The Floor then runs against fixture streams with no Worker. |
| `@cloudflare/vitest-pool-workers` | Version 0.22.0 requires vitest 4. Durable Object tests drive workerd through the Miniflare API. |
| Agents SDK (`agents`) | The Agent is a plain Durable Object. Rule AL1 needs the object's single alarm for its own `timers` table. |
| isomorphic-git | Only if S1 chooses option B. Then 1.43.0, imported only under `src/worker/adapters/pusher/`. |
| ESLint | Boundaries and lints are tests (1.3, AC7, AC20). |
| D1, R2, KV, Queues | Not in the minimum build (brief, section 2). |
| A CSS framework, an icon set, font files | `03-floor.md` VD2, VD5, VD6. Plain CSS with custom properties. |
| A test DOM (jsdom, happy-dom) | Floor logic is tested as pure functions; rendering is tested in a real browser against fixture streams. |

### 1.3 How the pure core stays free of Cloudflare imports

Pure paths: `src/protocol/**`, `src/copy/**`, `src/config/**`, `src/core/**`, `src/swarm/**`. Five mechanisms, all run by `npm run check`.

1. **Separate compile.** `tsconfig.core.json` includes only the pure paths, with `lib: ["ES2023"]` and `types: ["node"]`. `worker-configuration.d.ts` and the DOM library are not in that program, so `DurableObjectState`, `Env` and `document` are compile errors there.
2. **Import allow list** (`test/arch/imports.test.ts`). The test reads every import and re-export specifier of every file and fails on anything outside this table. It carries a negative fixture: a file under a fake core path that imports `cloudflare:workers` must be rejected.

   | Files | May import |
   | --- | --- |
   | `src/protocol/**` | `src/protocol` only |
   | `src/copy/**`, `src/config/**` | `src/protocol` |
   | `src/core/sync/**` | `node:crypto`, `node:zlib` |
   | `src/core/**` (other) | `src/core`, `src/protocol`, `acorn` |
   | `src/swarm/**` | `src/core/sync`, `src/protocol` |
   | `src/host/**` | `src/host`; types only from `src/protocol/channel.ts` |
   | `src/floor/**` | `src/floor`, `src/protocol`, `src/copy`, `react`, `react-dom` |
   | `src/worker/**` | everything under `src` except `src/floor` and `src/host`; `cloudflare:workers`; `node:*` |

   A test file (`*.test.ts`) may also import `vitest`, `node:*` and `test/support`. Test files are compiled by `tsconfig.test.json`, never by `tsconfig.core.json`.

3. **No waits, no clock, no chance** (`test/arch/sync.test.ts`; SY1, SY2, FE2). In `src/core/**`, `src/swarm/**` and `src/protocol/reducer/**` these tokens are forbidden: `async`, `await`, `Promise`, `.then(`, `fetch(`, `crypto.subtle`, `CompressionStream`, `setTimeout`, `Date.now(`, `new Date()` with no argument, `Math.random(`. Time, ids and random numbers are arguments. `src/protocol/ports.ts` declares asynchronous interfaces as types only. The cases driver also fails if any engine call returns a thenable.
4. **No patterns built from input** (`test/arch/sql.test.ts`; SQ1). No SQL text under `src/core/trunk/` contains `LIKE` or `GLOB`.
5. **One code path.** The engine receives `Sql`, the time and an id source as arguments. Tests pass `node:sqlite`; Trunk passes `ctx.storage.sql`. `test/workerd/cases-smoke.test.ts` runs the required cases inside workerd, so a difference between the two SQLite builds fails a test.

Two ports are defined by this plan, in `src/protocol/ports.ts`:

```ts
// The engine's only door to storage. Synchronous. `transaction` maps to ctx.storage.transactionSync.
interface Sql {
  exec(query: string, ...bindings: Array<string | number | null | Uint8Array>): { toArray(): Array<Record<string, unknown>> };
  transaction<T>(run: () => T): T;
}

// What decides an agent's next step. ModelDriver asks a Workers AI model. ScriptedDriver wraps a pattern of src/swarm.
// Both drive the same Agent Durable Object and the same seven Trunk tools.
interface Driver {
  next(input: { last: ModelToolMessage | null; state: unknown }): Promise<
    | { kind: "tool"; tool: ToolRequest["tool"]; args: object; state: unknown }
    | { kind: "wait"; state: unknown }               // an exempt wait (AG3)
    | { kind: "stop"; reason: string; state: unknown }>;
}
```

### 1.4 Where tests live

| Kind | Where | Runs in | Needs |
| --- | --- | --- | --- |
| Unit | Next to the source: `src/**/<name>.test.ts` | Node | nothing |
| Cases | `test/cases/` (loader, driver, `required.json`) | Node, `node:sqlite` | nothing |
| Real git | `test/git/` | Node, the `git` binary, a local `git http-backend` server | nothing |
| Architecture | `test/arch/` | Node | nothing |
| Tide pool | `test/tidepool/` (seed exactness, self-test verdicts, `scenarios/`) | Node | nothing |
| workerd | `test/workerd/` | Local workerd through the Miniflare API, over the built bundle; Artifacts and Workers AI are local fakes (real bare git repositories behind a fault proxy) | nothing |
| Browser | `test/e2e/` (Playwright) | Chromium against the built Floor and fixture streams; a second project runs against a deployed address | nothing, or `PREMISE_URL` |
| Integration | `test/integration/` | Node against the deployed `test` environment | `PREMISE_URL`, `PREMISE_OWNER_KEY`, Cloudflare login |
| Fixtures | `test/fixtures/streams/*.ndjson` (the format of 12.3), `test/support/` | | |

`test/cases/required.json` lists the cases that merged slices must pass. The lead adds a slice's cases when it merges the slice.

```json
{ "format": "premise-cases/2",
  "hash_cases": "all", "inbox_cases": "all",
  "required": { "1": ["C01", "C23", "C28"], "3": ["C20", "C21", "C22", "C50", "C51"] } }
```

### 1.5 Commands

| Purpose | Command | What it runs |
| --- | --- | --- |
| Install | `npm ci` | |
| Generate binding types | `npm run types` | `wrangler types` |
| Typecheck | `npm run typecheck` | `tsc --noEmit` for `tsconfig.core.json`, `.worker.json`, `.floor.json`, `.host.json`, `.test.json`, in that order |
| Unit tests | `npm test` | vitest projects `unit`, `arch`, `cases`, `git`, `tidepool`. Offline. `npm test -- <path filter>` narrows it. |
| Cases | `npm run test:cases` | The required cases. `CASES=all` runs all 57 and prints one line per case; `CASES=list` prints the counts only. |
| Durable Objects | `npm run test:workerd` | `npm run build:worker`, then the `workerd` project |
| Browser | `npm run test:e2e` | Playwright, fixture project. `-- --project=deployed` runs against `PREMISE_URL`. |
| Integration | `npm run test:integration -- <names>` | The named tests against `PREMISE_URL` |
| Build | `npm run build` | `build:seeds` (variants, seed bundle), `build:host` (to `dist/client/pool/~host.<build>.js`), `build:floor` (`floor.json`, then Vite to `dist/client`), `build:worker` (`wrangler deploy --dry-run --outdir dist/worker`) |
| Everything offline | `npm run check` | `prettier --check .`, `typecheck`, `npm test`, `build`, `check:licenses`, `check:secrets` |
| Lane boundary | `npm run check:lane -- <lane> <branch>` | Fails if `git diff --name-only main...<branch>` lists a path outside the lane's paths in `scripts/ops/lanes.json` (BP2) |
| Local run, no Cloudflare | `npm run dev:floor` | Vite dev server. `http://localhost:5173/replay/<fixture>` plays a fixture stream. |
| Local run, real service | `npm run dev` | `build`, then `wrangler dev` on port 8787. Artifacts and Workers AI are the real services (there is no emulator); needs `wrangler login` and a `.dev.vars` with `OWNER_KEY`. |
| Deploy | `npm run deploy:test`, `npm run deploy` | `check`, then `wrangler deploy --env test` or `wrangler deploy` |
| Pools | `npm run pool:create -- <pool> <seed>` | `POST /api/pools` with the key from the environment |
| Measurements | `npm run measure:models`, `npm run soak`, `npm run calibrate:clef`, `npm run rehearse:hero` | Each writes one file under `docs/measurements/` |
| Recordings | `npm run record:export -- --pool <pool> --id <id>` | Downloads the export, runs the check of RP1, writes `public/replay/<id>.ndjson` and the index entry |
| Submission checks | `npm run check:submission` | Character counts, phrase lint, limits equality, citations present |
| Cleanup | `npm run cleanup:test` | Deletes every repo in the two `test` namespaces. Never touches `production`. |
| Spend | `npm run spend` | Prints the model gate's ledger of both environments |

### 1.6 Wrangler configuration

`compatibility_date` 2026-10-01, `compatibility_flags: ["nodejs_compat"]` (SY1), `limits.cpu_ms` set (9.4), `assets.run_worker_first: true` so that one module sets every security header (SE14, SE14a) and applies the rate limits of SE21, `assets.not_found_handling: "single-page-application"` (the client route `/replay/{id}`).

| Binding | Kind | For |
| --- | --- | --- |
| `ASSETS` | Static assets, `dist/client` | The Floor, the host script, recordings |
| `POOLS` | Artifacts namespace `premise-pools` | Pool repos and plain-merge repos |
| `ATTEMPTS` | Artifacts namespace `premise-attempts` | Attempt repos (SE22) |
| `AI` | Workers AI | Coding models and Clef |
| `TRUNK`, `AGENT`, `FLOOR`, `GATE` | Durable Object classes `Trunk`, `Agent`, `Floor`, `ModelGate`, SQLite-backed | One per pool, per attempt, per pool, per deployment |
| `SWARM`, `GREEN`, `ARCHIVE` | Workflows | Slice 8, Slice 14, track 4D |
| `BROWSER` | Browser Run | Slice 14, only if S4 chooses option A |
| `OWNER_KEY` | Secret | SE1. Not listed under `secrets.required`: SE1 and RP2 need a deployment without it to start and to fail closed. |
| Variables | `SPEND_CAP_USD`, `APP_HOST` (optional, SE14b), `CLEF_TRIAGE`, `CLEF_RISK`, `CLEF_CONTRADICTION` | |

Durable Object classes are declared under `exports` (`"type": "durable-object"`, `"storage": "sqlite"`), the form the spike harness deployed with. `migrations` is not used. All four Durable Object classes and all three Workflow classes are declared from Slice 0, each backed by a stub file (2.1), so `wrangler.jsonc` does not change when a slice lands. Workflow names are unique in an account, so the `test` environment uses `premise-test-swarm`, `premise-test-green` and `premise-test-archive`.

Environments: the top level is `production` (Worker `premise`). `env.test` is Worker `premise-test` with namespaces `premise-test-pools` and `premise-test-attempts` and its own Durable Objects. Integration tests create pools named `it-<ULID>` there.

### 1.7 Ports decided by spike

The rest of the system codes against the interface. Each option is one file. `src/worker/adapters/index.ts` names the option in use; that file changes only with a decision record `docs/measurements/spikes/<id>.md` (question, measurement, choice, date). Until a record exists, option A of each spike is the working assumption (`01-core.md` section 15). This file chooses none.

| Spike | Interface | Options | Adapter directory |
| --- | --- | --- | --- |
| S1 | `Pusher`, `NotesReader` | A hand-built pack and raw receive-pack; B isomorphic-git for the push only; C one warm container. `NotesReader`: binding read by ref, or the ref advertisement plus binding reads by hash. | `adapters/pusher/`, `adapters/notes-reader/` |
| S2 | `TokenSource` | A minted token; B the token returned by `create()`, with rotation through `fork()`; C a container. | `adapters/token-source/` |
| S3 | `AttemptRepoProvisioner` | A `create()`; B `fork()` with retry; C a pre-warmed pool of repos. | `adapters/attempt-repo/` |
| S4 | `Verifier` | A Browser Run; B a Dynamic Worker isolate; C a container; D `static`. | `adapters/verifier/` |
| S5 | `ModelPlan` | Workhorse, race models, per-minute limits, `max_real_agents`, prices: all from measurement. | `src/config/model-plan.ts` |
| S6 | `Triage`, `RiskJudge` | A `clef-flash` and `clef`; B `clef` for both; C off; always `ScriptedTriage` for synthetic attempts. | `adapters/triage/`, `adapters/risk/` |
| PS | `PoolSource` | A binding reads by hash; B `readFile` with a commit id as ref; C Trunk's `files` table for head; E a directory on disk (tests). Option D is not built (0.1). | `adapters/pool-source/` |

---

## 2. Vertical slices

Slice 0 is the scaffold. Slice 1 is the thinnest path through every layer. Slices 2 to 10 each add one item of the brief's MUST list. Slices 11 to 15 each add one item of its SHOULD list, ordered by what the beat sheet loses without them (`03-floor.md` 1.4) and by dependency. STRETCH items have no slice (2.17).

| Slice | Adds | Scope | Depends on | Cases it must pass |
| --- | --- | --- | --- | --- |
| 0 | Scaffold and the `protocol` module | | | none run; the file loads |
| 1 | Tracer: one scripted agent lands one commit; the Floor and the pool show it. Owner key. Tide pool and app server by ref. | MUST | 0 | `C01`, `C23`, `C28`, `H01` to `H23`, `I01` to `I05` |
| 2 | Live premises: rule-based classification, derived premises, heads-ups, go-arounds, blind spots, the go-around limit, right of way | MUST | 1 | 34 cases (2.3) |
| 3 | Durable landing: outbox, push outcomes, restart, rebuild from Artifacts | MUST | 1 | `C20`, `C21`, `C22`, `C50`, `C51` |
| 4 | Real agents on Workers AI behind the model gate: spend cap, kill switch, recovery | MUST | 2 | none new |
| 5 | The Floor's MUST surface: intent box, cards with premise lights, live pool, file tiles, counters | MUST | 1 | none new (AC14 uses `C04`, `C05` as fixtures) |
| 6 | The hero conflict with the plain-merge pool side by side | MUST | 2, 3, 5 | none new; `02` Appendix A rows A3 to A16 |
| 7 | Why card, "show the git" drawer, Who relies | MUST | 1, 2, 5 | none new |
| 8 | Swarm with measured numbers | MUST | 2, 3, 5 | none new |
| 9 | Replay with no credentials | MUST | 5, 6 | none new |
| 10 | README, About, run instructions | MUST | 1 to 9 | none new |
| 11 | Held-path card with before and after | SHOULD | 2, 5, 6 | `C18`, `C34`, `C35`, `C48`, `C49` |
| 12 | Race and choose | SHOULD | 4, 11 | none new |
| 13 | Causal Undo that reopens dependents | SHOULD | 2, 4, 5 | `C19`, `C53` |
| 14 | Green line: verify, advance, revert on red | SHOULD | 3; 13 for the revert | none new |
| 15 | Clef triage and the risk lines | SHOULD | 2, 4; 11 for the risk lines | `C06`, `C07`, `C12`, `C31`, `C38`, `C42`, `C52`, `C55` |

3 + 34 + 5 + 5 + 2 + 8 = 57. Every case is required by exactly one slice and stays required from then on. A case is named by its number prefix (`C04` is `C04-hero-shared-rule-lands-first`; Appendix A of `01-core.md`, runner rule 10).

Where each item of the brief's scope list is built:

| Brief, section 6 | Slice |
| --- | --- |
| MUST: Trunk reads, premises, replay-landing, notes | 1 |
| MUST: Trunk derived premises, the gate | 2 |
| MUST: Trunk outbox | 1 (record, push, confirm), 3 (retry, restart, rebuild) |
| MUST: Agent with real Workers AI models | 4 |
| MUST: tide pool and app server by ref | 1 |
| MUST: Floor (intent box, cards with premise lights, live pool, file tiles, counters) | 1 (minimal), 5 |
| MUST: hero conflict with the plain-merge pool side by side | 2 (the catch), 6 |
| MUST: Why card with the "show the git" drawer | 7 |
| MUST: Swarm with measured numbers | 8 |
| MUST: Replay with no credentials | 1 (fixture player), 9 |
| MUST: owner key, spend cap, kill switch | 1 (owner key), 4 |
| MUST: README and run instructions | 10 |
| SHOULD: held-path card with before and after | 11 |
| SHOULD: Race and choose | 12 |
| SHOULD: causal Undo that reopens dependents | 13 |
| SHOULD: green line with self-test and revert | 14 |
| SHOULD: Clef triage and risk card | 15 |

Every acceptance check starts with `npm run check` (exit 0) on merged `main`. The commands listed under a slice are in addition. "On `test`" means on the deployed `test` environment after `npm run deploy:test`.

### 2.1 Slice 0: scaffold and `protocol`

| | |
| --- | --- |
| Goal | Every lane can start from one commit: the toolchain, the boundaries, the shared types, and a Worker that deploys and fails closed. |
| Lane | lead |
| Owns | Root files (`package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`, prettier files, `tsconfig.*.json`, `vitest.config.ts`, `vite.config.ts`, `vite.host.config.ts`, `playwright.config.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `AGENTS.md`); `src/protocol/*.ts`; `src/config/**`; the seams of 3.2 (`src/core/trunk/engine.ts`, `src/worker/trunk/effects.ts`, `src/worker/index.ts`, `src/floor/app/registry.ts`); `src/worker/env.ts`, `src/worker/adapters/index.ts`, `src/worker/adapters/not-built.ts`; `test/arch/**`; `test/support/**`; `test/cases/load.ts`, `test/cases/required.json`, `test/cases/list.test.ts`; `scripts/build/**`, `scripts/ops/**`; `docs/measurements/README.md`; the corrections of 0.1 and 0.2 in `docs/spec/`. Slice 0 also creates, as stubs that their lanes own from IP0 on: every wiring module of 3.2 (an empty `wire` function), and the seven class files (`src/worker/trunk/trunk-do.ts`, `agent/agent-do.ts`, `floor/floor-do.ts`, `gate/gate-do.ts`, `workflows/swarm.ts`, `workflows/green-line.ts`, `workflows/attempt-repo.ts`), each a class that answers `not_built`. |
| Depends on | nothing |

`src/protocol` files and their sources:

| File | Defines | Source |
| --- | --- | --- |
| `ids.ts` | `i_`, `a_`, `c_` ids, `call_id`, the `submit_id` formula | 01-core 1, 4.1, 4.9 |
| `constants.ts` | Every constant of 01-core Appendix C, 02 Appendix B and 03 Appendix A; the switches | |
| `premise.ts` | `PremiseKind`, `PremiseRef`, key formats | 2.2, 4.1 |
| `tools.ts` | `ToolRequest`, `ToolResponse`, `ErrorCode`, arguments and results of the seven tools, `SubmitResult`, `Check`, `SubmitError`, sync and register calls, `ModelToolMessage` | section 4 |
| `operations.ts`, `headsup.ts`, `attempt.ts`, `cards.ts`, `note.ts` | `Operation`; `HeadsUp`, `HeadsUpItem`, `Diff`; `AttemptState`, stop reasons, transition ids; `Card`, `CardOption`, `BlastRadius`, `FrameAddress`, `RiskAnswers`; `Note` | 5.1, 8.2, 9.1, 9.2, 10.3, 3.5 |
| `events.ts`, `stream.ts`, `replay.ts` | `PoolEvent`, `EVENT_TYPES`; socket frames and the `(src, epoch, source_n)` envelope; the Replay header and file checks | 12.1, 12.2, 12.3 |
| `routes.ts` | Method, path and role of every route | 13.6; 02 4.2 |
| `channel.ts` | `FloorToPool`, `PoolToFloor` | SE16 |
| `ports.ts` | The interfaces of 1.7, `Sql`, `Driver` | section 15; 02 4.9; 1.3 |
| `swarm.ts`, `floor-json.ts` | `SwarmConfig`; the shape of `/floor.json` with `features` | 02 10.1; 03 4.5 |
| `redact.ts` | `redact()` | SE5a |

Acceptance:

```
npm ci && npm run check
CASES=list npm run test:cases
npm run dev        # then, in a second shell, the three curl probes below
```

1. `CASES=list` prints `57 cases, 23 hash cases, 5 inbox cases, format premise-cases/2, required: 0`.
2. A constants test parses the three constants tables out of the specification files and compares every name and value with `constants.ts`. A difference fails.
3. `EVENT_TYPES` has the 35 types of 12.1; `routes.ts` has the 20 rows of 13.6 and the 6 rows of `02` 4.2; `ErrorCode` has 17 values; there are 10 attempt states and 16 stop reasons.
4. `redact()` has one test per pattern family of SE5a.
5. `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8787/api/pools -H 'content-type: application/json' -d '{}'` prints `503` with no `OWNER_KEY`, `401` with a key set and none sent, and `415` when the content type is `text/plain`.
6. `AGENTS.md` exists and names every command of 1.5 and every lane of 3.1. Its lane table is generated from `scripts/ops/lanes.json`.
7. Every seam and every wiring module of 3.2 exists. Every port of 1.7 resolves to `adapters/not-built.ts`, whose methods fail closed with the code `not_built`. `npm run check:lane -- leaf main` exits 0, and exits 1 for a fixture branch that touches `src/core/git/`.
8. `npm run deploy:test` succeeds. On `test`, with `OWNER_KEY` set: the request of item 5 answers 401 with no key sent and 415 with `text/plain`; `GET /api/pools/x/stream` answers 503 from the stub Floor class.

### 2.2 Slice 1: tracer

Goal: one scripted agent reads, edits and submits; Trunk validates and lands one ordinary commit and one note on Artifacts; the Floor shows it; the pool page updates.

```
POST /api/swarm ──► Agent DO (ScriptedDriver, pattern add-plain)
                      │  list, read, write, submit           (ToolRequest / ToolResponse, section 4)
                      ▼
                   Trunk DO ── engine ── SQLite: premises, ops
                      │  tick: replay ─► tree, commit, note, pack ─► outbox (pending)     one transaction, no await
                      ├─► Floor DO: landing.accepted ─────────────► socket ─► Floor: "Landing…"
                      ├─► Pusher: main + refs/notes/premise, compare-and-swap ─► Artifacts
                      └─► Floor DO: batch.pushed, landing.landed ─► socket ─► Floor: "Landed", probe ─► pool frame
                                                     app server: ~head.js, v/c-<commit>/… ◄── Artifacts
```

(DO: Durable Object.)

Ten tracks run at the same time. Each has its own check, so a track is known good before integration.

| Track | Lane | Owns | Done when |
| --- | --- | --- | --- |
| 1A | leaf | `src/core/sync/**`, `keys/**`, `entities/**`, `refs/**`, `replay/**`, `policy/**` | `H01` to `H23` pass. The worked examples of 2.4 (`5149f012fe7cd2dfd8820a214ea41ff0`), 2.5 and 6.2 (the `creatures/fish.js` table) pass. Each of OP1 to OP5 and PO1 to PO4 has a test named with its id. |
| 1B | git | `src/core/git/**`, `test/git/**`, `src/worker/adapters/pusher/**`, `token-source/**`, `notes-reader/**`; `src/worker/trunk/push-runner.ts` (first version: one request per batch, no retry), `src/worker/trunk/wiring/git.ts` | `npm test -- test/git`: the example commit of 3.5 has id `6bd48525d87d048e928a6dce65cd7e033fcbd839`; every object id equals `git hash-object`; a pack passes `git index-pack` and `git fsck --strict`; one request updates `refs/heads/main` and `refs/notes/premise` on a `git http-backend` server; a stale old id is refused; `git notes --ref=premise show` prints the note bytes of NT1. |
| 1C | engine | `src/core/trunk/` files `schema`, `registry`, `tools-read`, `tools-edit`, `premises`, `sets`, `submit`, `tick`, `landing`, `events`, `intents`, `wiring/engine`; `test/cases/driver.ts`, `test/cases/run.test.ts` | `C01`, `C23`, `C28` pass in Node. The schema is the whole of 3.2. The check `policy` (CK9) is in every submit's `checks` from this track on. |
| 1D | trunk | `src/worker/trunk/` files `trunk-do`, `sql`, `after-commit`, `alarm`, `wiring/trunk`; `src/worker/routes/` files `session`, `pools`, `wiring`; `src/worker/security/**`; `test/workerd/trunk/**` | In workerd: a tool call commits its transaction before any request leaves the object (SY2, shown by the fake remote's request log); SE1 to SE3 each have a test; the pool-create response holds no token (SE5). |
| 1E | stream | `src/protocol/reducer/**`; `src/worker/floor/**`; `test/fixtures/streams/**`; `scripts/fixtures/**` | Reducer tests for the event types this slice emits, with expected state from `03` 4.3 (AC2). In workerd: a repeated `source_n` is ignored, a gap is refused, a higher epoch restarts at 1 (EV2); a second client message closes the socket; a snapshot join gives the same state (AC1). Fixtures `tracer.ndjson`, `hero-c04.ndjson`, `hero-c05.ndjson` exist; they are written from the event types of 12.1 and the expectations of vectors `C04` and `C05`, not from an engine run (BP1). |
| 1F | floor-shell, floor-rail, floor-pool | floor-shell: `src/floor/main.tsx`, `app/**` except the seam and the other two wiring modules, `stream/**`, `styles/**`, `state/**`, `replay/player.ts`, `components/strip`, `components/banners`, `test/e2e/shell/**`. floor-rail: a minimal `components/attempt-card`, `app/wiring/rail.ts`, `test/e2e/rail/**`. floor-pool: a minimal `components/pool-frame`, `app/wiring/pool-area.ts`, `test/e2e/pool-area/**`. | `npm run dev:floor`, then `/replay/tracer` plays the fixture under the REPLAY banner with no Worker running. AC3 passes. |
| 1G | pool | `seeds/tidepool/**`; `scripts/seeds/**`; `test/tidepool/**` except `scenarios/`; `src/host/**`; `src/worker/app-server/**` (with its `wiring.ts`); `src/worker/adapters/pool-source/**` | Rows A1, A2 and A8 (for the seed modules) of `02` Appendix A pass. A test extracts the five "MUST be exactly this" blocks from `02-tidepool.md` (`world/energy.js`, `creatures/fish.js`, `GUIDE.md`, `index.html`, `.premise/policy.json`) and compares them with the seed files. The line and export limits of TP5 and TP6 hold for all 21 files. With `PoolSource` option E in a browser test: the pool runs, posts `stats`, and adopts a new creature file without a reload (`02` 4.7). |
| 1H | agent | `src/core/agent/**`; `src/worker/agent/` files `agent-do`, `journal`, `inbox`, `trunk-client`, `scripted-driver` | `I01` to `I05` pass. In workerd: the journal row exists before a tool call and is gone after it (AG1); a repeated `call_id` returns the stored response (TA2). |
| 1I | copy | `src/copy/**` | All of `03` section 5 is transcribed. AC7 (ids exist) and AC20 (phrase lint) pass. |
| 1J | swarm | `src/swarm/` files `prng`, `pattern`, `patterns/add-plain`; `src/worker/routes/swarm.ts` (launches scripted Agent Durable Objects directly; GP2) | The same seed gives the same tool calls (SW1). The written file equals template T-plain of `02` 10.2. |

Acceptance (the lead, at IP1):

```
CASES=required npm run test:cases
npm run test:workerd
npm run deploy:test
npm run pool:create -- it-tracer tidepool-swarm
npm run test:integration -- tracer stock-git
npm run test:e2e -- --project=deployed tracer
```

1. Event 1 of the pool's stream is `pool.state` with `head_seq: 0`; `pool.files` follows (EM1).
2. After one `add-plain` agent is launched, the stream holds, in this order: `attempt.opened`, `submit.result` (`validated`), `landing.accepted`, `batch.pushed`, `landing.landed` (EV3). At the moment `landing.landed` is appended, `git ls-remote` shows `refs/heads/main` at that commit (LP9).
3. With a read token and stock git: `git log -1 --format=%B | git interpret-trailers --parse` prints exactly a `Change-Id` and an `Intent-Id` line; the author name is `SYNTHETIC swarm` (CM1); `git fetch origin refs/notes/premise:refs/notes/premise && git notes --ref=premise show HEAD` prints JSON with `"seq":1`; `git hash-object` of that output equals `landing.landed.note`; `git fsck --strict` passes.
4. In a browser on the `test` address: the SYNTHETIC banner is shown; the card reads "Landing…" and changes to "Landed" only with `landing.landed` (FL3); the Landed counter reads 1; the pool frame shows one more creature with its white ring within `HEAD_POLL_MS` of that event, without a page reload.
5. `curl -sI <address>/pool/it-tracer/main/` shows a `Content-Security-Policy` with `sandbox allow-scripts` and `connect-src 'none'` (SE14). A `v/c-<commit>/` file has `Cache-Control: public, max-age=31536000, immutable` (SE20). `.premise/policy.json` under a version path answers 404 (SE15).
6. A mutating request without the key answers 401. The same `POST /api/pools` sent twice with one `request_id` creates one pool (9.8).

### 2.3 Slice 2: live premises

| | |
| --- | --- |
| Goal | A landing that changes something an in-flight attempt relied on reaches that attempt, in the accept transaction, as a heads-up with the exact diff. The attempt goes around and lands. Attempts that did not rely on it are not disturbed. |
| Builds | 7.1, 7.2 (every row; triage rows answer `confirm`, `triage_unavailable`, by TR5), 7.4, 7.5, section 8, 6.4, 9.3, 9.4 steps 3a and 3b and the checks of step 3c (row `CKL`), 11.1, 11.2 (RW1 to RW4), the card route, and the transitions of 9.2 with these exceptions: T3 and T12 (Slice 15), T17 and T17a (Slice 3), T18 to T19s (Slice 13). T4, T13 and T14 are built here in their minimal form, because a `held` tier must fail closed in every build: state `held`, `card.opened` with `preview: null` and an empty blast radius, and the options `land` and `decline`. Slice 11 adds what the card shows, `land_now`, and the CK9 part of step 3c. |
| Lanes | leaf, engine, trunk, agent, swarm |
| Owns | `src/core/classify/**`, `src/core/diff/**`; `src/core/trunk/` files `classify-batch`, `headsup`, `transitions`, `blind-spot`, `go-around`, `right-of-way`, `cards`; `src/worker/trunk/headsup-push.ts`; `src/worker/routes/cards.ts`; `src/worker/agent/heads-up.ts`; `src/swarm/patterns/` files `add-energy`, `add-relative`, `rescale-energy`, `cosmetic`; `test/integration/collide/**` |
| Depends on | Slice 1; GP2 and GP5 closed (for `collide`) |
| Cases | `C02`, `C03`, `C04`, `C05`, `C08`, `C09`, `C10`, `C11`, `C13`, `C14`, `C15`, `C16`, `C17`, `C24`, `C25`, `C26`, `C27`, `C29`, `C30`, `C32`, `C33`, `C36`, `C37`, `C39`, `C40`, `C41`, `C43`, `C44`, `C45`, `C46`, `C47`, `C54`, `C56`, `C57` |

Acceptance:

```
CASES=required npm run test:cases
npm test -- src/core/classify
npm run test:integration -- collide            # on test, pool seeded from tidepool-swarm
```

1. `src/core/classify` has at least one test named with each row id of 7.2: `X0`; `E0`, `E1`, `E2`, `E2m`, `E3`, `E4`; `F0`, `F1`, `F2`, `F3`, `F3m`, `F4` to `F7`; `L0` to `L3`, and L1 checked late; `QT0` to `QT3`; `QR0`, `QR1`, `QR1m`, `QR2`, `QR3`, `QR4`; `QO0` to `QO2`; `B1`; `CKL`; `Z1`. One test runs the first steps of `C06` with `CLEF_TRIAGE` off and expects `confirm`, reason `triage_unavailable`, in the same heads-up (TR5).
2. `collide`, order 1, on a pool that is not quiet (GP5): an `add-energy` agent is held before its submit (`op.recorded` for its file is the signal); a `rescale-energy` agent lands. The stream then has `headsup.sent` for the `add-energy` attempt with `result: "repair"`, `keys[0]` equal to `{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }`, `items[0].diff.before` containing `ENERGY_MAX = 100` and `after` containing `ENERGY_MAX = 1`; then `attempt.state` to `going_around` with `go_arounds: 1`; after release, `headsup.resolved` with a statement, then `landing.landed`. The landed file passes the oracle SW2. Its note has one `go_arounds` entry with rule `E2`.
3. `collide`, order 2: `rescale-energy` is held before its submit; `add-energy` lands. `headsup.sent` goes to the `rescale-energy` attempt with rule `QR1` in `keys` and the new referrers in `items[0].diff.added`.
4. An `add-plain` attempt in flight during either order receives no `headsup.sent`. A `cosmetic` landing causes no `headsup.sent` for any attempt (E0, F2).
5. `add-relative` in flight in order 1 receives the `E2` repair and acknowledges with no new operation. This is the designed false abort (`02` 10.3) and is counted by metric 14.4.
6. The same order 1 on a quiet pool: `headsup.sent` has the same `keys` and `items: null`, and the stream holds no `premise.recorded`, `op.recorded` or `attempt.step` (EV6).
7. On a pool created from the seed `tidepool`, a scripted `rescale-energy` submit answers `held`, the stream has `card.opened` of kind `held`, and nothing lands until `POST …/cards/<card_id>` with option `land` (T4, T13). With option `decline` the attempt stops with `declined` (T14).

### 2.4 Slice 3: durable landing

| | |
| --- | --- |
| Goal | An accepted landing is never lost, never applied twice, and never called landed before it is on `main`, through restarts, deploys and partial pushes. Trunk's SQLite can be rebuilt from Artifacts. |
| Builds | 9.6, 9.7, 9.8, 9.9 (LP3 to LP11), AL1 to AL4, 3.6 (RB1 to RB5, `register`), T17, T17a, the rebuild route |
| Lanes | git, trunk. The three engine files below belong to the git lane, so this slice runs beside Slice 2. |
| Owns | `src/core/outbox/**`, `src/core/rebuild/**`; `src/core/trunk/` files `outbox-apply`, `restart`, `register`; `src/worker/trunk/` files `push-runner`, `reconcile`, `rebuild-job`, `timers`; `src/worker/routes/rebuild.ts`; `test/workerd/landing/**`; `test/integration/landing/**` |
| Depends on | Slice 1 |
| Cases | `C20`, `C21`, `C22`, `C50`, `C51` |

Acceptance:

```
CASES=required npm run test:cases
npm run test:workerd -- landing
npm run test:integration -- pushes rebuild deploy-drill
```

1. workerd, with a real bare repository behind a proxy that can drop a response, answer 401, 429 or 503, or apply one ref only: each row of the LP5 table produces its action (`mark_pushed`, `retry_notes`, `repush`, `retry_main`, `pause`). `PUSH_REJECT_LIMIT` rejections with both refs unchanged pause the pool with `push_rejected` (LP5b). Trunk aborted between acceptance and push: after the next request the remote holds exactly one commit per landing.
2. `pushes` (real service): 300 single-landing batches in a row give 300 `batch.pushed` and no `pool.paused`. The report holds push time p50 and p99 and the number of retries.
3. `rebuild` (real service): after 5 landings, `POST …/rebuild` gives `pool.state` `rebuilding`, then `ready` with `epoch` one higher and `head_seq: 5`; the notes of landings 1 to 5 have the same blob ids as before; the next landing is `seq` 6.
4. `deploy-drill` (real service): `npm run deploy:test` runs while 64 scripted agents are in flight. Afterwards: commits on `main` after the seed equal `head_seq`; every landing has exactly one `landing.landed`; the stream's `n` has no gap; every attempt is `landed` or `stopped` with a reason; `epoch` is unchanged.

Limit of this evidence: an eviction cannot be forced on the real platform. Item 1 covers it on local workerd; item 4 covers a deploy.

### 2.5 Slice 4: real agents behind the model gate

| | |
| --- | --- |
| Goal | A typed intent gets a real Workers AI agent that reads through Trunk, edits, adapts to a heads-up with its context intact, and lands. Every model call passes the model gate. The kill switch and the spend cap stop model calls. An evicted agent ends in a recorded state. |
| Builds | 3.3 (AG1 to AG7), 4.10 (HE1 to HE4), 13.3 (SE6 to SE9), 13.4 (SE10 to SE12), the intent, kill and stop routes, `ModelPlan`, the Agent's side of `register` (3.6 step 6). Track 4D: attempt repos (AG5, S3). |
| Lanes | agent, trunk |
| Owns | `src/core/gate/**`; `src/worker/gate/**`; `src/worker/agent/` files `model-driver`, `prompt`, `recovery`, `watchdog`, `register`; `test/workerd/agent/**`, `test/workerd/gate/**`; `src/worker/adapters/model/**`; `src/worker/routes/` files `intents`, `kill`, `stop`; `scripts/measure/**`; `docs/measurements/models/**`. Track 4D: `src/worker/adapters/attempt-repo/**`, `src/worker/workflows/attempt-repo.ts`, `src/worker/agent/checkpoint.ts` |
| Depends on | Slice 2 |
| Cases | none new |

Acceptance:

```
npm run test:workerd -- agent gate
npm run test:integration -- real-agent kill cap
npm run measure:models
```

1. `real-agent`: `POST /api/pools/<pool>/intents` with intent A01 ("a jellyfish that drifts up and down") ends in `landing.landed` within `ATTEMPT_TIMEOUT_MS`. The commit's author name is the model id (CM1). Model turns in `attempt.step` carry `tokens_in`, `tokens_out` and `cost_usd`. `limits.spend_usd` rises.
2. `kill`: after `POST /api/kill {"killed":true}`, `limits.killed` is true, each in-flight attempt stops with `killed` at its next step, and a change that was already `validated` still lands (SE11). `{"killed":false}` clears it.
3. `cap`: deployed with `--var SPEND_CAP_USD:0.01`, the attempt stops with `spend_cap`, `limits.refusing` is true, and in workerd the fake `AI` binding counts zero calls.
4. workerd, with a model plan whose `max_real_agents` is 2: of three intents the third attempt stays `opened`, and `pool.state` shows `real_agents: 2`, `max_real_agents: 2` (SE8). After a rebuild from Artifacts, an Agent that is answered `attempt_unknown` calls `register` with its mirror and continues (3.6 step 6).
5. workerd: an Agent aborted during a model call retries from its journal at most `MODEL_RETRIES` times and then stops with `model_error` (AG2). With no journal row and state `working` it continues. The watchdog stops it with `stalled` only under the three conditions of AG3. An unsettled reservation is charged in full (SE6a). A rate-limit answer makes a `gate` timer and no retry count (SE8).
6. A heads-up placed in a tool result is acknowledged by the next submit of the same Agent Durable Object, and the transcript's step numbers continue (HE1). Text inside the heads-up never appears in the system role (HE4).
7. Track 4D: `attempt.repo` with `ok: true`; the repo in the `ATTEMPTS` namespace has `refs/heads/attempt` with `transcript.jsonl`, `ops.json`, `premises.json`. In workerd, with a provisioner that always fails, the landing still lands and `attempt.repo` has `ok: false` (AG5).

`measure:models` writes one file per model:

```ts
type ModelMeasurement = {
  v: 1; build: string; recorded_at: string; model: string;
  intents: Array<{ id: string; runs: number; landed: number; seconds: { p50: number; p90: number };
                   tool_calls: number; tool_errors: number; tokens_in: number; tokens_out: number; cost_usd: number }>;
  hero: { runs: number; references_energy_max: number; absolute_number: number;
          repaired_correctly: number; repair_ms: { p50: number; p90: number } };   // S5, TP22, metric 14.7
};
```

Plan thresholds for milestone M3:

| Id | Threshold | If missed |
| --- | --- | --- |
| PT1 | With the workhorse model, at least 8 of the 12 additive intents A01 to A12 land in one pass, with no owner action. | RR5 |
| PT2 | Intent to landed: p50 at most 120 s, p90 at most 300 s. | RR5 |
| PT3 | For at least one model, intents P1a and P1b each end with the correct number (`< 0.3`, `drain(…, 0.05)`) after the `ENERGY_MAX` heads-up in at least 4 of 5 runs. | RR6 |
| PT4 | At least `RACE_SIZE` models land at least 6 of the 12 additive intents. | Slice 12 is not built. |

### 2.6 Slice 5: the Floor's MUST surface

| | |
| --- | --- |
| Goal | A person who cannot read code types an intent, watches agents and their premises, and sees a landing, from the stream alone (FL1). |
| Builds | `03` sections 0, 2.1, 2.2, 2.8 to 2.10; components 3.1 to 3.5, 3.7, 3.8, 3.17, 3.18, 3.19 and the card sheet without frames (the last paragraph of 3.13); section 4 for every event type Slices 1 to 4 emit; section 6; the rows of section 7 that need no SHOULD feature (F1 to F14, F16, F17, F20 to F22, F26, F27) |
| Lanes | floor-shell, floor-rail, floor-pool (3.1), stream |
| Owns | `src/floor/components/` directories, by lane. floor-shell: `strip`, `banners`, `owner-key`, `kill-switch`, `toast`; `src/floor/keys/**`. floor-rail: `intent-box`, `attempt-card`, `lights`, `heads-up`, `tray`, `card-sheet` (the sheet of `03` 3.13 without frames, which a choice card uses). floor-pool: `pool-frame`, `tiles`. stream: the remaining handlers under `src/protocol/reducer/`; fixtures for each failure row. |
| Depends on | Slice 1 (track 1F). It runs against fixture streams, so it does not wait for Slices 2 to 4. |
| Cases | none new |

Acceptance:

```
npm run test:e2e
npm run test:e2e -- --project=deployed floor      # after IP3
```

1. Fixture project: AC1 to AC5, AC7 to AC9, AC12, AC13, AC14, AC16, AC17 and AC20 pass; AC15 passes for the rows in scope, in both themes.
2. AC14 in detail: in `hero-c04.ndjson` the light for `world/energy.js#ENERGY_MAX` on the creature's card is `changed` at the landing of the shared rule and `holds` again at the resolving submit.
3. On `test`, as the owner: the key is pasted once and appears in no address, storage, console line or other request (AC16). Typing intent A01 gives a card; one light appears for each `premise.recorded`; the file tiles show reader and writer marks; the strip shows real agents with the limit and its reason, landed, go-arounds, waiting and spend.
4. On `test`, in a fresh browser profile: the document contains no owner control (AC5); the intent box is disabled and says why (FL7).
5. Fixture project, with `features.held` false: a `card.opened` of kind `held` gives a tray row and the card sheet without frames (title, body, paths, the buttons of its options). Land sends one card request that carries the `submit_id` on screen (CO35). No wait on screen lacks its sentence (FL10).

### 2.7 Slice 6: the hero conflict and the plain-merge pool

| | |
| --- | --- |
| Goal | The same changes are shown in two pools side by side: `main`, where the broken premise was caught and repaired, and the plain-merge pool, labelled as constructed. Both landing orders. Deterministic with the canned cast; honest with real agents (TP20). |
| Builds | 11.7 (PM1 to PM6), `ops_first`, the plain-merge repository, `plain.updated`; the `plain` source of the app server; the in-page self-test (`02` 5.5); Compare view (`03` 2.3, 3.6); the canned casts of `02` 7.3 and 8.2 and the conductor (`02` 7.11) |
| Lanes | leaf, engine, git, pool, swarm, floor |
| Owns | `src/core/plain/**`; `src/core/trunk/` files `ops-first`, `plain-apply`; `src/worker/trunk/plain-runner.ts`; `src/swarm/casts/**`, `src/swarm/conductor.ts`; `src/floor/components/` directories `compare`, `plain-frame`; `test/tidepool/scenarios/**`; `test/integration/hero/**`; `scripts/rehearse/**` |
| Depends on | Slices 2, 3, 5; GP1, GP2, GP4 and GP5 closed |
| Cases | none new |

Acceptance:

```
npm test -- test/tidepool/scenarios
npm run test:integration -- hero
npm run rehearse:hero -- --runs 20
```

1. `scenarios`: rows A3 to A7, A8 (for the canned files), A10 and A12 to A16 of `02` Appendix A hold on the real seed with the canned operations. Rows A9 and A11 hold for their judgments under the `tidepool-auto` variant; their card expectations move to Slice 11. Row A11 is read with the correction of 0.1.
2. `hero`, order 1, canned cast: `main` ends with `ENERGY_MAX = 1`, `crab.energy < 0.3` and `drain(shrimp, 0.05)`. The plain-merge `main` ends with `ENERGY_MAX = 1`, `crab.energy < 30` and `drain(shrimp, 5)`. `plain.updated.skipped` is empty. J receives no heads-up.
3. Compare view, same seed in both frames: on the left the crab walks; on the right it never leaves its shell. After a probe with `selftest: true` the left badge reads pass and the right badge reads fail with `not_exhausted` for the shrimp. The right frame carries the label `plain.label` and the word "constructed".
4. Pair P4 on a fresh pool: `plain.updated.skipped` lists the second change and the page shows a text-conflict count of 1, with "approximated" next to it (PM3).
5. `rehearse:hero` runs the conductor 10 times in each landing order and writes `docs/measurements/rehearsal/hero-20.json`. Pass (M4): in 20 of 20 runs the heads-up (`E2` or `F3` in order 1, `QR1` in order 2) precedes the dependent landing, and both final trees are as in item 2.
6. With real agents whose code does not depend on the old scale, the page says "no visible difference in this run" and shows no canned code (TP20).

### 2.8 Slice 7: Why card, "show the git", Who relies

| | |
| --- | --- |
| Goal | Any creature on screen explains itself from the landing's note, and the same record is readable with stock git. |
| Builds | `03` 3.9, 3.10, 3.11, 2.5; the note route and the read-token route (13.6, SE5c); FS2, SE19 |
| Lanes | floor, stream, trunk, git |
| Owns | `src/floor/components/` directories `why`, `git-drawer`, `who-relies`; `src/protocol/reducer/` files `why`, `who-relies`; `src/worker/floor/public-reads.ts`; `src/worker/routes/read-token.ts` |
| Depends on | Slices 1, 2, 5 |
| Cases | none new |

Acceptance:

```
npm run test:e2e -- why
npm run test:integration -- why
```

1. Tapping a creature opens its Why card: the requester's words, the model, what it relied on, each go-around with its cause and the agent's statement, the checks, how it landed.
2. "Show the git" shows the commit id, the two trailers, the note and two git commands. For a landing by a real agent, the body of `GET /api/pools/<pool>/landings/<seq>/note` has the blob id given in `landing.landed.note`. On a quiet pool the route answers 404 and the drawer says so (13.6).
3. A token from `POST …/read-token` clones the repo and is refused on push. The adapter never calls `createToken` without a scope (unit test).
4. Who relies on `ENERGY_MAX` lists the landed changes and the in-flight attempts; the pool frame receives `highlight`.
5. workerd: during 100 public reads (Why, who relies, metrics, a ref-following frame) Trunk receives 0 requests (SE19).

### 2.9 Slice 8: Swarm with measured numbers

| | |
| --- | --- |
| Goal | One Trunk, one pool, a thousand scripted agents on the same tools and landing path, under the SYNTHETIC banner, with numbers that were measured in the run on screen. |
| Builds | `02` 10.1 to 10.4 (the remaining patterns, the collision dial, SW1 to SW3); the Swarm Workflow and its route; the `metrics` event (EM5, section 14); `ScriptedTriage` (TR8); EV6; `03` 2.6, 3.15, row F24 |
| Lanes | swarm, stream, floor |
| Owns | `src/swarm/patterns/` files `retune`, `edit-creature`, `sweep-colour`, `sweep-search`, `same-file`, `reader`, `blind`; `src/swarm/` files `dial`, `oracle`, `scripted-triage`; `src/worker/workflows/swarm.ts` (the route of track 1J now starts it); `src/protocol/reducer/metrics.ts`; `src/worker/floor/metrics.ts`; `src/floor/components/swarm/**`; `scripts/soak/**`; `docs/measurements/soak/**` |
| Depends on | Slices 2, 3, 5 |
| Cases | none new |

Acceptance:

```
npm test -- src/swarm src/protocol/reducer/metrics
npm run soak -- --agents 1024 --dial 0,0.1,0.25,0.5,1 --seed 7
npm run test:e2e -- swarm
```

1. Each metric of 14.1 to 14.8 has a reducer test whose expected value is worked by hand from a fixture stream and the definition in section 14.
2. The soak passes every check of VE6 (5.2).
3. Swarm view: the SYNTHETIC banner with the agent count and "no model calls"; the four large numbers come from `metrics` events; moving the dial changes `swarm.state.collision_dial`.

### 2.10 Slice 9: Replay with no credentials

| | |
| --- | --- |
| Goal | A judge opens one address with no account and no key, and the same page plays the recorded stream. |
| Builds | `03` section 8 (RP1 to RP25), 2.7, 3.16; the export route and the check of 12.3 RP1; the list of recordings |
| Lanes | floor, stream, lead |
| Owns | `src/floor/replay/**` except `player.ts`; `src/worker/floor/export.ts`; `scripts/recordings/**`; `public/replay/**`; `test/e2e/replay/**` |
| Depends on | Slices 5, 6 |
| Cases | none new |

Acceptance:

```
npm run record:export -- --pool <pool> --id hero
npm run test:e2e -- replay
```

1. A fixture stream with a planted string that matches `redact()` is refused by the export, which names the line (RP1).
2. AC1, AC6 and AC18 pass. RP25: against a local Worker started with no `OWNER_KEY`, in a browser context with no cookies, way 1 and way 3 of `03` 8.7 play the recording to its end, and the network log holds only the requests of RP1.
3. The same test against the deployed address, with no cookies: the frames load their commit addresses (RP10).
4. A recording of a synthetic pool shows both banners (RP3). Chapter keys jump to the chapters of `03` 8.5.

### 2.11 Slice 10: README, About, run instructions

| | |
| --- | --- |
| Goal | A stranger can run it and knows its limits. |
| Builds | `README.md`, the About sheet (`03` 5.12), the three submission texts |
| Lanes | lead, floor |
| Owns | `README.md`; `src/floor/components/about/**`; `src/copy/limits.ts`; `docs/submission/**`; `scripts/submission/**` |
| Depends on | Slices 1 to 9 |
| Cases | none new |

Acceptance:

```
npm run check:submission
git clone . /tmp/premise-fresh && cd /tmp/premise-fresh && npm ci && npm run check
```

1. `run.txt` has at most 4,000 characters; `vision.txt` and `cloudflare.txt` at most 2,000 each. The phrase lint (BP11) passes. The limits list in the README equals the one in About (AC19).
2. A builder that is given only the README reaches a playing Replay with `npm run dev:floor`, and a deployed `test` Worker with a created pool, by typing the README's commands unchanged.
3. Every number in the README names the file under `docs/measurements/` it came from (section 14, last sentence).

### 2.12 Slice 11: held-path card with before and after

| | |
| --- | --- |
| Goal | A change to a held path waits for one owner tap on a card that shows the pool before and after and which waiting changes it would send back. |
| Builds | 10.2 (T4, T13, T14), PV1 to PV4, 11.6 blast radius, RW5, 9.4 step 3c with CK9; `03` 2.4, 3.13, row F15 |
| Lanes | engine, git, trunk, floor |
| Owns | `src/core/trunk/` files `held`, `blast-radius`, `preview`; `src/worker/trunk/preview-runner.ts`; `src/floor/components/held-sheet/**`; `test/integration/held/**` |
| Depends on | Slices 2, 5, 6 |
| Cases | `C18`, `C34`, `C35`, `C48`, `C49` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:integration -- held`, `npm run test:e2e -- held`.

1. On a pool seeded from `tidepool`: canned S submits and the card opens with blast radius `repair: [C, H]` (row A9). The sheet shows two frames: "before" at the last landed commit of `main`, "after" at a commit under `refs/previews/<submit_id>` of the plain-merge repository.
2. Tapping Land: S lands; C and H receive `repair`. Tapping an out-of-date card does nothing and the sheet says so (`C34`).
3. `curl` to any `a_` or attempt path of the app server answers 404 (PV4).

### 2.13 Slice 12: Race and choose

| | |
| --- | --- |
| Goal | Three models attempt one intent; the owner compares three running pools and chooses one; it lands through the same gate. |
| Builds | 11.4 (RC1 to RC5), the race card (CD2), `03` 3.14 |
| Lanes | engine, trunk, agent, floor |
| Owns | `src/core/trunk/race.ts`; `src/floor/components/race-sheet/**`; `test/integration/race/**` |
| Depends on | Slices 4, 11; PT4 |
| Cases | none new (`C54` is already required) |

Acceptance: `npm run test:integration -- race`, `npm run test:e2e -- race`.

1. An intent with `race: true` opens `RACE_SIZE` attempts with different models. Each goes to `held` on one race card whatever its tier (RC2).
2. A candidate that goes around is shown with `can_choose: false`; the card stays open (RC5).
3. Choosing one lands it; the others stop with `not_chosen`; their attempt repos still exist (RC4).

### 2.14 Slice 13: causal Undo

| | |
| --- | --- |
| Goal | Undo takes back one landing and exactly the later landings built on it, and reopens their agents with their transcripts. |
| Builds | 11.3 (UN1 to UN8), T18, T19, T19s, AG6, the two undo routes; `03` 3.12, row F23 |
| Lanes | leaf, engine, trunk, agent, floor |
| Owns | `src/core/undo/**`; `src/core/trunk/` files `undo-apply`, `reopen`; `src/worker/routes/undo.ts`; `src/worker/agent/reopen.ts`; `src/floor/components/undo-sheet/**`; `test/integration/undo/**` |
| Depends on | Slices 2, 4, 5 |
| Cases | `C19`, `C53` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:integration -- undo`.

1. After the hero in order 1 with a real crab agent: the plan for the shared-rule landing lists the crab under reverted and reopened and the unrelated creatures under kept readers (UN4).
2. Confirming lands one commit of kind `undo` with `Undoes:` trailers. The crab's attempt returns to `going_around` with `revision: 2`, the same model and continuing transcript steps (UN6), and lands again.
3. A confirm whose `expect_reverted` no longer matches answers `plan_changed` and lands nothing (UN5).

### 2.15 Slice 14: green line

| | |
| --- | --- |
| Goal | `refs/heads/green` follows the newest verified commit. A confirmed red reverts and reopens. |
| Builds | 11.5 (GR1 to GR7); `02` 5.4; the `Verifier` chosen by S4; `03` rows F19 and the green cell of the strip. Part 14a: runtime `static`, GR1, GR2, GR4, GR5. Part 14b: the measured runtime and GR3. |
| Lanes | git, pool, engine, floor |
| Owns | `src/core/trunk/green.ts`; `src/worker/workflows/green-line.ts`; `src/worker/adapters/verifier/**`; `src/floor/components/green/**`; `test/integration/green/**` |
| Depends on | Slice 3 for 14a; Slice 13 and the S4 record for 14b |
| Cases | none new |

Acceptance: `npm run test:integration -- green`.

1. 14a: after a landing, `git ls-remote` shows `refs/heads/green` at the head commit; the stream has `green.verified` with `runtime: "static"` and `green.advanced`; the strip says "static checks only".
2. 14b: the plain-merge tree of the hero (row A5), pushed to a throwaway pool as a landing, gives `green.verified` with `ok: false` twice, then one landing of kind `revert` and reopened attempts (GR3). The log appears in no event and no heads-up (GR7).
3. 14b: the verifier's environment has no binding and no outbound network (GR6), shown by a test creature that tries both and is refused.

### 2.16 Slice 15: Clef triage and the risk lines

| | |
| --- | --- |
| Goal | Where an agent read something that changed and its patch does not name it, Clef gives a recorded probability instead of a blanket `confirm`. A held card shows three risk answers. |
| Builds | 7.3 (TR1 to TR9), V7, V7a, 10.4 (RK1 to RK4), GL4 if `CLEF_CONTRADICTION` is on; `03` row F18 and the risk lines |
| Lanes | engine, agent, trunk, floor |
| Owns | `src/core/trunk/triage.ts`; `src/worker/trunk/triage-runner.ts`; `src/worker/adapters/triage/**`, `adapters/risk/**`; `scripts/calibrate/**`; `docs/measurements/calibration/**`; `test/workerd/triage/**`; `src/floor/components/risk/**` |
| Depends on | Slices 2, 4; Slice 11 for the risk lines; the S6 record |
| Cases | `C06`, `C07`, `C12`, `C31`, `C38`, `C42`, `C52`, `C55` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:workerd -- triage`, `npm run calibrate:clef`.

1. The eight cases pass in Node with no Clef call (Appendix A, runner rule 5). This part has no dependency on the service and is built even if the adapters are cut.
2. `calibrate:clef` writes the confusion table for at least 48 hand-labelled cases and the thresholds chosen from it (S6). The switches go `on` only if RR7's condition holds.
3. workerd, with a fake `AI` binding that answers with given probabilities, for a real attempt that read a whole shared file while one of its entities changes: the `info` heads-up with a pending item is created in the accept transaction (TR1); the Clef request leaves only after the commit (TR2); a second `premise.judged` carries `clef.p` (JE1); an answer that arrives after a new operation is recorded as `stale` (TR4); a state over `CLEF_STATE_MAX_CHARS` is never sent (TR7); a synthetic attempt causes no request (TR8).
4. The real service is exercised by `calibrate:clef`, which calls the same adapters.

### 2.17 STRETCH

Clef vision check of screenshots, duplicate-intent detection, outside agents over MCP, the audience phone page. None is scheduled before the submission. One may start only when M5 passed with every SHOULD slice in the build and both reviews closed. Otherwise none starts before 2026-10-16.

---

## 3. Parallelism map

### 3.1 Lanes

A lane is a set of paths with one builder at a time. Two tasks that run at the same time are always in different lanes, so their paths are disjoint. Each lane works in its own git worktree on a branch `lane/<lane>/<slice>`. Commits are `<type>: <description>`. Only the lead merges into `main`. Nothing is pushed to a remote until the owner has named one (RR19, SC1).

| Lane | Paths |
| --- | --- |
| lead | Root files, `src/protocol/*.ts`, `src/config/**`, the seam files of 3.2, `scripts/build/**`, `scripts/ops/**`, `scripts/submission/**`, `docs/**`, `README.md`, `AGENTS.md`, `test/arch/**`, `test/support/**`, `test/workerd/cases-smoke.test.ts`, `public/**` |
| leaf | `src/core/` directories `sync`, `keys`, `entities`, `refs`, `replay`, `policy`, `diff`, `classify`, `plain`, `undo`; `test/tidepool/scenarios/**` |
| git | `src/core/` directories `git`, `outbox`, `rebuild`; `src/core/trunk/` files `outbox-apply`, `restart`, `register`; `src/worker/adapters/` directories `pusher`, `token-source`, `notes-reader`, `verifier`; `src/worker/trunk/` files `push-runner`, `reconcile`, `rebuild-job`, `plain-runner`, `preview-runner`; `src/worker/workflows/green-line.ts`; `test/git/**`; `test/integration/landing/**`, `test/integration/green/**` |
| engine | `src/core/trunk/**` except the three files of the git lane; `test/cases/driver.ts`, `test/cases/run.test.ts` |
| trunk | `src/worker/trunk/` (all other files); `src/worker/routes/**` except `swarm.ts`; `src/worker/security/**`; `test/workerd/trunk/**`, `test/workerd/landing/**`; `test/integration/**` except the directories named in other lanes |
| agent | `src/core/agent/**`, `src/core/gate/**`; `src/worker/agent/**`, `src/worker/gate/**`; `src/worker/adapters/` directories `model`, `attempt-repo`, `triage`, `risk`; `src/worker/workflows/attempt-repo.ts`; `test/workerd/agent/**`, `test/workerd/gate/**`, `test/workerd/triage/**`; `scripts/measure/**`, `scripts/calibrate/**` |
| stream | `src/protocol/reducer/**`; `src/worker/floor/**`; `test/workerd/floor/**`; `test/fixtures/streams/**`; `scripts/fixtures/**`, `scripts/recordings/**` |
| floor | `src/floor/**`, `test/e2e/**`. Up to three builders, each on its own directories: shell (`app`, `stream`, `replay`, `styles`, `keys`, header, strip, banners, About, Swarm view), rail (intent box, cards, lights, heads-up, tray, card sheets), pool area (frames, Compare, tiles, Why, git drawer, Who relies, Undo). |
| copy | `src/copy/**`. Used on D1 and D2; then a seam owned by the lead. |
| pool | `seeds/**`, `scripts/seeds/**`, `src/host/**`, `src/worker/app-server/**`, `src/worker/adapters/pool-source/**`, `test/tidepool/**` except `scenarios/` |
| swarm | `src/swarm/**`, `src/worker/routes/swarm.ts`, `src/worker/workflows/swarm.ts`, `scripts/soak/**`, `scripts/rehearse/**`, `test/integration/collide/**`, `test/integration/hero/**` |

### 3.2 Seam files

A seam file holds one registration line per handler and no logic. A slice adds its line in its own branch. When two branches add lines to one seam, the lead merges both lines. No other file is edited by two lanes.

| Seam file | One line per |
| --- | --- |
| `src/core/trunk/engine.ts` | Engine entry (tool, tick step, owner action, effect kind) |
| `src/worker/trunk/effects.ts` | Effect handler that runs after the transaction (push, events, heads-up push, triage, plain, preview, green) |
| `src/worker/index.ts` | Route |
| `src/protocol/reducer/index.ts` | Event type handler |
| `src/floor/app/registry.ts` | View, sheet, key |
| `src/copy/index.ts` | Copy file |
| `src/worker/adapters/index.ts` | Port and the option in use |
| `src/config/features.ts` | Feature switch |
| `wrangler.jsonc`, `package.json`, `test/cases/required.json` | Binding; script or dependency; required case. Lead only. |

Worked example. Slice 3 adds `src/core/outbox/decide.ts` and `src/core/trunk/outbox-apply.ts` (both git lane). Its only edit outside owned paths is one line in `engine.ts` (`pushResult: outboxApply.pushResult`) and one in `effects.ts` (`push: pushRunner.run`). Slice 2, built at the same time, adds `headsup: headsUpPush.run` to the same `effects.ts`. The lead keeps both lines.

A change to `src/protocol/*.ts` after IP0 is a protocol change: a builder asks, the lead edits, every lane rebases the same day.

### 3.3 What runs at the same time

Cells are slice or track ids. A lane with an empty cell helps the lead verify, or fixes findings in its own paths.

| Lane | D1 Oct 4 | D2 Oct 5 | D3 Oct 6 | D4 Oct 7 | D5 Oct 8 | D6 Oct 9 | D7 Oct 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| lead | 0, IP0 | IP1 | IP2 | IP3 | IP4 | IP5 | 10, IP6 |
| leaf | 1A | 1A, 2 (classify, diff) | 6 (plain) | 13 (undo planner) | 6 (scenarios) | | |
| git | 1B | 1B, 3 (outbox) | 3 | 3 (rebuild, deploy drill) | 6, 11 (plain and preview push) | 7 (read token), 14a | 14b |
| engine | 1C | 1C, 2 | 2 | 6 (`ops_first`) | 11 | 13, 15 | 12 |
| trunk | 1D | 1D | 2, 3 | 4 (routes) | 11, 7 (note route) | 13 | 12 |
| agent | 1H | 1H | 4 | 4, `measure:models` | 4D | 13 (reopen) | 15 (adapters, labelled cases) |
| stream | 1E | 1E | 5 | 5 | 7, 8 (metrics) | 9 (export) | |
| floor | 1F | 1F | 5 | 5 | 6, 7, 8 | 9, 11 | 12, 13, 10 |
| copy | 1I | 1I | | | | | |
| pool | 1G | 1G | hot swap, in-page self-test | 6 (`plain` source) | 6 | 14 (harness) | 14b |
| swarm | 1J | 2 (patterns) | 2 (`collide`) | 6 (casts, conductor) | 8 | 8 (soak) | |

Dependencies, as a list of what may not start earlier:

- Every track of Slice 1 after IP0.
- Slice 2 engine work after track 1C passes its three cases. `src/core/classify` (leaf) needs only track 1A.
- Slice 3 needs track 1B and track 1C. It runs beside Slice 2 (different lanes, different files, two seam lines).
- Slice 4's pure parts and gate need only IP0. Its integration needs IP2.
- Slice 5 needs track 1F only.
- Slices 6, 7 and 8 need IP2; their Floor parts need Slice 5's components.
- Slice 9 needs Slice 6 for the hero recording.
- Slices 11 to 15 follow the table of section 2. The engine parts of Slices 13 and 15 need only Slice 2.

### 3.4 Integration points

At each point the lead does these steps in order. A failing step blocks only the lane that fails; its merge is reverted and the others proceed.

1. Rebase each lane branch on `main`. Merge in the order given. Merge seam lines.
2. `npm ci && npm run check && npm run test:workerd`.
3. `npm run deploy:test`, then the integration and browser commands of the slices being merged.
4. Do the observable checks of those slices in a browser on `test`. Save screenshots under `docs/reviews/screens/ip<N>/`.
5. Add the slices' cases to `test/cases/required.json`. Run `CASES=all npm run test:cases` and save the table as `docs/measurements/cases.md`.
6. Write `docs/measurements/integration/ip<N>.md`: commit id, commands, results, open findings. Tag `ip<N>`. Run `npm run cleanup:test`.

| Point | When | Merges, in order | The lead verifies |
| --- | --- | --- | --- |
| IP0 | D1 | Slice 0 | 2.1. The protocol is frozen. Spike records S1 and S2 exist, or the working assumption is noted. |
| IP1 | D2 | 1A, 1B, 1C, 1D, 1E, 1G, 1H, 1J, 1I, 1F | 2.2: the tracer on `test`. Milestone M1. |
| IP2 | D3 | Slice 2 (leaf, engine, trunk, agent, swarm), Slice 3 (git, trunk) | 2.3 and 2.4. 42 cases required. |
| IP3 | D4 | Slice 4, then Slice 5 | 2.5 and 2.6. `measure:models` against PT1 to PT4. Milestone M3. |
| IP4 | D5 | Slice 6, Slice 7 | 2.7 and 2.8. `rehearse:hero`. Milestone M4. |
| IP5 | D6 | Slice 8, Slice 9, Slice 11 | 2.9, 2.10, 2.12. Soak run 1. Milestone M5 for MUST. |
| IP6 | D7 | Slices 12, 13, 14, 15, each on its own; Slice 10 | Each slice's acceptance, or the switch goes off (BP4). The freeze. |
| IP7 | D8 | Fixes from the reviews only | Section 5 in full on the frozen build. `production` deployed, its pool created, the check of BP10 done on it. Milestone M6. |

---

## 4. Schedule

The video is recorded on D9. D10 is margin. Nothing is built after D7.

| Day | Date | Work | Milestone at the end of the day | Cut line: if the day ends behind |
| --- | --- | --- | --- | --- |
| D1 | Sun Oct 4 | Slice 0 in the morning. Spike results arrive and are recorded. Slice 1 tracks start. | IP0 merged. | Slice 1 starts on D2 from the protocol as it is. STRETCH is dropped for good. If no S1 or S2 result has arrived, the tracer uses option A of each and the lead repeats the two checks on `test` on D2. |
| D2 | Mon Oct 5 | Slice 1. `src/core/classify` and Slice 2 patterns start. | **M1**: the tracer passes 2.2 on `test`. | D3 is the tracer only, all lanes. Slice 15's adapters and part 14b are dropped. If the push is the blocker, RR1's trigger has fired: switch option the same day. |
| D3 | Tue Oct 6 | Slices 2 and 3. Slice 4 pure parts and gate. Slice 5 on fixtures. | **M2**: IP2; 42 cases required and passing. | The engine lane stays on Slice 2 on D4. Slice 12 is dropped. |
| D4 | Wed Oct 7 | Slice 4 integration and model measurement. Slice 5 complete on fixtures. Slice 6 parts in leaf, engine, pool, swarm. | **M3**: IP3; PT1 to PT3 measured; kill and cap pass on `test`. | Apply RR5 or RR6. Slice 12 is dropped unless PT4 holds. Track 4D is dropped if it is not merged. |
| D5 | Thu Oct 8 | Slices 6 and 7. Slice 8 patterns and Workflow. Slice 11 engine part. | **M4**: IP4; `hero-20.json` shows 20 of 20. | D6 is Slice 6 only in the lanes it uses. Slice 13 and part 14b are dropped. |
| D6 | Fri Oct 9 | Slices 8, 9, 11. Engine lane reaches all 57 cases. Soak run 1. | **M5 (MUST)**: every acceptance check of Slices 1 to 9 passes at one commit on `test`. | D7 is MUST only. Of the SHOULD slices only Slice 11 may still finish on D7. The Swarm is run at the size that passes (RR9). |
| D7 | Sat Oct 10 | Slices 12, 13, 14, 15 in that order of priority. Slice 10. Security review and design review on the D6 build, by builders that wrote none of the reviewed code. | **M5 (freeze)**: `features` is final. | Each SHOULD slice that has not passed is switched off (BP4). No feature code after this day. |
| D8 | Sun Oct 11 | Review findings fixed, high ones before anything else. Calibrated constants set. Soak run 2 on the frozen build. `production` deployed; its pool created; the check of BP10 done; state P1 to P7 of `03` 1.1 prepared. Rehearsal 1 (scripted browser). Rehearsal 2 (the owner). Recordings `hero` and `swarm` exported. | **M6**: rehearsal 2 completes every beat in order with no use of key `R`; no open high finding. | A beat that failed is replaced by its row of `03` 1.4 and its feature is switched off. If a beat without such a row failed (0, 1, 6, 8, 9, 10), D9 morning is the fix and one more rehearsal, and the recording moves to D9 afternoon. |
| D9 | Mon Oct 12 | Rehearsal 3, then the recording (the owner). The lead watches spend and the stream. | **M7**: one complete take that follows BS1 to BS6. | D10 is the second recording day. Slice 10's remaining work continues beside it; it needs no owner time. |
| D10 | Tue Oct 13 | Cuts (waiting only), export, checks of SC5. Repository made public. Fresh-clone check. Texts final. Test resources cleaned. `OWNER_KEY` rotated. | **M8**: every row of section 7 except SC12 is done. | The best complete take is used. No re-recording after 12:00 PDT on D11. |
| D11 | Wed Oct 14 | The owner submits, target 12:00 PDT, deadline 23:59 PDT. The lead runs SC9 before and after. | **M9**: submitted; the confirmation is saved. | Nothing is cut. Nothing is deployed except a fix for a public address that does not answer. |

Order in which things are dropped, from the top. An item is dropped whole, by its switch.

1. STRETCH.
2. Slice 15 adapters (the build runs with the three Clef switches `off`; the eight cases still pass).
3. Slice 14 part 14b, then part 14a (`green.static`, then `green.none`).
4. Slice 13 (no Undo button; beat 7 becomes more of beat 6).
5. Slice 12 (the crab is one attempt; beat 3 uses the other landing order).
6. Slice 11 (the main pool is created from `tidepool-auto`).
7. Track 4D (`note.attempt.repo` is `null`; About says so).
8. Inside MUST, in this order: laptop and narrow layout polish (stage size is kept), the second catch live (it stays in the canned recording), Swarm size (1,024 down to the largest size that passes VE6).

Never dropped: the landing path of Slices 1 to 3, real agents, the Floor's MUST surface, the hero with the plain-merge pool, the Why card with the git drawer, a Swarm run of some size with measured numbers, Replay, the owner key, the spend cap, the kill switch, the README.

What the owner does, and when:

| Date | The owner | About |
| --- | --- | --- |
| Oct 4 | Confirms that the Cloudflare account is on Workers Paid and that `wrangler login` was done on the build machine. | 5 minutes |
| Oct 7 | Reads the M3 result. Decides RR5's paid option only if the lead asks. | 10 minutes |
| Oct 8, Oct 12 | Opens the Cloudflare billing page and tells the lead the total (RR14). | 5 minutes each |
| Oct 11 | Rehearsal 2 on the Floor, in a browser. | 90 minutes |
| Oct 12 | Rehearsal 3 and the recording. | 3 hours |
| Oct 13 | Approves making the repository public and the cleanup of SC10. Reads the three texts. | 30 minutes |
| Oct 14 | Fills in and submits the form. | 30 minutes |

---

## 5. Verification strategy

### 5.1 Summary

| Id | What | When | Pass | Evidence it produces |
| --- | --- | --- | --- | --- |
| VE1 | Unit tests from the cases | Every commit; every integration point | Every required case passes; at the freeze, 57 of 57 or the exceptions are listed in the README | `docs/measurements/cases.md` (one row per case, the commit id) |
| VE2 | Rule coverage | M5 | Every rule id cited by a case or by an acceptance check of section 2 appears in a test title or in a case's `rules` | `docs/measurements/rules.md` (rule id, tests) |
| VE3 | Real git | Every commit | Object ids equal git's; packs pass `git index-pack` and `git fsck --strict`; stock git reads the notes | Test output; the `stock-git` integration report |
| VE4 | Integration on a dedicated Artifacts namespace | Every integration point | The named tests of section 2 pass on `test` | `docs/measurements/integration/ip<N>.md` |
| VE5 | Browser checks of the Floor | Every integration point from IP1 | AC1 to AC20; the rows of `03` section 7; the deployed checks | Playwright report; `docs/reviews/screens/` |
| VE6 | Swarm soak | D6, D8 | The nine checks of 5.2 | `docs/measurements/soak/<date>-<build>-d<dial>.json`; `public/replay/swarm.ndjson` |
| VE7 | Security review | D7, closed D8 | No open high finding; every row of 5.3 has a result | `docs/reviews/security.md` |
| VE8 | Design review | D7, closed D8 | No open high finding; every row of 5.4 has a result | `docs/reviews/design.md`; `docs/reviews/screens/design/` |
| VE9 | Rehearsal of the beat sheet | D8 (two), D9 (one) | 5.5 | `docs/measurements/rehearsal/rehearsal-<n>.md`; the session's exported recording |
| VE10 | Hero determinism | D5, D8 | 20 of 20 | `docs/measurements/rehearsal/hero-20.json` |

### 5.2 Details

**VE1.** The driver builds an engine over `node:sqlite` from a case's `files`, applies `steps`, and checks `expect` and `final` by the runner rules of Appendix A. `at: n` hashes are computed by `src/core/keys` and `src/core/entities`, which the hash cases check on their own. The driver holds no expected value of its own.

**VE4.** Tests create pools `it-<ULID>` in the `test` namespaces and never touch `production`. Names used in section 2: `tracer`, `stock-git`, `collide`, `pushes`, `rebuild`, `deploy-drill`, `real-agent`, `kill`, `cap`, `hero`, `why`, `held`, `race`, `undo`, `green`. What this does not establish: behaviour under an eviction (covered on local workerd, 2.4 item 1), and behaviour of another Cloudflare account.

**VE5.** Three layers. (a) Fixture streams through Replay in Chromium at 1920×1080, 1440×900 and 320 wide, both themes: every acceptance check of `03` Appendix B. (b) The deployed project against `test`: headers, roles, the tracer, the hero. (c) A hostile-input pass: an intent, a statement and a path that contain markup are shown as text (AC8); a creature that names `fetch`, `document` or `eval` is rejected at submit with `banned_global` (CK6).

**VE6.** One Trunk, one pool per dial value, seeded from `tidepool-swarm`. `SwarmConfig`: `seed` 7, `agents` 1,024, `collision_dial` each of 0, 0.1, 0.25, 0.5, 1, `launch_per_second` set so that Trunk stays under its request-rate guidance (start at 50; the value used is recorded).

```ts
type SoakResult = {
  v: 1; build: string; recorded_at: string; pool: string; config: SwarmConfig;
  agents: { launched: number; landed: number; stopped: Record<string, number>; in_flight_at_end: number };
  landings: { count: number; commits_on_main: number; notes: number; batches: number; pushes: number; push_retries: number };
  metrics: { landings_per_second: number; time_to_land_ms: { p50: number; p99: number };
             go_around_rate: number; confirm_rate: number; false_abort_rate: number; escapes: number;
             waiting_behind_max: number; push_backlog_max: number;
             tick_cpu_ms: { p50: number; p99: number }; push_ms: { p50: number; p99: number } };
  stream: { events: number; bytes: number };
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};
```

Checks. These are about correctness. Speed has no pass mark: the numbers are published as measured, each with its dial value.

| Check | Passes when |
| --- | --- |
| `all_ended` | `in_flight_at_end` is 0 after the run plus `ATTEMPT_TIMEOUT_MS`; every stopped attempt has a reason. |
| `one_commit_per_landing` | `commits_on_main` equals `count`; `notes` equals `count`; each note's `seq` is its commit's position. |
| `oracle` | SW2: `escapes` is 0 (`ESCAPE_TARGET`). |
| `quiet_at_zero` | At dial 0 the go-around rate is 0 (`02` 10.4). |
| `cosmetic_is_silent` | No `headsup.sent` whose cause is a `cosmetic` landing reaches an attempt of another pattern. |
| `never_paused` | No `pool.paused`. |
| `fsck` | `git fsck --strict` passes on a fresh clone. |
| `rebuildable` | After the run, rebuild from Artifacts gives the same `head_seq` and the same head tree id. |
| `false_abort_reported` | `false_abort_rate` is present. Above `FALSE_ABORT_TARGET` it is published as measured and the README says the target was missed. |

Real-agent repair latency (14.7) comes from `measure:models`, never from the soak. Fork throughput (14.8) comes from track 4D's `attempt.repo` events, never from landing numbers.

### 5.3 Security review (VE7)

Done by a builder that wrote none of the reviewed code. Each row gets a test name or a probe with its observed result.

| Area | Rules | Probe |
| --- | --- | --- |
| Owner key and session | SE1 to SE4 | No key configured: 503 on every mutating route. Wrong key: 401. The comparison is one constant-time function with no early return (read of the code). Cookie request with a foreign `Origin`: refused. Body not JSON: 415. |
| Tokens and text | SE5, SE5a, SE5b, SE5c, AG7, RP1 | `npm run check:secrets` on the tree, the history and both recordings. No route returns a token except `read-token`, whose token cannot push. Event error fields hold codes only. |
| Public surface | 13.2, SE19 to SE22 | Every public route is GET. No public request reaches Trunk. Rate limits answer 429 past the limit. Attempt repos are served by no route. |
| Spend and kill | SE6 to SE12 | The checks of 2.5 on `production`. The ledger over-counts on a lost settlement. |
| Sandbox | SE13 to SE18, PV4, PN6, PN7, PN9 | Response headers on every app-server route. The pool document opened directly has an opaque origin. No `unsafe-eval`. The Floor's own policy (SE14a). |
| Verifier | GR6, GR7 | No bindings, no network, the log in no event. |
| Agent input | HE4 | Heads-up and pool text is never in the system role. A pool file that says "ignore your instructions" changes no tool permission. |
| Dependencies | BP5 | `npm audit --omit=dev` shows no high finding; `check:licenses` passes. |

### 5.4 Design review (VE8)

Against `03-floor.md` sections 2, 5 and 6, at stage size and at laptop size, in both themes, on the fixture of each beat.

| Area | Rules | Evidence |
| --- | --- | --- |
| Sizes and regions | 2.1, LY1 to LY5, VD15 to VD19, AC12, AC13 | Measured sizes; screenshots at 7 widths |
| Signals | VD2, VD10, VD11, VD16, AC9 | The five light shapes at 7 pixels; the contrast test |
| Labels | FL4, VD4 | SYNTHETIC, REPLAY and "constructed" on every view and sheet |
| Copy | CP1 to CP7, AC7, AC20 | Lint output; one read of every string on screen |
| Motion | VD1, VD13, VD14, AC11 | Reduced-motion run |
| Keyboard | AX1 to AX5, AC10 | Beats 1 to 7 and 10 with keys only |
| Failures | FA1 to FA4 | One screenshot per row of section 7 |

### 5.5 Rehearsal of the beat sheet (VE9)

On `production`, in a browser, no terminal (BS1). Before each run the state P1 to P7 of `03` 1.1 is checked on the page.

| Run | Driven by | Purpose |
| --- | --- | --- |
| 1 | `test/e2e/rehearsal.spec.ts`, with the canned cast on a second pool | Every control of every beat exists and responds. Repeatable after any fix. |
| 2 | The owner, with real agents | Timing, wording, the owner's path through the page. |
| 3 | The owner, the morning of the recording | The same as the take. |

Record for each run: per beat, start and end on the run clock, the window of `03` 1.2, whether the "Proves" column was observed, any deviation. Pass: every beat observed in order; total at most 10:00; no use of key `R`; the Why card of the crab shows its go-around; the Swarm numbers are on screen; Replay plays in a visitor's browser. A run that fails names the beat and the rule that did not hold.

---

## 6. Risk register

"Responsible" is who watches the trigger and makes the switch. Every trigger is a measured fact, not a feeling. Every fallback is behind an interface that already exists, so the switch is one line in `src/worker/adapters/index.ts` or one switch in `features`.

| Id | Risk | Level | Trigger | Fallback | Responsible |
| --- | --- | --- | --- | --- | --- |
| RR1 | S1, push path. A hand-built pack over receive-pack from Trunk is refused, slow or unreliable. | high | By the end of D2: the harness or the `pushes` test shows a refused pack, or fewer than 300 of 300 batches reach `pushed`, or push p99 above 5 s. | Option B (isomorphic-git for the push only). If B fails the same test: option C, which needs `docker info` to succeed on the build machine; the lead checks that on D1. If C is not possible, the lead tells the owner the same day: nothing can land. | lead |
| RR1a | S1, two-ref atomicity. The server applies one ref and not the other. | medium | The harness reports a non-atomic result, or `retry_notes` or `retry_main` occurs on `test`. | None needed: LP5 decides by ref values either way. The lead confirms that vectors `C50` and `C51` and the workerd fault matrix pass, and records which behaviour the service has. | lead |
| RR1b | S1, reading notes. The binding does not read `refs/notes/premise` by ref. | medium | The harness reports it, or the `rebuild` test fails at step 2 of 3.6. | `NotesReader` from the ref advertisement (`Pusher.readRefs`) plus binding reads by hash (`readCommit`, `readTree`, `readBlob`). | git lane |
| RR2 | S2, token source. A minted token is refused for git from a Durable Object. | high | The harness reports 401 or 403 for the minted token while the `create()` token works. | Option B. If the `create()` token expires before 2026-10-22, the rotation rules of S2 are built and tested on `test` before M6; otherwise rotation is not built and the README states the expiry. Option C only with RR1's container. | lead |
| RR3 | S3, attempt repos. Provisioning is slow or fails under concurrency. | medium | At 10 at a time: more than 5% fail after retries, or ready p90 above 10 s. | The next option of S3 (create, fork, pre-warmed). If none passes: track 4D is off, `note.attempt.repo` is `null`, About says so. No landing is affected in any case (AG5). | agent lane |
| RR4 | S4, green-line runtime. Browser Run cannot be deployed or flakes. | medium | By the end of D2 there is no S4 record; or in 50 runs on the seed more than one verdict is missing or late (`SELFTEST_TIMEOUT_MS`). | Option B. If B fails the same 50 runs: option D (`static`), and the strip says "static checks only" (GR5). Option C only if a container image deployed from the build machine on D2. | git lane, pool lane |
| RR5 | S5, model mix. Workers AI models do not land the seeded intents. | high | PT1 or PT2 missed at M3. | In order: (1) the best measured model becomes the workhorse; (2) the live cast is narrowed to the intents of difficulty E that pass; (3) the lead asks the owner about Claude through AI Gateway (a new paid commitment; the owner decides). `max_real_agents` is set from the measurement in every case. | agent lane; the owner for (3) |
| RR6 | S5, the repair. No model turns `30` into `0.3` after the heads-up. | high | PT3 missed at M3. | The video shows the hero with the canned cast on a second pool under the SYNTHETIC banner, and real agents on additive requests in the main pool. The voiceover and About say so. The catch itself (the heads-up with the diff) is still shown on real agents. | lead |
| RR7 | S6, Clef. Accuracy or latency is not good enough, or the service limits differ. | medium | On the labelled set, with the best thresholds: any case that truly depends gets `holds`; or fewer than half of the independent cases get `holds`; or p95 latency above `CLEF_TIMEOUT_MS`. | Option C: the three switches stay `off`. Triage rows answer `confirm` (TR5). The script does not mention Clef (`03` 1.4). | agent lane |
| RR8 | PS, pool files. Reads by ref lag a push, or `readFile` refuses a commit id. | medium | A frame shows an old file after `landing.landed`, or the harness reports the refusal. | Option A (reads by hash), which cannot lag: the commit id comes from the event. | pool lane |
| RR9 | One Trunk does not carry 1,024 scripted agents. | medium | A soak check fails, or the tick's CPU p99 exceeds `TICK_CPU_BUDGET_MS` at every launch rate tried. | Lower `launch_per_second`, then the agent count, to the largest run that passes all nine checks. The banner and the README state the size that was run. The sharding argument stays an argument. | swarm lane |
| RR10 | The Durable Object's SQLite and `node:sqlite` differ. | low | `test/workerd/cases-smoke.test.ts` fails where the Node run passes. | The engine avoids the construct; the adapter in `test/support` is corrected. Never a test weakened. | engine lane |
| RR11 | The specification files disagree in a place 0.1 does not list. | medium | A builder finds two rules that cannot both hold. | The builder stops that piece, reports both rule ids; the lead decides by the brief and `01-core.md` and edits the file the same day. | lead |
| RR12 | Two lanes need the same file. | medium | A merge conflict outside a seam file. | The lead moves the logic into an owned file and leaves a registration line. | lead |
| RR13 | The schedule slips. | high | A milestone check fails. | The cut line of that day (section 4). | lead |
| RR14 | Spend passes the budget. | medium | `npm run spend` shows more than 80% of an environment's cap; or the owner's billing page shows more than $40 in total. | Measurement runs stop. Rehearsals use the canned cast. The cap itself refuses further calls (SE7). The spike harness's own model calls are outside both gates; their cost is read from its result files and counted in the total. | lead; the owner reads the billing page on Oct 8 and Oct 12 |
| RR15 | Workers AI is slow or limited during the recording. | medium | In rehearsal 3, intent to landed p50 above twice the M3 value. | Record at another hour the same day. The Replay recording stands in for a beat only with the REPLAY banner on screen. | the owner, lead |
| RR16 | The production pool or the address breaks between the recording and Oct 21. | medium | SC9 fails. | BP12. Replay recordings are static assets and play with no Durable Object state (RP6). | lead |
| RR17 | A secret reaches the public repository or a recording. | high | `check:secrets` matches. | The secret is rotated at once; the history is rewritten before the repository is made public; the recording is exported again. | lead |
| RR18 | A real model writes the crab without a number in points. | medium | In `measure:models`, `absolute_number` is below half of `runs` for the chosen model. | Another model for the crab; the seeded wording of TP21 is kept. If none: TP20 applies and the canned recording shows the break. | agent lane |
| RR19 | The build machine is the only copy of the work. | medium | No remote exists (true on Oct 3). | A private remote as soon as the owner names the host and account (section 7, SC1). | the owner |

---

## 7. Submission checklist

"Who" is one of: **lead**; **owner only** (no agent can or may do it); **owner approves** (the lead prepares and acts after a clear yes).

| Id | Item | Check | Who |
| --- | --- | --- | --- |
| SC1 | The repository is public and holds a `LICENSE` file that names the MIT License. | Opened in a logged-out browser. `git log` on the public copy shows no secret (`check:secrets`). | owner approves; the owner names the host and account |
| SC2 | The README has: what Premise is, the public address with the Replay line, run instructions, the limits list, measured numbers with their files, related work with no priority claim. | Slice 10 acceptance. The two arXiv ids and the entry named in the brief resolve when opened. | lead |
| SC3 | "Instructions to run your project": `docs/submission/run.txt`, at most 4,000 characters. It holds, in this order: the Replay line of RP24; prerequisites (Node 22, git, a Cloudflare account on Workers Paid with Artifacts); `npm ci`; `npm run dev:floor` for an offline Replay; `npx wrangler login`; `npm run deploy`; `npx wrangler secret put OWNER_KEY`; `npm run pool:create`; unlocking the Floor; `npm run check`. | `npm run check:submission`. A builder follows it from a fresh clone (2.11). | lead |
| SC4 | "Project vision": `docs/submission/vision.txt`, at most 2,000 characters. It answers "What did you rethink, and why does it matter?": the thesis sentence; what a change replaces; the two catches; what one record serves; the limits. | `check:submission`; BP11. | lead writes; owner approves |
| SC5 | "How you used Cloudflare": `docs/submission/cloudflare.txt`, at most 2,000 characters. It lists only what is in the frozen build: the Worker, the four Durable Objects, Artifacts (pool repo with `main`, `green` and `refs/notes/premise`, plain-merge repo, attempt repos, every write a push with compare-and-swap), Workflows, Workers AI, static assets, the Cache API, and Browser Run and Clef only if their switches are on. | `check:submission`; compared with `features`. | lead writes; owner approves |
| SC6 | The video: MP4 (H.264 video, AAC audio), 1920×1080, 5:00 to 10:00 (target 7:30), under 2 GiB. It follows BS1 to BS6: one session on the deployed system, in a browser, no terminal; cuts remove waiting only; the run clock is in every shot. | `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of json <file>`: duration between 300 and 600, size below 2147483648. One full viewing by the lead against the beat sheet. | **owner only**: driving the session and recording the voice. lead: state P1 to P7, the cuts, the export. |
| SC7 | The session's stream is exported and committed as the `hero` recording; the Swarm run as `swarm`. | 2.10 item 1; both play at the public address. | lead |
| SC8 | Every calibrated constant has its measurement (BP8). Every number spoken in the video is on screen in the take (BS4). | The BP8 test; the lead's viewing. | lead |
| SC9 | The public demo address answers and plays Replay with no credentials. | In a browser with no cookies: `<address>/replay/hero` plays to the end; `<address>/` shows no owner control; `curl -X POST <address>/api/kill` answers 401. Run before the submission, after it, and daily until Oct 21. | lead |
| SC10 | Test resources are cleaned. Deleted: the Worker `premise-test`, every repo in the two `test` namespaces, the spike harness Worker and its `spike` namespace repos. Kept: `production`, its pool repo, its plain-merge repo, the recorded pools, the attempt repos named in notes. Read tokens are revoked. `OWNER_KEY` is rotated after the recording; the new key goes to the owner outside the repository and outside chat. | `wrangler artifacts repos list` for each namespace; the evidence under `docs/measurements/` was committed before the deletion. | owner approves (deletion cannot be undone); lead executes |
| SC11 | The terms hold: original work; licences (BP5); no third-party material without permission; no product is attacked and no GitHub branding appears (BP11); the two confirmations on the form are true. | `check:licenses`, `check:submission`, one read of the README and the texts. | lead prepares; **owner only** confirms on the form |
| SC12 | The form is submitted: team name, primary contact name and e-mail, team location, attendee names and e-mails, project name "Premise", the two texts, the video upload, the repository URL, the run instructions, the two confirmations. | The confirmation page or e-mail is saved by the owner. | **owner only** |

---

## Appendix A. Must-fix items about schedule, scope and measurement

`01-core.md` Appendix B maps the rule and protocol items. These are the ones it marks as outside that file.

| Judge | Must-fix item (short) | Where in this file |
| --- | --- | --- |
| Infrastructure | Day-1 push spike; recovery between accepted and on `main`; stock git reads the notes | RR1, RR1a, RR1b, RR2; 2.4; 2.2 item 3 |
| Infrastructure | Measure one Trunk with 1,000 or more scripted agents against the collision dial; report real-model repair latency separately | 2.9, VE6; `ModelMeasurement.hero.repair_ms` (2.5) |
| Infrastructure | Gate real-agent reliability by day 4, including the `30` to `0.3` adaptation; a reopened attempt uses its authoring model or the screen says otherwise | M3, PT1 to PT3, RR5, RR6; 2.14 item 2 |
| Infrastructure | Decide the verification runtime early; protect the public address; Replay built early | RR4; BP10, 2.2 item 6, 2.5 items 2 and 3; track 1F plays fixtures on D2 |
| Originality | Rehearse 20 runs and publish the false-abort and escape rates | VE10, VE6; 2.11 item 3 |
| Originality | Four spikes before other work | 1.7; D1 in section 4; RR1 to RR5 |
| Originality | One primitive; fixed build order; crowd input, the many-pool wall, MCP, merge and bisect out | Section 2 order; 2.17; the drop order in section 4 |
| Feasibility | Landing spike with pass or fail; container fallback decided the same day | RR1 (the `docker info` check on D1) |
| Feasibility | Model spike on the real codebase; live agent count from measurement; an evicted agent ends in a recorded state | 2.5 items 5 and `measure:models`; RR5 |
| Feasibility | Freeze one engine; confirm by day 2 whether a container deploys; else the green line is static and says so | BP4; RR4 |
| Feasibility | Forks off the hot path; never per scripted agent; fork throughput reported separately | Track 4D, 2.5 item 7; SW3; VE6 last paragraph |
| Feasibility | Measure the false-abort rate before recording; check that the cited papers exist | VE6 on D6 and D8; SC2 |
| Feasibility | Build the Floor from day 2 against a scripted stream, Replay first; video and stage are separate deliverables; owner key and spend cap before the address is shared | Tracks 1E and 1F, Slice 5; 2.17 and BP12; BP10 |

## Appendix B. Plan thresholds and where they are used

| Id | Value | Used by |
| --- | --- | --- |
| PT1 | 8 of 12 additive intents land with the workhorse model | M3, RR5 |
| PT2 | Intent to landed p50 at most 120 s, p90 at most 300 s | M3, RR5, RR15 |
| PT3 | 4 of 5 correct repairs of P1a and of P1b for at least one model | M3, RR6 |
| PT4 | `RACE_SIZE` models land at least 6 of 12 | Slice 12 |
| Push | 300 of 300 batches `pushed`, p99 at most 5 s | RR1, 2.4 |
| Attempt repos | At most 5% failures, ready p90 at most 10 s, at 10 at a time | RR3 |
| Verifier | At most one missing or late verdict in 50 runs | RR4 |
| Clef | No truly dependent case gets `holds`; at least half of the independent cases get `holds`; p95 latency within `CLEF_TIMEOUT_MS` | RR7 |
| Hero | 20 of 20 conductor runs | M4, VE10 |
| Spend | 80% of an environment's cap; $40 in total | RR14 |
