# Integration point 0: record

Date: 2026-10-04.

## Slice 0 on `main`

- `npm run check` exits 0 and `npm run test:workerd` exits 0 on `main` after merging Slice 0a, Slice 0b,
  the pure git encoding (track 1B, first part), the tide pool seed (track 1G, first part), the leaf
  modules (track 1A) and the stream lane (track 1E).
- Acceptance item 8 of plan 2.1, on the `test` environment (Worker `premise-test`, deployed 2026-10-04
  from `main` at `bd86214`): `wrangler deploy --env test` exited 0 and created the four Durable Object
  classes, the three Workflows, both Artifacts bindings, the AI binding and the Worker Loader binding.
  Live probes:

  | Request | Answer |
  | --- | --- |
  | `POST /api/pools`, JSON, before `OWNER_KEY` was set | 503 |
  | `POST /api/pools`, JSON, key set, none sent | 401 |
  | `POST /api/pools`, `text/plain` | 415 |
  | `GET /api/pools/x/stream` without an upgrade | 426 (the Floor is built; the plan's 503 was for the stub) |
  | `GET /` and `GET /floor.json` | 200 |

  The page does not carry the security headers of SE14 yet. They arrive with track 1D
  (`src/worker/security/**`).

## Citations checked (plan 2.1, acceptance item 11)

Each address was opened on 2026-10-03 or 2026-10-04 and answered.

| Cited as | Address | Title | Date |
| --- | --- | --- | --- |
| STORM | https://arxiv.org/abs/2605.20563 | Multi-agent Collaboration with State Management | 2026-05-19 |
| CoAgent | https://arxiv.org/abs/2606.15376 | CoAgent: Concurrency Control for Multi-Agent Systems | 2026-06-13 |
| dibs | https://github.com/shivamsriva31093/dibs | A public entry to the same competition | repository answered HTTP 200 on 2026-10-04 |

What each one does, in one line, as read from its own abstract or README:

- STORM mediates agents' interactions with a shared workspace so that conflicting edits are detected at
  write time.
- CoAgent builds concurrency control for agents that mutate shared state, and lets the model inside an
  agent judge whether a conflicting write invalidates its plan.
- dibs has agents declare what they will change and what they rely on before they write.

## Known defect found after Slice 0b was merged

`src/protocol/operations.ts` did not define `Operation` as `01-core.md` 5.1 does, and `Features.green`
differed from the specification. The Slice 0b tests compared sets of names and constants but not type
shapes, so the first check of Slice 0b missed both. A follow-up task replaces the type and adds a
compiler-checked comparison of every specification type with the protocol module.
