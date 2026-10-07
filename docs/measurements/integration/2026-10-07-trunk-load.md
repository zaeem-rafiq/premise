# Trunk load: local measurements

Status: all four after workerd measurement runs completed below the 1,000 ms bound, and the after microbenchmark completed. All required verification commands exited 0. The held dial-1 baseline remains an explicitly incomplete observation.

The task uses a **1,000 ms synchronous-call bound**. The official research and quotations are in [trunk-load.md](./trunk-load.md). This bound is not Cloudflare's undocumented storage timeout.

The normal baseline completed at both collision settings, with maximum calls of 469 ms and 361 ms. It reached only 12 and 9 simultaneous in-flight attempts in recorded engine-entry context. Those runs did not reproduce the live congestion.

The supplemental held baseline reached 264 in-flight attempts. Dial 0.5 completed but recorded a 6,493 ms tick. Dial 1 stopped collecting after 202,376 ms with `fetch failed`; its recorded maximum was 3,679 ms. These observations do not establish a Cloudflare storage reset.

After the changes, normal runs completed with maxima of 63 and 76 ms. Supplemental held runs reached 264 in-flight attempts and completed with maxima of 802 and 797 ms. All four after runs passed the local 1,000 ms bound. These measurements exclude live storage replication and do not prove a deployed-platform limit.

## Workloads, timing, and provenance

Every run used the local landing harness, real workerd Durable Objects and SQLite, scripted Agents, and a loopback git server. No Cloudflare service or git host was contacted.

The shared settings were 256 scripted agents, seed 7, `launch_per_second: 2`, `think_ms: [50, 400]`, and `rescale_every_s: 15`. The launcher added eight scheduled rescale attempts, so completion meant 264 terminal attempts and no pending outbox.

Normal runs let Agents proceed as launched. Supplemental held runs used the existing `hold_before_submit` option for all 22 scripted patterns. They waited for all 264 attempts, settled for five seconds, and released them through the Swarm route. This is an additional congestion workload, not an exact reproduction of the live schedule.

All four raw reports name baseline HEAD `46fdc0c493fd50217fdb65a929c09f4ffead338b`. The separately retained baseline bundle SHA-256 is `50372f17b4a735602cbcbbbf325edb9c92dd2c083bd1e58ddf514080380567a0`; both held reports record that same value.

The first normal reports predate additions to the harness metadata: they do not contain `bundle_sha256`, `supplemental_hold`, `peak_inflight`, release information, or session-counter conservation. Their request ID was `trunk-load-before`. The held reports use the later fixed request ID `trunk-load-measurement`. Attempt IDs derive from the request ID, so these workloads cannot be compared as identical ordered attempts. Wall-clock scheduling also changes interleaving and terminal outcomes.

No explicit instrumentation version number was stored. All four reports carry the same timing-definition text. Later harness metadata improves provenance and coverage evidence; it does not retroactively supply missing evidence for earlier runs. Any after comparison must disclose its request ID, bundle hash, instrumentation changes, and completion state.

`call_ms` includes EngineSession hydration, the facade callback, persistence, cleanup, and measurement counters. `engine_ms` measures facade-method time. `transaction_ms` sums outer synchronous SQLite transaction intervals. `transaction_max_ms` records the largest such interval in that call. The two transaction distributions are identical for every entry in all four baseline reports.

Timing uses local `performance.now()` wall time. Measurement reads occur inside timed regions, and analysis/classification timers are inclusive and overlap. Scheduling and garbage collection contribute. Network pushes and asynchronous alarm waits are excluded. Alarm-driven engine entries and standalone shell transactions are included. A zero can reflect timer resolution, not zero work.

`rows_changed` is the SQLite `total_changes()` delta. It counts repeated writes and trigger effects, including rolled-back writes when present. Judgment/event counts are table-write deltas. These are not unique logical-row counts. Quantiles below use the saved summaries: nearest rank for p50 and p99. The small held tick samples make p99 equal the maximum.

## Baseline command forms

The following commands select the normal and held measurement modes. Baseline runs used the unchanged built engine. Rebuilding the current tree and rerunning these commands measures the current engine instead. The current harness fixes the request ID to `trunk-load-measurement`, so it does not reproduce the earlier normal request ID verbatim.

```sh
TRUNK_LOAD=1 TRUNK_LOAD_LABEL=before TMPDIR="$PWD/.tmp-test" \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts

TRUNK_LOAD=1 TRUNK_LOAD_HOLD=1 TRUNK_LOAD_LABEL=held-before TMPDIR="$PWD/.tmp-test" \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts

TMPDIR="$PWD/.tmp-test" node scripts/scale/cause-seq.ts
```

The two normal measurement tests completed successfully. Held dial 0.5 completed. Held dial 1 failed to finish; its saved JSON records `fetch failed`, and the execution output reported the connection cause `other side closed`. There is no recorded platform storage-timeout error proving an object reset. Its partial statistics are not an acceptance pass, even though no completed synchronous sample has `failed: true`.

## Baseline run summary

| Run                                    | Elapsed ms | Calls | Complete | Peak in-flight     | States at last collection                 | Pending outbox | Calls > bound |
| -------------------------------------- | ---------- | ----- | -------- | ------------------ | ----------------------------------------- | -------------- | ------------- |
| Normal, dial 0.5                       | 129931     | 5704  | True     | 12 (entry samples) | landed: 251, stopped: 13                  | 0              | 0             |
| Normal, dial 1                         | 129835     | 5430  | True     | 9 (entry samples)  | landed: 246, stopped: 18                  | 0              | 0             |
| Supplemental held, dial 0.5            | 221939     | 9747  | True     | 264                | landed: 207, stopped: 57                  | 0              | 10            |
| Supplemental held, dial 1 (incomplete) | 202376     | 14033 | False    | 264                | accepted: 64, stopped: 27, validated: 173 | 1              | 1             |

Held dial 0.5 released 264 working attempts between 133,497 and 135,208 ms. Its final EngineSession counts exactly matched the measurement counts. Held dial 1 released 264 working attempts between 134,355 and 137,607 ms; its final conservation check is unavailable because the run did not complete.

## Baseline tick distributions

Each cell is **p50 / p99 / maximum**. These summaries include ticks that accepted no landing. A post-batch count records actual classified attempts after the batch, not all candidate or right-of-way classifications.

| Run                                    | Tick calls | Call ms           | Transaction ms    | Batch size   | Post-batch classified | Judgments written | Events written  |
| -------------------------------------- | ---------- | ----------------- | ----------------- | ------------ | --------------------- | ----------------- | --------------- |
| Normal, dial 0.5                       | 123        | 23 / 381 / 469    | 22 / 380 / 468    | 2 / 8 / 11   | 0 / 2 / 3             | 1 / 9 / 14        | 6 / 26 / 28     |
| Normal, dial 1                         | 136        | 22 / 113 / 122    | 22 / 112 / 121    | 2 / 5 / 6    | 1 / 3 / 4             | 1 / 24 / 26       | 6 / 43 / 50     |
| Supplemental held, dial 0.5            | 7          | 850 / 6493 / 6493 | 842 / 6481 / 6481 | 37 / 64 / 64 | 70 / 200 / 200        | 40 / 407 / 407    | 110 / 780 / 780 |
| Supplemental held, dial 1 (incomplete) | 2          | 0 / 3679 / 3679   | 0 / 3564 / 3564   | 0 / 64 / 64  | 0 / 200 / 200         | 0 / 581 / 581     | 0 / 997 / 997   |

| Run                                    | Rows changed       | Analysis calls    | Analysis ms       | All classify calls | All classify ms   |
| -------------------------------------- | ------------------ | ----------------- | ----------------- | ------------------ | ----------------- |
| Normal, dial 0.5                       | 55 / 225 / 256     | 6 / 89 / 109      | 17 / 360 / 455    | 2 / 11 / 11        | 4 / 158 / 427     |
| Normal, dial 1                         | 60 / 226 / 233     | 9 / 49 / 51       | 15 / 98 / 107     | 3 / 10 / 11        | 6 / 44 / 44       |
| Supplemental held, dial 0.5            | 1226 / 3655 / 3655 | 331 / 1964 / 1964 | 759 / 6311 / 6311 | 132 / 1229 / 1229  | 392 / 6213 / 6213 |
| Supplemental held, dial 1 (incomplete) | 0 / 4427 / 4427    | 0 / 923 / 923     | 0 / 2937 / 2937   | 0 / 310 / 310      | 0 / 1727 / 1727   |

Batch-size distributions, written as `batch size: number of ticks`:

- Normal, dial 0.5: `0: 10`, `1: 19`, `2: 78`, `3: 8`, `4: 2`, `5: 1`, `6: 1`, `7: 2`, `8: 1`, `11: 1`.
- Normal, dial 1: `0: 7`, `1: 40`, `2: 76`, `3: 5`, `4: 2`, `5: 5`, `6: 1`.
- Supplemental held, dial 0.5: `0: 2`, `2: 1`, `37: 1`, `40: 1`, `64: 2`.
- Supplemental held, dial 1 (incomplete): `0: 1`, `64: 1`.

