# Extension: a real three-way text merge in the plain-merge pool (`feat/text-merge`)

Status: stage 1 (the only stage) is built and passes offline with the switch off and on. Nothing is
deployed. The switch `features.text_merge` is **off** in `src/config/features.ts`; the lead turns it on
after the live check below.

## What was built

- **Specification first** (commit `a8d2cda`). `docs/spec/01-core.md` 11.7 gains **PM3a**: with
  `features.text_merge` on, each `change` landing merges into the plain-merge pool path by path, the way
  `git merge-file` merges three versions (fork point, base and theirs, ours, whole-file rules, the line
  rule, the landing, PM5, and git as the oracle). PM3 now says it holds while the switch is off. 5.1's
  "there is no text merge anywhere" gains the exception. FJ1 gains `text_merge`. `docs/spec/03-floor.md`
  gains the copy rows `plain.conflicts.merged` and `plain.conflicts.merged.tip`, CO25 item 4 picks them
  while the switch is on, and AC24 says so. In the limits list (5.12), line 5 has a second form for the
  switch on, and "text merge" left line 9 ("Not built") for line 15 ("Switched off in this build"), the
  way outside agents over MCP did on `main`: the feature is built and switched off.
- **`src/core/plain/merge3.ts`** (pure, synchronous, no dependency): `splitLines`, `diffLines` (Myers'
  linear-space shortest edit script, written from the 1986 paper; lines that the other side never holds are
  marked changed before the search; runs of changes slide down unless an earlier place lines them up with
  a change on the other side), `mergeLines` (PM3a's region rule) and `mergeFile` (the whole-file rules).
  No code was taken from Git (BP6: Git's xdiff is LGPL).
- **`src/core/plain/plain.ts`**: `replayPlainMerge(seed, landings, { textMerge: { history } })` merges
  each change by PM3a; without the option it is PM3, unchanged. A conflict records `conflict: { path, kind }`
  (`lines`, `add_add`, `modify_delete` or `no_base`). PM5's revert replays a later merged change by
  merging its recorded base and theirs into the restored content.
- **`src/core/trunk/plain.ts`**: an `ops_first` landing carries its attempt's `opened_seq` as the fork
  point; with `pool.featuresTextMerge` on, the replay reads the pool's history, built forward from the seed
  once per build (each landed blob read once). A build over 150 landings took 11 ms with the switch on and
  11 ms off (scratch benchmark, `Trunk` on Node's SQLite).
- **The switch**: `Features.text_merge` (`src/protocol/floor-json.ts`, `FEATURE_KEYS`),
  `FEATURES.text_merge = false`, `FEATURE_OFF_NAMES.text_merge`, `PoolOptions.features.text_merge` and
  `Pool.featuresTextMerge`
  (`src/core/trunk/registry.ts`, `sets.ts`). The Worker already passes `FEATURES` to the engine
  (`trunk-do.ts`), so no Worker file changed.
- **The page**: Compare view (`compare.tsx`) shows `plain.conflicts.merged` and its tooltip while the
  switch is on, `plain.conflicts` "(approximated)" while it is off. `limitsList` drops "approximated" from
  line 5 and "text merge" from line 9 while the switch is on.

## The check before building

No case vector encodes PM3's approximation: `docs/spec/premise-cases.json` names no `PM` rule, no
`plain.updated` and no `ops_first` (`grep -c` gives 0). The scenario rows that name PM3 are P4, P5
(`02-tidepool.md` 9.3, 9.4 and Appendix C item 14) and 7.8's zero count for the hero. All three hold
under PM3a too: P4 changes one line on both sides, P5 adds one path with two contents (add/add), and the
hero's four changes touch four different files. So nothing is valid only while the switch is off.

## Acceptance

| Item                                                                                                                                                                                                                                                                                  | Tests                                                                                                                                                                                                                                         | Result |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Line diff and three-way merge, hand-worked from git's documented behaviour, each also checked with `git merge-file`: clean merges, overlapping edits, adjacent edits, two insertions at one place, deletes, a whole-file rewrite, CRLF, no newline at the end, add/add, modify/delete | `src/core/plain/merge3.test.ts`, 21 named cases                                                                                                                                                                                               | pass   |
| 300 generated three-version cases over the tide pool's source lines give `git merge-file`'s result, conflicts included                                                                                                                                                                | `PM3a: 300 generated three-version cases give git's result, conflicts included`                                                                                                                                                               | pass   |
| P4 is still a conflict                                                                                                                                                                                                                                                                | `PM3a: pair P4 is still a text conflict: both sides change the DAY_TICKS line`                                                                                                                                                                | pass   |
| P5 gives git's tree                                                                                                                                                                                                                                                                   | `PM3a: pair P5 is still a text conflict: both sides add creatures/crab.js with different contents` (git merge-file reports the conflict; the tree equals `git write-tree` of the first crab's files)                                          | pass   |
| Hero order 1 gives git's tree                                                                                                                                                                                                                                                         | `PM3a: hero landing order 1 gives the tree git merge-file gives for the same three versions` (replay level) and `PM3a: hero order 1 through the engine: no text conflict, 7.8's tree, the same tree as PM3` (the canned cast through `Trunk`) | pass   |
| `plain.updated` counts exactly the true conflicts                                                                                                                                                                                                                                     | `PM3: with the switch off the second landing's first write is a text conflict` and `PM3a: with the switch on it merges, and the tree is git merge-file's` (`src/core/trunk/plain.test.ts`, two attempts through the engine)                   | pass   |
| Fork point, no base, revert                                                                                                                                                                                                                                                           | `PM3a: the fork point is the first version from opened_seq on where the operations apply`, `... (no_base)`, `PM3a with PM5: undoing the first of two merged changes keeps the second, merged again`                                           | pass   |
| The page drops "approximated" only while on                                                                                                                                                                                                                                           | `src/floor/components/compare/compare.render.test.ts` (both values); `src/config/floor-json.test.ts` GR5 (limits list against the spec, both forms)                                                                                           | pass   |

## Suites

RESULTS_PLACEHOLDER

## How close the merge is to Git

PM3a states its own line rule, and `git merge-file` is the oracle. Where a file has one shortest edit
script up to sliding, the two agree. Where it has several, Git chooses among them by its own heuristics,
which were not copied, so the two can group lines differently. Measured with `git merge-file` on generated
cases (the script is the committed generated test, scaled up in a scratch run):

- Source-code lines (the tide pool's and the plain-merge module's own lines, 20 to 60 lines per file,
  one to four edits per side): FUZZ_CODE_PLACEHOLDER
- An adversarial set of tiny files over a five-line alphabet, where nearly every diff is ambiguous:
  FUZZ_TINY_PLACEHOLDER

Practical effect: in an ambiguous case the right pool may show a conflict where git would have merged, or
the reverse. The count shown under Compare view can then differ from git's by one change.

## Choices where the specification was silent

1. **The three versions.** Base is the pool's own `main` (not the plain-merge pool) at the first seq from
   the attempt's `opened_seq` where the change's operations apply; theirs is those operations replayed on
   it. Plain git would fork from the plain-merge pool, but the agent's operations were written against
   `main`, so the real pool gives the change as the agent made it. Landed operations fork at `seq − 1`.
2. **A revision after an undo** keeps the attempt's first `opened_seq` (the engine stores no other); the
   "first seq where the operations apply" rule moves the fork forward to where they do.
3. **PM5 under PM3a** merges a later change's recorded base and theirs into the reverted content, instead
   of replaying its operations, because a merged change's operations need not apply to the plain pool.
4. **Conflicts never write markers.** A conflicting change is skipped whole, as under PM3.
5. **The tooltip text** `plain.conflicts.merged.tip` is new copy (two sentences of at most 25 words, CP2).
6. **Files outside the brief's path list** that the switch needed: `src/core/trunk/plain.ts` (the brief's
   `plain-apply.*` does not exist; this is the file that builds the plain commit), `registry.ts` and
   `sets.ts` (the pool flag), `src/floor/components/compare/compare.tsx` (the copy switch),
   `src/protocol/protocol.test.ts` and `src/config/floor-json.test.ts` (FJ1's key count and the limits
   forms), and two Floor tests' `Features` literals.

## The lead's live check (costs nothing: no model call)

1. Set `text_merge: true` in `src/config/features.ts`, then `npm run build` and `npm run deploy:test`.
2. Play the canned hero, order 1, on a fresh `tidepool` pool on `test` (the scripted rehearsal or
   `npm run rehearse:hero`). Scripted agents make no model calls, so the run costs only Worker and
   Artifacts requests.
3. Open Compare view. Expect: the right pool shows the crab that never comes out, and the line reads
   "Text conflicts in the plain merge: 0" with no "(approximated)"; its tooltip names git merge-file.
4. Check the tree. Fetch the pool's `plain` repository at the commit of the last `plain.updated`, and the
   seed. For each of `world/energy.js`, `creatures/crab.js`, `creatures/shrimp.js` and
   `creatures/jellyfish.js`, run `git merge-file -p` on (base, ours, theirs) as PM3a names them, write the
   merged files over the seed, and compare `git write-tree` with `plain.updated.tree`. The offline test
   `PM3a: hero order 1 through the engine ...` does exactly this against the engine's own build.
5. Before deploying with the switch on, change two lines of `README.md`'s Limits list, or
   `npm run check:submission` fails (AC19): line 5 becomes "The plain-merge pool is constructed by Trunk
   from the same changes. It is a comparison, not a second product. Each change is merged as git merges a
   file from three versions, and the version its agent started from is taken from the pool's history.",
   and "text merge" leaves "Switched off in this build". The two lines must equal
   `limitsList(FEATURES)`; the check prints the expected text.
6. If any step fails, set the switch back to `false` (BP4).

## A test that raced, fixed

With the switch on, `test/workerd/landing/push-table.test.ts` failed 6 of 9 runs on this Mac (rows
`retry_notes`, `retry_main` and `repush`). The cause is in the test: after the retry it waited for any
`batch.pushed`, and the seed's batch 0 had already sent one, so the wait ended before the retry ran
whenever the Durable Object's own alarm took the retry instead of the test's `runAlarm`. The plain build's
small extra work made that more likely. Commit `6930568` makes those five rows wait for the landing's
batch (`batch_id === 1`), which is what they meant; no assertion changed. After it, 3 of 3 runs passed with
the switch on.

`test/workerd/landing/event-latency.test.ts` ("delivers a tick's accepted event before the alarm's slow
push retry answers") failed in about half of the runs on this Mac with the switch off as well as on: its
measured delay was 4 to 5 s while other sessions' test runs loaded the machine (43 test processes at one
point). It passes when the machine is quiet. It is not caused by this branch.

## Not done

- No browser test drives Compare view with the switch on: the browser harness mounts the view without the
  shell's settings. The server render test covers the copy switch; the live check covers the page.
- The hero script lines in `03-floor.md` 2.3 and the mock in 3.6 still show "0 (approximated)". They
  describe the current build; the lead should edit them if the switch goes on.
- Git's choice among equal-length edit scripts is not reproduced (see "How close the merge is to Git").
