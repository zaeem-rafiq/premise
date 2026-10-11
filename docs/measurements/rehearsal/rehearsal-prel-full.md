# Rehearsal prel-full (VE9 run 1, scripted)

Driven by `test/e2e/lead/rehearsal.spec.ts` with the canned cast, on `premise-test.rk3469.workers.dev`, pool `reh-mv44yv8k`, recorded 2026-10-11T18:07:52.483Z.
Total 2:43 on the run clock of the test (the waits for the scripted agents are not cut). Key R was not used. Landings: 10. Events: 518.
Spend before: Spend $4.21 of $10.00. Spend after: Spend $4.21 of $10.00. Scripted agents make no model calls.

Beats observed: 4. Observed with a substitution: 7. Failed: 0.

## State before the run (03-floor 1.1)

- ok PS1 landed history: Landed counter is 0: a fresh pool by design of run 1 (5.5), so PS1's earlier real-agent history is absent.
- ok PS2 owner unlocked: Header shows Owner. The key was not typed.
- ok PS3 spend: Spend $4.21 of $10.00
- ok PS4 no banner: No banner before any agent starts.
- ok PS5 recordings: GET /replay/index.json answered 200: {"v":1,"default":"hero-canned","recordings":[{"id":"hero-canned","file":"/replay/hero-canned.ndjson","title":"The beat sheet, scripted agents","duration_ms":136160,"events":518,"bytes":256867,"synthet
- ok PS7 swarm pool: Swarm pool tidepool-swarm: stream probe answered 200.

## Beats

| Beat | Window | Start-end (s) | Status | Proves observed | Substitutions and deviations |
| --- | --- | --- | --- | --- | --- |
| 0 Compare view (cut forward) | 0:00-0:20 | 8-12 | substituted | no | Beat 0 is a cut forward from beat 4 (BS2). Here, before any landing, only the view's controls and labels are checked; the broken crab is observed in beat 4. |
| 1 Floor: the pool runs, starter set, crab race | 0:20-1:05 | 12-17 | substituted | yes | Starter set: not sent (real agents). The canned jellyfish (hero-j, the starter set's A01 text) lands by itself in its place. Crab race: not sent (three real models). One canned crab (hero-c, P1a's text) and the canned shrimp (hero-h, P1b's text) stand in; they are held before submit (conductor row 1 of 02-tidepool 7.11) instead of waiting on a race card. The crab cards do not reach "Waiting for you" on a race card: the canned crab is one attempt held before submit, so it shows as working until released in beat 3. |
| 2 Shared rule and Who relies | 1:05-1:35 | 17-20 | substituted | yes | Shared rule: the canned hero-s, started through POST /api/swarm, instead of the typed R01. |
| 3 Held card, Land, heads-up and go-around | 1:35-2:50 | 20-32 | substituted | yes | The crab and the shrimp are released by the rehearsal (POST /api/swarm release) after their heads-up, as conductor row 5 of 7.11 does; on the take a race candidate returns to "Waiting for you" instead. |
| 4 Race sheet and Compare view | 2:50-3:35 | 33-43 | substituted | yes | Race sheet: not exercised. A race needs three real models (Race 3 was checked enabled in beat 1); "Choose this one", "Not chosen" and the side-by-side frames are left to run 2. What differs does not say the crab "went around once after ENERGY_MAX changed" with "its first version": the canned crab was held before submit, so the plain-merge pool has its unfinished work (02-tidepool 7.11 permits this in order 1). The conflicts line reads "Text conflicts in the plain merge: 0", without "(approximated)" as beat 4 has it. |
| 5 The second catch (sweep and late creature) | 3:35-4:05 | 43-59 | substituted | yes | P9a and P9b: the canned sweep-a and sweep-b (02-tidepool 9.5) through POST /api/swarm, instead of the pre-written requests (real agents). |
| 6 Why card and Show the git | 4:05-4:50 | 59-81 | observed | yes | - |
| 7 Causal Undo | 4:50-5:30 | 81-91 | observed | yes | After the undo put ENERGY_MAX back to 100, the scripted crab still said "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.": the canned cast has one fixed sentence (02-tidepool 7.5). A real agent would describe the reverse change. |
| 8 Swarm view | 5:30-6:25 | 91-92 | substituted | no | Swarm run not started by run 1; controls checked only (swarm pool stream answered 200). |
| 9 About sheet | 6:25-7:05 | 92-92 | observed | yes | - |
| 10 Lock and play the Replay | 7:05-7:30 | 92-163 | observed | yes | The default recording on this deployment is `hero-canned`, not `rehearsal` (PS5, RY26): run 2 makes that recording. |

The checks of each beat, with their notes, are in the JSON file of the same name.