## Normal, dial 0.5

Raw artifact: [trunk-load-before-d0-5.json](../../.tmp-test/trunk-load-before-d0-5.json). The raw file is local and ignored by git.

Per-entry cells are **p50 / p99 / maximum**, with milliseconds for timing columns. `tx` means the sum of outer transaction intervals.

| Entry             | Calls | call_ms        | engine_ms      | transaction_ms | rows_changed   |
| ----------------- | ----- | -------------- | -------------- | -------------- | -------------- |
| open_attempt      | 264   | 1 / 2 / 4      | 0 / 1 / 1      | 0 / 1 / 1      | 5 / 5 / 7      |
| pool_create       | 1     | 24 / 24 / 24   | 24 / 24 / 24   | 18 / 18 / 18   | 81 / 81 / 81   |
| push_ok           | 114   | 1 / 4 / 5      | 1 / 4 / 4      | 1 / 4 / 4      | 83 / 294 / 414 |
| shell_transaction | 3019  | 0 / 1 / 4      | 0 / 0 / 0      | 0 / 1 / 4      | 0 / 8 / 35     |
| stop              | 13    | 1 / 3 / 3      | 0 / 1 / 1      | 0 / 1 / 1      | 3 / 9 / 9      |
| sync              | 177   | 0 / 1 / 1      | 0 / 1 / 1      | 0 / 1 / 1      | 0 / 0 / 0      |
| tick              | 123   | 23 / 381 / 469 | 22 / 380 / 468 | 22 / 380 / 468 | 55 / 225 / 256 |
| tool:list         | 193   | 1 / 2 / 2      | 0 / 2 / 2      | 0 / 2 / 2      | 5 / 5 / 5      |
| tool:read         | 1059  | 3 / 52 / 104   | 3 / 52 / 104   | 3 / 52 / 104   | 3 / 5 / 7      |
| tool:replace      | 264   | 56 / 330 / 382 | 56 / 329 / 382 | 56 / 329 / 382 | 7 / 14 / 14    |
| tool:search       | 8     | 4 / 5 / 5      | 4 / 5 / 5      | 4 / 5 / 5      | 5 / 5 / 5      |
| tool:submit       | 277   | 7 / 73 / 161   | 7 / 72 / 160   | 7 / 72 / 160   | 7 / 17 / 17    |
| tool:write        | 192   | 14 / 29 / 30   | 14 / 29 / 29   | 14 / 29 / 29   | 7 / 9 / 9      |

Ten largest collected calls, ordered by `call_ms`. `#` identifies the raw row. Context is measured on entry. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E  | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | ------ | ------------------- | ------------------- | ------------------------------------ |
| 5015 | tick         | 469 / 468 / 468       | 37   | 1 / 3              | 0 / 5  | 455 / 109           | 427 / 7             | 218 / 190 / 4 / 3                    |
| 4082 | tool:replace | 382 / 382 / 382       | 6    | 0 / 0              | 0 / 0  | 379 / 79            | 0 / 0               | 177 / 160 / 3 / 2                    |
| 4971 | tick         | 381 / 380 / 380       | 120  | 4 / 2              | 4 / 18 | 360 / 78            | 158 / 8             | 214 / 186 / 6 / 6                    |
| 5383 | tool:replace | 366 / 366 / 366       | 6    | 0 / 0              | 0 / 0  | 360 / 64            | 0 / 0               | 233 / 202 / 3 / 2                    |
| 5405 | tool:replace | 330 / 329 / 329       | 6    | 0 / 0              | 0 / 0  | 327 / 89            | 0 / 0               | 233 / 202 / 3 / 2                    |
| 5399 | tool:replace | 313 / 312 / 312       | 6    | 0 / 0              | 0 / 0  | 309 / 84            | 0 / 0               | 233 / 202 / 3 / 2                    |
| 5395 | tool:replace | 312 / 312 / 312       | 6    | 0 / 0              | 0 / 0  | 307 / 79            | 0 / 0               | 233 / 202 / 3 / 2                    |
| 5391 | tool:replace | 308 / 308 / 308       | 6    | 0 / 0              | 0 / 0  | 305 / 74            | 0 / 0               | 233 / 202 / 3 / 2                    |
| 4060 | tool:replace | 304 / 304 / 304       | 6    | 0 / 0              | 0 / 0  | 297 / 54            | 0 / 0               | 177 / 160 / 3 / 2                    |
| 4720 | tool:replace | 284 / 284 / 284       | 6    | 0 / 0              | 0 / 0  | 281 / 89            | 0 / 0               | 206 / 179 / 3 / 2                    |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Full attempt IDs and per-table write counts remain in the raw rows.

## Normal, dial 1

Raw artifact: [trunk-load-before-d1.json](../../.tmp-test/trunk-load-before-d1.json). The raw file is local and ignored by git.

Per-entry cells are **p50 / p99 / maximum**, with milliseconds for timing columns. `tx` means the sum of outer transaction intervals.

| Entry             | Calls | call_ms        | engine_ms      | transaction_ms | rows_changed   |
| ----------------- | ----- | -------------- | -------------- | -------------- | -------------- |
| open_attempt      | 264   | 1 / 3 / 9      | 0 / 2 / 4      | 0 / 2 / 4      | 5 / 5 / 7      |
| pool_create       | 1     | 11 / 11 / 11   | 11 / 11 / 11   | 8 / 8 / 8      | 81 / 81 / 81   |
| push_ok           | 130   | 1 / 4 / 6      | 1 / 4 / 5      | 1 / 4 / 5      | 71 / 245 / 273 |
| shell_transaction | 2895  | 0 / 2 / 10     | 0 / 0 / 0      | 0 / 2 / 10     | 0 / 8 / 50     |
| stop              | 17    | 0 / 1 / 1      | 0 / 1 / 1      | 0 / 1 / 1      | 3 / 11 / 11    |
| sync              | 183   | 0 / 1 / 2      | 0 / 1 / 1      | 0 / 1 / 1      | 0 / 0 / 0      |
| tick              | 136   | 22 / 113 / 122 | 22 / 112 / 121 | 22 / 112 / 121 | 60 / 226 / 233 |
| tool:list         | 138   | 1 / 5 / 6      | 1 / 2 / 3      | 1 / 2 / 3      | 5 / 5 / 5      |
| tool:read         | 884   | 3 / 41 / 68    | 2 / 41 / 67    | 2 / 41 / 67    | 3 / 5 / 7      |
| tool:replace      | 352   | 32 / 208 / 361 | 32 / 208 / 361 | 32 / 208 / 361 | 7 / 14 / 21    |
| tool:search       | 16    | 3 / 5 / 5      | 3 / 4 / 4      | 3 / 4 / 4      | 5 / 5 / 5      |
| tool:submit       | 283   | 7 / 46 / 64    | 7 / 45 / 63    | 7 / 45 / 63    | 7 / 17 / 17    |
| tool:write        | 131   | 12 / 35 / 40   | 11 / 35 / 38   | 11 / 35 / 38   | 7 / 9 / 9      |

Ten largest collected calls, ordered by `call_ms`. `#` identifies the raw row. Context is measured on entry. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | ----- | ------------------- | ------------------- | ------------------------------------ |
| 4526 | tool:replace | 361 / 361 / 361       | 6    | 0 / 0              | 0 / 0 | 356 / 84            | 0 / 0               | 201 / 130 / 4 / 3                    |
| 5083 | tool:replace | 246 / 245 / 245       | 6    | 0 / 0              | 0 / 0 | 241 / 59            | 0 / 0               | 230 / 146 / 3 / 2                    |
| 5105 | tool:replace | 229 / 229 / 229       | 6    | 0 / 0              | 0 / 0 | 225 / 79            | 0 / 0               | 230 / 146 / 3 / 2                    |
| 4518 | tool:replace | 208 / 208 / 208       | 6    | 0 / 0              | 0 / 0 | 207 / 74            | 0 / 0               | 201 / 130 / 4 / 3                    |
| 3876 | tool:replace | 204 / 203 / 203       | 6    | 0 / 0              | 0 / 0 | 201 / 79            | 0 / 0               | 172 / 117 / 3 / 2                    |
| 3880 | tool:replace | 198 / 198 / 198       | 6    | 0 / 0              | 0 / 0 | 193 / 84            | 0 / 0               | 172 / 117 / 3 / 2                    |
| 5099 | tool:replace | 194 / 193 / 193       | 6    | 0 / 0              | 0 / 0 | 191 / 74            | 0 / 0               | 230 / 146 / 3 / 2                    |
| 4522 | tool:replace | 193 / 193 / 193       | 6    | 0 / 0              | 0 / 0 | 189 / 79            | 0 / 0               | 201 / 130 / 4 / 3                    |
| 3850 | tool:replace | 190 / 190 / 190       | 6    | 0 / 0              | 0 / 0 | 188 / 59            | 0 / 0               | 172 / 117 / 3 / 2                    |
| 5079 | tool:replace | 190 / 189 / 189       | 6    | 0 / 0              | 0 / 0 | 188 / 54            | 0 / 0               | 230 / 146 / 3 / 2                    |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Full attempt IDs and per-table write counts remain in the raw rows.

