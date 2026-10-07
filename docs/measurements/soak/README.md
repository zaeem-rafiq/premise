# Soak results (VE6)

Each file is the `SoakResult` of one run of `npm run soak` against the `test` deployment, one pool per run, seed 7. The name is `<date>-<build>-<agents>-d<dial>.json` (the oldest files have no agent count: 1,024). Every check is defined in `04-build-plan.md` 5.2.

| File | Agents | Dial | Launch/s | Landed | Checks | Failed |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `2026-10-06-3f689b9-1024-d0.json` | 1,024 | 0 | 50 | 388 | 10/11 | `no_stall` |
| `2026-10-07-e499190-1024-d0.json` | 1,024 | 0 | 16 | 372 | 6/11 | `all_ended`, `one_commit_per_landing`, `no_stall`, `fsck`, `rebuildable` |
| `2026-10-07-51ac36d-1024-d0.json` | 1,024 | 0 | 16 | 232 | 8/11 | `all_ended`, `no_stall`, `rebuildable` |
| `2026-10-07-77f7636-512-d0.json` | 512 | 0 | 1 | 346 | 8/11 | `all_ended`, `no_stall`, `rebuildable` |
| `2026-10-07-4005768-256-d0.json` | 256 | 0 | 2 | 256 | 11/11 | none |
| `2026-10-07-4005768-256-d0.1.json` | 256 | 0.1 | 2 | 257 | 11/11 | none |
| `2026-10-07-4005768-256-d0.25.json` | 256 | 0.25 | 2 | 245 | 8/11 | `all_ended`, `no_stall`, `rebuildable` |
| `2026-10-07-4005768-256-d0.5.json` | 256 | 0.5 | 2 | 222 | 7/11 | `all_ended`, `cosmetic_is_silent`, `no_stall`, `rebuildable` |
| `2026-10-07-4005768-256-d1.json` | 256 | 1 | 2 | 210 | 7/11 | `all_ended`, `cosmetic_is_silent`, `no_stall`, `rebuildable` |
| `2026-10-07-b2bf784-256-d0.25.json` | 256 | 0.25 | 2 | 247 | 11/11 | none |
| `2026-10-07-b2bf784-256-d0.5.json` | 256 | 0.5 | 2 | 242 | 11/11 | none |
| `2026-10-07-b2bf784-256-d1.json` | 256 | 1 | 2 | 227 | 10/11 | `no_stall` (10,481 ms; a fault of the check, see below) |

## Size of the Swarm (RR9)

One Trunk did not carry 1,024 or 512 scripted agents: push times grew with the pool's history and the landing rate collapsed. Under RR9 the Swarm is run at 256 agents, the largest size that passed all eleven checks (dial 0 and 0.1 on `4005768`). The SYNTHETIC banner shows the number of agents of the run, and the project README will state 256.

## What the dials above 0.1 found on `4005768`

- **Truth false-abort rate.** A judgment's `cause_seq` named the first landing of its batch instead of the landing that changed the key, so the truth rate counted correct QR1 repairs as false aborts (dial 0.1: 3 of 3). Fixed in `af05f37` (merged `dad6034`).
- **`cosmetic_is_silent`.** In a `summary_only` pool the soak treated every landing of a batch as the cause of its heads-ups, so a `cosmetic` landing that only shared a batch with the real cause failed the check (5 at dial 0.5, 24 at dial 1). Fixed in `46fdc0c`: `headsup.sent.keys[].cause_seq`, and the check reads it.
- **`all_ended`, `no_stall`, `rebuildable`.** Under load Trunk was reset by the platform ("Durable Object storage operation exceeded timeout which caused object to be reset"). The Agents whose calls failed then made no further call and set no alarm, so their attempts stayed in flight until something woke them (2, 24 and 28 attempts); one that held right of way kept other landings waiting (gaps of 39 to 64 s). Both causes are being fixed: the Agents' liveness (AG3, TL16) and the length of Trunk's storage operations.

## The same dials on `b2bf784` (the fixes merged)

`b2bf784` carries the Agent liveness fix (`7d4622e`: an unfinished Agent always has an alarm that fires), the Trunk load fix (`63f5beb`: the longest engine call of a local 256-agent run fell from 6,493 ms to 802 ms, `docs/measurements/integration/2026-10-07-trunk-load.md`), the parse cache (`37ce004`) and the `cause_seq` fixes. Every attempt ended at every dial, no landing was lost, and the truth false-abort rate is 0.1, 0 and 0. Landings per second rose from 0.16 to 0.18 on `4005768` to 1.16 to 1.44, the median time to land fell from about 18 s to 3.8 to 5.8 s, and the median push from 11 to 15 s to 2.3 to 3.6 s.

Dial 1 failed `no_stall` with 10,481 ms. The cause is the check, not Trunk: the soak ran the stall clock on every event in arrival order, and Trunk's accept at 141.7 s reached the Floor after the Floor's own `metrics` events up to 149.6 s (Trunk's events reached the Floor 1.2 s late at the median, and up to 24 s late while a slow push was in flight). Order across sources says nothing about causality (`01-core.md` EV4). Since `cb41172` the clock runs on Trunk's own events and times; recomputed that way, the longest stall of this run was 4,591 ms. The late delivery itself is a separate defect of the page's freshness, being fixed.

The final soak runs on the frozen build.
