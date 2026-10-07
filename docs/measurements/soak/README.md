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

## Size of the Swarm (RR9)

One Trunk did not carry 1,024 or 512 scripted agents: push times grew with the pool's history and the landing rate collapsed. Under RR9 the Swarm is run at 256 agents, the largest size that passed all eleven checks (dial 0 and 0.1 on `4005768`). The SYNTHETIC banner shows the number of agents of the run, and the project README will state 256.

## What the dials above 0.1 found on `4005768`

- **Truth false-abort rate.** A judgment's `cause_seq` named the first landing of its batch instead of the landing that changed the key, so the truth rate counted correct QR1 repairs as false aborts (dial 0.1: 3 of 3). Fixed in `af05f37` (merged `dad6034`).
- **`cosmetic_is_silent`.** In a `summary_only` pool the soak treated every landing of a batch as the cause of its heads-ups, so a `cosmetic` landing that only shared a batch with the real cause failed the check (5 at dial 0.5, 24 at dial 1). Fixed in `46fdc0c`: `headsup.sent.keys[].cause_seq`, and the check reads it.
- **`all_ended`, `no_stall`, `rebuildable`.** Under load Trunk was reset by the platform ("Durable Object storage operation exceeded timeout which caused object to be reset"). The Agents whose calls failed then made no further call and set no alarm, so their attempts stayed in flight until something woke them (2, 24 and 28 attempts); one that held right of way kept other landings waiting (gaps of 39 to 64 s). Both causes are being fixed: the Agents' liveness (AG3, TL16) and the length of Trunk's storage operations.

These dials are measured again on the build that carries those fixes.