## Supplemental held, dial 0.5

Raw artifact: [trunk-load-held-before-d0-5.json](../../.tmp-test/trunk-load-held-before-d0-5.json). The raw file is local and ignored by git.

Per-entry cells are **p50 / p99 / maximum**, with milliseconds for timing columns. `tx` means the sum of outer transaction intervals.

| Entry             | Calls | call_ms           | engine_ms         | transaction_ms    | rows_changed       |
| ----------------- | ----- | ----------------- | ----------------- | ----------------- | ------------------ |
| open_attempt      | 264   | 1 / 3 / 64        | 0 / 1 / 28        | 0 / 1 / 27        | 5 / 5 / 7          |
| pool_create       | 1     | 19 / 19 / 19      | 19 / 19 / 19      | 16 / 16 / 16      | 81 / 81 / 81       |
| push_ok           | 6     | 16 / 23 / 23      | 13 / 19 / 19      | 13 / 19 / 19      | 1500 / 2581 / 2581 |
| shell_transaction | 6211  | 0 / 2 / 14        | 0 / 0 / 0         | 0 / 2 / 14        | 0 / 3 / 780        |
| stop              | 24    | 1 / 6 / 6         | 0 / 2 / 2         | 0 / 2 / 2         | 5 / 9 / 9          |
| sync              | 742   | 0 / 1 / 3         | 0 / 1 / 1         | 0 / 1 / 1         | 0 / 0 / 0          |
| tick              | 7     | 850 / 6493 / 6493 | 842 / 6481 / 6481 | 842 / 6481 / 6481 | 1226 / 3655 / 3655 |
| tool:list         | 193   | 1 / 2 / 5         | 0 / 2 / 2         | 0 / 2 / 2         | 5 / 5 / 5          |
| tool:read         | 1168  | 1 / 8 / 30        | 1 / 7 / 29        | 1 / 7 / 29        | 3 / 8 / 8          |
| tool:replace      | 540   | 79 / 1047 / 1241  | 79 / 1045 / 1240  | 79 / 1045 / 1240  | 9 / 16 / 16        |
| tool:search       | 8     | 2 / 4 / 4         | 1 / 3 / 3         | 1 / 3 / 3         | 5 / 5 / 5          |
| tool:submit       | 390   | 4 / 81 / 84       | 4 / 81 / 83       | 4 / 81 / 83       | 7 / 17 / 17        |
| tool:write        | 193   | 6 / 21 / 25       | 5 / 21 / 25       | 5 / 21 / 25       | 7 / 9 / 9          |

Ten largest collected calls, ordered by `call_ms`. `#` identifies the raw row. Context is measured on entry. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E     | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | --------- | ------------------- | ------------------- | ------------------------------------ |
| 8377 | tick         | 6493 / 6481 / 6481    | 1442 | 40 / 78            | 84 / 110  | 6311 / 1964         | 6213 / 1229         | 128 / 145 / 108 / 40                 |
| 8226 | tick         | 1582 / 1567 / 1567    | 3655 | 64 / 119           | 356 / 780 | 1393 / 721          | 596 / 270           | 64 / 85 / 183 / 183                  |
| 9732 | tick         | 1331 / 1324 / 1324    | 829  | 2 / 70             | 40 / 185  | 1263 / 331          | 909 / 132           | 168 / 184 / 62 / 62                  |
| 7507 | tool:replace | 1241 / 1240 / 1240    | 9    | 0 / 0              | 0 / 0     | 1225 / 169          | 0 / 0               | 64 / 85 / 259 / 169                  |
| 7523 | tool:replace | 1185 / 1184 / 1184    | 9    | 0 / 0              | 0 / 0     | 1063 / 174          | 0 / 0               | 64 / 85 / 259 / 169                  |
| 7525 | tool:replace | 1119 / 1118 / 1118    | 9    | 0 / 0              | 0 / 0     | 1111 / 174          | 0 / 0               | 64 / 85 / 259 / 169                  |
| 7510 | tool:replace | 1078 / 1078 / 1078    | 9    | 0 / 0              | 0 / 0     | 1042 / 174          | 0 / 0               | 64 / 85 / 259 / 169                  |
| 7497 | tool:replace | 1052 / 1048 / 1048    | 9    | 0 / 0              | 0 / 0     | 1025 / 169          | 0 / 0               | 64 / 85 / 263 / 169                  |
| 7504 | tool:replace | 1047 / 1045 / 1045    | 9    | 0 / 0              | 0 / 0     | 1029 / 169          | 0 / 0               | 64 / 85 / 260 / 169                  |
| 7505 | tool:replace | 1005 / 1004 / 1004    | 9    | 0 / 0              | 0 / 0     | 986 / 169           | 0 / 0               | 64 / 85 / 260 / 169                  |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Full attempt IDs and per-table write counts remain in the raw rows.

## Supplemental held, dial 1 (incomplete)

Raw artifact: [trunk-load-held-before-d1.json](../../.tmp-test/trunk-load-held-before-d1.json). The raw file is local and ignored by git.

**Incomplete workload.** All distributions below cover only the 14,033 collected calls. The last states were 64 accepted, 27 stopped, and 173 validated, with one pending outbox. Later slow or failed calls may be absent.

Per-entry cells are **p50 / p99 / maximum**, with milliseconds for timing columns. `tx` means the sum of outer transaction intervals.

| Entry             | Calls | call_ms         | engine_ms       | transaction_ms  | rows_changed    |
| ----------------- | ----- | --------------- | --------------- | --------------- | --------------- |
| open_attempt      | 264   | 1 / 3 / 7       | 0 / 1 / 3       | 0 / 1 / 2       | 5 / 5 / 7       |
| pool_create       | 1     | 18 / 18 / 18    | 18 / 18 / 18    | 15 / 15 / 15    | 81 / 81 / 81    |
| push_ok           | 1     | 1 / 1 / 1       | 0 / 0 / 0       | 0 / 0 / 0       | 4 / 4 / 4       |
| shell_transaction | 10565 | 0 / 2 / 135     | 0 / 0 / 0       | 0 / 2 / 135     | 0 / 3 / 997     |
| stop              | 27    | 1 / 3 / 3       | 0 / 3 / 3       | 0 / 3 / 3       | 5 / 5 / 5       |
| sync              | 662   | 0 / 1 / 3       | 0 / 1 / 1       | 0 / 1 / 1       | 0 / 0 / 0       |
| tick              | 2     | 0 / 3679 / 3679 | 0 / 3564 / 3564 | 0 / 3564 / 3564 | 0 / 4427 / 4427 |
| tool:list         | 138   | 1 / 2 / 2       | 0 / 2 / 2       | 0 / 2 / 2       | 5 / 5 / 5       |
| tool:read         | 1292  | 1 / 4 / 48      | 1 / 3 / 13      | 1 / 3 / 13      | 4 / 5 / 5       |
| tool:replace      | 565   | 44 / 329 / 408  | 43 / 327 / 408  | 43 / 327 / 408  | 8 / 16 / 16     |
| tool:search       | 15    | 2 / 3 / 3       | 2 / 3 / 3       | 2 / 3 / 3       | 5 / 5 / 5       |
| tool:submit       | 368   | 6 / 67 / 123    | 6 / 66 / 122    | 6 / 66 / 122    | 7 / 17 / 17     |
| tool:write        | 133   | 6 / 22 / 36     | 5 / 21 / 36     | 5 / 21 / 36     | 7 / 9 / 9       |

Ten largest collected calls, ordered by `call_ms`. `#` identifies the raw row. Context is measured on entry. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written.

