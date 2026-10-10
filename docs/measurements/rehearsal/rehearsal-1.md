# Rehearsal 1 (VE9 run 1, scripted)

Driven by `test/e2e/lead/rehearsal.spec.ts` with the canned cast, on `premise-test.rk3469.workers.dev`, pool `reh-mv2eqrla`, recorded 2026-10-10T13:05:58.318Z.
Total 1:52 on the run clock of the test (the waits for the scripted agents are not cut). Key R was not used. Landings: 10. Events: 473.
Spend before: SPEND $3.45 of $10.00. Spend after: SPEND $3.45 of $10.00. Scripted agents make no model calls.

Beats observed: 2. Observed with a substitution: 7. Failed: 2.

## State before the run (03-floor 1.1)

- ok PS1 landed history: Landed counter is 0: a fresh pool by design of run 1 (5.5), so PS1's earlier real-agent history is absent.
- ok PS2 owner unlocked: Header shows Owner. The key was not typed.
- ok PS3 spend: SPEND $3.45 of $10.00
- ok PS4 no banner: No banner before any agent starts.
- ok PS5 recordings: GET /replay/index.json answered 200: {"v":1,"default":"hero-canned","recordings":[{"id":"hero-canned","file":"/replay/hero-canned.ndjson","title":"The conflict, scripted agents","duration_ms":22034,"events":169,"bytes":81606,"synthetic":
- ok PS7 swarm pool: Swarm pool tidepool-swarm: stream probe answered 404 (the pool does not exist on this deployment).

## Beats

| Beat | Window | Start-end (s) | Status | Proves observed | Substitutions and deviations |
| --- | --- | --- | --- | --- | --- |
| 0 Compare view (cut forward) | 0:00-0:20 | 10-12 | substituted | no | Beat 0 is a cut forward from beat 4 (BS2). Here, before any landing, only the view's controls and labels are checked; the broken crab is observed in beat 4. |
| 1 Floor: the pool runs, starter set, crab race | 0:20-1:05 | 12-17 | substituted | yes | Starter set: not sent (real agents). The canned jellyfish (hero-j, the starter set's A01 text) lands by itself in its place. Crab race: not sent (three real models). One canned crab (hero-c, P1a's text) and the canned shrimp (hero-h, P1b's text) stand in; they are held before submit (conductor row 1 of 02-tidepool 7.11) instead of waiting on a race card. The crab cards do not reach "Waiting for you" on a race card: the canned crab is one attempt held before submit, so it shows as working until released in beat 3. |
| 2 Shared rule and Who relies | 1:05-1:35 | 17-19 | substituted | yes | Shared rule: the canned hero-s, started through POST /api/swarm, instead of the typed R01. |
| 3 Held card, Land, heads-up and go-around | 1:35-2:50 | 19-35 | substituted | yes | The crab and the shrimp are released by the rehearsal (POST /api/swarm release) after their heads-up, as conductor row 5 of 7.11 does; on the take a race candidate returns to "Waiting for you" instead. |
| 4 Race sheet and Compare view | 2:50-3:35 | 35-44 | substituted | yes | Race sheet: not exercised. A race needs three real models (Race 3 was checked enabled in beat 1); "Choose this one", "Not chosen" and the side-by-side frames are left to run 2. What differs does not say the crab "went around once after ENERGY_MAX changed" with "its first version": the canned crab was held before submit, so the plain-merge pool has its unfinished work (02-tidepool 7.11 permits this in order 1). The conflicts line reads "Text conflicts in the plain merge: 0", without "(approximated)" as beat 4 has it. |
| 5 The second catch (sweep and late creature) | 3:35-4:05 | 44-62 | substituted | yes | P9a and P9b: the canned sweep-a and sweep-b (02-tidepool 9.5) through POST /api/swarm, instead of the pre-written requests (real agents). |
| 6 Why card and Show the git | 4:05-4:50 | 62-65 | failed | no | The crab could not be hit in the frame; the Why card was opened from the crab tile instead. FAILED tap the crab in the pool frame: no Why card opened from 237 taps on the frame; the pool frame logged 240 errors, e.g. "p.rect is not a function" |
| 7 Causal Undo | 4:50-5:30 | 65-75 | observed | yes | After the undo put ENERGY_MAX back to 100, the scripted crab still said "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.": the canned cast has one fixed sentence (02-tidepool 7.5). A real agent would describe the reverse change. |
| 8 Swarm view | 5:30-6:25 | 76-76 | substituted | no | Swarm run not started: the deployment's swarm pool tidepool-swarm does not exist (stream 404), so it is not idle (PS7). Controls checked only. |
| 9 About sheet | 6:25-7:05 | 76-77 | observed | yes | - |
| 10 Lock and play the Replay | 7:05-7:30 | 77-112 | failed | no | The default recording on this deployment is `hero-canned`, not `rehearsal` (PS5, RY26): run 2 makes that recording. FAILED Play the Replay: the REPLAY banner and the same page: locator.click: Timeout 30000ms exceeded. / Call log: /   - waiting for getByRole('button', { name: /^Play the Replay \(/ }) |

The checks of each beat, with their notes, are in the JSON file of the same name.

## Runs, follow-up and open items (written by hand after the run)

The table above is the last of six live runs on `premise-test.rk3469.workers.dev` (pool budget: six `reh-` pools). The first three runs found faults in the spec itself (an unbounded navigation wait, selectors for the Landed tab, the owner dialog's two "Lock"-like buttons); the last three ran the spec back to back:

| Pool | Result | Failed checks |
| --- | --- | --- |
| `reh-mv2eh4g7` | failed | beat 6 pool tap (product defect below); beat 10 start card (spec: strict-mode text match) |
| `reh-mv2eivwc` | failed | beat 0 key C pressed before the page's keys were live (spec); beat 6 pool tap, and the tile fallback missed the crab tile folded under "+10 more" (spec); beat 10 as above |
| `reh-mv2eqrla` | failed | beat 6 pool tap (product defect); beat 10: the start card showed for a moment and went (spec waited too little) |

After `reh-mv2eqrla` the spec was changed so that beat 10 waits for a pool that has stayed quiet for `QUIET_POOL_MS` (RY23) and counts the start card only when it is still there after the page settles. That flow (Lock, start card, "Play the Replay", REPLAY banner) was then checked on `reh-mv2eqrla` with no new pool, and passed. No full run of the final spec exists yet: the pool budget was spent.

Product defect that fails beat 6 on every run: tapping a creature in the live pool frame never opens a Why card. The pool host throws `TypeError: p.rect is not a function` on each tap: `src/host/env.ts` hands the raw `canvas#pool` element to the host as a `CanvasLike`, and `src/host/main.ts` calls `canvas.rect()`, which an HTML canvas element does not have (it has `getBoundingClientRect()`).

Spend: the strip read $3.45 of $10.00 before and after each run. The scripted agents made no model calls.
