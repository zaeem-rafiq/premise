# Premise build plan (04-build-plan)

Status: binding for the build. Revision 1 (2026-10-03), reconciled on 2026-10-04 with `01-core.md`, `02-tidepool.md`, `03-floor.md`, the lead's decisions and the platform record. The last section, "Changes in reconciliation (2026-10-04)", lists what changed. Read `01-core.md`, `02-tidepool.md`, `03-floor.md` and `05-agent.md` before this file. They say what Premise is. This file says in what order it is built, who owns which paths, and what evidence closes each step.

Sources: the architecture brief (scope lists, engineering standards), the design brief (contest dates and platform limits), the concept panel (the three judges' must-fix lists; Appendix A maps every schedule and measurement item to a section of this file), the lead's reconciliation decisions of 2026-10-04, and the platform record `docs/measurements/spikes/2026-10-04-platform.md` (what was measured on the real service before the build).

Not in this file: any rule of the product. Where this file needs a product rule it cites it by id. The agent's system prompt, the tool definitions as a model receives them, how a heads-up is shown to a model, the context budgets and the seeded-intent measurement protocol are in `05-agent.md` (`01-core.md` 4.11).

Conventions:

- Words of the glossary of `01-core.md` section 1 keep their meaning. The plain-merge pool is the pool the brief's scope list calls the counterfactual pool. A **summary-only pool** is a pool created with `summary_only: true` (PL1); before the reconciliation this file called it a quiet pool.
- Roles. **Owner**: the person. Defines goals, drives the Floor, records the video, submits. Cannot read code. **Lead**: the lead agent. Owns the shared files, merges, deploys, verifies. **Builder**: one coding agent working in one lane.
- Ids in this file: `BP` (rules of the build), **Slice** 0 to 15 with tracks such as `1A`, `IP` (integration points), `M` (milestones), `PT` (plan thresholds), `VE` (verification), `RR` (risks), `SC` (submission checklist), `GP` (gaps in the specification; all were closed on 2026-10-04, see 0.2).
- `S1` to `S7` are the ports of `01-core.md` section 15. `S7` (reading pool files) is the `PoolSource` port of `02-tidepool.md` 4.9; before the reconciliation this file called it `PS`. A slice is never written `S<n>`.
- Ids of the other files are cited as those files write them after the reconciliation. In `03-floor.md`: `RY` (Replay rules, formerly `RP`), `FR` (the failure rows of section 7, formerly `F`), `PS` (the recording state of 1.1, formerly `P`). `RP1` is only the export rule of `01-core.md` 12.3. `E0` to `E4` and `F0` to `F7` are only rows of the decision table of `01-core.md` 7.2. `P1` to `P9` are only the pairs of `02-tidepool.md` 9.4, and `TP` ids are only rules of `02-tidepool.md`.
- **The platform record** is `docs/measurements/spikes/2026-10-04-platform.md`. The date in its name is a UTC date: the file was committed at 04:34 UTC on 2026-10-04, which was 23:34 on 2026-10-03 on the build machine, before the build began. The record numbers its experiments E1 to E9. This file cites them as **X1 to X9** (X*n* is experiment E*n*), the convention of `01-core.md`, because E0 to E4 are rows of the decision table (7.2). Every experiment ran once, from one location, on small repositories; the record says so itself.
- Days are written **Day 1** to **Day 11**. Day 1 is Sunday 2026-10-04, Day 11 is Wednesday 2026-10-14. (`D1` to `D4` are rules of `01-core.md` 6.3 and never days.) A day ends at the lead's integration run. "Behind" means the day's milestone check failed at that run. The reconciliation itself was done in the first hours of Day 1.
- A **plan threshold** is a pass mark set by this file for a go or no-go decision. It is not a calibrated constant of the product.
- Authorizations already given by the owner (brief, 2026-10-03): deployment to the owner's Cloudflare account, and up to $50 of Cloudflare usage. Not yet given: making the repository public, deleting resources, any other paid commitment. Section 7 says where each is needed.
- This file makes no priority claim and never says "first" or "no one else". Related work is named in `01-core.md`. Wherever a text of the build lists related work, it names STORM, CoAgent and the entry "dibs".

---

## 0. Rules of the build

| Id | Rule | How it is checked |
| --- | --- | --- |
| BP1 | Expected values in tests come from the specification files, the brief, and real git. Never from the implementation's own output. A builder does not edit `docs/spec/premise-cases.json`; a suspected error in a vector goes to the lead with the rule ids, and the lead changes the rule and the vector together. | Review of every test at the integration point; `git log -- docs/spec/` shows only lead commits. |
| BP2 | A lane has one builder at a time. A builder writes only inside the paths its lane owns (3.1). There is no exception: a seam is a lead file, and each lane reaches it through its own wiring module (3.2). | `npm run check:lane -- <lane> <branch>` at the integration point exits 0. It fails on any changed path outside the lane. |
| BP3 | A slice is complete when its acceptance check passed on merged `main`, run by the lead, on the deployed `test` environment where the check says so. A builder's report is not evidence. | The lead records commands and results in `docs/measurements/integration/ip<N>.md`. |
| BP4 | A feature that fails its acceptance check at the freeze (M5) is switched off in `features` and listed under limits in About and in the README. `features` has the type `Features` of `01-core.md` FJ1 and no other key; `/floor.json` and the Worker read the same values from `src/config/features.ts`. A request that needs a feature that is off answers 404 with the code `feature_off`. Nothing ships half-working. | AC19 of `03-floor.md`; the rows of `03-floor.md` 1.4; the `feature_off` probes at IP6 (3.4). |
| BP5 | Dependencies are pinned to exact versions (1.2). A package that ends up in the Worker bundle or in a browser bundle must be MIT, Apache-2.0, BSD or Unlicense. A new dependency is added by the lead only. | `npm run check:licenses` reads the bundlers' module lists and fails on any other licence. |
| BP6 | No code is copied from another entry or from a GPL or FSL project. `reference/` holds the working material from before the build and is not product code (its README). Nothing under `src/`, `test/` or `scripts/` imports from it. (a) `reference/spec-sim/` checked cases `C01` to `C57` of `premise-cases.json`. It is frozen and has no race support, so it does not run `C58` (`01-core.md` Appendix A). It is never used as product code or as a source of expected values, so the vectors stay an independent check of the engine. (b) The pack and pkt-line code of `reference/artifacts-spike/` and (c) the trees of `reference/tidepool-check/` are the project's own work. A builder may start from them. They then count as new code: the same tests and review apply, and the specification wins where they differ (`reference/tidepool-check/pool` has 20 files, with a `creatures/README.md` and without `GUIDE.md` and `index.html`; `02` 2.1 fixes 21). | `test/arch/imports.test.ts` fails on an import from `reference/`. Tracks 1B and 1G pass their checks (2.2) whatever the starting point was. |
| BP7 | Secrets (the `OWNER_KEY` value, Artifacts tokens, Cloudflare API tokens) never enter the repository, a log, a test report, a recording or a chat message. Tests read them from the shell environment. | `npm run check:secrets` scans the work tree and the full history for the patterns of `redact()` (SE5a). |
| BP8 | A calibrated constant is changed only together with a measurement file under `docs/measurements/`, named in a comment next to the value (`01-core.md` conventions). | Unit test: every constant marked calibrated in Appendix C either has its starting value or cites an existing file. |
| BP9 | The sum of `SPEND_CAP_USD` over all deployed environments, plus what the early model measurement (2.2a) spent outside the gate, is at most 40 (`01-core.md` Appendix C). Start: `production` 30, `test` 10. Before the first `test` deploy that makes model calls (IP3) the lead lowers the `test` cap by the early measurement's recorded spend, rounded up to a whole dollar. The gate's ledger is never reset before the submission. | `wrangler.jsonc`; `npm run spend` prints both ledgers; `spend_usd` in the files of 2.2a. |
| BP10 | The address of the `production` deployment is given to nobody until the kill-switch and spend-cap checks of Slice 4 have passed on `test`, and, on `production` itself, the kill-switch check has passed and `limits.cap_usd` shows the configured cap. | Milestones M3 and M6. |
| BP11 | (a) The phrases of FL6 appear nowhere: not in the page text, not in the README, not in the submission texts. No text says "first" or "no one else". (b) The words of CP4 (branch, pull request, merge queue, claim, reviewer) are not used in `src/copy`, the page's own words. (c) In the README and the submission texts, "branch", "pull request" and "merge queue" appear only where the text states what a change replaces: `check:submission` allows them in `docs/submission/vision.txt` and in the README section that states the thesis, and nowhere else. | `npm run check:submission` and AC20. |
| BP12 | After the recording (M7) the code and the assets of the `production` deployment change only for one of two reasons: (a) adding recordings under `public/replay/` (the take's own export, SC7), by a deploy whose only difference from the deployed commit lies under `public/replay/`; (b) a fix the lead has verified on `test`. Each is followed by the checks of SC9. The rotation of `OWNER_KEY` after the recording (SC10) changes a secret, and no code and no asset; it is entered in the same log and is followed by the checks of SC9 too. The pool repos, plain-merge repos and recordings of `production` are never deleted or rebuilt (`03` RY10). The Worker of the `test` environment is kept until 2026-10-22 so that (b) stays possible (SC10). | Deploy log in `docs/measurements/deploys.md`: for each change after M7 the commit, the reason ((a), (b) or the key rotation), for (a) the output of `git diff --name-only <deployed commit> HEAD`, and the result of SC9. |

### 0.1 Disagreements between the specification files: resolved on 2026-10-04

Before the reconciliation, `02-tidepool.md` and `03-floor.md` still showed the state before `01-core.md` revision 2 in the places below, and this section told builders what to build instead. That is over. On 2026-10-04 the lead's decisions, the cross-document critic's findings F01 to F43 and the architect's corrections were applied to every specification file. Each file ends with its own section "Changes in reconciliation (2026-10-04)", which names the edit. Builders follow the files as they are now.

The precedence did not change: `01-core.md` wins over the other files, except where the lead's decisions changed the core. A disagreement that the reconciliation did not find is handled by RR11.

| Topic | Decided by (`01-core.md`) | Was wrong in | Decision or finding |
| --- | --- | --- | --- |
| Attempt views and previews | PV1, PV2, PV4, PV5: no route serves a live attempt view; "after" frames are preview commits addressed `p-<40 hex>` | `02` 4.1, 4.2, 4.6, 4.8, 4.9; `03` 4.5 | Architect's corrections; GP1 |
| Moving a pool frame; the channel | SE16, SE16a: live frames use `main` and `plain` and get `probe`; commit frames get `advance` | `02` 4.5 to 4.7, HO6, HO9; `03` CO20, CO21 | Lead decision 1; F01 |
| The hero walk-through | D1 (derived premises exist from the write), HU2a, B1a; vectors `C10`, `C30`, `C41`, `C57` | `02` 7.4 to 7.6, variant 1c, Appendix A rows A9 to A11, risk 19 | Lead decision 3; F03 |
| A listing gain before a sweep's first edit | The late L1 check (7.2, vector `C41`). The Swarm's expected escape count is 0. | `02` 8.3, 10.3, risk 8 | Architect's corrections |
| Card options and card texts | CD4, CD5, GL6 | `03` 5.10, 4.5 | Lead decision 2; F02, F17 |
| Stopping from the Agent side; scripted triage | The `stop` call (TA9, TA9a), stop reason `withdrawn`; TR8, S6a | `02` 10.3 | Lead decision 4; F04, F16, F25 |
| Undo plan and undo request | UN4, UN5, `UndoPlanResponse`, `UndoResponse`; both are owner routes (13.6) | `03` 4.5, 3.12, 5.9 | Architect's corrections; F22, F26 |
| Replay header, clocks, reducer details | 12.3 (`premise_replay: 2`), EV5 (`ts`), GA1, GA3, 12.1, `FLOOR_KEEP_LANDINGS` | `03` 8.2, 8.3, 4.1, 4.3, 4.6, 5.6, 5.8, Appendix A | Architect's corrections; F29 |
| The plain-merge pool on screen | PM3, PM4, PM6, PM7 (`plain.updated.tree`) | `02` 4.6, 9.4 pair P5; `03` 3.6, 5.4, `FloorState.plain` | F08, F38 |
| Public reads | SE15, SE19, FS2, S7: a public request never reaches Trunk | `02` 4.4, 4.9, AS5, AS11 | F18, F38 |
| Green line | GR3 (`confirmed`), GR8 (fixed check names and codes) | `02` 5.3, 5.4; `03` 4.3 | F19, F20 |
| Policy | `limits.max_paths` 64 (10.1), `DEFAULT_GLOBALS` (PO4), L2 | `02` section 6, PN9, 9.1 row A12 | F31, F39, F38 |
| Failure states the owner sees | LP8, `pool.paused.reason`, SE19 | `03` 5.11, section 7 | F26 |
| Which run each recording is | SC7 of this file | `03` 8.2, beat 10; `02` 7.11 | F10 |

One file outside `docs/spec/` follows: `seeds/tidepool/.premise/policy.json` is brought to `02` section 6 as reconciled (`max_paths` 64) in track 1G, whose exactness test (2.2) fails until it is.

### 0.2 Gaps GP1 to GP5: closed on 2026-10-04

Every gap this section listed was decided by the lead on 2026-10-04 and written into the specification. No working assumption is left.

| Id | The gap was | Decision | Where it is specified now |
| --- | --- | --- | --- |
| GP1 | No source segment existed for a commit of the plain-merge repository. Preview commits and Replay frames need one. | Accepted. The source segment `p-<40 hex>` is that commit of the pool's plain-merge repository. | `01-core.md` 10.2, PV5 |
| GP2 | No way to launch a named scripted pattern or a canned cast on a named pool, and no way to release `hold_before_submit`. | Accepted. `POST /api/swarm` takes `SwarmRequest`: `pool`, `running`, optional `patterns` and `release`, `request_id`. | `01-core.md` 13.6, SWR1 to SWR4 |
| GP3 | Beat 5 of `03` 1.2 needs a sweep that changes a shared rule and edits every creature found by a search for `drain(`. `02` section 9 had no such seeded request, no late creature and no starter set. | Closed with seeded requests only; no scripted agent runs in the real-agent pool. `02` section 9 gains pair P9: the sweep P9a, which changes `world/energy.js#drain` and every caller found by the search `drain(`, and the late creature P9b, which calls `drain(`. It also gains the group `starter` (A01, A03, A04, A06, A11 and P1b), which puts the shrimp, a caller of `drain(`, on `main` before the sweep starts. The sweep is then a real QT1 case: an earlier match that the sweep altered. | `02` section 9 (F13); `03` 1.2; `src/config/prewritten.ts` holds the same texts |
| GP4 | The seed policy holds `world/**`, but a build without the held card needs shared-rule paths to be `auto`. | Accepted. The generated seed variant `tidepool-auto`. The main pool is created from it while `features.held` is false. | `01-core.md` 13.6, PL1 and FJ1 |
| GP5 | Event suppression was tied to synthetic attempts, so a canned cast showed no lights and no diff, and the conductor's first wait never ended. | Accepted under another name, because `03` uses "quiet pool" for something else. The per-pool flag is `summary_only` (default false), set at `POST /api/pools` and carried by `pool.state`. Only summary-only pools (the Swarm pool and the soak pools) leave those events out. A canned cast on any other pool emits every event under the SYNTHETIC banner. | `01-core.md` PL1, EV6, EM1a |
| (none) | A held-tier submit in a build without the held card. | Confirmed. The minimal form of T4, T13 and T14 is built in Slice 2, so the held tier fails closed in every build. | `01-core.md` 10.2, HD1; 2.3 of this file |

No GP id is open. A new gap goes to the lead (RR11).

---

## 1. Repository layout

### 1.1 Directories

One npm package, one Worker project. No workspaces.

| Path | Purpose | Pure (1.3) |
| --- | --- | --- |
| `AGENTS.md` | Rules for coding agents: the commands of 1.5, the lanes of 3.1, BP1 to BP12, the glossary pointer. | |
| `README.md` | What Premise is, run instructions, limits (built from `src/copy/limits.ts`, AC19), measured numbers with the file each came from. | |
| `LICENSE` | MIT. | |
| `docs/spec/` | The five specification files (`01-core.md`, `02-tidepool.md`, `03-floor.md`, `04-build-plan.md`, `05-agent.md`) and `premise-cases.json`. | |
| `docs/measurements/` | Recorded evidence: `spikes/` (the platform record is its first file), `models/` (the early measurement of 2.2a and the engine measurement of 2.5), `calibration/`, `soak/`, `integration/`, `rehearsal/`, `cases.md`, `rules.md`, `deploys.md`. | |
| `reference/` | Working material from before the build: `spec-sim/`, `tidepool-check/`, `artifacts-spike/`. Not product code and not changed by the build (BP6). `typecheck`, `npm test`, `build` and prettier leave it out; `check:secrets` scans it. prettier also leaves out `docs/` and `seeds/`, because tests read exact text from them. | |
| `docs/reviews/` | `security.md`, `design.md`, `screens/`. | |
| `docs/submission/` | `vision.txt`, `cloudflare.txt`, `run.txt`, `checklist.md`. | |
| `src/protocol/` | The shared module: every event, tool request and response, record type, route, constant, `redact()`, port interface, and the model-facing texts of `05-agent.md` (`agent-prompt.ts`). `src/protocol/reducer/` holds `FloorState` and `reduce` (EV5). | yes |
| `src/copy/` | Every interface string of `03-floor.md` section 5 (CP1), the card texts that Trunk fills in (CD5) and the limits list. | yes |
| `src/config/` | `features.ts` (the values of `Features`, FJ1), `pools.ts`, `prewritten.ts` (the seeded requests of `02` section 9 that the page offers pre-written: the starter group, the sweep, the late creature), `model-plan.ts` (`ModelPlan` and the price table, SE6). Source of `/floor.json`. | yes |
| `src/core/sync/` | `H()`, SHA-1, git blob id, deflate. The only files that import `node:crypto` and `node:zlib` (SY1). | yes |
| `src/core/keys/` | Paths, premise keys, member sets, listing and query hashes (2.1, 2.2, 2.5, 2.6). | yes |
| `src/core/entities/` | acorn parse, entities, regions, entity hash, outline lines, module hash (2.3, 2.4, 2.7, KH1). | yes |
| `src/core/refs/` | `resolve`, reference extraction, `resolveExport`, globals (6.1, 6.2). | yes |
| `src/core/replay/` | Operations and replay, OP1 to OP5 (section 5). | yes |
| `src/core/policy/` | Policy file, globs, tiers (10.1). | yes |
| `src/core/diff/` | Entity and unified diffs, the size cut of HU10. | yes |
| `src/core/classify/` | The decision table of 7.2 as one pure function, sweeping, the triage mapping of 7.3, `OffTriage` (S6a), blast radius (11.6). | yes |
| `src/core/git/` | Blob, tree, commit and note bytes (3.5), notes tree, pack, pkt-line, receive-pack request and report, ref advertisement parser (9.5). | yes |
| `src/core/outbox/` | The table of LP5 as a pure function, backoff, the poison-batch rule, the command subset of LP6. | yes |
| `src/core/rebuild/` | Re-index and rebuild planning (3.6) over a reader port. | yes |
| `src/core/plain/` | The plain-merge replay (PM1 to PM5) and the preview tree (PV1). | yes |
| `src/core/undo/` | Undo and revert planning (UN1 to UN8). | yes |
| `src/core/agent/` | `inboxNext` (HU6a), budgets (AG4, AG6), journal decisions (AG2, AG3), the resume decision (RS2, RS3). Its directory `loop/` holds the model side as pure functions of `05-agent.md`: `toHeadsUpForModel` (HE3), the tool-message rendering (4.10), `assembleMessages` with the context rules, and `nextAction`. The early measurement and the Agent Durable Object run the same `loop/` code (`05-agent.md` ME1). | yes |
| `src/core/gate/` | Reservation arithmetic and the token bucket (SE6 to SE8). | yes |
| `src/core/trunk/` | The Trunk engine: schema (3.2), tools, premises, sets (6.3), submit, tick, heads-ups, transitions, cards, events. Synchronous, over the `Sql` port. `engine.ts` is a seam and `wiring/` holds its wiring modules (3.2). | yes |
| `src/swarm/` | Scripted patterns with their truth lists (`02` 10.2 to 10.4), `ScriptedTriage` (TR8), canned casts, the conductor script (`02` 7.11), the oracle SW2. | yes |
| `src/worker/` | Cloudflare shells. `index.ts` (router), `trunk/`, `agent/`, `floor/`, `gate/` (the four Durable Objects), `routes/`, `app-server/`, `security/`, `workflows/`, `adapters/` (one directory per port of 1.7). | |
| `src/host/` | The pool host (`02` 4.5 to 4.7): browser code served as `~host.<build>.js`. | |
| `src/floor/` | The Floor (React): `app/`, `stream/`, `replay/`, `state/`, `styles/`, `components/<name>/`. | |
| `seeds/tidepool/` | The 21 seed files of `02` 2.1. Five are fixed character for character by `02` (`world/energy.js`, `creatures/fish.js`, `GUIDE.md`, `index.html`, `.premise/policy.json`). The other 16 implement `02` sections 2, 3 and 5. Variants `tidepool-swarm` and `tidepool-auto` are generated, never stored (PL1). | |
| `public/` | Static files: `floor.json` (generated), `replay/index.json`, `replay/*.ndjson`. | |
| `scripts/` | `build/`, `seeds/`, `fixtures/`, `measure/` (with `measure/early/`, 2.2a), `soak/`, `calibrate/`, `rehearse/`, `recordings/`, `submission/`, `ops/` (pool create, cleanup, spend, and `lanes.json`, the one list of lane paths that `check:lane` and `AGENTS.md` are built from). | |
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
| isomorphic-git | S1 chose the hand-built pack (1.7). It is installed only if RR1's trigger fires and the push falls back to option B. Then 1.43.0, imported only under `src/worker/adapters/pusher/`. |
| A container, Browser Run | The green line runs in a Dynamic Worker isolate (S4, 1.7). No container and no Browser Run is in the build. |
| ESLint | Boundaries and lints are tests (1.3, AC7, AC20). |
| D1 (the database), R2, KV, Queues | Not in the minimum build (brief, section 2). |
| A CSS framework, an icon set, font files | `03-floor.md` VD2, VD5, VD6. Plain CSS with custom properties. The system font stack stays and no font file is bundled (lead decision, 2026-10-04). |
| A test DOM (jsdom, happy-dom) | Floor logic is tested as pure functions; rendering is tested in a real browser against fixture streams. |

### 1.3 How the pure core stays free of Cloudflare imports

Pure paths: `src/protocol/**`, `src/copy/**`, `src/config/**`, `src/core/**`, `src/swarm/**`. Five mechanisms, all run by `npm run check`.

1. **Separate compile.** `tsconfig.core.json` includes only the pure paths, with `lib: ["ES2023"]` and `types: ["node"]`. `worker-configuration.d.ts` and the DOM library are not in that program, so `DurableObjectState`, `Env` and `document` are compile errors there. `tsconfig.floor.json` and `tsconfig.host.json` hold no types of Node, so `process` is a compile error in browser code. `test/arch/programs.test.ts` reads each program from the compiler and checks both, and that every TypeScript file under `src/`, `test/` and `scripts/` is in at least one program.
2. **Import allow list** (`test/arch/imports.test.ts`). The test reads every import and re-export specifier of every file and fails on anything outside this table. It carries a negative fixture: a file under a fake core path that imports `cloudflare:workers` must be rejected. In every file under `src/` it also fails on a comment that would undo mechanism 1: a `/// <reference>` directive, which adds a file, a type package or a library to its whole program, and `@ts-nocheck`.

   | Files | May import |
   | --- | --- |
   | `src/protocol/**` | `src/protocol` only. `ids.ts` takes `H` as an argument, so the `submit_id` formula needs no import from `src/core/sync`. |
   | `src/copy/**`, `src/config/**` | `src/protocol` |
   | `src/core/sync/**` | `node:crypto`, `node:zlib` |
   | `src/core/**` (other) | `src/core`, `src/protocol`, `src/copy` (Trunk fills card texts from it, CD5), `acorn` |
   | `src/swarm/**` | `src/core/sync`, `src/protocol` |
   | `src/host/**` | `src/host`; types only from `src/protocol/channel.ts`; values from `src/protocol/constants.ts` (`HEAD_POLL_MS`, `STATS_EVERY_MS`, `DEFAULT_GLOBALS`), which itself imports nothing |
   | `src/floor/**` | `src/floor`, `src/protocol`, `src/copy`, `react`, `react-dom` |
   | `src/worker/**` | everything under `src` except `src/floor` and `src/host`; `cloudflare:workers`; `node:*` |

   A test file (`*.test.ts`) may also import `vitest`, `node:*` and `test/support`. A test file is compiled with the libraries of the code it tests, never by `tsconfig.core.json`: the Worker's unit tests by `tsconfig.worker.json`; the unit tests of the Floor and of the host, and the specs of `test/e2e/`, by `tsconfig.test-browser.json` (DOM and Node); every other test and every script by `tsconfig.test.json` (Node). No file under `src/`, `test/` or `scripts/` imports from `reference/` (BP6).

3. **No waits, no clock, no chance** (`test/arch/sync.test.ts`; SY1, SY2, FE2). In `src/core/**`, `src/swarm/**` and `src/protocol/reducer/**` these tokens are forbidden: `async`, `await`, `Promise`, `.then(`, `fetch(`, `crypto.subtle`, `CompressionStream`, `setTimeout`, `Date.now(`, `new Date()` with no argument, `Math.random(`. Time, ids and random numbers are arguments. `src/protocol/ports.ts` declares asynchronous interfaces as types only. The cases driver also fails if any engine call returns a thenable. Triage inside the accept transaction goes through `SyncTriage.judgeNow`, which returns a value and no promise (S6a): `ScriptedTriage` in `src/swarm/` and `OffTriage` in `src/core/classify/` meet this rule. The asynchronous `Triage.judge` (Clef) is implemented only under `src/worker/adapters/triage/`.
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
    | { kind: "stop"; reason: AgentStopReason; state: unknown }>;   // the Agent then calls `stop` on Trunk (TA9)
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
| Typecheck | `npm run typecheck` | `tsc --noEmit` for `tsconfig.core.json`, `.worker.json`, `.floor.json`, `.host.json`, `.test.json`, `.test-browser.json`, in that order |
| Unit tests | `npm test` | vitest projects `unit`, `arch`, `cases`, `git`, `tidepool`. Offline. `npm test -- <path filter>` narrows it. |
| Cases | `npm run test:cases` | The required cases. `CASES=all` runs all 58 and prints one line per case; `CASES=list` prints the counts only. |
| Durable Objects | `npm run test:workerd` | `npm run build:worker`, then the `workerd` project |
| Browser | `npm run test:e2e` | Playwright, fixture project. `-- --project=deployed` runs against `PREMISE_URL`. |
| Integration | `npm run test:integration -- <names>` | The named tests against `PREMISE_URL` |
| Build | `npm run build` | `build:seeds` (variants, seed bundle), `build:host` (to `dist/client/pool/~host.<build>.js`), `build:floor` (`floor.json`, then Vite to `dist/client`), `build:worker` (`wrangler deploy --dry-run --outdir dist/worker`) |
| Everything offline | `npm run check` | `prettier --check .`, `typecheck`, `npm test`, `build`, `check:licenses`, `check:secrets` |
| Lane boundary | `npm run check:lane -- <lane> <branch>` | Fails if `git diff --name-only main...<branch>` lists a path outside the lane's paths in `scripts/ops/lanes.json` (BP2) |
| Local run, no Cloudflare | `npm run dev:floor` | Vite dev server. `http://localhost:5173/replay/<fixture>` plays a fixture stream. |
| Local run, real service | `npm run dev` | `build`, then `wrangler dev` on port 8787. Artifacts and Workers AI are the real services (there is no emulator); needs `wrangler login` and a `.dev.vars` with `OWNER_KEY`. |
| Deploy | `npm run deploy:test`, `npm run deploy` | `check`, then `wrangler deploy --env test` or `wrangler deploy` |
| Pools | `npm run pool:create -- <pool> <seed>` | `POST /api/pools` with the key from the environment. `-- <pool> <seed> --summary-only` sets `summary_only: true` (PL1). |
| Measurements | `npm run measure:models -- --early`, `npm run measure:models`, `npm run soak`, `npm run calibrate:clef`, `npm run rehearse:hero` | Each writes its files under `docs/measurements/`. `--early` is the run of 2.2a: no engine, Workers AI over REST. Without it, the run of 2.5 against `test`. |
| Recordings | `npm run record:export -- --pool <pool> --id <id>` | Downloads the export, runs the check of `01-core.md` RP1, writes `public/replay/<id>.ndjson` and the index entry |
| Submission checks | `npm run check:submission` | Character counts, phrase lint (BP11), limits equality, citations present |
| Cleanup | `npm run cleanup:test` | Deletes every repo in the two `test` namespaces. Never touches `production`. Never deletes the Worker `premise-test` (SC10). |
| Spend | `npm run spend` | Prints the model gate's ledger of both environments |

### 1.6 Wrangler configuration

`compatibility_date` 2026-10-01, `compatibility_flags: ["nodejs_compat"]` (SY1), `limits.cpu_ms` set (9.4), `assets.run_worker_first: true` so that one module sets every security header (SE14, SE14a) and applies the rate limits of SE21, `assets.not_found_handling: "single-page-application"` (the client routes `/replay/{id}` and `/p/{pool}`).

| Binding | Kind | For |
| --- | --- | --- |
| `ASSETS` | Static assets, `dist/client` | The Floor, the host script, recordings |
| `POOLS` | Artifacts namespace `premise-pools` | Pool repos and plain-merge repos |
| `ATTEMPTS` | Artifacts namespace `premise-attempts` | Attempt repos (SE22) |
| `AI` | Workers AI | Coding models and Clef |
| `TRUNK`, `AGENT`, `FLOOR`, `GATE` | Durable Object classes `Trunk`, `Agent`, `Floor`, `ModelGate`, SQLite-backed | One per pool, per attempt, per pool, per deployment |
| `SWARM`, `GREEN`, `ARCHIVE` | Workflows | Slice 8, Slice 14, track 4D |
| `LOADER` | Worker Loader (`worker_loaders`) | Slice 14 part 14b: the Dynamic Worker isolate that runs the self-test (S4, the chosen runtime) |
| `OWNER_KEY` | Secret | SE1. Not listed under `secrets.required`: SE1 and `03` RY2 need a deployment without it to start and to fail closed. |
| Variables | `SPEND_CAP_USD`, `APP_HOST` (optional, SE14b), `CLEF_TRIAGE`, `CLEF_RISK`, `CLEF_CONTRADICTION` | |

No Browser Run binding and no container is declared (S4c).

Durable Object classes are declared under `exports` (`"type": "durable-object"`, `"storage": "sqlite"`), the form the spike harness deployed with. `migrations` is not used. All four Durable Object classes and all three Workflow classes are declared from Slice 0, each backed by a stub file (2.1), so `wrangler.jsonc` does not change when a slice lands. Workflow names are unique in an account, so the `test` environment uses `premise-test-swarm`, `premise-test-green` and `premise-test-archive`.

Environments: the top level is `production` (Worker `premise`). `env.test` is Worker `premise-test` with namespaces `premise-test-pools` and `premise-test-attempts` and its own Durable Objects. Integration tests create pools named `it-<ULID>` there.

### 1.7 Ports decided by spike: the chosen adapters

The rest of the system codes against the interface. Each option is one file under the port's adapter directory, and `src/worker/adapters/index.ts` names the option in use. The options were measured on the real service (the platform record) and the lead chose on 2026-10-04. `01-core.md` section 15 holds the evidence for each choice, the rules S1a to S7b that follow from it, and what is not yet measured. This table states the adapter that is built, the fallback, and the measured fact that triggers the switch. A fallback adapter is written only when its trigger fires. `adapters/index.ts` changes only together with a new record under `docs/measurements/spikes/` (question, measurement, choice, date; RR20).

| Port | Interface | Chosen adapter | Adapter directory | Fallback | Trigger for the fallback |
| --- | --- | --- | --- | --- | --- |
| S1, push | `Pusher` | Option A. Trunk builds the pack by hand and posts `git-receive-pack` itself. One request carries both commands, `refs/heads/main` and `refs/notes/premise` (S1a). After any result that is not all-ok, Trunk reads the ref advertisement and decides by the values of both refs (S1b). No git client library is on the landing path. | `adapters/pusher/` | Option B: isomorphic-git 1.43.0 inside Trunk, for the push only (X7 ran it 100 times with no failure). Option C, a container, is not built. | RR1: by the end of Day 3 the `pushes` test (2.4 item 2) shows a refused pack, fewer than 300 of 300 batches `pushed`, push p99 above 5 s, or a memory-limit error. |
| S1, notes | `NotesReader` | The notes commit id comes from the ref advertisement (`Pusher.readRefs`) or from `meta.notes_commit`. The notes tree and the note blobs are then read through the binding by object id (S1c). | `adapters/notes-reader/` | A hand-built `git-upload-pack` fetch of the notes ref with a read token (the pkt-line code of `src/core/git`). | RR1b: the `rebuild` test fails at step 2 of 3.6. |
| S2 | `TokenSource` | Option A. Trunk mints a write token with `createToken()`, always with an explicit scope (S2b), keeps it until near its expiry, and asks for a new one after a 401 or 403 on a push (LP5a). Only Trunk holds a write token (S2a). | `adapters/token-source/` | Option B: the token that `create()` returned, with the rotation rules of S2. | RR2: on `test`, a push with a freshly minted token answers 401 or 403 twice in a row. |
| S3 | `AttemptRepoProvisioner` | Option B. `fork()` off the landing path, at most `MAX_FORKS_IN_FLIGHT` (4) in flight, `FORK_RETRIES` retries with a doubling backoff (S3a). The attempt repo's token is minted with `createToken()`, because `fork()` returned none that works (S3b). Nothing that the Floor or the video shows depends on a fork having finished (S3c). | `adapters/attempt-repo/` | Option A: `create()` an empty repository per attempt and push the checkpoint. Then no attempt repo: `features.attempt_repos` is false. | RR3: at four at a time, more than 5% fail after retries or ready p90 is above 10 s. Also when `fork()` cannot place the fork in the `ATTEMPTS` namespace: SE22 wins and option A is used (track 4D measures this first). |
| S4 | `Verifier` | Option B. A Dynamic Worker isolate through the `LOADER` binding: an empty environment, `globalOutbound: null`, `limits.cpuMs` set to `GREEN_CPU_MS`, the checks run in sequence, at most four isolates in flight per request (S4a, S4b). No container and no Browser Run (S4c). | `adapters/verifier/` | Option D: runtime `static` (parse, import resolution, policy invariants). `features.green` is then `"static"` and the strip says "static checks only" (GR5). | RR4: in 50 runs on the seed more than one verdict is missing or late, or a commit with `MAX_KINDS` creature files does not load. |
| S5 | `ModelPlan` | The starting plan. Workhorse `@cf/openai/gpt-oss-120b`. Race (`RACE_SIZE` is 3): the workhorse, `@cf/moonshotai/kimi-k2.7-code` and `@cf/zai-org/glm-5.3-flash`. The starting `per_minute` values and the starting `max_real_agents` are in `05-agent.md` MG2. The final mix, `per_minute` and `max_real_agents` follow the seeded-intent measurement (MP2; `05-agent.md` section 6): a first reading on Day 2 (2.2a), judged on the engine at M3 (2.5). The request shape is MP1. | `src/config/model-plan.ts`; `adapters/model/` | The next model of the record's X9 table that passes the thresholds; a shorter race list with a lower `RACE_SIZE`. A model outside Workers AI needs the owner's approval. | RR5 (PT1 or PT2 missed), RR6 (PT3 missed), PT4 for the race list. |
| S6 | `Triage`, `SyncTriage`, `RiskJudge` | Option B. `@cf/cloudflare/clef` answers the triage questions and the risk questions (`ClefTriage`, the asynchronous `Triage`). In every build, two `SyncTriage` implementations answer inside the accept transaction: `ScriptedTriage` for synthetic attempts (TR8) and `OffTriage` while `CLEF_TRIAGE` is off (TR5, S6a). The thresholds stay calibrated constants, and the three switches stay `off`, until Slice 15 has measured them (S6b). | `adapters/triage/`, `adapters/risk/`; `src/swarm/` (`ScriptedTriage`); `src/core/classify/` (`OffTriage`) | `@cf/cloudflare/clef-flash` for triage when latency matters, with its own thresholds. Then option C: off, `features.clef` is false. | In `calibrate:clef`, p95 latency of `clef` above `CLEF_TIMEOUT_MS`: `clef-flash`. RR7: off. |
| S7 | `PoolSource` | `readFile({ ref: <commit id>, path })` through the binding. A moving source (`main`, `green`, `plain`) is first resolved to a commit id from the Floor's state (S7a, SE19). Code never passes a full ref name to the binding (S7b). | `adapters/pool-source/` | Reads by object id: `readCommit`, `readTree`, `readBlob`, with trees cached per version. | RR8: a read by commit id of a commit that `landing.landed` named misbehaves. |

Not built under any port: a container; Browser Run; a `PoolSource` that reads Trunk's `files` table (a public request never reaches Trunk, SE19); a live view of an attempt (PV4). Tests use one more `PoolSource`: a directory on disk.

What the platform record did not measure, and the step of this plan that measures it:

| Not yet measured | Measured by | When |
| --- | --- | --- |
| The hand-built pack at volume; the largest pack; the size of Trunk's SQLite after 300 batches; memory against the 128 MB limit | 2.4 item 2 (`pushes`) | Day 3 |
| A binding read of an object that is reachable only from the notes ref, or only from `refs/previews/*` | 2.4 item 3 (`rebuild`); 2.12 item 1 (`held`); RR1b | Day 4; Day 5 |
| Whether `fork()` can place a fork in the `ATTEMPTS` namespace | Track 4D, its first task | Day 5 |
| The full pool in the isolate; 50 runs in a row; the value of `GREEN_CPU_MS` | 2.15 item 4 | Day 7 |
| Seeded intents per model, and the repair after a heads-up | 2.2a (no engine), then 2.5 (`measure:models` on the engine) | Day 1 and Day 2; Day 4 |
| Clef thresholds on a larger set with QR4 cases; questions per request; the input size at which the service truncates | 2.16 item 2 (`calibrate:clef`) | Day 7 |
| One Trunk under 1,024 scripted agents | VE6 | Day 6, Day 8 |
| The lifetime of a `create()` token; what a fork copies | Only if RR2's trigger fires | |

---

## 2. Vertical slices

Slice 0 is the scaffold, in two parts: 0a is the toolchain, 0b is the `protocol` module and the stubs (2.1). Slice 1 is the thinnest path through every layer. The early model measurement (2.2a) is not a slice: it runs beside Slice 1 and needs no engine. Slices 2 to 10 each add one item of the brief's MUST list. Slices 11 to 15 each add one item of its SHOULD list, ordered by what the beat sheet loses without them (`03-floor.md` 1.4) and by dependency. STRETCH items have no slice (2.17).

| Slice | Adds | Scope | Depends on | Cases it must pass |
| --- | --- | --- | --- | --- |
| 0 | 0a: the toolchain scaffold. 0b: the `protocol` module, the seams and the stubs. | | | none run; the file loads |
| 1 | Tracer: one scripted agent lands one commit; the Floor and the pool show it. Owner key. Tide pool and app server by ref. | MUST | 0 | `C01`, `C23`, `C28`, `H01` to `H23`, `I01` to `I05` |
| 2.2a | Early model measurement: the seeded intents on the real seed, per model, with no engine | MUST (S5) | 0b, `05-agent.md` | none |
| 2 | Live premises: rule-based classification, derived premises, heads-ups, go-arounds, blind spots, the go-around limit, right of way, the held tier in its minimal form, the `stop` call, the Trunk side of `resume` | MUST | 1 | 36 cases (2.3) |
| 3 | Durable landing: outbox, push outcomes, restart, rebuild from Artifacts | MUST | 1 | `C20`, `C21`, `C22`, `C50`, `C51` |
| 4 | Real agents on Workers AI behind the model gate: spend cap, kill switch, recovery | MUST | 2 | none new |
| 5 | The Floor's MUST surface: intent box, cards with premise lights, live pool, file tiles, counters | MUST | 1 | none new (AC14 uses `C04`, `C05` as fixtures) |
| 6 | The hero conflict with the plain-merge pool side by side | MUST | 2, 3, 5 | none new; `02` Appendix A rows A3 to A20 |
| 7 | Why card, "show the git" drawer, Who relies | MUST | 1, 2, 5 | none new |
| 8 | Swarm with measured numbers | MUST | 2, 3, 5 | none new |
| 9 | Replay with no credentials | MUST | 5, 6 | none new |
| 10 | README, About, run instructions | MUST | 1 to 9 | none new |
| 11 | Held-path card with before and after | SHOULD | 2, 5, 6 | `C18`, `C48`, `C49` |
| 12 | Race and choose | SHOULD | 4, 11; the engine files of 13 for `C58` | `C58` |
| 13 | Causal Undo that reopens dependents | SHOULD | 2, 4, 5 | `C19`, `C53` |
| 14 | Green line: verify, advance, revert on red | SHOULD | 3; 13 for the revert | none new |
| 15 | Clef triage and the risk lines | SHOULD | 2, 3, 4, 11 | `C06`, `C07`, `C12`, `C31`, `C38`, `C42`, `C52`, `C55` |

3 + 36 + 5 + 3 + 1 + 2 + 8 = 58. Every case is required by exactly one slice and stays required from then on. A case is named by its number prefix (`C04` is `C04-hero-shared-rule-lands-first`; Appendix A of `01-core.md`, runner rule 10).

Two assignments changed in the reconciliation. `C34` and `C35` moved from Slice 11 to Slice 2: they test the minimal held form and the tier re-check of the tick, which HD1 puts in every build, and neither expects a blast radius or a preview. `C58` is new (rule RC7). It needs the engine files of Race and of Undo, so it becomes required when both are merged. The cases run on the engine in Node, where every engine part is present; `features` switches routes and page parts, not engine code.

Where each item of the brief's scope list is built:

| Brief, section 6 | Slice |
| --- | --- |
| MUST: Trunk reads, premises, replay-landing, notes | 1 |
| MUST: Trunk derived premises | 1 (rules D1 and D2, which cases `C01` and `C28` need); 2 (the rest of 6.3 and 6.4) |
| MUST: Trunk, the gate | 2 |
| MUST: Trunk outbox | 1 (record, push, confirm), 3 (retry, restart, rebuild) |
| MUST: Agent with real Workers AI models | 2.2a (the first measurement, no engine), 4 |
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

### 2.1 Slice 0: scaffold (0a) and `protocol` (0b)

Slice 0 has two parts. They are built one after the other and merged together at IP0.

| Part | What it is | State on 2026-10-04 |
| --- | --- | --- |
| 0a, the toolchain scaffold | Section 1 of this file as files: the directory layout (1.1), the pinned toolchain (1.2), the five mechanisms of 1.3 with their tests under `test/arch/`, the test projects of 1.4, the commands of 1.5, `wrangler.jsonc` (1.6), `scripts/build/**`, `scripts/ops/**` with `lanes.json`, `test/support/**`, the case loader with `list.test.ts`, `AGENTS.md`, and a placeholder Worker that builds. | Being built during the reconciliation, before the protocol module. It was started from this file as it was before the reconciliation. |
| 0b, the protocol module and the stubs | `src/protocol/*.ts` (the table below), `src/config/**`, the seams and the wiring modules of 3.2, the seven stub classes, `src/worker/env.ts`, `src/worker/adapters/index.ts` and `adapters/not-built.ts`, and the tests of acceptance items 2 to 5 and 9. | Starts when 0a passes `npm run check` and the five specification files are reconciled. It needs `05-agent.md` for `agent-prompt.ts`. |

0b changes neither the toolchain versions nor the directory layout of 0a. Three things in 0a mirror a table of this file: `ZONES` in `test/arch/import-rules.ts` (the allow list of 1.3), `scripts/ops/lanes.json` (the lanes of 3.1, from which the lane table of `AGENTS.md` is generated), and the commands of `package.json` (1.5). The reconciliation changed the first two tables and one command. 0a takes those changes over before IP0, and acceptance item 10 checks it.

| | |
| --- | --- |
| Goal | Every lane can start from one commit: the toolchain, the boundaries, the shared types, and a Worker that deploys and fails closed. |
| Lane | lead |
| Owns | Root files (`package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`, prettier files, `tsconfig.*.json`, `vitest.config.ts`, `vite.config.ts`, `vite.host.config.ts`, `playwright.config.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `AGENTS.md`); `src/protocol/*.ts`; `src/config/**`; the seams of 3.2 (`src/core/trunk/engine.ts`, `src/worker/trunk/effects.ts`, `src/worker/index.ts`, `src/floor/app/registry.ts`); `src/worker/env.ts`, `src/worker/adapters/index.ts`, `src/worker/adapters/not-built.ts`; `test/arch/**`; `test/support/**`; `test/cases/load.ts`, `test/cases/required.json`, `test/cases/list.test.ts`; `scripts/build/**`, `scripts/ops/**`; `docs/measurements/README.md`. Slice 0 also creates, as stubs that their lanes own from IP0 on: every wiring module of 3.2 (an empty `wire` function), and the seven class files (`src/worker/trunk/trunk-do.ts`, `agent/agent-do.ts`, `floor/floor-do.ts`, `gate/gate-do.ts`, `workflows/swarm.ts`, `workflows/green-line.ts`, `workflows/attempt-repo.ts`), each a class that answers `not_built`. |
| Depends on | nothing |

`src/protocol` files and their sources:

| File | Defines | Source |
| --- | --- | --- |
| `ids.ts` | `i_`, `a_`, `c_` ids, `call_id`, the `submit_id` formula (it takes `H` as an argument, 1.3) | 01-core 1, 4.1, 4.9 |
| `constants.ts` | Every constant of 01-core Appendix C (with `DEFAULT_GLOBALS`), 02 Appendix B and 03 Appendix A; the switches. It imports nothing (1.3). | |
| `premise.ts` | `PremiseKind`, `PremiseRef`, key formats | 2.2, 4.1 |
| `tools.ts` | `ToolRequest`, `ToolResponse`, `ErrorCode`, arguments and results of the seven tools, `SubmitResult`, `Check`, `SubmitError`; the four calls that are not tools: `sync`, `register` (with `truth`), `stop` (`AgentStopReason`, `StopRequest`, `StopResponse`) and `resume` (`ResumeRequest`, `ResumeResponse`); `ModelToolMessage`, `HeadsUpForModel` | section 4, 8.3 |
| `agent-prompt.ts` | The texts a model receives, exactly as the five blocks of `05-agent.md` give them: `system-prompt`, `first-user-message`, `resume-message`, `tool-definitions` (the seven tool definitions as sent to Workers AI) and `agent-texts`; `AGENT_SPEC`. The caller computes `prompt_hash`, `tools_hash` and `texts_hash` over them with `H` (`05-agent.md` 2.4). | `05-agent.md` 2, 3.1, 3.6; 01-core 4.11, PR1 |
| `operations.ts`, `headsup.ts`, `attempt.ts`, `cards.ts`, `undo.ts`, `note.ts`, `green.ts` | `Operation`; `HeadsUp`, `HeadsUpItem`, `Diff`; `AttemptState`, the 17 stop reasons, transition ids; `Card`, `CardOption`, `BlastRadius`, `FrameAddress`, `frameUrl` (PV5), `RiskAnswers`; `UndoPlan`, `UndoRefusal`, `UndoPlanResponse`, `UndoResponse`; `Note`; `VerifyResult` with the check names and codes of GR8 | 5.1, 8.2, 9.1, 9.2, 10.2, 10.3, 11.3, 3.5, 11.5 |
| `events.ts`, `stream.ts`, `replay.ts` | `PoolEvent`, `EVENT_TYPES`, the five values of `EventBase.src`; socket frames and the `(src, epoch, source_n)` envelope with the source ids of EV2a; the Replay header and file checks | 12.1, 12.2, 12.3 |
| `routes.ts` | Method, path and role of every route, with the client route `/p/{pool}`; `SwarmRequest`; the error code `feature_off` | 13.6; 02 4.2 |
| `channel.ts` | `FloorToPool`, `PoolToFloor` | SE16, SE16a |
| `ports.ts` | The interfaces of 1.7 (with `Triage`, `SyncTriage`, `TriageInput`, `TriageAnswers`), `Sql`, `Driver` | section 15; 02 4.9; 1.3 |
| `swarm.ts`, `floor-json.ts` | `SwarmConfig`; the shape of `/floor.json` with `Features` | 02 10.1; 01-core 13.6, FJ1; 03 4.5 |
| `redact.ts` | `redact()` | SE5a |

Acceptance:

```
npm ci && npm run check
CASES=list npm run test:cases
npm run dev        # 0b: then, in a second shell, the three curl probes below
```

Each item names its part.

1. (0a) `CASES=list` prints `58 cases, 23 hash cases, 5 inbox cases, format premise-cases/2, required: 0`. The test reads the three counts from the case index of `01-core.md` Appendix A, so the specification and the vectors cannot drift apart unseen.
2. (0b) A constants test parses the three constants tables out of the specification files and compares every name and value with `constants.ts`. A difference fails.
3. (0b) `EVENT_TYPES` has the 35 types of 12.1 and `EventBase.src` has 5 values. `routes.ts` has the 21 rows of 13.6 and the 6 rows of `02` 4.2. `ErrorCode` has 17 values. There are 10 attempt states, 17 stop reasons (9 of them in `AgentStopReason`), 8 card options, and the 6 keys of `Features`.
4. (0b) `redact()` has one test per pattern family of SE5a.
5. (0b) `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8787/api/pools -H 'content-type: application/json' -d '{}'` prints `503` with no `OWNER_KEY`, `401` with a key set and none sent, and `415` when the content type is `text/plain`.
6. (0a) `AGENTS.md` exists and names every command of 1.5 and every lane of 3.1. Its lane table is generated from `scripts/ops/lanes.json`.
7. (0b) Every seam and every wiring module of 3.2 exists. Every port of 1.7 resolves to `adapters/not-built.ts`, whose methods fail closed with the code `not_built`. (0a) `npm run check:lane -- leaf main` exits 0, and exits 1 for a fixture branch that touches `src/core/git/`.
8. (0b) `npm run deploy:test` succeeds. On `test`, with `OWNER_KEY` set: the request of item 5 answers 401 with no key sent and 415 with `text/plain`; `GET /api/pools/x/stream` answers 503 from the stub Floor class.
9. (0b) A test extracts the five blocks of `05-agent.md` by their marker lines (`system-prompt`, `first-user-message`, `resume-message`, `tool-definitions`, `agent-texts`) and compares them with `agent-prompt.ts`. A difference fails (PR1). The three hashes of `05-agent.md` 2.4 are computed from the blocks and equal the values that file states.
10. (0a, checked by the lead at IP0) `ZONES` in `test/arch/import-rules.ts` equals the allow list of 1.3, and `scripts/ops/lanes.json` equals the lanes of 3.1, both as reconciled.
11. (0b) The citations exist. The lead opens the two arXiv ids named in the header of `01-core.md` (2605.20563 and 2606.15376) and the entry "dibs", and records the address, the title and the date in `docs/measurements/integration/ip0.md`. A citation that does not resolve is removed from the specification and from `src/copy` before track 1I transcribes the copy.

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

Ten tracks run at the same time, and the early model measurement (2.2a) runs beside them in its own lane. Each track has its own check, so a track is known good before integration.

| Track | Lane | Owns | Done when |
| --- | --- | --- | --- |
| 1A | leaf | `src/core/sync/**`, `keys/**`, `entities/**`, `refs/**`, `replay/**`, `policy/**` | `H01` to `H23` pass. The worked examples of 2.4 (`5149f012fe7cd2dfd8820a214ea41ff0`), 2.5 and 6.2 (the `creatures/fish.js` table) pass. Each of OP1 to OP5 and PO1 to PO4 has a test named with its id. |
| 1B | git | `src/core/git/**`, `test/git/**`, `src/worker/adapters/pusher/**`, `token-source/**`, `notes-reader/**`; `src/worker/trunk/push-runner.ts` (first version: one request per batch, no retry), `src/worker/trunk/wiring/git.ts` | `npm test -- test/git`: the example commit of 3.5 has id `6bd48525d87d048e928a6dce65cd7e033fcbd839`; every object id equals `git hash-object`; a pack passes `git index-pack` and `git fsck --strict`; one request updates `refs/heads/main` and `refs/notes/premise` on a `git http-backend` server (S1a); a stale old id is refused; `git notes --ref=premise show` prints the note bytes of NT1; a note over `NOTE_MAX_BYTES` is shrunk by NT2. The adapters are the chosen ones of 1.7: the hand-built pack, the minted token, notes read by object id. |
| 1C | engine | `src/core/trunk/` files `schema`, `registry`, `tools-read`, `tools-edit`, `premises`, `sets`, `submit`, `tick`, `landing`, `events`, `intents`, `wiring/engine`; `test/cases/driver.ts`, `test/cases/run.test.ts` | `C01`, `C23`, `C28` pass in Node; they need the derived premises of rules D1 and D2. The schema is the whole of 3.2, with the columns `attempts.race`, `attempts.truth`, `attempts.resumes` and `heads_ups.op_mark` and the `meta` keys `summary_only` and `synthetic`. The check `policy` (CK9) is in every submit's `checks` from this track on. |
| 1D | trunk | `src/worker/trunk/` files `trunk-do`, `sql`, `after-commit`, `alarm`, `wiring/trunk`; `src/worker/routes/` files `session`, `pools`, `wiring`; `src/worker/security/**`; `test/workerd/trunk/**` | In workerd: a tool call commits its transaction before any request leaves the object (SY2, shown by the fake remote's request log); SE1 to SE3 each have a test; the eleventh wrong key within a minute from one address answers 429, and so does the right key in that minute (SE2a); the pool-create response holds no token (SE5). Pool creation stores `summary_only` and `pool.state` carries it (PL1). It also makes the two registration calls of PL1, to the model gate and to the Swarm launcher. Until Slice 4 (gate) and Slice 8 (launcher) the stubs answer `not_built` and pool creation ignores that answer; from the slice that builds the emitter on, a failed registration fails the pool creation. |
| 1E | stream | `src/protocol/reducer/**`; `src/worker/floor/**`; `test/workerd/floor/**`; `test/fixtures/streams/**`; `scripts/fixtures/**` | Reducer tests for the event types this slice emits, with expected state from `03` 4.3 (AC2). In workerd: a repeated `source_n` is ignored, a gap is refused, a higher epoch restarts at 1 (EV2); two sources (`trunk` and `gate`) with the same `source_n` are both kept (EV2a); a second client message closes the socket; a snapshot join gives the same state (AC1). Sockets (EV7, FS3): a unit test finds no `.accept(` call under `src/worker/floor/`; in workerd, an event appended after the object was evicted reaches a socket that was opened before, from the `after` of its attachment (the test detects the eviction by an in-memory marker that is gone; if local workerd gives the test no way to evict the object, the stream lane reports that on Day 1 and the lead records the limit in `ip1.md`). The Floor answers the app server's internal read of the landed commit, the landed `seq` and the newest paths from its reducer state (FS2), so that track 1G needs no call to Trunk. Fixtures `tracer.ndjson`, `hero-c04.ndjson`, `hero-c05.ndjson` exist; they are written from the event types of 12.1 and the expectations of vectors `C04` and `C05`, not from an engine run (BP1). |
| 1F | floor-shell, floor-rail, floor-pool | floor-shell: `src/floor/main.tsx`, `app/**` except the seam and the other two wiring modules, `stream/**`, `styles/**`, `state/**`, `replay/player.ts`, `components/strip`, `components/banners`, `test/e2e/shell/**`. floor-rail: a minimal `components/attempt-card`, `app/wiring/rail.ts`, `test/e2e/rail/**`. floor-pool: a minimal `components/pool-frame`, `app/wiring/pool-area.ts`, `test/e2e/pool-area/**`. | `npm run dev:floor`, then `/replay/tracer` plays the fixture under the REPLAY banner with no Worker running. AC3 passes. The client route `/p/<pool>` shows that pool as the main pool, and `/` shows the default pool of `/floor.json` (13.6); item 4 below needs it. |
| 1G | pool | `seeds/tidepool/**`; `scripts/seeds/**`; `test/tidepool/**` except `scenarios/`; `src/host/**`; `src/worker/app-server/**` (with its `wiring.ts`); `src/worker/adapters/pool-source/**` | Rows A1, A2 and A8 (for the seed modules) of `02` Appendix A pass. A test extracts the five "MUST be exactly this" blocks from `02-tidepool.md` (`world/energy.js`, `creatures/fish.js`, `GUIDE.md`, `index.html`, `.premise/policy.json`) and compares them with the seed files. The line and export limits of `02` TP5 and TP6 hold for all 21 files. The seed's policy file equals `02` section 6 as reconciled (`max_paths` 64). The app server resolves `main` to a commit id from the Floor's state and reads every file by commit id (S7a, SE19); it never calls Trunk. The host takes `HEAD_POLL_MS`, `STATS_EVERY_MS` and `DEFAULT_GLOBALS` from `src/protocol/constants.ts` (`02` PN9). With the directory-on-disk `PoolSource` in a browser test: the pool runs, posts `stats`, and adopts a new creature file after a `probe` without a reload (`02` 4.7, SE16a); in a commit frame `advance { version }` loads that version, and `highlight { kinds }` outlines those kinds, as `02` HO14 and HO15 define them. |
| 1H | agent | `src/core/agent/**` except `loop/**` (the measure lane builds it, 2.2a); `src/worker/agent/` files `agent-do`, `journal`, `inbox`, `trunk-client` (the seven tools, `sync`, `register`, `stop`), `scripted-driver` | `I01` to `I05` pass. In workerd: the journal row exists before a tool call and is gone after it (AG1); a repeated `call_id` returns the stored response (TA2). |
| 1I | copy | `src/copy/**` | All of `03` section 5, as reconciled, is transcribed, with the card texts of 5.10 that Trunk fills in (CD5). AC7 (ids exist) and AC20 (phrase lint) pass. It starts after item 11 of 2.1, so that no unchecked citation is transcribed. |
| 1J | swarm | `src/swarm/` files `prng`, `pattern`, `patterns/add-plain`; `src/worker/routes/swarm.ts` (the Swarm launcher for a canned cast: it takes `SwarmRequest` and starts one scripted Agent Durable Object per entry of `patterns`; SWR1, SWR2, SWR4) | The same seed gives the same tool calls (SW1). The written file equals template T-plain of `02` 10.2. Each agent is opened with its truth list (TR8). A repeated `request_id` launches nothing (SWR4). |

Acceptance (the lead, at IP1):

```
CASES=required npm run test:cases
npm run test:workerd
npm run deploy:test
npm run pool:create -- it-tracer tidepool-swarm
npm run test:integration -- tracer stock-git
npm run test:e2e -- --project=deployed tracer
```

1. Event 1 of the pool's stream is `pool.state` with `head_seq: 0`, `synthetic: false` and `summary_only: false`; `pool.files` follows (EM1).
2. One `add-plain` agent is launched with `POST /api/swarm` and `patterns: ["add-plain"]` (SWR2). `pool.state` is emitted again with `synthetic: true` before the agent's `attempt.opened` (EM1a). The stream then holds, in this order: `attempt.opened`, `submit.result` (`validated`), `landing.accepted`, `batch.pushed`, `landing.landed` (EV3). At the moment `landing.landed` is appended, `git ls-remote` shows `refs/heads/main` at that commit (LP9).
3. With a read token and stock git: `git log -1 --format=%B | git interpret-trailers --parse` prints exactly a `Change-Id` and an `Intent-Id` line; the author name is `SYNTHETIC swarm` (CM1); `git fetch origin refs/notes/premise:refs/notes/premise && git notes --ref=premise show HEAD` prints JSON with `"seq":1`; `git hash-object` of that output equals `landing.landed.note`; `git fsck --strict` passes.
4. In a browser at `<test address>/p/it-tracer` (the client route of 13.6 that shows a named pool): the SYNTHETIC banner is shown; the card reads "Landing…" and changes to "Landed" only with `landing.landed` (FL3); the Landed counter reads 1; the pool frame shows one more creature with its white ring within `HEAD_POLL_MS` of that event, without a page reload. The frame is a live frame: its source is `main` and it moves by `probe` (SE16a).
5. `curl -sI <address>/pool/it-tracer/main/` shows a `Content-Security-Policy` with `sandbox allow-scripts` and `connect-src 'none'` (SE14). A `v/c-<commit>/` file has `Cache-Control: public, max-age=31536000, immutable` (SE20). `.premise/policy.json` under a version path answers 404 (SE15). In workerd, the request log shows that the app server sent no request to Trunk (SE19).
6. A mutating request without the key answers 401. The same `POST /api/pools` sent twice with one `request_id` creates one pool (9.8).

### 2.2a Early model measurement (no engine)

Two judges asked for the model measurement on the real demo codebase on day 1 or 2. Before the reconciliation this plan first measured the seeded intents at M3, the end of Day 4, which left three build days to react to the two risks rated high (RR5, RR6). This step moves the first reading to Day 2.

| | |
| --- | --- |
| Goal | By the end of Day 2 the lead knows, per model and on the real seed, what share of the seeded intents a Workers AI model completes, how long a change takes, whether energy creatures reference `ENERGY_MAX`, and whether the model repairs `30` to `0.3` after a heads-up. The model mix, the first `max_real_agents` and the fate of Slice 12 are set from that. |
| What it is | The early variant of the measurement protocol of `05-agent.md` section 6 (ME1 to ME11), which is binding for it. A Node script with no engine: no Trunk, no premises, no Durable Object, no deploy. It runs the product's own model loop against an in-memory copy of `seeds/tidepool/` and calls Workers AI over its REST API with the request shape MP1. It replaces four things and nothing else (ME1): Trunk by the in-memory pool, the model gate by a local ledger, the `AI` binding by REST, SQLite by arrays. |
| Lane | measure (3.1): a second builder, beside track 1H. From Day 3 its paths belong to the agent lane. |
| Owns | (1) `src/core/agent/loop/**`: the model side of the Agent as pure functions, which Slice 4 then wraps in the Agent Durable Object: `toHeadsUpForModel`, the tool-message rendering, `assembleMessages` with the context rules, `nextAction` (`05-agent.md` sections 3 and 4). (2) `scripts/measure/models.ts`, the entry of `npm run measure:models`: with `--early` it runs this step, without it the engine variant of 2.5. (3) `scripts/measure/early/` files: `run` (the loop driver and the run plan), `mem-pool` (the in-memory pool of ME3), `ledger` (the limits and the spend of ME4), `workers-ai-rest` (MP1 over REST), `heads-up` (the scripted heads-up of ME5), `score` (the pure scoring of `05-agent.md` 6.5 and ME8), and their unit tests. Output: `docs/measurements/models/`, committed by the lead. |
| Depends on | Slice 0b (`src/protocol/tools.ts`, `src/protocol/agent-prompt.ts`), `05-agent.md`, and the seed, which is already in the repository. No track of Slice 1. Until track 1A is merged, `mem-pool` finds entity boundaries with its own acorn pass over top-level declarations (2.3); at IP1 it switches to `src/core/entities` and the pass is deleted (ME3). |
| Starts | As soon as `05-agent.md` and the two protocol files exist: Day 1 after IP0. The results are judged on Day 2 (M1a). |

Run plan, for each of the three models of the starting plan (1.7, S5). The sets and the sample sizes are those of `05-agent.md` 6.2:

1. Set `additive`: each intent A01 to A12 of `02` 9.1, one run.
2. Set `hero`: intents P1a and P1b of `02` 9.3, five runs each, each with the scripted heads-up of ME5. After the run's first passing `submit` the script puts the shared-rule change into the in-memory `world/energy.js` (`ENERGY_MAX` from 100 to 1) and gives the loop one heads-up of result `repair` with rule `E2`, built like the one Trunk would send in landing order 1. The run ends at the next passing `submit` or at a limit.

That is 22 runs per model, at the concurrency of ME4. Every run starts from an unchanged copy of the seed (ME2). If the workhorse reads under PT1, the next models of the record's X9 table are measured the same day, inside the same spend limit.

The four numbers the lead asked for, per model. `05-agent.md` 6.5, 6.6 and ME8 hold the exact definitions; every expected value comes from the specification, never from the run (BP1).

| Number | In short | Read by |
| --- | --- | --- |
| The share of seeded intents completed | A passing `submit` within the limits; every module parses; every import resolves; the intent's file exists and exports `spawn`, `update` and `draw` | PT1, PT4 |
| The time per change | From the first model call to the passing `submit`, p50 and p90 | PT2 (a lower bound: there is no Trunk and no push in it) |
| The share of energy creatures that reference `ENERGY_MAX` | For A08, A09, P1a and P1b: the module imports `ENERGY_MAX` and references it outside the import (`02` TP16, HC4) | RR18; the limit of HC3 (a) in the README |
| The share that repair correctly after the scripted heads-up | For P1a: 0.3 is an energy number of the final file and 30 is not. For P1b: 0.05 is, and 5 is not. A run that wrote a share of `ENERGY_MAX` has nothing to repair and is classed `relative` (ME8). | PT3 |

The script never executes code that a model wrote; it parses it (ME6). Whether a creature behaves is judged at M3, where that code runs in the sandbox.

Access and spend. The script reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the shell environment (BP7); the owner creates that token (section 4). Its calls are outside the model gate, which does not exist yet. So the script keeps its own ledger with the arithmetic of SE6 and the prices of `05-agent.md` MG2, and starts no run that could pass `--max-usd` (default 3, a plan threshold; ME4). BP9 counts what it spent. If the token is not there by the end of Day 1, RR22 applies.

Output (`05-agent.md` 6.8). One file per model, `docs/measurements/models/<UTC date>-early-<model short name>.json`, of the type `ModelMeasurement` with `mode: "early"`, the three hashes of the texts it ran with, and for every run the final text of each file it wrote, so that the scoring can be checked again without a new run. The transcripts are written next to it, after `redact()`. The lead adds `docs/measurements/models/<UTC date>-early.md`: the question, the numbers against the marks, the decision, the date.

Acceptance (the lead):

```
npm test -- src/core/agent/loop scripts/measure
npm run measure:models -- --early --max-usd 3
```

1. Unit tests. `toHeadsUpForModel`, the tool-message rendering and `assembleMessages` reproduce the two worked examples of `05-agent.md` (3.7 and 3.8) from their inputs. `mem-pool` answers each of the seven tools on the seed with the result shapes of `01-core.md` 4.3 to 4.9 and the error codes of ME3. `score` gives the canned crab and shrimp of `02` 7.3 "references `ENERGY_MAX`" and "absolute number" before their repair and the class `repaired` after it. `workers-ai-rest` sends an assistant message that carries tool calls with a string `content` (MP1).
2. One result file per model exists, with every field of `ModelMeasurement`, `mode: "early"`, and `prompt_hash`, `tools_hash` and `texts_hash` equal to the values of `05-agent.md` 2.4. The sum of `spend_usd` over the files is at most the limit. A file with `incomplete: true` is measured again or its missing runs are named in the judgment.
3. The lead writes the judgment against PT1 to PT4 and sets `src/config/model-plan.ts` (`workhorse`, `race`, `per_minute`, a first `max_real_agents`; the default reading is ME11) in a commit that cites the files.

What the lead decides from it on Day 2:

| Result | Decision |
| --- | --- |
| The workhorse misses PT1 | RR5 step 1 now: the best measured model becomes the workhorse. If no model meets PT1, RR5 step 2, and the lead tells the owner on Day 2, because step 3 needs the owner. |
| Fewer than `RACE_SIZE` models meet PT4 | Slice 12 is not built, unless M3 reverses the result. |
| No model meets PT3 on this first reading | RR6's fallback is prepared from Day 3: the canned hero on a second pool becomes the planned path for the video. The prompt is revised in `05-agent.md` first (PR1) and measured again before M3. |
| "Absolute number" is below half of the runs for the chosen crab model | RR18. |

Limits of this evidence. There is no Trunk in the loop: no premises, no blind-spot confirm, no heads-up through the engine, no push, and tool calls take no time. The heads-up is scripted. Completion is therefore an upper bound, and time a lower bound, of what the engine measurement will show. The samples are small (`05-agent.md` 7.2 gives the odds), so a mark that is narrowly met or missed is measured again before it decides anything. A reading under a mark is acted on at once. A reading at or over a mark is not a pass (ME9): M3 judges the marks on the engine (2.5), and where the two differ, M3 decides.

### 2.3 Slice 2: live premises

| | |
| --- | --- |
| Goal | A landing that changes something an in-flight attempt relied on reaches that attempt, in the accept transaction, as a heads-up with the exact diff. The attempt goes around and lands. Attempts that did not rely on it are not disturbed. |
| Builds | 7.1; 7.2, every row; 7.4; 7.5; section 8; 6.3 and 6.4; 9.3; 9.4 steps 3a, 3b and 3c; 11.1; 11.2 (RW1 to RW4); the card route; and the transitions of 9.2 with these exceptions: T3 and T12 (Slice 15), T17 and T17a (Slice 3), T18 to T19s (Slice 13). Five things inside that list are named, because the reconciliation added or moved them. (1) Triage rows are answered inside the transaction by a `SyncTriage` (S6a): `OffTriage` gives `confirm` with reason `triage_unavailable` (TR5), and `ScriptedTriage` answers for a synthetic attempt from its truth list (TR8). (2) The held tier in the minimal form of HD1, because it must fail closed in every build: T4, T13 and T14, the CK9 re-check of step 3c, and `card.opened` with `preview: null`, `risk: null`, an empty blast radius and the options `land` and `decline`. Slice 11 adds what `features.held` adds: previews, the blast radius, the sentence of 10.2 step 4 and `land_now`. (3) The `stop` call (TA9, TA9a) with the stop reason `withdrawn`. (4) The Trunk side of `resume` for T21 (RS1, RS4, T20r, `attempts.resumes`, `RESUME_ACK_TIMEOUT_MS`) and the `reopen_failed` card; the engine entry of its option `new_attempt` opens the attempt, and Slice 4 starts its agent (UN6a). The card options are the ones of CD4. (5) `headsup.resolved` with `result`, `go_around` and `changed` (HU12); EV6 and EM1a for `summary_only`; SWR3 (hold and release). |
| Lanes | leaf, engine, trunk, agent, swarm |
| Owns | `src/core/classify/**`, `src/core/diff/**`; `src/core/trunk/` files `classify-batch`, `headsup`, `transitions`, `blind-spot`, `go-around`, `right-of-way`, `cards`, `stop`, `resume`; `src/worker/trunk/` files `headsup-push`, `resume-push`; `src/worker/routes/cards.ts`; `src/worker/agent/heads-up.ts`; `src/swarm/patterns/` files `add-energy`, `add-relative`, `rescale-energy`, `cosmetic`; `src/swarm/scripted-triage`; `test/integration/collide/**` |
| Depends on | Slice 1 |
| Cases | `C02`, `C03`, `C04`, `C05`, `C08`, `C09`, `C10`, `C11`, `C13`, `C14`, `C15`, `C16`, `C17`, `C24`, `C25`, `C26`, `C27`, `C29`, `C30`, `C32`, `C33`, `C34`, `C35`, `C36`, `C37`, `C39`, `C40`, `C41`, `C43`, `C44`, `C45`, `C46`, `C47`, `C54`, `C56`, `C57` |

Acceptance:

```
CASES=required npm run test:cases
npm test -- src/core/classify
npm test -- src/swarm/scripted-triage
npm run test:workerd -- trunk                  # item 9
npm run test:integration -- collide            # items 2 to 8, on test; pools seeded from tidepool-swarm, and from tidepool for item 7
```

1. `src/core/classify` has at least one test named with each row id of 7.2: `X0`; `E0`, `E1`, `E2`, `E2m`, `E3`, `E4`; `F0`, `F1`, `F2`, `F3`, `F3m`, `F4` to `F7`; `L0` to `L3`, and L1 checked late; `QT0` to `QT3`; `QR0`, `QR1`, `QR1m`, `QR2`, `QR3`, `QR4`; `QO0` to `QO2`; `B1`; `CKL`; `Z1`. One test runs `C06` as far as its landing with `CLEF_TRIAGE` off and expects `confirm`, reason `triage_unavailable`, in the same heads-up (TR5, `OffTriage`). `ScriptedTriage.judgeNow` answers 1 for a key in the attempt's truth list and 0 for any other key, and returns no promise (TR8, S6a).
2. `collide`, order 1, on a pool that is not summary-only: an `add-energy` agent is held before its submit by `hold_before_submit` (`op.recorded` for its file is the signal); a `rescale-energy` agent lands. The stream then has `headsup.sent` for the `add-energy` attempt with `result: "repair"`, `keys[0]` equal to `{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }`, `items[0].diff.before` containing `ENERGY_MAX = 100` and `after` containing `ENERGY_MAX = 1`; then `attempt.state` to `going_around` with `go_arounds: 1`; after a request with `release` (SWR3), `headsup.resolved` with `result: "repair"`, `changed: true` and a statement, then `landing.landed`. The landed file passes the oracle SW2. Its note has one `go_arounds` entry with rule `E2`.
3. `collide`, order 2: `rescale-energy` is held before its submit; `add-energy` lands. `headsup.sent` goes to the `rescale-energy` attempt with rule `QR1` in `keys` and the new referrers in `items[0].diff.added`.
4. An `add-plain` attempt in flight during either order receives no `headsup.sent`. A `cosmetic` landing causes no `headsup.sent` for any attempt (E0, F2).
5. `add-relative` in flight in order 1 receives the `E2` repair and acknowledges with no new operation. Its `headsup.resolved` has `changed: false` (HU12). This is the designed false abort (`02` 10.3), and it is what metric 14.4 counts.
6. The same order 1 on a pool created with `summary_only: true`: `headsup.sent` has the same `keys` and `items: null`; `landing.landed` has `note_json: null`; the stream holds no `premise.recorded`, `op.recorded` or `attempt.step` (EV6); `headsup.resolved` still carries `changed` (HU12).
7. On a pool created from the seed `tidepool`, a scripted `rescale-energy` submit answers `held`. The stream has `card.opened` of kind `held` with `preview: null`, an empty blast radius and exactly the options `land` and `decline` (HD1, CD4). Nothing lands until `POST …/cards/<card_id>` with option `land` (T4, T13). With option `decline` the attempt stops with `declined` (T14). An option that the card does not offer answers `invalid_args` (CD4).
8. Two `rescale-energy` agents are in flight and the first lands. The second receives `repair` with rule `E1` and ends its own attempt through the `stop` call: `attempt.state` goes to `stopped` with reason `withdrawn`, and no card opens (TA9, TA9a). A repeated `stop` answers `ok: true` with the stored reason.
9. workerd, Trunk side of `resume`, with a stub Agent: after `retry` on a go-around-limit card (T21), `attempt.reopened` has `cause: "retry"`, and a `resume` request with `resume_n: 1` reaches the Agent after the commit and is repeated every `HEADS_UP_REPUSH_MS` until it is answered (RS1). With a stub that never answers, after `RESUME_ACK_TIMEOUT_MS` the attempt is `stopped` with `reopen_failed`, and a `choice` card offers `new_attempt` and `stop` (RS4, T20r). No attempt is left in `going_around` with nobody working on it.

### 2.4 Slice 3: durable landing

| | |
| --- | --- |
| Goal | An accepted landing is never lost, never applied twice, and never called landed before it is on `main`, through restarts, deploys and partial pushes. Trunk's SQLite can be rebuilt from Artifacts. |
| Builds | 9.6, 9.7, 9.8, 9.9 (LP3 to LP11), AL1 to AL4 (every timer kind of 3.3, the `resume` timer of Slice 2 included), 3.6 (RB0 to RB5, `register` with `truth`), T17, T17a, the rebuild route |
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
2. `pushes` (real service, with the hand-built pack of S1): 300 single-landing batches in a row give 300 `batch.pushed` and no `pool.paused`. The report holds push time p50 and p99, the number of retries, the largest pack in bytes, and the size of Trunk's SQLite after the 300 batches. The run fails on any memory-limit error of the Durable Object (the 128 MB limit). This is the measurement that S1 lists as not yet made, and RR1's trigger reads it.
3. `rebuild` (real service): after 5 landings, `POST …/rebuild` gives `pool.state` `rebuilding`, then `ready` with `epoch` one higher and `head_seq: 5`; the notes of landings 1 to 5 have the same blob ids as before; the next landing is `seq` 6. The rebuild reads the notes by object id, from the notes commit that the ref advertisement names (S1c); this is the first read on the real service of objects reachable only from the notes ref (RR1b). A card that was open before the rebuild is closed as `stale` afterwards (RB0).
4. `deploy-drill` (real service): `npm run deploy:test` runs while 64 scripted agents are in flight. Afterwards: commits on `main` after the seed equal `head_seq`; every landing has exactly one `landing.landed`; the stream's `n` has no gap; every attempt is `landed` or `stopped` with a reason; `epoch` is unchanged.

Limit of this evidence: an eviction cannot be forced on the real platform. Item 1 covers it on local workerd; item 4 covers a deploy.

### 2.5 Slice 4: real agents behind the model gate

| | |
| --- | --- |
| Goal | A typed intent gets a real Workers AI agent that reads through Trunk, edits, adapts to a heads-up with its context intact, and lands. Every model call passes the model gate. The kill switch and the spend cap stop model calls. An evicted agent ends in a recorded state. |
| Builds | 3.3 (AG1 to AG8); 4.10 (HE1 to HE4); 4.11 and `05-agent.md`: the system prompt, the first `user` message, the seven tool definitions, how a heads-up is shown to the model, the context budgets, the resume message (PR1); the Agent side of `resume` (RS2, RS3, RS5) with the budgets of AG6; the Agent's own `stop` calls (TA9: budget, spend cap, time-out, model error, stall, kill switch, owner cancel); `new_attempt` starts a real agent (UN6a); 13.3 (SE6 to SE9, with `limits` sent to every registered pool: EV2a, EM6); 13.4 (SE10 to SE12); the intent, kill and stop routes; `ModelPlan` (S5) with the request shape MP1; the Agent's side of `register` (3.6 step 6). Track 4D: attempt repos (AG5, S3a to S3c). |
| Lanes | agent, trunk |
| Owns | `src/core/gate/**`; `src/worker/gate/**`; `src/worker/agent/` files `model-driver` (the `Driver` that wraps the pure loop of `src/core/agent/loop/**`, which exists since 2.2a), `resume`, `recovery`, `watchdog`, `register`; `test/workerd/agent/**`, `test/workerd/gate/**`; `src/worker/adapters/model/**`; `src/worker/routes/` files `intents`, `kill`, `stop`; the engine variant of `scripts/measure/models.ts` (the measure lane's paths are the agent lane's from Day 3); `docs/measurements/models/**`. The prompt and the tool definitions are not agent-lane files: they are `src/protocol/agent-prompt.ts` (lead, 2.1). Track 4D: `src/worker/adapters/attempt-repo/**`, `src/worker/workflows/attempt-repo.ts`, `src/worker/agent/checkpoint.ts` |
| Depends on | Slice 2. The model plan it starts with is the one the lead set from 2.2a. |
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
5. workerd: an Agent aborted during a model call retries from its journal at most `MODEL_RETRIES` times and then stops with `model_error` (AG2). With no journal row and state `working` it continues. The watchdog stops it with `stalled` only under the three conditions of AG3. Each of these stops reaches Trunk through the `stop` call, and a repeated call changes nothing (TA9). An unsettled reservation is charged in full (SE6a). A rate-limit answer makes a `gate` timer and no retry count (SE8).
6. A heads-up placed in a tool result is acknowledged by the next submit of the same Agent Durable Object, and the transcript's step numbers continue (HE1). Text inside the heads-up never appears in the system role (HE4). The system prompt and the tool definitions that the fake `AI` binding receives equal `src/protocol/agent-prompt.ts`, and the request has the shape MP1.
7. Track 4D: `attempt.repo` with `ok: true`; the repo in the `ATTEMPTS` namespace has `refs/heads/attempt` with `transcript.jsonl`, `ops.json`, `premises.json`. In workerd, with a provisioner that always fails, the landing still lands and `attempt.repo` has `ok: false` (AG5). With 12 attempts opened at once, at most `MAX_FORKS_IN_FLIGHT` provisioning calls are in flight at any moment (S3a; the platform record, X5), and each attempt's token is minted with an explicit scope, never taken from `fork()` (S3b). The track's first task is one measurement on `test`: whether `fork()` can place the fork in the `ATTEMPTS` namespace. If it cannot, SE22 wins and the `create()` adapter is built instead (1.7).
8. workerd, Agent side of `resume`: an attempt is parked by the go-around limit (T9), and the owner taps `retry`. The same Agent Durable Object receives `resume`, extends its budgets (AG6), calls `sync`, shows every waiting heads-up in one `user` message whatever its `wake` flag, continues its transcript step numbers, and lands (RS2, T21). A second `resume` with the same `resume_n` changes nothing. An Agent in `stopped` or `landed` is not started by a heads-up push (AG8, HE2). With the attempt's model removed from the model plan the Agent answers `model_unavailable`; the attempt stops with `reopen_failed` and the card offers `new_attempt` and `stop` (RS3, RS4). `new_attempt` opens a new attempt of the same intent with a real agent on the workhorse model; the old attempt stays `stopped` (UN6a).
9. workerd, `gate`: two pools are registered. Each pool's stream receives `limits` with source `gate` and that pool's own `source_n` counter, and a pool's first `limits` arrives at its registration (EV2a, EM6, SE9).

`measure:models` without `--early` is the engine variant of `05-agent.md` 6.4 (ME7): real agents through Trunk on `test`, with pools made from the seed `tidepool-auto` that are not summary-only. It measures one model per invocation, the workhorse of the `test` deployment. At M3 the workhorse runs all four sets of `05-agent.md` 6.2: `additive`, `hero`, `confirm` (P3a, which gives the cost of a confirm turn of row E2m) and `shared` (R01 to R12): 37 runs. Each other model of the race list is then measured with the sets `additive` and `hero`, after a `test` deploy that names it as workhorse: PT4 reads the first set, and the race of the video needs every candidate to repair the crab.

Both variants write one file per model, of one type. These are the fields that this plan's thresholds and risks read. `05-agent.md` 6.8 holds the full type, which adds fields and changes none of these:

```ts
type ModelMeasurement = {
  v: 1; mode: "early" | "engine";            // early: 2.2a, no Trunk. engine: real agents through Trunk on `test`
  build: string; recorded_at: string; model: string;
  prompt_hash: string; tools_hash: string; texts_hash: string;   // PR1 and `05-agent.md` 2.4
  spend_usd: number;                         // what this invocation spent (BP9)
  intents: Array<{ id: string; runs: number; landed: number;    // mode early: `landed` counts the completed runs
                   seconds: { p50: number; p90: number };
                   tool_calls: number; tool_errors: number; tokens_in: number; tokens_out: number; cost_usd: number }>;
  hero: { runs: number; references_energy_max: number; absolute_number: number;   // P1a, P1b (TP21, TP22)
          repaired_correctly: number; repair_ms: { p50: number; p90: number } };  // PT3; metric 14.7
  energy_creatures: { runs: number; references_energy_max: number };              // A08, A09, P1a, P1b (HC4, TP16)
  confirm: object | null;                    // engine variant only: the cost of a confirm turn of row E2m (MP2)
  runs: Array<{ intent: string; run: number; files: Record<string, string> }>;    // with more fields; `files` is what was scored
};
```

Plan thresholds. Each is judged twice: a first reading from the early measurement on Day 2 (2.2a), and the confirming measurement on the engine at milestone M3. Where the two differ, M3 decides.

| Id | Threshold | If missed |
| --- | --- | --- |
| PT1 | With the workhorse model, at least 8 of the 12 additive intents A01 to A12 land in one pass, with no owner action. (Early reading: 8 of 12 are completed.) | RR5 |
| PT2 | Intent to landed: p50 at most 120 s, p90 at most 300 s. (The early reading has no Trunk and no push in it. It can show that PT2 is missed, not that it is met.) | RR5 |
| PT3 | For at least one model, intents P1a and P1b each end with the correct number (`< 0.3`, `drain(…, 0.05)`) after the `ENERGY_MAX` heads-up in at least 4 of 5 runs. (Early reading: after the scripted heads-up.) | RR6 |
| PT4 | At least `RACE_SIZE` models land at least 6 of the 12 additive intents. | Slice 12 is not built. |

### 2.6 Slice 5: the Floor's MUST surface

| | |
| --- | --- |
| Goal | A person who cannot read code types an intent, watches agents and their premises, and sees a landing, from the stream alone (FL1). |
| Builds | `03` sections 0, 2.1, 2.2, 2.8 to 2.10; components 3.1 to 3.5, 3.7, 3.8, 3.17, 3.18, 3.19 and the card sheet without frames (the last paragraph of 3.13); section 4 for every event type Slices 1 to 4 emit; section 6; the rows of `03` section 7 that need no SHOULD feature (FR1 to FR14, FR16, FR17, FR20 to FR22, FR26, FR27, and of the rows the reconciliation added: FR28, the stalled pool frame, and FR30, an unknown pool; FR11 now also covers a pool paused with `push_rejected`) |
| Lanes | floor-shell, floor-rail, floor-pool (3.1), stream |
| Owns | `src/floor/components/` directories, by lane. floor-shell: `strip`, `banners`, `owner-key`, `kill-switch`, `toast`; `src/floor/keys/**`. floor-rail: `intent-box`, `attempt-card`, `lights`, `heads-up`, `tray`, `card-sheet` (the sheet of `03` 3.13 without frames, which a choice card uses). floor-pool: `pool-frame`, `tiles`. stream: the remaining handlers under `src/protocol/reducer/`; fixtures for each failure row. |
| Depends on | Slice 1 (track 1F). It runs against fixture streams, so it does not wait for Slices 2 to 4. |
| Cases | none new |

Acceptance:

```
npm run test:e2e
npm run test:e2e -- --project=deployed floor      # after IP3
```

1. Fixture project: AC1 to AC5, AC7 to AC9, AC12, AC13, AC14, AC16, AC17 and AC20 pass; AC15 passes for the rows in scope, in both themes. Of the checks that the reconciliation added to `03` Appendix B, these pass here: AC22 for held and choice cards, AC23 for the frame on `main`, AC25, AC26, AC27 and AC29.
2. AC14 in detail: in `hero-c04.ndjson` the light for `world/energy.js#ENERGY_MAX` on the creature's card is `changed` at the landing of the shared rule and `holds` again at the resolving submit.
3. On `test`, as the owner: the key is pasted once and appears in no address, storage, console line or other request (AC16). Typing intent A01 gives a card; one light appears for each `premise.recorded`; the file tiles show reader and writer marks; the strip shows real agents with the limit and its reason, landed, go-arounds, waiting and spend.
4. On `test`, in a fresh browser profile: the document contains no owner control (AC5); the intent box is disabled and says why (FL7).
5. Fixture project, with `features.held` false: a `card.opened` of kind `held` in the minimal form of HD1 gives a tray row and the card sheet without frames (title, body, paths, the buttons of its options). The texts are the ones the event carries (CD5), and the buttons are the card's options and no other (CD4). Land sends one card request that carries the `submit_id` on screen (CO35). No wait on screen lacks its sentence (FL10).
6. `/p/<pool>` shows that pool as the main pool (it exists since track 1F). A pool id that does not exist shows the page of row FR30. A fixture with `pool.paused` and reason `push_rejected` shows its banner with the Rebuild button (LP8, row FR11).

### 2.7 Slice 6: the hero conflict and the plain-merge pool

| | |
| --- | --- |
| Goal | The same changes are shown in two pools side by side: `main`, where the broken premise was caught and repaired, and the plain-merge pool, labelled as constructed. Both landing orders. Deterministic with the canned cast; honest with real agents (TP20). |
| Builds | 11.7 (PM1 to PM7), `ops_first`, the plain-merge repository, `plain.updated` with `tree` and `interrupted`; the `plain` source of the app server and the source segment `p-<40 hex>` (PV5); the in-page self-test (`02` 5.5); Compare view (`03` 2.3, 3.6) with its self-test badges and its lines for "approximated", "interrupted" and "no visible difference"; the canned casts of `02` 7.3 and 8.2, pair P9 of the second catch (GP3) and the conductor (`02` 7.11) |
| Lanes | leaf, engine, git, pool, swarm, floor-pool |
| Owns | `src/core/plain/**`; `src/core/trunk/` files `ops-first`, `plain-apply`; `src/worker/trunk/plain-runner.ts`; `src/swarm/casts/**`, `src/swarm/conductor.ts`; `src/floor/components/` directories `compare`, `plain-frame`; `test/tidepool/scenarios/**`; `test/integration/hero/**`; `scripts/rehearse/**` |
| Depends on | Slices 2, 3, 5 |
| Cases | none new |

Acceptance:

```
npm test -- test/tidepool/scenarios
npm run test:integration -- hero
npm run rehearse:hero -- --runs 20
```

1. `scenarios`: rows A3 to A7, A8 (for the canned files), A10 and A12 to A19 of `02` Appendix A hold on the real seed with the canned operations. Rows A9, A11 and A20 hold for their judgments on the seed `tidepool`, where the shared-rule change waits on the minimal held card of Slice 2; what they expect of a card's blast radius moves to Slice 11. Row A21 belongs to Slice 13 and row A22 to Slice 8. Rows A9 to A11 are the rows as rewritten on 2026-10-04 (0.1), and they agree with the vectors: in A9, H receives one item, `entity:world/energy.js#ENERGY_MAX` with rule `E2`, and both of H's judgments are recorded (`E2`, and `F3` folded by HU2a; `C57`); A10 is "written before S lands: `E2` repair, one go-around (`C10`); written after: `B1` at submit (`C30`)"; A11 has no blind-spot confirm (B1a), so S's submit after its repair answers `held`.
2. `hero`, order 1, canned cast: `main` ends with `ENERGY_MAX = 1`, `crab.energy < 0.3` and `drain(shrimp, 0.05)`. The plain-merge `main` ends with `ENERGY_MAX = 1`, `crab.energy < 30` and `drain(shrimp, 5)`. `plain.updated.skipped` is empty. J receives no heads-up.
3. Compare view, same seed in both frames: on the left the crab walks; on the right it never leaves its shell. After a probe with `selftest: true` the left self-test badge reads pass and the right badge reads fail with `not_exhausted` for the shrimp (`02` 5.5). The right frame carries the label `plain.label` and the word "constructed". Both frames are live frames: the left on `main`, moved by `probe` at `landing.landed`; the right on `plain`, moved by `probe` at `plain.updated` (SE16a).
4. Pair P4 on a fresh pool: `plain.updated.skipped` lists the second change and the page shows a text-conflict count of 1, with "approximated" next to it (PM3). Pair P5: the later `write`, whose base moved, is counted as a text conflict as well (PM3). A landing that the plain-merge replay built from unfinished work is in `plain.updated.interrupted`, and the page labels it (PM4, PM6).
5. `rehearse:hero` runs the conductor 10 times in each landing order and writes `docs/measurements/rehearsal/hero-20.json`. Pass (M4): in 20 of 20 runs the heads-up (rule `E2` in order 1, rule `QR1` in order 2) precedes the dependent landing, and both final trees are as in item 2. The conductor runs on a pool that is not summary-only, so its waits on `op.recorded` end (EV6).
6. With real agents whose code does not depend on the old scale, the two pools hold the same files: `plain.updated.tree` equals `landing.landed.tree` of the landing `through_seq`. Only on that fact does the page say "no visible difference in this run", and it shows no canned code (PM7, `02` TP20). AC24 passes, and so does AC23 for the frame on `plain`.
7. The second catch, with pair P9 of `02` 9.3 on the real seed (GP3): the group `starter` has landed, so the shrimp of P1b, which calls `drain(`, is on `main`. The sweep P9a searches for `drain(`, edits the match and waits on its held card. The late creature P9b, which also calls `drain(`, lands. The sweep receives `repair` with rule `QT1` and the new match in `added`, and its card closes as `stale` (QT1, T8; `03` beat 5; `02` 9.5 and row A20). A test compares every text of `src/config/prewritten.ts` with `02` section 9, word for word.

### 2.8 Slice 7: Why card, "show the git", Who relies

| | |
| --- | --- |
| Goal | Any creature on screen explains itself from the landing's note, and the same record is readable with stock git. |
| Builds | `03` 3.9, 3.10, 3.11, 2.5; the note route and the read-token route (13.6, SE5c); the rest of FS2 and SE19 (Why, who relies and the note are answered from the Floor's state; the part the app server needs exists since track 1E) |
| Lanes | floor-pool, stream, trunk, git |
| Owns | `src/floor/components/` directories `why`, `git-drawer`, `who-relies`; `src/protocol/reducer/` files `why`, `who-relies`; `src/worker/floor/public-reads.ts`; `src/worker/routes/read-token.ts` |
| Depends on | Slices 1, 2, 5 |
| Cases | none new |

Acceptance:

```
npm run test:e2e -- why
npm run test:integration -- why
```

1. Tapping a creature opens its Why card: the requester's words, the model, what it relied on, each go-around with its cause and the agent's statement, the checks, how it landed.
2. "Show the git" shows the commit id, the two trailers, the note and two git commands. For a landing by a real agent, the body of `GET /api/pools/<pool>/landings/<seq>/note` has the blob id given in `landing.landed.note`. The same holds for a landing of a canned cast on a pool that is not summary-only: its Why card and its note are shown under the SYNTHETIC banner (EV6). In a summary-only pool the route answers 404 (13.6) and the drawer shows `git.no_note`.
3. A token from `POST …/read-token` clones the repo and is refused on push. The adapter never calls `createToken` without a scope (unit test).
4. Who relies on `ENERGY_MAX` lists the landed changes and the in-flight attempts; the pool frame receives `highlight { kinds }` and outlines those creatures (`02` 4.5).
5. workerd: during 100 public reads (Why, who relies, metrics, a ref-following frame) Trunk receives 0 requests (SE19). The app server's `~head.js` takes `seq`, and its order of newest files, from the Floor's state (FS2).

### 2.9 Slice 8: Swarm with measured numbers

| | |
| --- | --- |
| Goal | One Trunk, one pool, a thousand scripted agents on the same tools and landing path, under the SYNTHETIC banner, with numbers that were measured in the run on screen. |
| Builds | `02` 10.1 to 10.4: the remaining patterns with their truth lists, the collision dial, SW1 to SW3. A sweep pattern answers its first repair; at its second repair, or on `limit_reached`, it withdraws through the `stop` call (`02` SW7, TA9a), so that one sweep cannot hold right of way against every creature-adding landing. The Swarm Workflow as the launcher of a run (SWR1, SWR4), with `swarm.state` sent to every registered pool (EV2a, EM6). The `metrics` event (EM5, section 14), with 14.4 taken from `headsup.resolved.changed` and 14.5 from green-line reverts. `03` 2.6, 3.15, row FR24. (`ScriptedTriage` exists since Slice 2.) |
| Lanes | swarm, stream, floor-shell |
| Owns | `src/swarm/patterns/` files `retune`, `edit-creature`, `sweep-colour`, `sweep-search`, `same-file`, `reader`, `blind`; `src/swarm/` files `dial`, `oracle`; `src/worker/workflows/swarm.ts` (the route of track 1J now starts it); `src/protocol/reducer/metrics.ts`; `src/worker/floor/metrics.ts`; `src/floor/components/swarm/**`; `scripts/soak/**`; `docs/measurements/soak/**` |
| Depends on | Slices 2, 3, 5 |
| Cases | none new |

Acceptance:

```
npm test -- src/swarm src/protocol/reducer/metrics
npm run soak -- --agents 1024 --dial 0,0.1,0.25,0.5,1 --seed 7
npm run test:e2e -- swarm
```

1. Each metric of 14.1 to 14.8 has a reducer test whose expected value is worked by hand from a fixture stream and the definition in section 14. The test of 14.4 runs on a summary-only fixture that holds no `op.recorded`: the rate comes from `headsup.resolved.changed` alone (HU12). The test of 14.5 gives `null` when `features.green` is `"none"`.
2. The soak passes every check of VE6 (5.2). Its pools are created with `summary_only: true`.
3. Swarm view: the SYNTHETIC banner with the agent count and "no model calls"; the four large numbers, the false-abort rate and the escape rate come from `metrics` events; moving the dial changes `swarm.state.collision_dial`. The truth-label false-abort rate and the SW2 escape count are not on the page: they are in `SoakResult` (VE6).
4. `swarm.state` reaches the stream of the Swarm pool and the stream of the main pool, each with source `swarm` and its own counter (EV2a). The `reader` pattern receives an `info` heads-up and no confirm when `world/energy.js` changes (TR8: its truth list does not hold the changed keys). Row A22 of `02` Appendix A holds, and a sweep pattern that is repaired a second time withdraws (`02` SW7).

### 2.10 Slice 9: Replay with no credentials

| | |
| --- | --- |
| Goal | A judge opens one address with no account and no key, and the same page plays the recorded stream. |
| Builds | `03` section 8 (RY1 to RY27), 2.7, 3.16, row FR25; the export route and the check of `01-core.md` 12.3 RP1; the list of recordings, which names the four recordings of SC7 (`hero`, `rehearsal`, `hero-canned`, `swarm`) |
| Lanes | floor-shell, stream, lead |
| Owns | `src/floor/replay/**` except `player.ts`; `src/worker/floor/export.ts`; `scripts/recordings/**`; `public/replay/**`; `test/e2e/shell/replay/**` |
| Depends on | Slices 5, 6 |
| Cases | none new |

Acceptance:

```
npm run record:export -- --pool <pool> --id hero-canned
npm run test:e2e -- replay
```

In this slice the recording is `hero-canned`: the conductor's run of Slice 6 on a pool that is not summary-only. The recordings `rehearsal` and `hero` are real-agent runs and are exported on Day 8 and after the take (SC7).

1. A fixture stream with a planted string that matches `redact()` is refused by the export, which names the line (`01-core.md` 12.3 RP1).
2. AC1, AC6, AC18 and AC30 pass, and AC23 for Replay. RY25: against a local Worker started with no `OWNER_KEY`, in a browser context with no cookies, way 1 and way 3 of `03` 8.7 play the recording to its end, and the network log holds only the requests of RY1.
3. The same test against the deployed address, with no cookies. The frames are commit frames (SE16a): they load their commit addresses (PV5) from the kept pool repo and plain-merge repo (RY10), and they move from one landing to the next by `advance`, with no page reload.
4. A recording whose header says `synthetic: true` shows both banners, REPLAY and SYNTHETIC (RY3). `hero-canned` is such a recording, and it still shows premise lights, heads-up diffs and Why cards, because its pool is not summary-only (EV6). Chapter keys jump to the chapters of `03` 8.5.
5. `record:export` refuses a file larger than `REPLAY_MAX_BYTES` (RY6) and a file that fails a check of `03` 8.3. In the page, each failing check of 8.3 shows its sentence and `replay.to_live` (row FR25).

### 2.11 Slice 10: README, About, run instructions

| | |
| --- | --- |
| Goal | A stranger can run it and knows its limits. |
| Builds | `README.md`, the About sheet (`03` 5.12), the three submission texts |
| Lanes | lead, floor-shell |
| Owns | `README.md`; `src/floor/components/about/**`; `src/copy/limits.ts`; `docs/submission/**`; `scripts/submission/**` |
| Depends on | Slices 1 to 9 |
| Cases | none new |

Acceptance:

```
npm run check:submission
git clone . /tmp/premise-fresh && cd /tmp/premise-fresh && npm ci && npm run check
```

1. `run.txt` has at most 4,000 characters; `vision.txt` and `cloudflare.txt` at most 2,000 each. The phrase lint (BP11) passes: no phrase of FL6 anywhere, and "branch", "pull request" and "merge queue" only in `vision.txt` and in the README section that states the thesis. The limits list in the README equals the one in About (AC19).
2. A builder that is given only the README reaches a playing Replay with `npm run dev:floor`, and a deployed `test` Worker with a created pool, by typing the README's commands unchanged.
3. Every number in the README names the file under `docs/measurements/` it came from (section 14, last sentence).
4. The limits list holds the limits that the core says must be stated: the three of HC3 (a hard-coded number in a module that never references the quantity is caught by rule in neither order; references are direct; a sweep is recognised from operations) and the one of RB0 (after a rebuild from Artifacts, open cards close and agents in flight register again). The README says whether the deployment uses a separate app host (SE14b). Its related-work section names STORM, CoAgent and the entry "dibs", and makes no priority claim.

### 2.12 Slice 11: held-path card with before and after

| | |
| --- | --- |
| Goal | A change to a held path waits for one owner tap on a card that shows the pool before and after and which waiting changes it would send back. |
| Builds | 10.2 in full, which is `features.held` true: what the card shows, the sentence of step 4 and `land_now` (the minimal form of HD1, with the tier re-check of the tick, exists since Slice 2); PV1 to PV5 with PV1a; 11.6 blast radius; RW5; `03` 2.4, 3.13, rows FR15 and FR32 |
| Lanes | engine, git, trunk, floor-rail |
| Owns | `src/core/trunk/` files `held`, `blast-radius`, `preview`; `src/worker/trunk/preview-runner.ts`; `src/floor/components/held-sheet/**`; `test/integration/held/**` |
| Depends on | Slices 2, 5, 6 |
| Cases | `C18`, `C48`, `C49` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:integration -- held`, `npm run test:e2e -- held`.

1. On a pool seeded from `tidepool`: canned S submits and the card opens with blast radius `repair: [C, H]` (row A9). The sheet shows two commit frames: "before" at the last landed commit of `main`, "after" at the preview commit that Trunk pushed under `refs/previews/<submit_id>` of the plain-merge repository, addressed `/pool/<pool>/p-<commit>/` (PV2, PV5). This is the first read on the real service of a commit that is reachable only from `refs/previews/*`. If the after frame does not load for that reason, RR1b's fallback applies (PV1a).
2. Tapping Land: S lands; C and H receive `repair`. Tapping an out-of-date card does nothing and the sheet says so (`C34`). When the blast radius lists an attempt with right of way, the card shows the sentence of 10.2 step 4 and offers `land_now` between `land` and `decline` (CD4, `C48`, `C49`).
3. `curl` to any `a_` or attempt path of the app server answers 404 (PV4, PV5).

### 2.13 Slice 12: Race and choose

| | |
| --- | --- |
| Goal | Three models attempt one intent; the owner compares three running pools and chooses one; it lands through the same gate. |
| Builds | 11.4 (RC1 to RC7), the race card (CD2; its one option is `choose`, CD4), `03` 3.14 |
| Lanes | engine, trunk, agent, floor-rail |
| Owns | `src/core/trunk/race.ts`; `src/floor/components/race-sheet/**`; `test/integration/race/**` |
| Depends on | Slices 4, 11; PT4. For `C58`: the engine files of Slice 13 (`undo-apply`, `reopen`), which the engine lane builds the day before (3.3). |
| Cases | `C58` (`C54` is already required) |

Acceptance: `CASES=required npm run test:cases`, `npm run test:integration -- race`, `npm run test:e2e -- race`.

1. An intent with `race: true` opens `RACE_SIZE` attempts with different models. Each goes to `held` on one race card whatever its tier (RC2).
2. A candidate that goes around is shown with `can_choose: false`; the card stays open (RC5).
3. Choosing one sends `option: "choose"` with that candidate's `attempt_id` (CD4). It lands. `card.closed` has `action: "choose"` and that `attempt_id`, and `reason` holds only what the owner typed (CD1). The others stop with `not_chosen`; their attempt repos still exist (RC4). AC22 passes for the race column.
4. `C58` passes: a chosen candidate is an ordinary attempt afterwards. Reopened by an undo, its next submit follows its path tier and lands with no card (RC7).
5. With `features.race` false, an intent with `race: true` answers 404 with `feature_off` and changes nothing (FJ1).

### 2.14 Slice 13: causal Undo

| | |
| --- | --- |
| Goal | Undo takes back one landing and exactly the later landings built on it, and reopens their agents with their transcripts. |
| Builds | 11.3 (UN1 to UN8, with the types `UndoPlan`, `UndoPlanResponse` and `UndoResponse`), T18, T19, T19s, GL6 (the `revert_limit` card offers `retry` and `stop`), `resume` with the causes `undo` and `revert` (RS1), the two undo routes; `03` 3.12, rows FR23, FR29 and FR31. The Agent side of `resume`, AG6 and AG8 are not built here: they exist since Slice 4, because "Try again" needs them in every build. |
| Lanes | leaf, engine, trunk, floor-pool |
| Owns | `src/core/undo/**`; `src/core/trunk/` files `undo-apply`, `reopen`; `src/worker/routes/undo.ts`; `src/floor/components/undo-sheet/**`; `test/integration/undo/**` |
| Depends on | Slices 2, 4, 5 |
| Cases | `C19`, `C53` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:integration -- undo`.

1. After the hero in order 1 with a real crab agent, the plan for the shared-rule landing (`UndoPlan`) lists the crab's landing under `reverted` and its attempt under `reopened`. A creature whose agent read `world/energy.js` after the shared-rule landing, and whose code does not reference it, is under `kept_readers`. An unrelated creature is in no list (UN4, vector `C19`). Row A21 of `02` Appendix A holds for the canned run of `02` 9.5.
2. Confirming lands one commit of kind `undo` with `Undoes:` trailers. `attempt.reopened` has `cause: "undo"`. The crab's Agent receives `resume`; its attempt returns to `going_around` with `revision: 2`, the same model and continuing transcript steps (UN6, RS2), and lands again.
3. A confirm whose `expect_reverted` no longer matches answers `plan_changed` with the new plan (`UndoResponse`) and lands nothing. The sheet shows the new plan and asks again (UN5, `C53`, row FR31, AC28).
4. Engine test: an attempt at `MAX_REVISIONS` is not reopened by itself. Its landing is still reverted, it stops with `revert_limit`, and the `choice` card offers exactly `retry` and `stop`. `retry` resumes it with `revision` one higher (T19s, GL6).
5. With `features.undo` false, the undo-plan route and the undo route answer 404 with `feature_off` (FJ1).

### 2.15 Slice 14: green line

| | |
| --- | --- |
| Goal | `refs/heads/green` follows the newest verified commit. A confirmed red reverts and reopens. |
| Builds | 11.5 (GR1 to GR8); `02` 5.4; the `Verifier` of S4; `03` row FR19 and the green cell of the strip. Part 14a: runtime `static`, GR1, GR2, GR4, GR5; `features.green` is `"static"`. Part 14b: the Dynamic Worker isolate (S4a to S4c) and GR3; `features.green` is `"full"`. |
| Lanes | git, pool, engine, floor-shell |
| Owns | `src/core/trunk/green.ts`; `src/worker/workflows/green-line.ts`; `src/worker/adapters/verifier/**` (git lane), except `src/worker/adapters/verifier/harness/**` (pool lane: the generated entry module and the mapping of `02` 5.4 to `VerifyResult`); `src/floor/components/green/**`; `test/integration/green/**` |
| Depends on | Slice 3 for 14a; Slice 13 for 14b. The runtime of 14b is the Dynamic Worker isolate through the `LOADER` binding (1.7, S4). |
| Cases | none new |

Acceptance: `npm run test:integration -- green`.

1. 14a: after a landing, `git ls-remote` shows `refs/heads/green` at the head commit; the stream has `green.verified` with `runtime: "static"` and `green.advanced`; the strip says "static checks only".
2. 14b: the plain-merge tree of the hero (row A5), pushed to a throwaway pool as a landing, gives `green.verified` with `ok: false` and `confirmed: false`, then `green.verified` with `ok: false` and `confirmed: true`, then one landing of kind `revert` and reopened attempts (GR3). After the first event the page shows only `green.checking`; the banner that announces the revert appears after the second (`03` 4.3, row FR19, AC21). `checks` holds only names and codes of the fixed list of GR8; the free text of a check and the log appear in no event and no heads-up (GR7).
3. 14b: the verifier's environment has no binding and no outbound network (GR6), shown by a test creature that tries both and is refused.
4. 14b: 50 verifications of the seed commit give at most one missing or late verdict, and a commit with `MAX_KINDS` creature files loads and gives a verdict (RR4). `GREEN_CPU_MS` is set from this run (BP8). The lead adds the result as a dated record under `docs/measurements/spikes/`.

### 2.16 Slice 15: Clef triage and the risk lines

| | |
| --- | --- |
| Goal | Where an agent read something that changed and its patch does not name it, Clef gives a recorded probability instead of a blanket `confirm`. A held card shows three risk answers. |
| Builds | 7.3 (TR1 to TR9) with `ClefTriage`, the asynchronous `Triage` (S6a), V7, V7a, 10.4 (RK1 to RK4), GL4 if `CLEF_CONTRADICTION` is on; `03` row FR18 and the risk lines. The model for triage and for risk is `@cf/cloudflare/clef` (1.7, S6). |
| Lanes | engine, agent, trunk, floor-rail |
| Owns | `src/core/trunk/triage.ts`; `src/worker/trunk/triage-runner.ts`; `src/worker/adapters/triage/**`, `adapters/risk/**`; `scripts/calibrate/**`; `docs/measurements/calibration/**`; `test/workerd/triage/**`; `src/floor/components/risk/**` |
| Depends on | Slices 2, 4; Slice 3 for `C52`; Slice 11 for `C55` and for the risk lines; the S6 record for the adapters |
| Cases | `C06`, `C07`, `C12`, `C31`, `C38`, `C42`, `C52`, `C55` |

Acceptance: `CASES=required npm run test:cases`, `npm run test:workerd -- triage`, `npm run calibrate:clef`.

1. The eight cases pass in Node with no Clef call (Appendix A, runner rule 5). This part has no dependency on the service and is built even if the adapters are cut.
2. `calibrate:clef` writes the confusion table for at least 48 hand-labelled cases and the thresholds chosen from it (S6). The set is the `triage` vectors plus at least 40 more cases; it includes QR4 cases and cases taken from real agent runs. The file also holds what S6 lists as not yet measured: how many questions one request accepts (`CLEF_MAX_QUESTIONS`), the input size at which the service truncates (`CLEF_INPUT_TOKEN_LIMIT`), and the latency of `clef` and of the fallback `clef-flash`. The switches go `on`, and `features.clef` true, only if RR7's condition holds.
3. workerd, with a fake `AI` binding that answers with given probabilities, for a real attempt that read a whole shared file while one of its entities changes: the `info` heads-up with a pending item is created in the accept transaction (TR1); the Clef request leaves only after the commit (TR2); a second `premise.judged` carries `clef.p` (JE1); an answer that arrives after a new operation is recorded as `stale` (TR4); a state over `CLEF_STATE_MAX_CHARS` is never sent (TR7); a synthetic attempt causes no request (TR8).
4. The real service is exercised by `calibrate:clef`, which calls the same adapters.

### 2.16a Slice 16: real repositories (added 2026-10-04)

The owner decided on 2026-10-04 that a pool can also be made from a public git repository, in any language, with entity-level premises for TypeScript beside JavaScript and, as a stretch, for Python and Go. `06-repos.md` is the specification of this slice: its section 5 holds the three steps and their acceptance. Slice 12 (Race and choose) is kept. Step 3 starts only if steps 1 and 2 pass by 2026-10-08.

### 2.17 STRETCH

Clef vision check of screenshots, duplicate-intent detection, outside agents over MCP, the audience phone page. None is scheduled before the submission. One may start only when M5 passed with every SHOULD slice in the build and both reviews closed. Otherwise none starts before 2026-10-16.

---

## 3. Parallelism map

### 3.1 Lanes

A lane is a set of paths with one builder at a time. Two tasks that run at the same time are always in different lanes, so the paths they write are disjoint (BP2). Each lane works in its own git worktree on a branch `lane/<lane>/<slice>`. Commits are `<type>: <description>`. Only the lead merges into `main`. Nothing is pushed to a remote until the owner has named one (RR19, SC1).

`scripts/ops/lanes.json` holds this table as globs. `check:lane` and the lane table of `AGENTS.md` are built from it. A path that no lane lists belongs to the lead.

| Lane | Paths |
| --- | --- |
| lead | Root files, `src/protocol/*.ts`, `src/config/**`, the seams of 3.2, `src/copy/index.ts`, `src/worker/env.ts`, `src/worker/adapters/index.ts`, `src/worker/adapters/not-built.ts`, `scripts/build/**`, `scripts/ops/**`, `scripts/submission/**`, `docs/**`, `README.md`, `AGENTS.md`, `test/arch/**`, `test/support/**`, `test/cases/` files `load.ts`, `required.json`, `list.test.ts`, `test/workerd/cases-smoke.test.ts`, `test/e2e/lead/**` (the rehearsal run), `public/**` |
| leaf | `src/core/` directories `sync`, `keys`, `entities`, `refs`, `replay`, `policy`, `diff`, `classify`, `plain`, `undo`; `test/tidepool/scenarios/**` |
| git | `src/core/` directories `git`, `outbox`, `rebuild`; `src/core/trunk/` files `outbox-apply`, `restart`, `register`, `wiring/git`; `src/worker/adapters/` directories `pusher`, `token-source`, `notes-reader`, and `verifier` except `verifier/harness/**`; `src/worker/trunk/` files `push-runner`, `reconcile`, `rebuild-job`, `plain-runner`, `preview-runner`, `wiring/git`; `src/worker/workflows/green-line.ts`; `test/git/**`; `test/integration/landing/**`, `test/integration/green/**` |
| engine | `src/core/trunk/**` except `engine.ts` (seam) and the four files of the git lane; `test/cases/driver.ts`, `test/cases/run.test.ts` |
| trunk | `src/worker/trunk/**` except `effects.ts` (seam) and the files of the git lane; `src/worker/routes/**` except `swarm.ts`; `src/worker/security/**`; `test/workerd/trunk/**`, `test/workerd/landing/**`; `test/integration/**` except the directories named in other lanes |
| agent | `src/core/agent/**` (on Day 1 and Day 2 except `loop/**`), `src/core/gate/**`; `src/worker/agent/**`, `src/worker/gate/**`; `src/worker/adapters/` directories `model`, `attempt-repo`, `triage`, `risk`; `src/worker/workflows/attempt-repo.ts`; `test/workerd/agent/**`, `test/workerd/gate/**`, `test/workerd/triage/**`; `scripts/calibrate/**`; from Day 3 also `scripts/measure/**` |
| measure | `scripts/measure/**` and `src/core/agent/loop/**`. Used on Day 1 and Day 2 for the early model measurement (2.2a), so that it has its own builder beside track 1H. At IP1 the lead moves both globs to the agent lane in `lanes.json`. |
| stream | `src/protocol/reducer/**`; `src/worker/floor/**`; `test/workerd/floor/**`; `test/fixtures/streams/**`; `scripts/fixtures/**`, `scripts/recordings/**` |
| floor-shell | `src/floor/main.tsx`; `src/floor/app/**` except `registry.ts` (seam) and the wiring modules of the other two floor lanes; `src/floor/` directories `stream`, `replay`, `state`, `styles`, `keys`; `src/floor/components/` directories `strip`, `banners`, `owner-key`, `kill-switch`, `toast`, `about`, `swarm`, `green`; `test/e2e/shell/**` |
| floor-rail | `src/floor/app/wiring/rail.ts`; `src/floor/components/` directories `rail` (the rail region, moved to this lane at IP1), `intent-box`, `attempt-card`, `lights`, `heads-up`, `tray`, `card-sheet`, `held-sheet`, `race-sheet`, `risk`; `test/e2e/rail/**` |
| floor-pool | `src/floor/app/wiring/pool-area.ts`; `src/floor/components/` directories `pool-frame`, `plain-frame`, `compare`, `tiles`, `why`, `git-drawer`, `who-relies`, `undo-sheet`; `test/e2e/pool-area/**` |
| copy | `src/copy/**` except `index.ts`. Used on Day 1 and Day 2; from Day 3 these paths belong to the lead. |
| pool | `seeds/**`, `scripts/seeds/**`, `src/host/**`, `src/worker/app-server/**`, `src/worker/adapters/pool-source/**`, `src/worker/adapters/verifier/harness/**` (the self-test harness of Slice 14), `test/tidepool/**` except `scenarios/` |
| swarm | `src/swarm/**`, `src/worker/routes/swarm.ts`, `src/worker/workflows/swarm.ts`, `scripts/soak/**`, `scripts/rehearse/**`, `test/integration/collide/**`, `test/integration/hero/**` |

Result files under `docs/measurements/` are written by a lane's script and committed by the lead (BP3). A slice's "Owns" row in section 2 lists the files the slice adds; each of them lies inside the lane named for it here.

### 3.2 Seams and wiring modules

Two lanes never edit the same file. Where handlers of several lanes meet, the meeting point is a **seam**: a file of the lead, written in Slice 0 and complete from then on. A seam holds a table type and no logic. It imports one **wiring module** for each lane that registers something there and calls that module's `wire` function. Slice 0 creates every wiring module with an empty `wire`. After IP0 a wiring module is edited by its lane only, in whichever slice that lane is working on.

| Seam (lead) | Wiring modules, each with its lane | A line registers |
| --- | --- | --- |
| `src/core/trunk/engine.ts` | `src/core/trunk/wiring/engine.ts` (engine), `src/core/trunk/wiring/git.ts` (git) | An engine entry: a tool, a tick step, an owner action, an effect kind |
| `src/worker/trunk/effects.ts` | `src/worker/trunk/wiring/trunk.ts` (trunk), `src/worker/trunk/wiring/git.ts` (git) | A handler that runs after the transaction: events to the Floor, push, heads-up push, triage, plain, preview, green |
| `src/worker/index.ts` | `src/worker/routes/wiring.ts` (trunk), `src/worker/routes/swarm.ts` (swarm), `src/worker/floor/wiring.ts` (stream), `src/worker/app-server/wiring.ts` (pool) | A route of `protocol/routes.ts`. The seam also re-exports the seven class files of 2.1. |
| `src/floor/app/registry.ts` | `src/floor/app/wiring/shell.ts` (floor-shell), `rail.ts` (floor-rail), `pool-area.ts` (floor-pool) | A view, a sheet, a key |

The Floor's registry, as decided at IP1. A wiring module of the Floor holds no JSX, because `test/arch/seams.test.ts` loads it in the Node test program. An entry's `value` is therefore the entry's own name. Each Floor lane binds its names to components in `src/floor/app/wiring/<lane>.views.tsx`, and the lead's file `src/floor/app/bindings.tsx` merges the three records; `app.tsx` resolves a name only through it. The pool area and the rail are regions of the Floor view and not registry entries: the shell imports `PoolArea` (floor-pool, `components/pool-frame/`) and `Rail` (floor-rail, `components/rail/`) directly.

Files that only the lead edits, and that are not seams: `src/copy/index.ts`, `src/worker/adapters/index.ts` (the option in use for each port), `src/config/features.ts`, `wrangler.jsonc`, `package.json`, `test/cases/required.json`. The reducer's `index.ts` needs no seam: only the stream lane writes handlers.

Worked example. The seam is fixed at IP0:

```ts
// src/core/trunk/engine.ts (lead)
import { wire as wireEngine } from "./wiring/engine.js";
import { wire as wireGit } from "./wiring/git.js";

export type EngineTable = { entries: Map<string, EntryHandler>; effects: Set<string> };
export function engineTable(): EngineTable {
  const table: EngineTable = { entries: new Map(), effects: new Set() };
  wireEngine(table);
  wireGit(table);
  return table;
}
```

Slice 3 (git lane) adds `src/core/outbox/decide.ts` and `src/core/trunk/outbox-apply.ts`, and the lines `table.entries.set("push_result", outboxApply.pushResult)` and `table.entries.set("restart", restart.reconcile)` to `src/core/trunk/wiring/git.ts`. Slice 2 (engine lane), built at the same time, adds its entries to `src/core/trunk/wiring/engine.ts`. No file is touched by both, and `engine.ts` is touched by neither.

A builder asks the lead, and does not edit, when it needs: a change to `src/protocol/*.ts` (a protocol change; every lane rebases the same day), a new field in a seam's table type, a new dependency, a new binding, or a path that no lane owns.

### 3.3 What runs at the same time

Cells are slice or track ids. A lane with an empty cell helps the lead verify, or fixes findings in its own paths.

| Lane | Day 1 Oct 4 | Day 2 Oct 5 | Day 3 Oct 6 | Day 4 Oct 7 | Day 5 Oct 8 | Day 6 Oct 9 | Day 7 Oct 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| lead | reconciliation, 0a, 0b, IP0 | IP1; judges 2.2a | IP2 | IP3 | IP4 | IP5 | 10, IP6 |
| leaf | 1A | 1A, 2 (classify, diff) | 6 (plain) | 13 (undo planner) | 6 (scenarios) | | |
| git | 1B | 1B, 3 (outbox) | 3 | 3 (rebuild, deploy drill) | 6, 11 (plain and preview push) | 7 (read token), 14a | 14b |
| engine | 1C | 1C, 2 | 2 | 6 (`ops_first`) | 11 | 13, 15 | 12 |
| trunk | 1D | 1D | 2, 3 | 4 (routes) | 11, 7 (note route) | 13 | 12 |
| agent | 1H | 1H | 2 (heads-up, `stop`), 4 (pure parts, gate) | 4 (with `resume`), `measure:models` on the engine | 4D | 4D, 15 (labelled cases) | 15 (adapters) |
| measure | 2.2a | 2.2a | | | | | |
| stream | 1E | 1E | 5 | 5 | 7, 8 (metrics) | 9 (export) | |
| floor-shell | 1F | 1F | 5 | 5 | 8 (Swarm view) | 9 | 10 (About), 14 (green cell) |
| floor-rail | 1F | 1F | 5 | 5 | 11 (on fixtures) | 11 | 12, 15 (risk lines) |
| floor-pool | 1F | 1F | 5 | 5 | 6, 7 | 7, 13 (on fixtures) | 13 |
| copy | 1I | 1I | | | | | |
| pool | 1G | 1G | hot swap, in-page self-test | 6 (`plain` source) | 6 | 14 (harness) | 14b |
| swarm | 1J | 2 (patterns, `ScriptedTriage`) | 2 (`collide`) | 6 (casts, conductor) | 8 | 8 (soak) | |

Dependencies, as a list of what may not start earlier:

- Every track of Slice 1 after IP0. On Day 1 that is after the reconciliation, Slice 0a and Slice 0b.
- The early model measurement (2.2a) after IP0. It needs `05-agent.md`, `src/protocol/tools.ts` and `src/protocol/agent-prompt.ts`, and no track of Slice 1.
- Slice 2 engine work after track 1C passes its three cases. `src/core/classify` (leaf) needs only track 1A.
- Slice 3 needs track 1B and track 1C. It runs beside Slice 2: different lanes, different files, different wiring modules. The trunk lane does its Slice 2 files first, then its Slice 3 files.
- Slice 4's pure parts and gate need only IP0. Its integration needs IP2.
- Slice 5 needs track 1F only.
- Slices 6, 7 and 8 need IP2; their Floor parts need Slice 5's components.
- Slice 9 needs Slice 6 for the `hero-canned` recording.
- Slices 11 to 15 follow the table of section 2. The engine parts of Slice 13 need only Slice 2. `C58` (Slice 12) needs the engine parts of Slice 13 as well. The engine part of Slice 15 needs Slice 2 for six of its cases, Slice 3 for `C52` and Slice 11 for `C55`.

### 3.4 Integration points

At each point the lead does these steps in order. A failing step blocks only the lane that fails; its merge is reverted and the others proceed.

1. Run `npm run check:lane` for each lane branch. Rebase it on `main`. Merge in the order given. A branch that fails `check:lane` is not merged.
2. `npm ci && npm run check && npm run test:workerd`.
3. `npm run deploy:test`, then the integration and browser commands of the slices being merged.
4. Do the observable checks of those slices in a browser on `test`. Save screenshots under `docs/reviews/screens/ip<N>/`.
5. Add the slices' cases to `test/cases/required.json`. Run `CASES=all npm run test:cases` and save the table as `docs/measurements/cases.md`.
6. Write `docs/measurements/integration/ip<N>.md`: commit id, commands, results, open findings. Tag `ip<N>`. Run `npm run cleanup:test`.

| Point | When | Merges, in order | The lead verifies |
| --- | --- | --- | --- |
| IP0 | Day 1 | Slice 0a, then Slice 0b | 2.1. The protocol is frozen. Every port still resolves to `not-built`. When a track that builds an adapter is merged, the lead points that port in `adapters/index.ts` at the chosen adapter of 1.7, in a commit that cites the platform record. |
| IP1 | Day 2 | 1A, 1B, 1C, 1D, 1E, 1G, 1H, 1J, 1I, 1F; the measure lane's branch (2.2a) | 2.2: the tracer on `test`. Milestone M1. The result files of 2.2a, judged against PT1 to PT4: milestone M1a. The lead moves `scripts/measure/**` to the agent lane in `lanes.json`. |
| IP2 | Day 3 | Slice 2 (leaf, engine, trunk, agent, swarm), Slice 3 (git, trunk) | 2.3 and 2.4. 44 cases required. |
| IP3 | Day 4 | Slice 4, then Slice 5 | Before the deploy, the lead lowers the `test` cap by what 2.2a spent (BP9). 2.5 and 2.6. `measure:models` on the engine against PT1 to PT4. Milestone M3. |
| IP4 | Day 5 | Slice 6, Slice 7 | 2.7 and 2.8. `rehearse:hero`. Milestone M4. |
| IP5 | Day 6 | Slice 8, Slice 9, Slice 11 | 2.9, 2.10, 2.12. Soak run 1. Milestone M5 for MUST. |
| IP6 | Day 7 | Slices 12, 13, 14, 15, each on its own; Slice 10 | Each slice's acceptance, or its switch in `features` goes off (BP4). For each switch that is off, the request that needs it answers 404 with `feature_off` (FJ1). The freeze. |
| IP7 | Day 8 | Fixes from the reviews only | Section 5 in full on the frozen build. `production` deployed, its pools created, the check of BP10 done on it. Milestone M6. |

---

## 4. Schedule

The video is recorded on Day 9. Day 10 is margin. Nothing is built after Day 7.

| Day | Date | Work | Milestone at the end of the day | Cut line: if the day ends behind |
| --- | --- | --- | --- | --- |
| Day 1 | Sun Oct 4 | The reconciliation of the specification (done in the first hours of the day; 0.1, 0.2). `05-agent.md` is written. Slice 0a (the toolchain scaffold), then Slice 0b (the protocol module and the stubs). Slice 1 tracks start after IP0. The early model measurement (2.2a) starts as soon as `05-agent.md` and the two protocol files it needs exist. The platform record is already in the repository, so no track waits for a spike. | IP0 merged. | Slice 1 starts on Day 2 from the protocol as it is. STRETCH is dropped for good. A disagreement between the specification files that is found later follows RR11. |
| Day 2 | Mon Oct 5 | Slice 1. `src/core/classify` and Slice 2 patterns start. The early model measurement runs, and the lead judges it. | **M1**: the tracer passes 2.2 on `test`. **M1a**: the files of 2.2a exist for the three models of the starting plan, and the lead has judged PT1, PT4 and the first reading of PT3 and set the model plan from them. | For M1: Day 3 is the tracer only, all lanes; the drop order reaches item 3a (Slice 15's adapters, part 14b); if the push is the blocker, RR1's trigger has fired: switch option the same day. For M1a: the measurement finishes on Day 3 beside Slice 4's pure parts, and RR5 and RR6 are judged at M3 as before (RR22). |
| Day 3 | Tue Oct 6 | Slices 2 and 3. Slice 4 pure parts and gate. Slice 5 on fixtures. | **M2**: IP2; 44 cases required and passing. | The engine lane stays on Slice 2 on Day 4. The drop order reaches item 3a (Slice 15's adapters, part 14b); if both were already dropped on Day 2, it reaches item 3b (part 14a). Slice 12 is not dropped here: PT4 alone decides it. |
| Day 4 | Wed Oct 7 | Slice 4 integration and the model measurement on the engine. Slice 5 complete on fixtures. Slice 6 parts in leaf, engine, pool, swarm. | **M3**: IP3; PT1 to PT3 measured on the engine; kill and cap pass on `test`. | Apply RR5 or RR6, unless the early measurement already did. Slice 12 is dropped unless PT4 holds. The agent and trunk lanes stay on Slice 4 on Day 5, and track 4D starts when Slice 4 has passed. The drop order reaches item 3. |
| Day 5 | Thu Oct 8 | Slices 6 and 7. Slice 8 patterns and Workflow. Slice 11 engine part. Track 4D. | **M4**: IP4; `hero-20.json` shows 20 of 20. | Day 6 is Slice 6 only in the lanes it uses. The drop order reaches item 4 (Slice 15's adapters, part 14b, part 14a, Slice 13). |
| Day 6 | Fri Oct 9 | Slices 8, 9, 11. The engine lane reaches the 57 cases that need no Race. Soak run 1. | **M5 (MUST)**: every acceptance check of Slices 1 to 9 passes at one commit on `test`. | Day 7 is MUST only, in every lane. The drop order reaches item 5: of the SHOULD slices only Slice 11 may still finish on Day 7. Track 4D may still finish on Day 7; if it has not passed at the freeze, `features.attempt_repos` is false. The Swarm is run at the size that passes (RR9). |
| Day 7 | Sat Oct 10 | Slices 12, 13, 14, 15 in that order of priority; `C58` with Slice 12. Slice 10. Security review and design review on the Day 6 build, by builders that wrote none of the reviewed code. | **M5 (freeze)**: `features` is final. | Each SHOULD slice that has not passed is switched off (BP4). No feature code after this day. |
| Day 8 | Sun Oct 11 | Review findings fixed, high ones before anything else. Calibrated constants set. Soak run 2 on the frozen build. `production` deployed; its pools created; the check of BP10 done; state PS1 to PS7 of `03` 1.1 prepared. Rehearsal 1 (scripted browser). Rehearsal 2 (the owner). The recordings `rehearsal`, `hero-canned` and `swarm` are exported and deployed (SC7). | **M6**: rehearsal 2 completes every beat in order with no use of key `R`; no open high finding. | A beat that failed is replaced by its row of `03` 1.4 and its feature is switched off. If a beat without such a row failed (0, 1, 2, 6, 8, 9, 10), Day 9 morning is the fix and one more rehearsal, and the recording moves to Day 9 afternoon. |
| Day 9 | Mon Oct 12 | Rehearsal 3, then the recording (the owner). The lead watches spend and the stream. After the take the lead exports the session as the recording `hero` and deploys it under BP12 (a). | **M7**: one complete take that follows BS1 to BS6. | Day 10 is the second recording day. Slice 10's remaining work continues beside it; it needs no owner time. |
| Day 10 | Tue Oct 13 | Cuts (waiting only), export, the checks of SC6. Repository made public. Fresh-clone check. Texts final. After the owner's yes, the repos of the two `test` namespaces are deleted; the Worker `premise-test` stays until Oct 22 (SC10). `OWNER_KEY` rotated (BP12, SC10). | **M8**: every row of section 7 except SC12 is done. | The best complete take is used, and `hero` is exported from that take. No re-recording after 12:00 PDT on Day 11. |
| Day 11 | Wed Oct 14 | The owner submits, target 12:00 PDT, deadline 23:59 PDT. The lead runs SC9 before and after. | **M9**: submitted; the confirmation is saved. | Nothing is cut. Nothing is deployed except a fix for a public address that does not answer, verified on `test` first (BP12 (b)). |

Order in which things are dropped, from the top. An item is dropped whole, by its switch in `features` (FJ1). A cut line of the table above says how far down this list it reaches. Within that reach it drops the items that are not yet merged and that need a lane which is behind. An item that already passed its acceptance check, or whose lanes are all on time, stays in the build. So a later item is never dropped while an earlier item that needs the same lane is kept. The one exception to the order is Slice 12, which a plan threshold decides (PT4), not the calendar.

1. STRETCH.
2. Slice 15 adapters (`features.clef` is false: the build runs with the three Clef switches `off`; the eight cases still pass).
3. Slice 14: (3a) part 14b, then (3b) part 14a (`features.green` is `"static"`, then `"none"`).
4. Slice 13 (`features.undo` is false: no Undo button; beat 7 becomes more of beat 6).
5. Slice 12 (`features.race` is false: the crab is one attempt; beat 3 uses the other landing order).
6. Slice 11 (`features.held` is false: the minimal held form of HD1; the main pool is created from `tidepool-auto`).
7. Track 4D (`features.attempt_repos` is false: `note.attempt.repo` is `null`; About says so).
8. Inside MUST, in this order: laptop and narrow layout polish (stage size is kept), the second catch live (it stays in the canned recording), Swarm size (1,024 down to the largest size that passes VE6).

Never dropped: the landing path of Slices 1 to 3, real agents, the Floor's MUST surface, the hero with the plain-merge pool, the Why card with the git drawer, a Swarm run of some size with measured numbers, Replay, the owner key, the spend cap, the kill switch, the README.

What the owner does, and when:

| Date | The owner | About |
| --- | --- | --- |
| Oct 4 | Confirms that the account the spikes ran on is the one to deploy to (Workers Paid, `wrangler login` on the build machine). Names the host and account for a private remote (RR19). Creates one Cloudflare API token that may call Workers AI and nothing else, and puts it, with the account id, into the lead's shell environment, outside the repository and outside chat (BP7). The early model measurement needs it (2.2a, RR22). | 15 minutes |
| Oct 5 | Reads the result of the early model measurement (M1a). Decides RR5's paid option only if the lead asks. | 10 minutes |
| Oct 7 | Reads the M3 result. Decides RR5's paid option only if the lead asks. | 10 minutes |
| Oct 8, Oct 12 | Opens the Cloudflare billing page and tells the lead the total (RR14). | 5 minutes each |
| Oct 11 | Rehearsal 2 on the Floor, in a browser. | 90 minutes |
| Oct 12 | Rehearsal 3 and the recording. | 3 hours |
| Oct 13 | Approves making the repository public and the deletion of the `test` repos (SC10). Reads the three texts. | 30 minutes |
| Oct 14 | Fills in and submits the form. | 30 minutes |

---

## 5. Verification strategy

### 5.1 Summary

| Id | What | When | Pass | Evidence it produces |
| --- | --- | --- | --- | --- |
| VE1 | Unit tests from the cases | Every commit; every integration point | Every required case passes; at the freeze, 58 of 58 or the exceptions are listed in the README | `docs/measurements/cases.md` (one row per case, the commit id) |
| VE2 | Rule coverage | M5 | Every rule id cited by a case or by an acceptance check of section 2 appears in a test title or in a case's `rules`. Every rule that the vectors do not cover has the test named in 5.2. | `docs/measurements/rules.md` (rule id, tests) |
| VE3 | Real git | Every commit | Object ids equal git's; packs pass `git index-pack` and `git fsck --strict`; stock git reads the notes | Test output; the `stock-git` integration report |
| VE4 | Integration on a dedicated Artifacts namespace | Every integration point | The named tests of section 2 pass on `test` | `docs/measurements/integration/ip<N>.md` |
| VE5 | Browser checks of the Floor | Every integration point from IP1 | AC1 to AC30; the rows of `03` section 7; the deployed checks | Playwright report; `docs/reviews/screens/` |
| VE6 | Swarm soak | Day 6, Day 8 | The eleven checks of 5.2 | `docs/measurements/soak/<date>-<build>-d<dial>.json`; `public/replay/swarm.ndjson` |
| VE7 | Security review | Day 7, closed Day 8 | No open high finding; every row of 5.3 has a result | `docs/reviews/security.md` |
| VE8 | Design review | Day 7, closed Day 8 | No open high finding; every row of 5.4 has a result | `docs/reviews/design.md`; `docs/reviews/screens/design/` |
| VE9 | Rehearsal of the beat sheet | Day 8 (two), Day 9 (one) | 5.5 | `docs/measurements/rehearsal/rehearsal-<n>.md`; the session's exported recording |
| VE10 | Hero determinism | Day 5, Day 8 | 20 of 20 | `docs/measurements/rehearsal/hero-20.json` |
| VE11 | Model measurement on the seeded intents | Day 1 and Day 2 (no engine, 2.2a); Day 4 (on the engine, 2.5) | The files exist for every model of the model plan, and the lead has judged them against PT1 to PT4 | `docs/measurements/models/` |

### 5.2 Details

**VE1.** The driver builds an engine over `node:sqlite` from a case's `files`, applies `steps`, and checks `expect` and `final` by the runner rules of Appendix A (rule 11 for race candidates and the owner action `choose`). `at: n` hashes are computed by `src/core/keys` and `src/core/entities`, which the hash cases check on their own. The driver holds no expected value of its own.

**VE2.** The vectors exercise the pure core with real attempts only. `01-core.md` Appendix A lists the rules they do not cover. Each has a test here:

| Rules that the vectors do not cover | Test | Built in |
| --- | --- | --- |
| The `stop` call (TA9, TA9a, T20) | 2.3 item 8; 2.5 item 5 | Slice 2, Slice 4 |
| `resume` (RS1 to RS5, T20r) | 2.3 item 9 (Trunk side); 2.5 item 8 (Agent side) | Slice 2, Slice 4 |
| The revert-limit card (GL6, T19s) | 2.14 item 4 | Slice 13 |
| `changed` in `headsup.resolved` (HU12); metric 14.4 | 2.3 items 2, 5 and 6; 2.9 item 1 | Slice 2, Slice 8 |
| Event sources and delivery (EV2a, EM6) | Track 1E; 2.5 item 9; 2.9 item 4 | Slice 1, Slice 4, Slice 8 |
| Hibernatable sockets (EV7) | Track 1E | Slice 1 |
| `summary_only` (EV6, EM1a, PL1) | Track 1D; 2.2 items 1 and 2; 2.3 item 6 | Slice 1, Slice 2 |
| The minimal held form (HD1) | 2.3 item 7; cases `C34`, `C35` | Slice 2 |
| The Swarm route (SWR1 to SWR4) | Track 1J; 2.3 item 2 (hold and release) | Slice 1, Slice 2 |
| Scripted triage (TR5, TR8, S6a) | 2.3 item 1; 2.9 item 4; 2.16 item 3 | Slice 2, Slice 8, Slice 15 |
| The unlock brake (SE2a) | Track 1D; 5.3 | Slice 1 |
| The check codes (GR8) | 2.15 item 2 | Slice 14 |
| Timers and alarms (AL1 to AL4) | `test/workerd/landing` (2.4 item 1) | Slice 3 |
| Re-index and rebuild (RB1 to RB5) | Unit tests of `src/core/rebuild`; 2.4 item 3 | Slice 3 |
| Push time-out and poison batch (LP5a to LP5c) | 2.4 item 1 (the fault matrix) | Slice 3 |
| Model gate accounting (SE6 to SE8) | Unit tests of `src/core/gate`; 2.5 items 3 to 5 | Slice 4 |
| Sandbox headers (SE13 to SE15) | 2.2 item 5; 5.3 | Slice 1 |
| The green line (GR1 to GR7) | 2.15 | Slice 14 |
| Preview commits (PV1 to PV5) | 2.12 items 1 and 3 | Slice 11 |
| Note shrinking (NT2) | Track 1B | Slice 1 |

**VE4.** Tests create pools `it-<ULID>` in the `test` namespaces and never touch `production`. Names used in section 2: `tracer`, `stock-git`, `collide`, `pushes`, `rebuild`, `deploy-drill`, `real-agent`, `kill`, `cap`, `hero`, `why`, `held`, `race`, `undo`, `green`. What this does not establish: behaviour under an eviction (covered on local workerd, 2.4 item 1), and behaviour of another Cloudflare account.

**VE5.** Three layers. (a) Fixture streams through Replay in Chromium at 1920×1080, 1440×900 and 320 wide, both themes: every acceptance check of `03` Appendix B. (b) The deployed project against `test`: headers, roles, the tracer, the hero. (c) A hostile-input pass: an intent, a statement and a path that contain markup are shown as text (AC8); a creature that names `fetch`, `document` or `eval` is rejected at submit with `banned_global` (CK6).

**VE6.** One Trunk, one pool per dial value, seeded from `tidepool-swarm` and created with `summary_only: true` (PL1). `SwarmConfig`: `seed` 7, `agents` 1,024, `collision_dial` each of 0, 0.1, 0.25, 0.5, 1, `launch_per_second` set so that Trunk stays under its request-rate guidance (start at 50; the value used is recorded).

Two kinds of number come out of a soak run, and they are kept apart (`01-core.md` 14.4, 14.5). `metrics` holds what the reducer computes from the stream, which is what the Swarm view shows: the false-abort rate from `headsup.resolved.changed` (HU12), and the escape rate from green-line reverts. `truth` holds what only the soak script can compute, because the truth lists of `02` 10.3 are in no event: it reads the landed notes and the final tree from Artifacts after the run.

```ts
type SoakResult = {
  v: 2; build: string; recorded_at: string; pool: string; config: SwarmConfig;
  agents: { launched: number; landed: number; stopped: Record<string, number>; in_flight_at_end: number };
  landings: { count: number; commits_on_main: number; notes: number; batches: number; pushes: number; push_retries: number };
  metrics: { landings_per_second: number; time_to_land_ms: { p50: number; p99: number };
             go_around_rate: number; confirm_rate: number;
             false_abort_rate: number | null;        // 14.4: go-arounds resolved with `changed: false`
             escape_rate: number | null;             // 14.5: landings later reverted by the green line; null when `features.green` is "none"
             waiting_behind_max: number; push_backlog_max: number;
             longest_gap_ms: number;                 // the longest time without a landing while a change was `validated`
             tick_cpu_ms: { p50: number; p99: number }; push_ms: { p50: number; p99: number } };
  truth: { repairs: number;                          // `repair` results in the landed notes
           repairs_outside_truth: number;            // of them, on a key that is not in the attempt's truth list (`02` 10.3, TR8)
           false_abort_rate: number | null;          // repairs_outside_truth / repairs
           escapes: number };                        // SW2: landed T-energy files whose number does not fit the scale at head
  stream: { events: number; bytes: number };
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};
```

Checks. These are about correctness. Speed has no pass mark: the numbers are published as measured, each with its dial value.

| Check | Passes when |
| --- | --- |
| `all_ended` | `in_flight_at_end` is 0 after the run plus `ATTEMPT_TIMEOUT_MS`; every stopped attempt has a reason. |
| `one_commit_per_landing` | `commits_on_main` equals `count`; `notes` equals `count`; each note's `seq` is its commit's position. |
| `oracle` | SW2: `truth.escapes` is 0 (`ESCAPE_TARGET`). |
| `no_go_around_at_zero` | At dial 0 the go-around rate is 0 (`02` 10.4). |
| `cosmetic_is_silent` | No `headsup.sent` whose cause is a `cosmetic` landing reaches an attempt of another pattern. |
| `never_paused` | No `pool.paused`. |
| `no_stall` | `metrics.longest_gap_ms` is at most 10,000: at no time did more than 10 s pass without a `landing.accepted` while at least one attempt was in `validated`. A sweep that holds right of way must not stop every creature-adding landing (RW3); the sweep patterns withdraw at their second repair so that it cannot (2.9). |
| `fsck` | `git fsck --strict` passes on a fresh clone. |
| `rebuildable` | After the run, rebuild from Artifacts gives the same `head_seq` and the same head tree id. |
| `false_abort_reported` | `metrics.false_abort_rate` and `truth.false_abort_rate` are both present. A value above `FALSE_ABORT_TARGET` is published as measured and the README says the target was missed. |
| `recording_fits` | The exported stream of the run chosen as the `swarm` recording is at most `REPLAY_MAX_BYTES` (`stream.bytes`). If no run at 1,024 agents fits, the recording is made from a shorter run and its banner shows that run's agent count. |

Real-agent repair latency (14.7) comes from `measure:models`, never from the soak. Fork throughput (14.8) comes from track 4D's `attempt.repo` events, never from landing numbers.

### 5.3 Security review (VE7)

Done by a builder that wrote none of the reviewed code. Each row gets a test name or a probe with its observed result.

| Area | Rules | Probe |
| --- | --- | --- |
| Owner key and session | SE1 to SE4, SE2a | No key configured: 503 on every mutating route. Wrong key: 401. The comparison is one constant-time function with no early return (read of the code). Eleven wrong keys within a minute from one address: the eleventh answers 429, and so does the right key in that minute (SE2a, `UNLOCK_FAILS_PER_MIN`). Cookie request with a foreign `Origin`: refused. Body not JSON: 415. |
| Tokens and text | SE5, SE5a, SE5b, SE5c, S2a, AG7, `01-core.md` RP1 | `npm run check:secrets` on the tree, the history and every recording. No route returns a token except `read-token`, whose token cannot push. No Agent, verifier or app-server code path holds a write token for a pool repository (S2a). Event error fields hold codes only, and `green.verified.checks` holds only the names and codes of GR8. |
| Public surface | 13.2, SE19 to SE22, EV7 | Every public route is GET. No public request reaches Trunk. Rate limits answer 429 past the limit. Attempt repos are served by no route. A ninth socket from one address is refused (`MAX_SOCKETS_PER_ADDR`). |
| Spend and kill | SE6 to SE12 | The checks of 2.5 on `production`. The ledger over-counts on a lost settlement. |
| Sandbox | SE13 to SE18, PV4, PN6, PN7, PN9 | Response headers on every app-server route. The pool document opened directly has an opaque origin. No `unsafe-eval`. The Floor's own policy (SE14a). |
| Verifier | GR6, GR7 | No bindings, no network, the log in no event. |
| Agent input | HE4, `05-agent.md` | Heads-up and pool text is never in the system role. A pool file that says "ignore your instructions" changes no tool permission. The early measurement script never executes model-written code (2.2a). |
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

On `production`, in a browser, no terminal (BS1). Before each run the state PS1 to PS7 of `03` 1.1 is checked on the page.

| Run | Driven by | Pool | Purpose | Its recording (SC7) |
| --- | --- | --- | --- | --- |
| 1 | `test/e2e/lead/rehearsal.spec.ts`, with the canned cast | A second pool that is not summary-only, opened at `/p/<pool>` | Every control of every beat exists and responds. Repeatable after any fix. | `hero-canned` |
| 2 | The owner, with real agents | Its own pool, opened at `/p/<pool>` | Timing, wording, the owner's path through the page. | `rehearsal`, which beat 10 of the take plays |
| 3 | The owner, the morning of the recording | The pool of run 2 (its file was exported on Day 8, so run 3 does not change it) | The same as the take. | none |

A recording is the export of one pool's whole stream (13.6). Runs 2 and 3 therefore use their own pool, so that the file `rehearsal` and the file `hero` are two streams and neither holds the other run. The take runs in the default pool, whose state PS1 to PS7 is prepared before it. Every recorded pool and its two repos are kept (RY10).

The owner types the crab request as `02` 9.3 gives it for P1a, word for word, because the number in it is what makes the hero visible (`02` TP21).

Record for each run: per beat, start and end on the run clock, the window of `03` 1.2, whether the "Proves" column was observed, any deviation. Pass: every beat observed in order; total at most 10:00; no use of key `R`; the Why card of the crab shows its go-around; the Swarm numbers are on screen; Replay plays in a visitor's browser. A run that fails names the beat and the rule that did not hold.

---

## 6. Risk register

"Responsible" is who watches the trigger and makes the switch. Every trigger is a measured fact, not a feeling. Every fallback is behind an interface that already exists, so the switch is one line in `src/worker/adapters/index.ts` or one switch in `features`.

| Id | Risk | Level | Trigger | Fallback | Responsible |
| --- | --- | --- | --- | --- | --- |
| RR1 | S1, push path. The chosen hand-built pack over receive-pack from Trunk is refused, slow or unreliable at the size of a real pool. The platform record saw it accepted in two single requests (X8); its 100-push run used isomorphic-git (X7). | high | By the end of Day 3: the `pushes` test shows a refused pack, or fewer than 300 of 300 batches reach `pushed`, or push p99 above 5 s, or a memory-limit error. | Option B (isomorphic-git for the push only), which the record's X7 ran 100 times with no failure. If B fails the same test: option C, a container, which is not built and was not measured. `docker info` succeeded on the build machine on 2026-10-04 (Docker Desktop, server 29.7.2); that shows a container image can be built there, not that a container deploys on the account. If C is not possible, the lead tells the owner the same day: nothing can land. | lead |
| RR1a | S1, two-ref atomicity. The server applies one ref and not the other. The platform record saw both commands refused together (X8, one sample per order). | low | `retry_notes` or `retry_main` occurs on `test`. | None needed: LP5 decides by ref values either way (S1b). The lead confirms that vectors `C50` and `C51` and the workerd fault matrix pass, and adds a dated record of the behaviour seen. | lead |
| RR1b | Reading an object that no branch reaches. The binding does not resolve `refs/notes/premise` or `refs/previews/*` by name (the platform record, X4; S7b). So `NotesReader` takes the notes commit id from the ref advertisement and reads by object id (S1c), and the app server reads a preview commit by commit id (PV1a). The platform record measured such reads for commits on branches and tags only. The risk is that a read by id fails for an object reachable only from the notes ref or only from `refs/previews/*`. | medium | Notes: the `rebuild` test fails at step 2 of 3.6. Previews: 2.12 item 1 fails to load the "after" frame. | Notes: `NotesReader` fetches the notes with a hand-built upload-pack request (a read token, the pkt-line code of `src/core/git`). Previews: Trunk pushes preview commits to the branch `refs/heads/previews/<submit_id>` of the plain-merge repository, and `PREVIEW_REF_PREFIX` changes with a measurement record (PV1a, BP8). | git lane |
| RR2 | S2, token source. A minted token is refused for git from a Durable Object. The platform record saw minted tokens accepted (X2). | medium | On `test`, a push with a freshly minted token answers 401 or 403 twice in a row (LP5a asks for a fresh token between the two). | Option B. The lead first measures the lifetime of a `create()` token. If it expires before 2026-10-22, the rotation rules of S2 are built and tested on `test` before M6; otherwise rotation is not built and the README states the expiry. Option C only with RR1's container. | lead |
| RR3 | S3, attempt repos. Provisioning by `fork()` is slow or fails under concurrency, or cannot place the fork in the `ATTEMPTS` namespace. The platform record saw 5 of 20 concurrent forks fail (X5). | medium | At four at a time: more than 5% fail after retries, or ready p90 above 10 s. Or the first task of track 4D shows that a fork cannot be placed in the `ATTEMPTS` namespace (SE22 wins). | Option A (`create()` and a push of the checkpoint; X1 saw 1.3 to 2.7 s to ready). If it does not pass either: `features.attempt_repos` is false, `note.attempt.repo` is `null`, About says so. No landing is affected in any case (AG5, S3c). | agent lane |
| RR4 | S4, green-line runtime. The Dynamic Worker isolate cannot load the whole pool, or flakes. The platform record ran shared rules and one creature, not the 21 files and every kind. | medium | In 50 runs on the seed more than one verdict is missing or late (`SELFTEST_TIMEOUT_MS`); or a run with `MAX_KINDS` creature files does not load. | Option D (`static`): `features.green` is `"static"` and the strip says "static checks only" (GR5). No container and no Browser Run is built (S4c). | git lane, pool lane |
| RR5 | S5, model mix. Workers AI models do not land the seeded intents. | high | PT1 or PT2 missed: first in the early measurement on Day 2 (2.2a), then at M3. The early reading can fire this risk two days sooner; M3 decides where the two differ. | In order: (1) the best measured model becomes the workhorse; (2) the live cast is narrowed to the intents of difficulty E that pass; (3) the lead asks the owner about Claude through AI Gateway (a new paid commitment; the owner decides). `max_real_agents` is set from the measurement in every case. | agent lane; the owner for (3) |
| RR6 | S5, the repair. No model turns `30` into `0.3` after the heads-up. | high | PT3 missed: for every model in the early measurement on Day 2 (after a scripted heads-up), or at M3 (through the engine). | The video shows the hero with the canned cast on a second pool, opened at `/p/<pool>`, under the SYNTHETIC banner, and real agents on additive requests in the main pool. That pool is not summary-only, so the canned hero shows its lights, its heads-up diff and its Why card (EV6); its recording is `hero-canned` (SC7). The voiceover and About say so. The catch itself (the heads-up with the diff) is still shown on real agents. Before that, once: the prompt is revised in `05-agent.md` (PR1) and measured again. | lead |
| RR7 | S6, Clef. Accuracy or latency is not good enough, or the service limits differ. The platform record is a smoke test of eight cases by one author. | medium | On the labelled set, with the best thresholds: any case that truly depends gets `holds`; or fewer than half of the independent cases get `holds`; or p95 latency above `CLEF_TIMEOUT_MS`. | First, when only latency fails: `clef-flash` for triage, with its own thresholds (S6). Otherwise option C: the three switches stay `off` and `features.clef` is false. Triage rows answer `confirm` (TR5, `OffTriage`). The script does not mention Clef (`03` 1.4). | agent lane |
| RR8 | S7, pool files. A read lags a push. The platform record saw reads by branch name catch up 109 to 274 ms after a push; reads by commit id were not timed right after a push. | medium | A frame shows an old file after `landing.landed`; or a read of a commit that `landing.landed` named answers not found. | The app server never resolves a branch name: the commit id comes from the event (SE19). A commit that the Floor state names and Artifacts does not return yet is answered 503, never 404 and never cached, and the host's next probe retries. If `readFile` by commit id misbehaves, the fallback of S7: reads by object id (`readCommit`, `readTree`, `readBlob`). | pool lane |
| RR9 | One Trunk does not carry 1,024 scripted agents. | medium | A soak check fails, or the tick's CPU p99 exceeds `TICK_CPU_BUDGET_MS` at every launch rate tried. | Lower `launch_per_second`, then the agent count, to the largest run that passes all eleven checks. The banner and the README state the size that was run. The sharding argument stays an argument. | swarm lane |
| RR10 | The Durable Object's SQLite and `node:sqlite` differ. | low | `test/workerd/cases-smoke.test.ts` fails where the Node run passes. | The engine avoids the construct; the adapter in `test/support` is corrected. Never a test weakened. | engine lane |
| RR11 | The specification files still disagree in a place that the reconciliation of 2026-10-04 did not find (0.1), or a new gap appears (0.2). | medium | A builder finds two rules that cannot both hold. | The builder stops that piece, reports both rule ids; the lead decides by the brief and `01-core.md` and edits the file the same day. | lead |
| RR12 | Two lanes need the same file. | medium | `check:lane` fails at an integration point, or a merge conflict occurs. | The lead moves the logic into a file of one lane and has it registered through that lane's wiring module. If a seam's table type lacks the field, the lead adds it and every lane rebases. | lead |
| RR13 | The schedule slips. | high | A milestone check fails. | The cut line of that day (section 4). | lead |
| RR14 | Spend passes the budget. | medium | `npm run spend` shows more than 80% of an environment's cap; or the owner's billing page shows more than $40 in total. | Measurement runs stop. Rehearsals use the canned cast. The cap itself refuses further calls (SE7). The model calls of the two spike Workers (X9 and the Clef test) were outside both gates; they are part of the billing total the owner reads. The early model measurement is outside both gates too: its own limit is $3, and BP9 takes what it spent off the `test` cap. Artifacts operations are billed from 2026-10-14 (10,000 a month included, then $0.15 per 1,000), so both soak runs and the 300-push test are done before that date. After it, a soak, or the integration tests that verify a fix on `test` (BP12 (b)), need the lead's count of their pushes and creates first. | lead; the owner reads the billing page on Oct 8 and Oct 12 |
| RR15 | Workers AI is slow or limited during the recording. | medium | In rehearsal 3, intent to landed p50 above twice the M3 value. | Record at another hour the same day. The Replay recording stands in for a beat only with the REPLAY banner on screen. | the owner, lead |
| RR16 | The production pool or the address breaks between the recording and Oct 21. | medium | SC9 fails. | BP12 (b): a fix verified on `test`, whose Worker is kept until Oct 22 for this purpose (SC10). Replay recordings are static assets and play with no Durable Object state (RY6). | lead |
| RR17 | A secret reaches the public repository or a recording. | high | `check:secrets` matches. | The secret is rotated at once; the history is rewritten before the repository is made public; the recording is exported again. | lead |
| RR18 | A real model writes the crab without a number in points. | medium | In `measure:models` (first in the early run of Day 2, then at M3), `hero.absolute_number` is below half of `hero.runs` for the chosen model. | Another model for the crab; the seeded wording of `02` TP21 is kept, and the owner types it word for word (5.5). If none: `02` TP20 applies, the page says "no visible difference in this run" on the fact of PM7, and the `hero-canned` recording shows the break. | agent lane |
| RR19 | The build machine is the only copy of the work. | medium | No remote exists (true on Oct 3). | A private remote as soon as the owner names the host and account (section 7, SC1). | the owner |
| RR20 | The platform record misleads. Every experiment ran once, from one location, on small repositories. | medium | A test of this plan on `test` contradicts a row of the record or a choice of 1.7 (`pushes`, `rebuild`, `deploy-drill`, `held`, track 4D, `green`, the soak). | The test's result wins. The lead adds a dated record under `docs/measurements/spikes/`, switches the port to its fallback in `adapters/index.ts` in the same commit, and applies the risk row of that port. | lead |
| RR21 | The owner cannot do a rehearsal or the recording on its planned day. | medium | The owner says so, or no record of rehearsal 2 exists at the end of Day 8. | Rehearsal 2 moves to the morning of Day 9 and the recording to the afternoon; Day 10 is the second recording day. No agent records a voice or stands in for the owner (SC6). If no complete take exists at 12:00 PDT on Day 11, the lead tells the owner at once: the form cannot be sent without a video. | the owner, lead |
| RR22 | The early model measurement cannot run on Day 1 or Day 2: `05-agent.md` or the protocol files it needs are late, or no API token for Workers AI is in the lead's shell environment. | medium | At the end of Day 1 the measurement has not started. | Late files: it starts on Day 2 and is judged at the end of Day 2 or on Day 3 (the cut line of M1a). No token: the measure lane wraps the same loop in a throwaway Worker that calls the `AI` binding, the way the platform record's X9 ran, and the lead deploys it; the output files and the spend limit are the same. In both cases M3 on Day 4 still measures on the engine, so the plan is never later than it was before the reconciliation. | lead; the owner for the token |

---

## 7. Submission checklist

"Who" is one of: **lead**; **owner only** (no agent can or may do it); **owner approves** (the lead prepares and acts after a clear yes).

| Id | Item | Check | Who |
| --- | --- | --- | --- |
| SC1 | The repository is public and holds a `LICENSE` file that names the MIT License. | Opened in a logged-out browser. `git log` on the public copy shows no secret (`check:secrets`). | owner approves; the owner names the host and account |
| SC2 | The README has: what Premise is, the public address with the Replay line, run instructions, the limits list (with the limits of HC3 and RB0), whether the deployment uses a separate app host (SE14b), measured numbers with their files, and related work that names STORM, CoAgent and the entry "dibs", with no priority claim and without the words "first" or "no one else". | Slice 10 acceptance (2.11 item 4). The citations were opened and recorded at IP0 (2.1 item 11); the lead opens them once more on Day 10. | lead |
| SC3 | "Instructions to run your project": `docs/submission/run.txt`, at most 4,000 characters. It holds, in this order: the Replay line of `03` RY24; prerequisites (Node 22, git, a Cloudflare account on Workers Paid with Artifacts); `npm ci`; `npm run dev:floor` for an offline Replay; `npx wrangler login`; `npm run deploy`; `npx wrangler secret put OWNER_KEY`; `npm run pool:create`; unlocking the Floor; `npm run check`. | `npm run check:submission`, which also checks that the README's section "Run it" is the same text. A builder follows it from a fresh clone (2.11). | lead |
| SC4 | "Project vision": `docs/submission/vision.txt`, at most 2,000 characters. It answers "What did you rethink, and why does it matter?": the thesis sentence; what a change replaces (branch, pull request and merge-queue entry; BP11 (c) allows these words in this text); the two catches; what one record serves; the limits. | `check:submission`; BP11. | lead writes; owner approves |
| SC5 | "How you used Cloudflare": `docs/submission/cloudflare.txt`, at most 2,000 characters. It lists only what is in the frozen build: the Worker, the four Durable Objects, Artifacts (pool repo with `main`, `green` and `refs/notes/premise`, plain-merge repo, attempt repos, every write a push with compare-and-swap), Workflows, Workers AI, static assets, the Cache API, the Dynamic Worker isolate of the green line only if `features.green` is `"full"`, and Clef only if `features.clef` is true. Browser Run and containers are not named: they are not in the build. | `check:submission`; compared with `features`. | lead writes; owner approves |
| SC6 | The video: MP4 (H.264 video, AAC audio), 1920×1080, 5:00 to 10:00 (target 7:30), under 2 GiB. It follows BS1 to BS6: one session on the deployed system, in a browser, no terminal; cuts remove waiting only; the run clock is in every shot. | `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of json <file>`: duration between 300 and 600, size below 2147483648. One full viewing by the lead against the beat sheet. The video holds no music, picture or text from a third party (terms, section 4). | **owner only**: driving the session and recording the voice. lead: state PS1 to PS7, the cuts, the export. |
| SC7 | Four recordings are exported, checked and committed under `public/replay/` (`03` 8.2). `rehearsal`: the real-agent run of rehearsal 2 on Day 8. It is the default recording before and during the take (RY26), so it is what beat 10 plays, and the voiceover says that a run like this one is recorded. `hero`: the take's own session, exported after the take and deployed under BP12 (a); from then on it is the default recording (RY26). `hero-canned` (`synthetic: true`): the conductor's run on a second pool that is not summary-only; RR6 and RR18 use it. `swarm` (`synthetic: true`): the Swarm run chosen by VE6. | 2.10 items 1 and 5 for each file; all four play at the public address; `replay/index.json` names the default. | lead |
| SC8 | Every calibrated constant has its measurement (BP8). Every number spoken in the video is on screen in the take (BS4). | The BP8 test; the lead's viewing. | lead |
| SC9 | The public demo address answers and plays Replay with no credentials. | In a browser with no cookies: `<address>/replay/hero` plays to the end (before the take's export exists: `<address>/replay/rehearsal`); `<address>/` shows no owner control; `curl -X POST <address>/api/kill` answers 401. Run before the submission, after it, daily until Oct 21, and after every change that BP12 allows. | lead |
| SC10 | Test resources are cleaned, in two steps. On Day 10: every repo in the two `test` namespaces is deleted; the Worker `premise-test` is kept, because BP12 (b) needs it to verify a fix. After 2026-10-22: the Worker `premise-test` is deleted. The platform record says that all spike repositories and both spike Workers were deleted after the runs; the lead confirms that none is left. Kept: `production`, its pool repos, its plain-merge repos, the recorded pools, the attempt repos named in notes. Read tokens are revoked, and so is the API token of the early model measurement. `OWNER_KEY` is rotated after the recording (BP12); the new key goes to the owner outside the repository and outside chat. | `wrangler artifacts repos list` for each namespace; the evidence under `docs/measurements/` was committed before the deletion. | owner approves each step (deletion cannot be undone); lead executes |
| SC11 | The terms hold: original work; licences (BP5); no third-party material without permission; no product is attacked and no GitHub branding appears (BP11); the two confirmations on the form are true. The entrant meets the eligibility rules of the terms (section 3: residence and age). | `check:licenses`, `check:submission`, one read of the README and the texts. The owner reads section 3 of the terms. | lead prepares; **owner only** confirms eligibility and ticks the form |
| SC12 | The form is submitted: team name, primary contact name and e-mail, team location, attendee names and e-mails, project name "Premise", the two texts, the video upload, the repository URL, the run instructions, the two confirmations. | The confirmation page or e-mail is saved by the owner. The terms void an entry made by automated means, so no agent fills in or sends the form. | **owner only** |

---

## Appendix A. Must-fix items about schedule, scope and measurement

`01-core.md` Appendix B maps the rule and protocol items. These are the ones it marks as outside that file.

| Judge | Must-fix item (short) | Where in this file |
| --- | --- | --- |
| Infrastructure | Day-1 push spike; recovery between accepted and on `main`; stock git reads the notes | The platform record (X2, X3, X7, X8); 1.7 (S1, S2); RR1, RR1a, RR1b, RR2; 2.4; 2.2 item 3 |
| Infrastructure | Measure one Trunk with 1,000 or more scripted agents against the collision dial; report real-model repair latency separately | 2.9, VE6; `ModelMeasurement.hero.repair_ms` (2.5) |
| Infrastructure | Gate real-agent reliability by day 4, including the `30` to `0.3` adaptation; a reopened attempt uses its authoring model or the screen says otherwise | A first reading on Day 2 (2.2a, M1a), then M3; PT1 to PT3, RR5, RR6; 2.5 item 8 and 2.14 item 2 (RS3) |
| Infrastructure | Decide the verification runtime early; protect the public address; Replay built early | 1.7 (S4, decided on 2026-10-04), RR4; BP10, 2.2 item 6, 2.5 items 2 and 3; track 1F plays fixtures on Day 2 |
| Originality | Rehearse 20 runs and publish the false-abort and escape rates | VE10; VE6 (`SoakResult.metrics` and `SoakResult.truth`); 2.11 item 3 |
| Originality | Four spikes before other work | The platform record (push and notes: X4, X8; token: X2; fork: X5; tool loop: X9); 1.7; RR1 to RR5. The success rate on the seeded intents is measured on Day 1 and Day 2 (2.2a) and confirmed at M3. |
| Originality | One primitive; fixed build order; crowd input, the many-pool wall, MCP, merge and bisect out | Section 2 order; 2.17; the drop order in section 4 |
| Feasibility | Landing spike with pass or fail; container fallback decided the same day | The platform record (X7, X8: pass; no container); 1.7 (S1); RR1, with the result of `docker info` on 2026-10-04 |
| Feasibility | Model spike on the real codebase on day 1 or 2; live agent count from measurement; an evicted agent ends in a recorded state | 2.2a (Day 1 and Day 2, no engine), 2.5 (`measure:models` on the engine); RR5, RR22; 2.5 items 5 and 8 |
| Feasibility | Freeze one engine; confirm by day 2 whether a container deploys; else the green line is static and says so | BP4; 1.7 (S4: a Dynamic Worker isolate, no container, fallback `static`); RR4 |
| Feasibility | Forks off the hot path; never per scripted agent; fork throughput reported separately | 1.7 (S3); track 4D, 2.5 item 7; SW3; VE6 last paragraph |
| Feasibility | Measure the false-abort rate before recording; check that the cited papers exist; watch memory against 128 MB over several hundred pushes | VE6 on Day 6 and Day 8; 2.1 item 11 (the citations, at IP0) and SC2; 2.4 item 2 |
| Feasibility | Build the Floor from day 2 against a scripted stream, Replay first; video and stage are separate deliverables; owner key and spend cap before the address is shared | Tracks 1E and 1F, Slice 5; 2.17 and BP12; BP10 |

## Appendix B. Plan thresholds and where they are used

| Id | Value | Used by |
| --- | --- | --- |
| PT1 | 8 of 12 additive intents land with the workhorse model | M1a (first reading), M3, RR5 |
| PT2 | Intent to landed p50 at most 120 s, p90 at most 300 s | M3, RR5, RR15 |
| PT3 | 4 of 5 correct repairs of P1a and of P1b for at least one model | M1a (first reading, scripted heads-up), M3, RR6 |
| PT4 | `RACE_SIZE` models land at least 6 of 12 | M1a (first reading), M3, Slice 12 |
| Early measurement | 22 runs per model (`05-agent.md` 6.2); at most $3 outside the gate | 2.2a, BP9, RR14 |
| Push | 300 of 300 batches `pushed`, p99 at most 5 s, no memory-limit error | RR1, 2.4 |
| Attempt repos | At most 5% failures after retries, ready p90 at most 10 s, at four at a time | RR3 |
| Verifier | At most one missing or late verdict in 50 runs | RR4 |
| Clef | No truly dependent case gets `holds`; at least half of the independent cases get `holds`; p95 latency within `CLEF_TIMEOUT_MS` | RR7 |
| Hero | 20 of 20 conductor runs | M4, VE10 |
| Swarm stall | No more than 10 s without a landing while a change is `validated` | VE6 (`no_stall`) |
| Spend | 80% of an environment's cap; $40 in total | RR14 |

---

## Changes in reconciliation (2026-10-04)

Inputs: the lead's decisions, the cross-document critic's findings F01 to F43, the architect's corrections and notes for the lead, the planner's open items, the notes of the `01-core.md` reconciliation, and the platform record. No id of this file (`BP`, `IP`, `M`, `PT`, `VE`, `RR`, `SC`, `GP`, slice and track numbers) was renumbered. New ids: section 2.2a, milestone M1a, check VE11, risk RR22, the lane `measure`. Days are written Day 1 to Day 11 (they were `D1` to `D11`).

### Lead decisions

| Decision | What changed in this file | Section |
| --- | --- | --- |
| Precedence | The record of 0.1 states it; a later disagreement follows RR11 | 0.1, 6 |
| Platform: push path, landing atomicity, tokens, attempt repositories, reading pool files, green-line runtime, models, Clef | 1.7 states the chosen adapter of every port, its fallback and the measured trigger, and lists what is still to measure with the step that measures it. `PS` is now S7. No Browser Run binding; isomorphic-git, a container and Browser Run are under "not used". The risk rows follow. | 1.2, 1.6, 1.7, 2.2 (tracks 1B, 1G), 2.4, 2.5, 2.15, 2.16, 6 (RR1 to RR8, RR20), SC5 |
| 1. Live pool frame | The tracer, Compare view and Replay checks name the mechanism: `probe` for live frames, `advance` for commit frames. Track 1G builds the host's `advance` and `highlight`. | 2.2, 2.7, 2.8, 2.10 |
| 2. Card options | The option ids of CD4 in every card check; `invalid_args` for an id the card does not offer; GL6 in Slice 13 | 2.3, 2.6, 2.12, 2.13, 2.14 |
| 3. Hero walk-through | Slice 6 reads rows A9 to A11 of `02` as rewritten; the heads-up of order 1 is rule `E2` | 0.1, 2.7 |
| 4. Stopping from the Agent side | The `stop` call in `tools.ts`, in track 1H, in Slice 2 (`withdrawn`) and in Slice 4; 17 stop reasons | 2.1, 2.2, 2.3, 2.5 |
| GP1 to GP5, and the held tier in every build | 0.2 is a record of the decisions. The plan uses `p-<40 hex>`, `SwarmRequest`, the seeded requests of GP3, `tidepool-auto` and `summary_only`. | 0.2, 2.2, 2.3, 2.7, 2.12, 5.2, 5.5 |
| Agent prompt and tools (`05-agent.md`) | The header and 1.1 point to the file. `src/protocol/agent-prompt.ts` holds its five blocks, with a test that compares them (Slice 0b). The model side of the Agent is the pure code of `src/core/agent/loop/`, which the early measurement and Slice 4 share (ME1). `ModelMeasurement` here is the part of the type of `05-agent.md` 6.8 that this plan reads. | header, 1.1, 2.1, 2.2a, 2.5, 3.1 |
| Waking or restarting an Agent | The Trunk side of `resume` is in Slice 2, the Agent side with AG6 and AG8 in Slice 4, the causes `undo` and `revert` in Slice 13 | 2.3, 2.5, 2.14, 3.3 |
| Early model measurement | New section 2.2a: a Node script with no engine, its lane, its files, its output under `docs/measurements/models/`, its spend limit, and the decisions taken from it on Day 2. Milestone M1a, check VE11, risk RR22, the owner's token, BP9. | 2.2a, 0 (BP9), 2.5, 3.1, 3.3, 3.4, 4, 5.1, 6, Appendix A, Appendix B |
| Words banned by BP11 | BP11 is rewritten in three parts; `check:submission` allows the three words in `vision.txt` and in the README's thesis section | 0, 2.11, SC4 |
| Fonts | The system font stack stays; no font file | 1.2 |
| Related work wording | Never "first" or "no one else"; STORM, CoAgent and "dibs" are named | Conventions, 2.11, SC2 |
| Slice 0 in two parts (the lead's task for this file) | 0a is the toolchain scaffold, 0b the protocol module and the stubs; the acceptance items name their part | 2, 2.1, 3.3, 3.4, 4 |

### Critic findings

| Finding | What changed in this file | Section |
| --- | --- | --- |
| F01 | As decision 1 | 2.2 item 4, 2.7 item 3, 2.10 item 3 |
| F02 | As decision 2 | 2.3 item 7, 2.6 item 5, 2.12 item 2, 2.13 item 3, 2.14 item 4 |
| F03 | As decision 3 | 0.1, 2.7 items 1 and 5 |
| F04 | As decision 4 | 2.1, 2.3 item 8 |
| F05 | The prompt and the tool definitions come from `05-agent.md`; the measurement files record their hashes (PR1) | 2.1 item 9, 2.2a, 2.5 |
| F06 | The Agent side of `resume` and AG6 moved from Slice 13 to Slice 4; the Trunk side and T20r are in Slice 2 | 2.3 item 9, 2.5 item 8, 2.14 |
| F07 | Slice 12 builds RC1 to RC7 and requires the new vector `C58` | 2, 2.13 |
| F08 | Slice 6 checks the self-test badges, "approximated", `interrupted` and the tree equality of PM7 | 2.7 |
| F09 | Browser checks on a named pool use `/p/<pool>` | 1.6, 2.1, 2.2 item 4, 2.6 item 6, 5.5, RR6 |
| F10 | Four recordings: `hero` (the take, exported after it), `rehearsal`, `hero-canned`, `swarm` | 2.10, 4 (Day 8, Day 9), 5.5, SC7, SC9 |
| F11 | BP12 names the two reasons for a production change after the take and the key rotation; the Worker `premise-test` is kept until 2026-10-22 and only its repos are deleted on Day 10 | 0 (BP12), 1.5, 4 (Day 10, Day 11), RR14, RR16, SC10 |
| F12 | The owner types the P1a text word for word | 5.5, RR18 |
| F13 | GP3 is closed by seeded requests; Slice 6 checks the second catch as a QT1 case; `prewritten.ts` is compared with `02` section 9 | 0.2, 1.1, 2.7 item 7 |
| F14 | `SoakResult` separates `metrics` (from the stream, HU12) from `truth` (truth-label rate and SW2 escapes, computed by the soak script) | 2.3 item 5, 2.9, 5.2 (VE6) |
| F15 | Registration at pool creation (track 1D); `limits` from the gate (Slice 4) and `swarm.state` from the launcher (Slice 8) reach every registered pool | 2.2, 2.5 item 9, 2.9 item 4 |
| F16 | `SyncTriage` and `Triage`; `ScriptedTriage` moved from Slice 8 to Slice 2; `OffTriage` | 1.3, 1.7, 2.3, 2.9 |
| F17 | The allow list: `src/core` may import `src/copy`; `src/host` may import `src/protocol/constants.ts`; `ids.ts` takes `H` as an argument | 1.3, 2.1 |
| F18 | No `PoolSource` reads Trunk; the app server resolves `main` from the Floor's state from track 1E and 1G on | 1.7, 2.2, 2.8 |
| F19 | Slice 14 builds GR8 and checks that `checks` holds only its names and codes | 2.1, 2.15, 5.3 |
| F20 | Slice 14 expects `confirmed: false`, then `confirmed: true`, then the revert | 2.15 item 2 |
| F21 | `features` is the type `Features` of FJ1 in BP4, the drop order and IP6; `feature_off` probes | 0 (BP4), 2.1, 2.13, 2.14, 3.4, 4 |
| F22 | Slice 13 item 1 is reworded: a reader is under `kept_readers`, an unrelated creature in no list | 2.14 |
| F23 | As the lead's decision on the early model measurement | 2.2a |
| F24 | As the lead's decision on BP11 | 0 (BP11) |
| F25 | The sweep patterns withdraw at their second repair; new soak check `no_stall` (eleven checks) | 2.9, 5.2 (VE6), RR9, Appendix B |
| F26 | Slice 5 builds the rows FR28 and FR30 and the `push_rejected` banner of FR11; Slice 13 the `plan_changed` state (FR31) | 2.6, 2.14 |
| F27 | "Quiet" is replaced by `summary_only` everywhere | Conventions, 0.2, 2.2, 2.3, 2.8, 2.9, 5.2, 5.5 |
| F28 | Track 1E tests EV7 | 2.2, 5.2 (VE2), 5.3 |
| F29 | Recorded in 0.1; Slice 5 lists the new acceptance checks of `03` | 0.1, 2.6 |
| F30 | X1 to X9 for the record's experiments; Day 1 to Day 11; the renamed ids of `03` (`RY`, `FR`, `PS`) are cited in their new form | Conventions and every section |
| F31 | Recorded in 0.1; the seed's policy file follows in track 1G | 0.1, 2.2 |
| F32 | `ModelMeasurement.hero.repair_ms` is p50 and p90, as 14.7 now is | 2.5 |
| F33 | The `pushes` report holds the largest pack and the SQLite size and fails on a memory-limit error; the citations are checked in Slice 0b; `docker info` was run on 2026-10-04 and its result is in RR1 | 2.1 item 11, 2.4 item 2, RR1, Appendix A |
| F34 | Every cut line follows the drop order; Slice 12 is decided by PT4 only | 4 |
| F38 | Recorded in 0.1; Slice 6 counts pair P5 as a text conflict | 0.1, 2.7 item 4 |
| F39 | The host takes `DEFAULT_GLOBALS` from `protocol/constants.ts` | 1.3, 2.2 (track 1G) |
| F40 | RR1b covers preview commits, with the trigger and the fallback of PV1a | 2.12 item 1, RR1b |
| F41 | (a) The record's date is stated as a UTC date, with the commit time as evidence, and SC10 quotes the record without a date. (b) Derived premises: Slice 1 for D1 and D2. (c) The pool lane owns `src/worker/adapters/verifier/harness/**`. | Conventions, SC10; 2; 3.1, 2.15 |
| F42 | The unlock brake is tested in track 1D and probed in the security review | 2.2, 5.3 |
| F35, F36, F37, F43 | No change of their own in this file. Slice 10 and SC2 take over the limits of HC3 and RB0 that F37 and F43 put into the limits list. | 2.11, SC2 |

### Architect's corrections and the notes of the core reconciliation

| Item | What changed in this file | Section |
| --- | --- | --- |
| The README must list the limits of HC3 and say whether a separate app host is used (SE14b) | Slice 10 item 4, SC2 | 2.11, 7 |
| S5 must report the share that references `ENERGY_MAX` and the cost of an E2m confirm | `ModelMeasurement.energy` and `e2m_confirm` | 2.5 |
| S6 must measure questions per request, the truncation point and QR4 cases | `calibrate:clef` | 2.16 item 2 |
| S2 must measure the lifetime of a `create()` token and what a fork copies | Listed in 1.7 as measured only if RR2's trigger fires | 1.7 |
| Rules that the vectors do not cover | A table names the test of each | 5.2 (VE2) |
| `C58` and 58 cases | Counts in 1.5, 2, 2.1, VE1; `C58` belongs to Slice 12 | 1.5, 2, 2.1, 2.13, 5.1 |
| HD1 and the tier re-check of the tick (9.4 step 3c) | Built in Slice 2 in the minimal form; `C34` and `C35` moved from Slice 11 to Slice 2 (36 cases; 44 required at IP2) | 2, 2.3, 2.12, 3.4 |
| S3: whether `fork()` can place a fork in the attempt namespace | The first task of track 4D; SE22 wins | 1.7, 2.5 item 7, RR3 |
| The frozen reference simulator does not run `C58` | BP6 says so | 0 (BP6) |
| The `03-floor.md` reconciliation added the acceptance checks AC21 to AC30 and the failure rows FR28 to FR32 | Each is assigned to the slice that builds it; VE5 covers AC1 to AC30 | 2.6, 2.7, 2.10, 2.12, 2.13, 2.14, 2.15, 5.1 |

### Decisions this file took, for the lead to confirm

Each follows from a rule above but was not decided by name. Each is one edit to reverse.

1. `C34` and `C35` are required by Slice 2, not Slice 11 (HD1).
2. The early model measurement has its own lane `measure`, which also builds `src/core/agent/loop/**`, and a spend limit of $3 that BP9 takes off the `test` cap.
3. The model-facing texts live in `src/protocol/agent-prompt.ts` (lead), not in the agent lane.
4. Rehearsals 2 and 3 run in their own pool, so that `rehearsal` and `hero` are separate streams (5.5).
5. The rotation of `OWNER_KEY` is named in BP12 as a change of `production` after the take.
6. `ScriptedTriage` is built in Slice 2, not Slice 8, so that a synthetic attempt is never answered by `OffTriage` (S6a).
7. A cut line drops, in the drop order, only items that need a lane which is behind (section 4).
8. At M3 the workhorse runs all four measurement sets; each other race model runs `additive` and `hero` only, after a `test` deploy that names it as workhorse (`05-agent.md` ME7, O9).