| #     | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E     | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ----- | ------------ | --------------------- | ---- | ------------------ | --------- | ------------------- | ------------------- | ------------------------------------ |
| 4690  | tick         | 3679 / 3564 / 3564    | 4427 | 64 / 200           | 581 / 997 | 2937 / 923          | 1727 / 310          | 0 / 25 / 264 / 252                   |
| 13343 | tool:replace | 408 / 408 / 408       | 8    | 0 / 0              | 0 / 0     | 399 / 139           | 0 / 0               | 64 / 80 / 263 / 170                  |
| 13522 | tool:replace | 390 / 389 / 389       | 8    | 0 / 0              | 0 / 0     | 386 / 159           | 0 / 0               | 64 / 80 / 249 / 170                  |
| 13553 | tool:replace | 364 / 363 / 363       | 8    | 0 / 0              | 0 / 0     | 353 / 169           | 0 / 0               | 64 / 80 / 246 / 170                  |
| 13590 | tool:replace | 337 / 336 / 336       | 8    | 0 / 0              | 0 / 0     | 330 / 174           | 0 / 0               | 64 / 80 / 245 / 170                  |
| 13583 | tool:replace | 332 / 331 / 331       | 8    | 0 / 0              | 0 / 0     | 323 / 174           | 0 / 0               | 64 / 80 / 246 / 170                  |
| 13569 | tool:replace | 329 / 327 / 327       | 8    | 0 / 0              | 0 / 0     | 324 / 174           | 0 / 0               | 64 / 80 / 246 / 170                  |
| 13591 | tool:replace | 325 / 325 / 325       | 8    | 0 / 0              | 0 / 0     | 319 / 174           | 0 / 0               | 64 / 80 / 245 / 170                  |
| 13571 | tool:replace | 310 / 309 / 309       | 8    | 0 / 0              | 0 / 0     | 304 / 169           | 0 / 0               | 64 / 80 / 246 / 170                  |
| 13518 | tool:replace | 301 / 300 / 300       | 8    | 0 / 0              | 0 / 0     | 294 / 159           | 0 / 0               | 64 / 80 / 250 / 170                  |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Full attempt IDs and per-table write counts remain in the raw rows.

## Existing 260-file tick microbenchmark

Raw artifact: [cause-seq-before.json](../../.tmp-test/cause-seq-before.json). The fixture has 260 files, 137,817 bytes, and 235 prior landings. Each batch size has seven measured samples after warmup. Preparation, reopening, assertions, and simulated push completion are outside the timed tick.

The valid `exact` mode preserves causal attribution. `first` is only a harness counterfactual that attributes everything to the first batch member. It is not a proposed engine behavior. This Node SQLite microbenchmark is separate from workerd and is not the 256-agent workload.

| Batch | Mode  | Tick p50 ms | Tick p95 ms | Tick max ms | CPU p50 ms | Analysis mean ms | Analysis share % | Analysis calls mean |
| ----- | ----- | ----------- | ----------- | ----------- | ---------- | ---------------- | ---------------- | ------------------- |
| 1     | first | 48.214      | 50.663      | 55.177      | 64.326     | 39.873           | 80.618           | 9                   |
| 1     | exact | 48.904      | 52.141      | 53.393      | 66.152     | 39.486           | 78.941           | 9                   |
| 8     | first | 126.353     | 130.444     | 200.322     | 160.254    | 112.385          | 82.7             | 23                  |
| 8     | exact | 132.42      | 138.379     | 141.077     | 178.951    | 105.387          | 80.366           | 23                  |
| 16    | first | 216.875     | 227.699     | 228.396     | 269.196    | 180.92           | 83.918           | 39                  |
| 16    | exact | 229.51      | 244.148     | 299.81      | 329.339    | 193.842          | 81.589           | 39                  |

The exact 16-landing baseline recorded a 229.510 ms median and 299.810 ms maximum. Whole-pool analysis averaged 193.842 ms, or 81.589% of the tick. Inclusive component timers overlap, so their shares must not be added.

## Normal after measurements — complete

Both normal after tests completed with exit 0. All 264 attempts reached a terminal state at each dial, no outbox remained pending, and no recorded call exceeded 1,000 ms. The largest calls were **63 ms at dial 0.5** and **76 ms at dial 1**. Both runs reached a peak of only three in-flight attempts, so the held workload remains necessary to assess congestion.

The after reports identify bundle SHA-256 `fe52f50d4f46815a0a4ed89e1f45fffcaf996ac626dfb5b2aa0e94bbbacc9e4e`, with request ID `trunk-load-measurement`. Their Git build field still names `46fdc0c493fd50217fdb65a929c09f4ffead338b` because the local source edits were not committed. The bundle hash distinguishes these changed bytes from the baseline bundle.

The 256-agent configuration, seed, collision settings, launch rate, think interval, and rescale interval match the normal baseline. The request ID differs from that early baseline, and timing changed interleavings and terminal counts. The tables report observed before/after runs; they do not establish an exact percentage speedup for an identical schedule.

The after observer also records `tick_calls` per entry, which the original baseline reports lack. Existing timing definitions are unchanged in the raw metadata. Each after run passed a stable comparison between EngineSession counters and recorded entries. These checks establish complete recording of EngineSession entries for the completed runs; they do not measure external I/O or production replication latency.

Command form, after building the changed local engine:

```sh
TRUNK_LOAD=1 TRUNK_LOAD_LABEL=after TRUNK_LOAD_ENFORCE=1 TMPDIR="$PWD/.tmp-test" \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts
```

The saved reports independently show zero over-bound calls. `TRUNK_LOAD_ENFORCE=1` makes future runs assert that bound; command-specific enforcement is not separately recorded in JSON.

| Run                    | Elapsed ms | Calls | Peak in-flight | Terminal states          | Pending outbox | Failed samples | Over bound |
| ---------------------- | ---------- | ----- | -------------- | ------------------------ | -------------- | -------------- | ---------- |
| Normal after, dial 0.5 | 129894     | 5669  | 3              | landed: 257, stopped: 7  | 0              | 0              | 0          |
| Normal after, dial 1   | 129553     | 5290  | 3              | landed: 251, stopped: 13 | 0              | 0              | 0          |

EngineSession coverage, shown as **session counter / recorded calls**:

| Run                    | open_attempt | push_ok   | stop    | sync      | tick      | tool        | Outside session                         |
| ---------------------- | ------------ | --------- | ------- | --------- | --------- | ----------- | --------------------------------------- |
| Normal after, dial 0.5 | 264 / 264    | 142 / 142 | 7 / 7   | 188 / 188 | 145 / 145 | 1931 / 1931 | pool_create: 1, shell_transaction: 2991 |
| Normal after, dial 1   | 264 / 264    | 145 / 145 | 13 / 13 | 183 / 183 | 148 / 148 | 1727 / 1727 | pool_create: 1, shell_transaction: 2809 |

The observed normal-call maxima, without assuming identical scheduling:

| Dial | Before largest call ms | After largest call ms | Before largest tick ms | After largest tick ms | Before largest tick row delta | After largest tick row delta |
| ---- | ---------------------- | --------------------- | ---------------------- | --------------------- | ----------------------------- | ---------------------------- |
| 0.5  | 469                    | 63                    | 469                    | 28                    | 256                           | 132                          |
| 1    | 361                    | 76                    | 122                    | 52                    | 233                           | 158                          |

### Normal after tick distributions

Cells are **p50 / p99 / maximum**. All `transaction_max_ms` distributions equal `transaction_ms` in both after reports.

| Run                    | Tick calls | Call ms      | Transaction ms | Batch size | Post-batch classified | Judgments written | Events written |
| ---------------------- | ---------- | ------------ | -------------- | ---------- | --------------------- | ----------------- | -------------- |
| Normal after, dial 0.5 | 145        | 11 / 26 / 28 | 11 / 26 / 27   | 2 / 3 / 3  | 0 / 1 / 1             | 0 / 2 / 2         | 6 / 8 / 10     |
| Normal after, dial 1   | 148        | 10 / 28 / 52 | 10 / 28 / 52   | 2 / 3 / 3  | 0 / 1 / 1             | 0 / 2 / 12        | 6 / 9 / 22     |

| Run                    | Rows changed   | Analysis calls | Analysis ms | All classify calls | All classify ms |
| ---------------------- | -------------- | -------------- | ----------- | ------------------ | --------------- |
| Normal after, dial 0.5 | 55 / 91 / 132  | 2 / 6 / 6      | 6 / 17 / 17 | 2 / 4 / 4          | 1 / 7 / 8       |
| Normal after, dial 1   | 48 / 120 / 158 | 2 / 6 / 6      | 5 / 19 / 46 | 2 / 3 / 3          | 2 / 10 / 44     |

Batch-size distributions, written as `batch size: number of ticks`:

- Normal after, dial 0.5: `0: 4`, `1: 31`, `2: 104`, `3: 6`.
- Normal after, dial 1: `0: 4`, `1: 42`, `2: 97`, `3: 5`.

### Normal after, dial 0.5

Raw artifact: [trunk-load-after-d0-5.json](../../.tmp-test/trunk-load-after-d0-5.json). Cells are **p50 / p99 / maximum**; time is milliseconds.

