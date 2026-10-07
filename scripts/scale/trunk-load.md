# Trunk storage load

## Limit and acceptance bound

Reviewed on 2026-10-07. Cloudflare's [Durable Objects troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/#durable-object-storage-operation-exceeded-timeout-which-caused-object-to-be-reset)
states: "To prevent indefinite blocking, there is a limit on how much time storage operations can take."
It does not give a numeric duration for this storage timeout.

The [D1 troubleshooting page](https://developers.cloudflare.com/d1/observability/debug-d1/)
describes the related error: "A query is trying to write a large amount of information (e.g. GBs), and is taking too long."
Its advice is to shorten queries, spread load or shard. This does not establish whether the observed
Trunk resets came from synchronous computation, storage writes, or both.

The [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)
describes `transactionSync`: "Invokes `callback()` wrapped in a transaction, and returns its result."
It gives no numeric transaction duration. The [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
page instead specifies an invocation CPU limit: "30 seconds (default) / configurable to 5 minutes of active CPU time".
The separate [blockConcurrencyWhile API](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
says: "To help mitigate deadlocks there is a 30 second timeout applied when executing the callback."
Neither number is documented as the storage-operation or synchronous SQL transaction timeout.

Use the brief's fallback: **1,000 ms per synchronous engine call**, including its transaction.
This is a local task acceptance bound, not a claim about Cloudflare's undocumented storage timeout.

## Measurement plan and evidence limits

Use the landing harness's real local workerd Durable Objects, scripted Swarm agents, SQLite and
loopback git server. Run 256 agents, seed 7, collision dials 0.5 and 1, and two launches per second.
Record each synchronous engine entry and transaction separately, plus SQLite `total_changes()`
deltas. Report tick batch sizes, post-batch classified attempts, judgments and events written.
Retain raw samples, per-entry p50/p99/max and the ten largest calls for each run.

Timing instrumentation belongs only in the test bundle. Cloudflare's [timer documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/)
states: "In local development, however, timers will increment regardless of whether I/O happens or not."
Local wall time includes scheduling and garbage collection. It excludes remote storage replication
and does not prove that the deployed platform cannot reset an object. No deployment or live soak is authorized.

## Change sequence and recovery

1. Commit this documented limit before building measurement code.
2. Measure the unchanged engine, save the raw baseline, and commit the harness.
3. Optimize measured repeated work without changing decisions or transaction boundaries.
4. Run the same measurement commands and all required regression checks.

The impact trace is tool/alarm/push response -> EngineSession -> Trunk facade -> one SQLite
transaction -> classification/persistence -> events and after-commit effects. The tick's batch
classification must finish within that transaction (LP2a/LP2b). Preserve every required judgment
and event (JE1/EV2/EV6). The supplied specification, case vectors and real git are the semantic oracles.

The sandbox refused the first commit preparation because it cannot create `.git/index.lock`
(`Operation not permitted`). The task's patch fallback is therefore in use: `.tmp-test/trunk-load.patch`
contains tracked changes and new files. Component checks and the patch are checkpointed as work finishes.
No safeguard was bypassed. This task does not mutate external services, change branches or deploy.

## Measurement choices

- The brief gives no think-time or rescale setting. Use the repository's `SWARM_DEFAULTS`:
  `think_ms: [50, 400]` and `rescale_every_s: 15`. The latter adds eight scheduled rescale attempts
  to the 256 agents, so a completed run contains 264 terminal attempts.
- Use nearest-rank percentiles. Include observer overhead rather than subtract an estimate.
  Report both the whole synchronous session call and the engine facade method, plus transaction time.
- Normal local runs reached only 12 and nine concurrent nonterminal attempts before optimization.
  A supplemental run holds every scripted pattern before submit until all 264 attempts exist,
  waits five seconds, and releases them through the existing Swarm route. This deliberately tests
  congestion and is reported separately from the supplied launch configuration.
- Keep the tick as one transaction and replay every attempt's operations even when premise hashes hold.
  Delay attempt-set analysis until a changed premise or a possible QR4 reader needs those sets.
  All applicable classifications, judgments and events remain required.
- Keep analysis caches scoped as before. Syntax-only lookups read current file content and reuse the
  existing parser cache. They do not cache hashes by mutable tree identity.

See [the results](../../docs/measurements/integration/2026-10-07-trunk-load.md) for command evidence, before/after distributions,
the largest calls, verification limits and the final repository state.
