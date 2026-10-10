# Six extensions before the deadline: the rules every builder session follows

Written by the lead on 2026-10-09. The owner decided to build six features that the build plan had
switched off or left out: the green line, Clef, attempt repositories, text merge, outside agents over
MCP and audience input. Each is built by its own Claude session from its own file in this folder.
Read this file first, then your feature file.

## Who does what

- **The owner** starts your session, reads your reports and tells the lead when you are ready.
- **The lead** is a Claude session on the owner's Mac, working in `~/Documents/gitpro`. Only the lead
  merges into `main`, deploys, holds Cloudflare access and runs live checks on the `test` deployment.
- **You** build one feature on one branch, verify it locally, and hand it back.

## Workspace

```bash
git clone https://github.com/zaeem-rafiq/premise.git ~/Documents/premise-<feature>
cd ~/Documents/premise-<feature>
git checkout -b feat/<feature>
npm ci
npm run check
```

Never work in `~/Documents/gitpro`: that folder belongs to the lead's session. Use the port your
feature file gives for every browser test (`PREMISE_E2E_PORT=<port> npm run test:e2e`). Record the
baseline of `npm run check`, `npm run test:workerd`, `npm run test:cases`,
`npx vitest run --project integration` and `npm run test:e2e` before you change anything.

## The rules

`AGENTS.md` applies, with these changes for your task only:

1. You may edit every path your feature file names, across lanes, the lead's paths included.
2. You may push your branch `feat/<feature>` to `origin`, and you should push after each milestone as
   a backup. Never push `main`, never force-push, never merge into `main`.
3. Never deploy, never run `npm run dev`, `npm run deploy:test` or `npm run deploy`, never log in to
   Cloudflare, and never ask for the owner key. Whatever needs the live service, you build so that it
   runs offline against fakes, and you give the lead the exact command to run it live.
4. No new dependency unless your feature file names it. If you think one is needed, propose it in your
   report with its licence and size instead of adding it.
5. The specification in `docs/spec/` is binding. Where your feature is not specified, write the
   specification text first, in the place your feature file names, commit it, then build to it. Mark
   such text as "added 2026-10-10 by the owner's decision to build the extensions".
6. Expected values in tests come from the specification, from real git or from the languages and
   protocols themselves, never from your code's output (BP1). Never weaken, skip or delete a check.
   Do not edit `docs/spec/premise-cases.json`; all 58 case vectors stay green.

## The switch

Every feature is behind a switch in `src/config/features.ts` whose default is **off**. With the switch
off, every existing test passes unchanged, and the Worker and the page behave exactly as before. With it
on, your acceptance tests pass. The lead turns a switch on only after a live check on `test`.

Three features need a new switch (`text_merge`, `mcp`, `audience`, each a boolean). Add it to the type
`Features` in `src/protocol/floor-json.ts`, to `src/config/features.ts` (false), and to the list of
FJ1 in `docs/spec/01-core.md`, which says no other document may add one; this file is the lead's
amendment that allows it.

## Files other sessions edit too

`src/config/features.ts`, `src/protocol/floor-json.ts`, `docs/spec/01-core.md` (FJ1),
`src/protocol/events.ts`, `src/copy/strings.ts`, `src/config/limits.ts`, `docs/spec/03-floor.md`
5.12 and the About boxes, and `README.md` (its Limits list must equal `limitsList(FEATURES)`; run
`npm run check:submission`). Keep your edits there small and in their own lines. When your switch is
on, your feature's "not built" or "switched off" wording must leave the limits list, and any new blind
spot your feature has must join it.
The limits line "Not built: text merge, outside agents over MCP, audience input" is shared by three
features: after `git merge origin/main`, if no other session has already made it depend on the switches,
make it so (each name listed only while its switch is off).

## Time

The owner moved the freeze for these six features to **Sunday Oct 11, 12:00 CDT (10:00 PDT)**. Hand
back as soon as a shippable stage passes; do not wait for the cutoff. At the cutoff, push what passes,
write the report, and stop. A feature that is not merged by then is not in the submitted build, and
nothing ships half-working (BP4).

## Handing back

1. `git fetch origin && git merge origin/main`, resolve conflicts, and run every suite again:
   `npm run check`, `npm run test:workerd`, `npm run test:cases`, `CASES=required npm run test:cases`,
   `npx vitest run --project integration`, `npm run test:e2e`, `npm run check:submission` and
   `node scripts/ops/rules-coverage.ts` (every new rule id appears in a test title).
2. Write `docs/measurements/integration/2026-10-11-<feature>.md`: what you built; each acceptance item
   with its test names and results; the live checks the lead must run, with exact commands and what
   they cost; every choice you made where the specification was silent; what is not done.
3. Commit (`<type>: <description>`), push the branch, and tell the owner exactly:
   "Ready for the lead: feat/<feature>", followed by a plain-English summary.

If several sessions run on one Mac, tests run slower and timing tests can flake. Rerun a failing timing
test once before you investigate, and report any flake.