| Entry             | Calls | call_ms      | engine_ms    | transaction_ms | rows_changed   |
| ----------------- | ----- | ------------ | ------------ | -------------- | -------------- |
| open_attempt      | 264   | 1 / 2 / 3    | 0 / 1 / 2    | 0 / 1 / 2      | 5 / 5 / 7      |
| pool_create       | 1     | 21 / 21 / 21 | 21 / 21 / 21 | 17 / 17 / 17   | 81 / 81 / 81   |
| push_ok           | 142   | 2 / 4 / 4    | 1 / 2 / 3    | 1 / 2 / 3      | 83 / 145 / 215 |
| shell_transaction | 2991  | 0 / 2 / 37   | 0 / 0 / 0    | 0 / 2 / 37     | 0 / 8 / 11     |
| stop              | 7     | 0 / 1 / 1    | 0 / 1 / 1    | 0 / 1 / 1      | 3 / 3 / 3      |
| sync              | 188   | 0 / 3 / 3    | 0 / 1 / 1    | 0 / 1 / 1      | 0 / 0 / 0      |
| tick              | 145   | 11 / 26 / 28 | 11 / 26 / 27 | 11 / 26 / 27   | 55 / 91 / 132  |
| tool:list         | 193   | 1 / 3 / 3    | 1 / 3 / 3    | 1 / 3 / 3      | 5 / 5 / 5      |
| tool:read         | 1033  | 3 / 8 / 56   | 2 / 8 / 55   | 2 / 8 / 26     | 3 / 5 / 5      |
| tool:replace      | 232   | 10 / 23 / 25 | 10 / 23 / 25 | 10 / 23 / 25   | 6 / 14 / 14    |
| tool:search       | 8     | 5 / 9 / 9    | 5 / 8 / 8    | 5 / 8 / 8      | 5 / 5 / 5      |
| tool:submit       | 272   | 6 / 28 / 63  | 5 / 26 / 61  | 5 / 26 / 61    | 7 / 17 / 17    |
| tool:write        | 193   | 9 / 30 / 43  | 9 / 29 / 41  | 9 / 29 / 41    | 7 / 9 / 9      |

Ten largest calls. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written. Context is recorded on entry.

| #    | Entry             | Call / engine / tx ms | Rows | Batch / post-batch | J / E | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ----------------- | --------------------- | ---- | ------------------ | ----- | ------------------- | ------------------- | ------------------------------------ |
| 5183 | tool:submit       | 63 / 61 / 61          | 7    | 0 / 0              | 0 / 2 | 60 / 2              | 0 / 0               | 236 / 200 / 2 / 0                    |
| 5582 | tool:read         | 56 / 55 / 6           | 5    | 0 / 0              | 0 / 1 | 6 / 1               | 0 / 0               | 252 / 215 / 2 / 0                    |
| 5179 | tool:write        | 43 / 41 / 41          | 7    | 0 / 0              | 0 / 0 | 41 / 4              | 0 / 0               | 236 / 200 / 2 / 0                    |
| 1910 | shell_transaction | 37 / 0 / 37           | 0    | 0 / 0              | 0 / 0 | 0 / 0               | 0 / 0               | — / — / — / —                        |
| 5181 | tool:write        | 30 / 29 / 29          | 7    | 0 / 0              | 0 / 0 | 26 / 3              | 0 / 0               | 236 / 200 / 2 / 0                    |
| 5184 | tool:submit       | 28 / 26 / 26          | 7    | 0 / 0              | 0 / 2 | 25 / 2              | 0 / 0               | 236 / 200 / 2 / 1                    |
| 5601 | tool:submit       | 28 / 27 / 27          | 12   | 0 / 0              | 0 / 3 | 24 / 3              | 0 / 0               | 253 / 215 / 1 / 0                    |
| 5604 | tick              | 28 / 27 / 27          | 31   | 1 / 0              | 0 / 4 | 11 / 1              | 0 / 1               | 253 / 215 / 1 / 1                    |
| 18   | tool:read         | 26 / 26 / 26          | 3    | 0 / 0              | 0 / 0 | 25 / 1              | 0 / 0               | 0 / 25 / 2 / 0                       |
| 4190 | tool:submit       | 26 / 26 / 26          | 12   | 0 / 0              | 0 / 3 | 24 / 3              | 0 / 0               | 189 / 167 / 1 / 0                    |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Raw rows retain full attempt IDs, per-table writes, and tick invocation counts.

### Normal after, dial 1

Raw artifact: [trunk-load-after-d1.json](../../.tmp-test/trunk-load-after-d1.json). Cells are **p50 / p99 / maximum**; time is milliseconds.

| Entry             | Calls | call_ms      | engine_ms    | transaction_ms | rows_changed   |
| ----------------- | ----- | ------------ | ------------ | -------------- | -------------- |
| open_attempt      | 264   | 1 / 3 / 4    | 0 / 1 / 2    | 0 / 1 / 2      | 5 / 5 / 7      |
| pool_create       | 1     | 10 / 10 / 10 | 10 / 10 / 10 | 7 / 7 / 7      | 81 / 81 / 81   |
| push_ok           | 145   | 1 / 3 / 5    | 1 / 3 / 4    | 1 / 3 / 4      | 71 / 165 / 245 |
| shell_transaction | 2809  | 0 / 2 / 3    | 0 / 0 / 0    | 0 / 2 / 3      | 0 / 8 / 22     |
| stop              | 13    | 1 / 1 / 1    | 0 / 1 / 1    | 0 / 1 / 1      | 3 / 3 / 3      |
| sync              | 183   | 1 / 2 / 2    | 0 / 1 / 1    | 0 / 1 / 1      | 0 / 0 / 0      |
| tick              | 148   | 10 / 28 / 52 | 10 / 28 / 52 | 10 / 28 / 52   | 48 / 120 / 158 |
| tool:list         | 138   | 1 / 2 / 3    | 1 / 2 / 3    | 1 / 2 / 3      | 5 / 5 / 5      |
| tool:read         | 856   | 2 / 6 / 12   | 2 / 5 / 11   | 2 / 5 / 11     | 3 / 5 / 5      |
| tool:replace      | 310   | 8 / 19 / 26  | 8 / 18 / 26  | 8 / 18 / 26    | 6 / 14 / 14    |
| tool:search       | 15    | 4 / 9 / 9    | 3 / 8 / 8    | 3 / 8 / 8      | 5 / 5 / 5      |
| tool:submit       | 275   | 5 / 12 / 17  | 5 / 12 / 15  | 5 / 12 / 15    | 7 / 17 / 17    |
| tool:write        | 133   | 8 / 35 / 76  | 8 / 35 / 76  | 8 / 35 / 76    | 7 / 9 / 9      |

Ten largest calls. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written. Context is recorded on entry.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | ----- | ------------------- | ------------------- | ------------------------------------ |
| 4870 | tool:write   | 76 / 76 / 76          | 9    | 0 / 0              | 0 / 1 | 73 / 4              | 0 / 0               | 232 / 147 / 2 / 0                    |
| 2255 | tick         | 52 / 52 / 52          | 42   | 1 / 1              | 1 / 8 | 46 / 4              | 44 / 3              | 111 / 81 / 2 / 2                     |
| 8    | tool:write   | 35 / 35 / 35          | 9    | 0 / 0              | 0 / 1 | 27 / 4              | 0 / 0               | 0 / 25 / 2 / 0                       |
| 3240 | tick         | 28 / 28 / 28          | 37   | 2 / 0              | 0 / 5 | 19 / 4              | 10 / 2              | 149 / 106 / 2 / 2                    |
| 3686 | tick         | 27 / 27 / 27          | 42   | 2 / 0              | 0 / 5 | 17 / 4              | 9 / 2               | 173 / 119 / 2 / 2                    |
| 5216 | tool:replace | 26 / 26 / 26          | 9    | 0 / 0              | 0 / 0 | 22 / 4              | 0 / 0               | 246 / 156 / 2 / 0                    |
| 3886 | tick         | 24 / 23 / 23          | 47   | 2 / 0              | 0 / 6 | 15 / 3              | 6 / 2               | 179 / 121 / 2 / 2                    |
| 3804 | tick         | 23 / 22 / 22          | 47   | 2 / 0              | 0 / 6 | 14 / 3              | 3 / 2               | 175 / 119 / 2 / 2                    |
| 3660 | tick         | 22 / 22 / 22          | 55   | 2 / 0              | 1 / 6 | 6 / 2               | 1 / 2               | 171 / 117 / 2 / 2                    |
| 4855 | tick         | 22 / 21 / 21          | 69   | 3 / 0              | 1 / 8 | 11 / 4              | 4 / 3               | 229 / 145 / 3 / 3                    |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Raw rows retain full attempt IDs, per-table writes, and tick invocation counts.

## Supplemental held after measurements — complete

Both supplemental held after tests completed with exit 0 and the 1,000 ms bound enforced. Each reached 264 in-flight attempts and released all 264 through the Swarm route. The largest calls were **802 ms at dial 0.5** and **797 ms at dial 1**. No synchronous sample failed, no measured call exceeded the bound, and no outbox remained pending at completion.

