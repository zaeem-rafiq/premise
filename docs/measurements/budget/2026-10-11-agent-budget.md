# Agent budget after the pre-landing checks, 2026-10-11

`MAX_MODEL_CALLS` 30 → 45 and `MAX_STEPS` 40 → 60 (BP8).

The pre-landing checks added on 2026-10-11 (CK6b `colours_known`, CK6c `selftest`, CK6d
`energy_through_rules`) send a broken change back before it lands, so an agent now spends turns on
repairs that used to happen after landing (or never). Real-agent runs on `production` and `test`
the same day stopped good attempts on `budget` (30 model calls) while they were repairing:

| Run | Pool | Stopped on `budget` | What it was doing |
| --- | --- | --- | --- |
| live test | `prel-1011` (test) | jellyfish | four `selftest` rejections, repairing |
| live test | `prel3-1011` (test) | starfish | four `selftest` rejections, repairing |
| rehearsal 2a | `rehearsal2` | lobster; sweep (P9a) | six `selftest` rejections; the sweep's search loop (since fixed) |
| rehearsal 2b | `rehearsal-b` | jellyfish, octopus | repairing after rejections |
| rehearsal 2d | `rehearsal-d` | shrimp (P1b, needed by beat 5) | three `energy_direct`, two `selftest` rejections |

Cost of the extra headroom: a gpt-oss-120b turn costs $0.0005 to $0.0045 in these runs, so 15 more
calls is at most about $0.07 per attempt; `MAX_ATTEMPT_USD` (1) is unchanged and still bounds it.
