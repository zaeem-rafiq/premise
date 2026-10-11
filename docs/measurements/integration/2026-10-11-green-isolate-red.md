# Green line part 14b: forced red on `test`, 2026-10-11

The owner approved a diagnostic deploy ("test deploy", 2026-10-11 14:29 UTC). `feat/green-line` at
`c2c2838` (branch plus main `7b5db0f`) with `features.green = "full"` was deployed to `test` as version
`fd9deae3` (built in a separate clone, never committed). Afterwards main `7b5db0f` was deployed to `test`
again (version `340535f5`, `floor.json` green `"static"`).

Pool `green-red-1011b` (seed `tidepool-auto`). An outside agent over MCP (no model calls) read `GUIDE.md`
and the seed's modules, wrote the four files in which the hero's plain-merge tree (02-tidepool A5) differs
from the seed, and submitted. Stream (from `/api/pools/green-red-1011b/replay.ndjson`):

| n | Event | Detail |
| --- | --- | --- |
| 84 | `landing.landed` | seq 1, commit `4dbb6d7` |
| 88 | `green.verified` | seq 1, `ok: false`, `confirmed: false`, runtime `isolate`, 64 ms, failed `not_exhausted:failed` |
| 90 | `green.verified` | seq 1, `ok: false`, `confirmed: true`, 57 ms, failed `not_exhausted:failed` |
| 91 | `undo.planned` | `green-revert-1`, cause `revert`, reverted `[1]`, reopened the attempt |
| 92 | `landing.accepted` | seq 2, kind `revert` |
| 95 | `attempt.reopened` | cause `revert`, revision 2; the heads-up's one key is `check` `not_exhausted`, rule `GR3` |
| 100 | `attempt.state` | `stopped`, `reopen_failed`: an outside attempt is never started again (07-mcp MC23) |
| 107 | `green.verified` | seq 2 (the revert), `ok: true`, 48 ms |
| 108 | `green.advanced` | seq 2 |

No event contains the log's text ("resting"). The pool page's strip read "Green line landing 2". Not run
live: 2.15 item 4 (`node scripts/measure/green-isolate.ts`, the lead's measurement of 50 runs and
`GREEN_CPU_MS`).