These runs used bundle SHA-256 `fe52f50d4f46815a0a4ed89e1f45fffcaf996ac626dfb5b2aa0e94bbbacc9e4e`, request ID `trunk-load-measurement`, seed 7, and the same 22 held patterns and timing configuration as the held baseline. The Git build field remains the unchanged HEAD `46fdc0c493fd50217fdb65a929c09f4ffead338b`; the bundle digest identifies the modified source build.

Held before and after use the same request ID, unlike the early normal baseline. They still follow wall-clock scheduling, so the operation interleavings, batch composition, call totals, and terminal outcomes differ. Each table reports the work actually performed. Fewer written judgments or events across different runs is not evidence of omitted required writes; semantic preservation is checked by the focused regressions and specification cases.

Command:

```sh
TRUNK_LOAD=1 TRUNK_LOAD_HOLD=1 TRUNK_LOAD_LABEL=held-after TRUNK_LOAD_ENFORCE=1 TMPDIR="$PWD/.tmp-test" \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts
```

| Run                               | Elapsed ms | Calls | Peak in-flight | Terminal states           | Pending outbox | Failed samples | Over bound |
| --------------------------------- | ---------- | ----- | -------------- | ------------------------- | -------------- | -------------- | ---------- |
| Supplemental held after, dial 0.5 | 146695     | 8931  | 264            | landed: 206, stopped: 58  | 0              | 0              | 0          |
| Supplemental held after, dial 1   | 147232     | 9530  | 264            | landed: 158, stopped: 106 | 0              | 0              | 0          |

Dial 0.5 released 264 working attempts between 133,750 and 135,148 ms. Dial 1 released 264 working attempts between 133,828 and 135,245 ms. Both final EngineSession conservation checks matched exactly.

EngineSession coverage, shown as **session counter / recorded calls**:

| Run                               | open_attempt | push_ok | stop    | sync      | tick    | tool        | Outside session                         |
| --------------------------------- | ------------ | ------- | ------- | --------- | ------- | ----------- | --------------------------------------- |
| Supplemental held after, dial 0.5 | 264 / 264    | 6 / 6   | 24 / 24 | 568 / 568 | 5 / 5   | 2487 / 2487 | pool_create: 1, shell_transaction: 5576 |
| Supplemental held after, dial 1   | 264 / 264    | 9 / 9   | 42 / 42 | 564 / 564 | 11 / 11 | 2565 / 2565 | pool_create: 1, shell_transaction: 6074 |

### Before/after maximum observed call time

| Workload          | Dial | Before maximum ms | After maximum ms | Before coverage                   | After coverage         |
| ----------------- | ---- | ----------------- | ---------------- | --------------------------------- | ---------------------- |
| Normal            | 0.5  | 469               | 63               | Complete                          | Complete; bound passed |
| Normal            | 1    | 361               | 76               | Complete                          | Complete; bound passed |
| Supplemental held | 0.5  | 6493              | 802              | Complete                          | Complete; bound passed |
| Supplemental held | 1    | 3679              | 797              | Incomplete; collected prefix only | Complete; bound passed |

The held dial-1 baseline maximum of 3,679 ms is a lower bound on that unfinished run's full maximum. Its collection ended with `fetch failed` and `other side closed`. The completed after run does not establish the cause of that earlier connection failure or prove that a live platform reset cannot recur.

### Supplemental held after tick distributions

Each cell is **p50 / p99 / maximum**. Every entry's `transaction_max_ms` distribution equals `transaction_ms` in both held-after reports.

| Run                               | Tick calls | Call ms         | Transaction ms  | Batch size   | Post-batch classified | Judgments written | Events written  |
| --------------------------------- | ---------- | --------------- | --------------- | ------------ | --------------------- | ----------------- | --------------- |
| Supplemental held after, dial 0.5 | 5          | 443 / 802 / 802 | 428 / 785 / 785 | 64 / 64 / 64 | 110 / 200 / 200       | 79 / 408 / 408    | 231 / 766 / 766 |
| Supplemental held after, dial 1   | 11         | 106 / 797 / 797 | 105 / 780 / 780 | 1 / 64 / 64  | 66 / 200 / 200        | 6 / 574 / 574     | 35 / 995 / 995  |

| Run                               | Rows changed       | Analysis calls  | Analysis ms     | All classify calls | All classify ms |
| --------------------------------- | ------------------ | --------------- | --------------- | ------------------ | --------------- |
| Supplemental held after, dial 0.5 | 1605 / 3496 / 3496 | 205 / 336 / 336 | 300 / 612 / 612 | 212 / 284 / 284    | 204 / 496 / 496 |
| Supplemental held after, dial 1   | 85 / 4363 / 4363   | 37 / 364 / 364  | 95 / 618 / 618  | 94 / 316 / 316     | 27 / 343 / 343  |

Batch-size distributions, written as `batch size: number of ticks`:

- Supplemental held after, dial 0.5: `2: 1`, `12: 1`, `64: 3`.
- Supplemental held after, dial 1: `0: 3`, `1: 4`, `2: 1`, `24: 1`, `64: 2`.

### Supplemental held after, dial 0.5

Raw artifact: [trunk-load-held-after-d0-5.json](../../.tmp-test/trunk-load-held-after-d0-5.json). Cells are **p50 / p99 / maximum**; time is milliseconds.

| Entry             | Calls | call_ms         | engine_ms       | transaction_ms  | rows_changed       |
| ----------------- | ----- | --------------- | --------------- | --------------- | ------------------ |
| open_attempt      | 264   | 1 / 3 / 4       | 0 / 1 / 2       | 0 / 1 / 2       | 5 / 5 / 7          |
| pool_create       | 1     | 22 / 22 / 22    | 22 / 22 / 22    | 16 / 16 / 16    | 81 / 81 / 81       |
| push_ok           | 6     | 5 / 23 / 23     | 4 / 19 / 19     | 4 / 19 / 19     | 466 / 2550 / 2550  |
| shell_transaction | 5576  | 0 / 2 / 5       | 0 / 0 / 0       | 0 / 2 / 5       | 0 / 3 / 766        |
| stop              | 24    | 1 / 2 / 2       | 0 / 1 / 1       | 0 / 1 / 1       | 3 / 5 / 5          |
| sync              | 568   | 0 / 2 / 3       | 0 / 1 / 1       | 0 / 1 / 1       | 0 / 0 / 0          |
| tick              | 5     | 443 / 802 / 802 | 428 / 785 / 785 | 428 / 785 / 785 | 1605 / 3496 / 3496 |
| tool:list         | 194   | 1 / 2 / 2       | 0 / 1 / 1       | 0 / 1 / 1       | 5 / 5 / 5          |
| tool:read         | 1171  | 1 / 4 / 50      | 1 / 4 / 50      | 1 / 4 / 50      | 3 / 5 / 5          |
| tool:replace      | 532   | 7 / 17 / 29     | 7 / 16 / 29     | 7 / 16 / 29     | 7 / 14 / 14        |
| tool:search       | 8     | 3 / 5 / 5       | 2 / 4 / 4       | 2 / 4 / 4       | 5 / 5 / 5          |
| tool:submit       | 389   | 2 / 9 / 22      | 2 / 8 / 21      | 2 / 8 / 21      | 7 / 17 / 17        |
| tool:write        | 193   | 4 / 9 / 13      | 3 / 9 / 13      | 3 / 9 / 13      | 7 / 9 / 9          |

Ten largest calls. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written. Context is recorded on entry.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E     | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | --------- | ------------------- | ------------------- | ------------------------------------ |
| 7796 | tick         | 802 / 785 / 785       | 3496 | 64 / 119           | 350 / 766 | 612 / 307           | 364 / 270           | 64 / 85 / 183 / 183                  |
| 8890 | tick         | 577 / 574 / 574       | 603  | 2 / 110            | 42 / 231  | 540 / 205           | 496 / 212           | 128 / 145 / 102 / 102                |
| 5036 | tick         | 443 / 428 / 428       | 3177 | 64 / 200           | 408 / 528 | 292 / 336           | 204 / 284           | 0 / 25 / 264 / 256                   |
| 8896 | tick         | 407 / 400 / 400       | 1605 | 64 / 46            | 79 / 151  | 300 / 109           | 77 / 113            | 130 / 145 / 79 / 79                  |
| 8916 | tick         | 66 / 65 / 65          | 286  | 12 / 34            | 10 / 26   | 45 / 12             | 1 / 46              | 194 / 206 / 12 / 12                  |
| 20   | tool:read    | 50 / 50 / 50          | 3    | 0 / 0              | 0 / 0     | 49 / 1              | 0 / 0               | 0 / 25 / 2 / 0                       |
| 8604 | tool:replace | 29 / 29 / 29          | 9    | 0 / 0              | 0 / 0     | 27 / 3              | 0 / 0               | 128 / 145 / 169 / 35                 |
| 7108 | tool:replace | 24 / 23 / 23          | 7    | 0 / 0              | 0 / 0     | 17 / 3              | 0 / 0               | 64 / 85 / 264 / 166                  |
| 8886 | push_ok      | 23 / 19 / 19          | 2550 | 0 / 0              | 0 / 194   | 0 / 0               | 0 / 0               | 128 / 145 / 166 / 102                |
| 8912 | push_ok      | 23 / 18 / 18          | 2493 | 0 / 0              | 0 / 194   | 0 / 0               | 0 / 0               | 194 / 206 / 76 / 12                  |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Raw rows retain full attempt IDs, per-table writes, and tick invocation counts.

### Supplemental held after, dial 1

Raw artifact: [trunk-load-held-after-d1.json](../../.tmp-test/trunk-load-held-after-d1.json). Cells are **p50 / p99 / maximum**; time is milliseconds.

| Entry             | Calls | call_ms         | engine_ms       | transaction_ms  | rows_changed     |
| ----------------- | ----- | --------------- | --------------- | --------------- | ---------------- |
| open_attempt      | 264   | 1 / 2 / 6       | 0 / 1 / 1       | 0 / 1 / 1       | 5 / 5 / 7        |
| pool_create       | 1     | 18 / 18 / 18    | 18 / 18 / 18    | 15 / 15 / 15    | 81 / 81 / 81     |
| push_ok           | 9     | 1 / 24 / 24     | 1 / 20 / 20     | 1 / 20 / 20     | 36 / 2404 / 2404 |
| shell_transaction | 6074  | 0 / 1 / 4       | 0 / 0 / 0       | 0 / 1 / 4       | 0 / 3 / 995      |
| stop              | 42    | 1 / 1 / 1       | 0 / 1 / 1       | 0 / 1 / 1       | 3 / 5 / 5        |
| sync              | 564   | 0 / 1 / 5       | 0 / 1 / 1       | 0 / 1 / 1       | 0 / 0 / 0        |
| tick              | 11    | 106 / 797 / 797 | 105 / 780 / 780 | 105 / 780 / 780 | 85 / 4363 / 4363 |
| tool:list         | 138   | 1 / 2 / 2       | 0 / 1 / 1       | 0 / 1 / 1       | 5 / 5 / 5        |
| tool:read         | 1286  | 1 / 4 / 9       | 1 / 3 / 9       | 1 / 3 / 9       | 3 / 5 / 5        |
| tool:replace      | 571   | 6 / 14 / 31     | 6 / 13 / 30     | 6 / 13 / 30     | 6 / 14 / 14      |
| tool:search       | 16    | 3 / 5 / 5       | 2 / 5 / 5       | 2 / 5 / 5       | 5 / 5 / 5        |
| tool:submit       | 421   | 3 / 8 / 10      | 2 / 7 / 9       | 2 / 7 / 9       | 7 / 17 / 17      |
| tool:write        | 133   | 4 / 9 / 35      | 3 / 9 / 34      | 3 / 9 / 34      | 7 / 9 / 9        |

Ten largest calls. `analysis` and `classify` are `ms / calls`; `J / E` means judgments / events written. Context is recorded on entry.

| #    | Entry        | Call / engine / tx ms | Rows | Batch / post-batch | J / E     | Analysis ms / calls | Classify ms / calls | Head / files / in-flight / validated |
| ---- | ------------ | --------------------- | ---- | ------------------ | --------- | ------------------- | ------------------- | ------------------------------------ |
| 8815 | tick         | 797 / 780 / 780       | 3248 | 64 / 110           | 265 / 737 | 618 / 288           | 343 / 254           | 64 / 81 / 174 / 174                  |
| 4690 | tick         | 491 / 470 / 470       | 4363 | 64 / 200           | 574 / 995 | 301 / 364           | 211 / 316           | 0 / 25 / 264 / 252                   |
| 9317 | tick         | 286 / 283 / 283       | 432  | 2 / 93             | 40 / 160  | 261 / 105           | 213 / 145           | 128 / 139 / 52 / 52                  |
| 9450 | tick         | 235 / 233 / 233       | 349  | 1 / 90             | 28 / 129  | 216 / 87            | 185 / 133           | 131 / 139 / 43 / 43                  |
| 9462 | tick         | 149 / 145 / 145       | 602  | 24 / 66            | 29 / 74   | 98 / 39             | 27 / 94             | 132 / 139 / 28 / 28                  |
| 9342 | tick         | 106 / 105 / 105       | 85   | 1 / 92             | 6 / 35    | 95 / 37             | 93 / 180            | 130 / 139 / 45 / 30                  |
| 10   | tool:write   | 35 / 34 / 34          | 9    | 0 / 0              | 0 / 1     | 28 / 4              | 0 / 0               | 0 / 25 / 2 / 0                       |
| 7431 | tool:replace | 31 / 30 / 30          | 6    | 0 / 0              | 0 / 0     | 28 / 3              | 0 / 0               | 64 / 81 / 263 / 151                  |
| 9494 | tick         | 29 / 28 / 28          | 75   | 1 / 65             | 5 / 19    | 23 / 7              | 13 / 68             | 156 / 158 / 4 / 3                    |
| 8811 | push_ok      | 24 / 20 / 20          | 2404 | 0 / 0              | 0 / 194   | 0 / 0               | 0 / 0               | 64 / 81 / 238 / 174                  |

Every top-ten call has one measured outer transaction; its transaction maximum equals the transaction value shown. Raw rows retain full attempt IDs, per-table writes, and tick invocation counts.

## 260-file microbenchmark after measurements — complete

`TMPDIR="$PWD/.tmp-test" node scripts/scale/cause-seq.ts` completed with exit 0. Raw artifact: [cause-seq-after.json](../../.tmp-test/cause-seq-after.json). The fixture and seven measured samples per batch/mode match the baseline: 260 files, 137,817 bytes, and 235 prior landings.

The exact 16-landing median changed from 229.510 to 197.347 ms, and its maximum changed from 299.810 to 237.925 ms. Analysis averaged 159.011 ms across 34 calls, or 76.417% of the after tick.

Not every distribution improved. The exact eight-landing median changed from 132.420 to 117.118 ms, while its maximum increased from 141.077 to 182.975 ms. Maxima include local scheduling and garbage collection. This seven-sample microbenchmark does not establish universal latency improvement.

| Batch | Mode  | Tick p50 ms | Tick p95 ms | Tick max ms | CPU p50 ms | Analysis mean ms | Analysis share % | Analysis calls mean |
| ----- | ----- | ----------- | ----------- | ----------- | ---------- | ---------------- | ---------------- | ------------------- |
| 1     | first | 31.651      | 36.239      | 41.048      | 43.623     | 18.566           | 54.731           | 4                   |
| 1     | exact | 31.851      | 32.633      | 41.346      | 40.082     | 17.759           | 53.72            | 4                   |
| 8     | first | 78.075      | 80.373      | 80.699      | 115.656    | 50.189           | 64.932           | 11                  |
| 8     | exact | 117.118     | 125.718     | 182.975     | 156.435    | 91.815           | 73.846           | 18                  |
| 16    | first | 120.159     | 148.672     | 153.301     | 154.471    | 89.909           | 69.681           | 19                  |
| 16    | exact | 197.347     | 235.812     | 237.925     | 243.141    | 159.011          | 76.417           | 34                  |

Direct comparison of the valid exact-attribution mode:

| Batch | Before p50 ms | After p50 ms | Before maximum ms | After maximum ms | Before analysis calls | After analysis calls |
| ----- | ------------- | ------------ | ----------------- | ---------------- | --------------------- | -------------------- |
| 1     | 48.904        | 31.851       | 53.393            | 41.346           | 9                     | 4                    |
| 8     | 132.42        | 117.118      | 141.077           | 182.975          | 23                    | 18                   |
| 16    | 229.51        | 197.347      | 299.81            | 237.925          | 39                    | 34                   |

As in the baseline, `first` remains a harness-only counterfactual rather than valid production attribution. Inclusive analysis and cause timings overlap. These Node measurements remain separate from the completed workerd measurements.

## Final verification and delivery

All required commands exited **0**. No production code changed after these runs.

The execution environment used these values throughout the final checks:

```sh
export TMPDIR="$PWD/.tmp-test"
export PATH="$PWD/.tmp-test/git-bin:$PATH"
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_CF_FETCH_ENABLED=false
```

I used the brief's prescribed sandbox fallback: `npm test -- test/git`
ran once and passed 65 tests, exit 0. Subsequent commands used the existing `.tmp-test/git-bin/git` wrapper,
which adds `--template=` to `git init` and delegates all other commands to `/usr/bin/git`.
This wrapper does not bypass the main repository's read-only Git metadata.

| Command                                                                                                               | Observed result                                                                                                                                                      | Artifact                                                           |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run check`                                                                                                       | Exit 0; formatting, six TypeScript programs, 191 test files, 2,401 tests passed and one existing expected failure; offline build, licences and secrets checks passed | [final-check.log](../../.tmp-test/final-check.log)                 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm run test:workerd`                                  | Exit 0; 46 files and 234 tests passed; two opt-in measurement tests skipped here and passed separately below                                                         | [final-workerd.log](../../.tmp-test/final-workerd.log)             |
| `CASES=required npm run test:cases`                                                                                   | Exit 0; 10 files and 105 tests passed                                                                                                                                | [final-cases.log](../../.tmp-test/final-cases.log)                 |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npx vitest run --project integration`                  | Exit 0; 11 files and 716 tests passed                                                                                                                                | [final-integration.log](../../.tmp-test/final-integration.log)     |
| `npm run typecheck`                                                                                                   | Exit 0 after the production changes                                                                                                                                  | [optimized-typecheck.log](../../.tmp-test/optimized-typecheck.log) |
| `npm test -- src/core/trunk src/core/replay src/core/classify test/cases scripts/scale/trunk-load-instrument.test.ts` | Exit 0; 31 files, 250 tests passed and one existing expected failure                                                                                                 | [optimized-focused.log](../../.tmp-test/optimized-focused.log)     |
| `npm test -- test/git`                                                                                                | Exit 0; 7 files and 65 tests passed                                                                                                                                  | [git-tests.log](../../.tmp-test/git-tests.log)                     |

The final measurement commands were exactly these forms, with the environment above:

```sh
TRUNK_LOAD=1 TRUNK_LOAD_LABEL=after TRUNK_LOAD_ENFORCE=1 \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts

TRUNK_LOAD=1 TRUNK_LOAD_HOLD=1 TRUNK_LOAD_LABEL=held-after TRUNK_LOAD_ENFORCE=1 \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts

node scripts/scale/cause-seq.ts
```

Both workerd commands passed two tests and exited 0. The microbenchmark exited 0.
Logs: [normal after](../../.tmp-test/trunk-load-after.log),
[held after](../../.tmp-test/trunk-load-held-after.log), and
[microbenchmark](../../.tmp-test/cause-seq-after.log).
Normal before exited 0. Supplemental held before exited 1 because dial 1 lost its local connection;
its incomplete observations remain explicitly marked above.

The independent record audit, repeated directly by the root agent with assertions, exited 0:
**29,420 records**, including **11,966 engine-session calls**, 17,450 shell transactions and four pool creations.
Every recorded call and transaction was below 1,000 ms. The maximum transaction was 785 ms.
All **309 core ticks used exactly one outer transaction**. Recorded session counts matched Trunk's own
counters. Each SQLite `total_changes()` delta matched the sum of its per-table deltas.
All record indices were sequential; no recorded engine call failed.
Both held runs reached 264 concurrent nonterminal attempts, batches of 64, and 200 post-batch classifications.
Parked stopped attempts with open choice cards can also require classification, so a later post-batch count
can exceed the nonterminal count. See [measurement-audit.log](../../.tmp-test/measurement-audit.log).
The rebuilt bundle's SHA-256 matches all four after reports.

### Task items and changed files

| Item                       | State                                    | Implementation and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Find the limit          | Done                                     | [trunk-load.md](./trunk-load.md) quotes the official pages. No numeric storage-operation/transactionSync timeout was found; the task's 1,000 ms fallback was used.                                                                                                                                                                                                                                                                                                                                                              |
| 2. Measure locally         | Done for both requested normal workloads | [trunk-load-instrument.ts](./trunk-load-instrument.ts), [trunk-load-instrument.test.ts](./trunk-load-instrument.test.ts), and [trunk-load.test.ts](../../test/workerd/landing/trunk-load.test.ts). Additional congestion baselines include the explicitly incomplete dial-1 run. Tests cover nearest-rank summaries, explicit and alarm-driven tick context, and fail-closed bundle anchors.                                                                                                                                    |
| 3. Bound the largest calls | Done for the measured local workloads    | [sets.ts](../../src/core/trunk/sets.ts) uses cached syntax parsing for single-module lookups and avoids an identical view copy for attempts without operations. [table.ts](../../src/core/classify/table.ts) defers attempt-set analysis while always replaying operations and preserving QR4. [attempt-rows.ts](../../src/core/trunk/attempt-rows.ts) and [registry.ts](../../src/core/trunk/registry.ts) persist only changed heads-up rows. [landing.ts](../../src/core/trunk/landing.ts) does not dirty unchanged attempts. |
| Delivery                   | Patch saved; commits blocked             | The sandbox refused `.git/index.lock`. The task's fallback patch includes all modified and new files. No push, merge, branch change or deployment occurred.                                                                                                                                                                                                                                                                                                                                                                     |

Regression files added:

- [sets-module.test.ts](../../src/core/trunk/sets-module.test.ts): syntax-only lookups avoid unrelated modules,
  read current mutable file content, retain OP3 target validation, and preserve opaque-file/language behavior.
- [table-lazy.test.ts](../../src/core/classify/table-lazy.test.ts): unchanged-hash OP2 failures, V6/E1 pre-change
  semantics, QR4 entity/file readers, first-reader identity, exclusions, ordering and stronger-rule precedence.
- [attempt-rows-heads.test.ts](../../src/core/trunk/attempt-rows-heads.test.ts): unchanged 64-row history,
  one-row insertion/update/deletion, all persisted fields, rollback/retry, unchanged attempts, and retained
  L3 holds judgments/events/pins.

No existing test assertion or case vector was changed. The new source-region test's final-newline expectation
follows EN6/EN7. Independent read-only reviews of syntax lookups, persistence and lazy classification found
no actionable correctness issue. Execution results above provide the behavior evidence.

`Classification.sets` was an unused internal result field. Searches covered tick, landing/blast, reopen,
undo, rebuild registration, tests and scripts; no consumer read it. Its removal prevents a lazy result from
capturing mutable attempt state. No protocol or external API type changed.

### Decisions and evidence limits

No specification decision rule, judgment/event requirement or transaction boundary was relaxed.
The following explicit choices cover gaps in the task's measurement procedure:

> “Use 1,000 ms per synchronous engine call because Cloudflare does not document a numeric storage timeout.”

> “Use the repository defaults for think time and scheduled rescale attempts; report all 264 attempts.”

> “Add a separate hold-and-release workload because ordinary local launches do not reproduce the live concurrency.”

> “Use nearest-rank p50/p99, retain observer overhead, and report partial runs as partial.”

> “Use the authorized patch fallback when the filesystem prevents local commits.”

The implementation follows the specification's existing permission to avoid repeated set work.
Section 9.4 states: “The sets of 6.3 are stored per attempt and recomputed only when its operations change
or a landing changes a path it has operations on.” This change does not add a persistent set cache;
it avoids analysis where no classification rule needs the sets and reuses the existing parser cache.
Every affected attempt is still classified, and operation replay remains unconditional.

Local measurements do not include Cloudflare storage replication. The held dial-1 baseline's closed connection
is not proof of a platform reset. The initial normal request ID differs from the final one, and asynchronous
scheduling differs even for held runs with matching IDs. Do not interpret timing ratios as identical replay
comparisons or treat differing terminal counts as proof of equivalent decisions. Required case vectors,
focused regressions and integration tests supply that semantic evidence. No live soak was run.
The 260-file, eight-landing microbenchmark's maximum increased despite its improved median; that limitation
is recorded above. No universal latency guarantee is made.

### Final Git state

Branch: `lane/engine/trunk-load`. HEAD: `46fdc0c493fd50217fdb65a929c09f4ffead338b`.
The branch did not change. The initial working tree was clean.

`git log --oneline main..HEAD` exited 0 and produced **no output**. No commit was created.
The commit attempt failed while creating `.git/index.lock` with `Operation not permitted`.
No permission workaround was attempted.

`git status --short` exited 0 and produced:

```text
 M src/core/classify/table.ts
 M src/core/trunk/attempt-rows.ts
 M src/core/trunk/landing.ts
 M src/core/trunk/registry.ts
 M src/core/trunk/sets.ts
?? scripts/scale/trunk-load-instrument.test.ts
?? scripts/scale/trunk-load-instrument.ts
?? scripts/scale/trunk-load-results.md
?? scripts/scale/trunk-load.md
?? src/core/classify/table-lazy.test.ts
?? src/core/trunk/attempt-rows-heads.test.ts
?? src/core/trunk/sets-module.test.ts
?? test/workerd/landing/trunk-load.test.ts
```

The recovery artifact is [.tmp-test/trunk-load.patch](../../.tmp-test/trunk-load.patch).
It includes every tracked modification and untracked task file above. Raw measurement JSON and test logs
remain under ignored `.tmp-test/`. Nothing was deployed, pushed or merged. Live behavior is unverified.
