# VE7 — security review

Independent review (the reviewer wrote none of the reviewed code). Scope: the eight rows of
`docs/spec/04-build-plan.md` section 5.3. Assessment only — no product code, test or
configuration was changed.

Reviewed build: `e499190` on branch `lead/security-review`
(`git log --oneline main..HEAD` prints nothing: every commit on HEAD is already reachable
from `main`).

## Summary

- Findings: **0 high, 3 medium, 2 low.**
- Every row of 5.3 has a result. Six rows pass on local evidence. The Verifier row reports
  the component as **not built** (fail-closed stub — nothing runs pool code). The Spend row's
  production checks of plan 2.5 could not run here (deploying is out of scope); they are
  listed under "For the lead, on `test`".
- The medium findings are: no `Content-Security-Policy` on the Floor document (SE14a), no
  `PUBLIC_RATE_PER_MIN` limit on the Floor page or the stream handshake (SE21), and the
  verifier/green line not implemented (GR6/GR7 unexercised, fails closed).

## How to read the evidence

- **code**: file and line read during the review.
- **test**: a committed test; all suites named here were run in this session and passed.
- **probe**: a one-off check run from `.tmp-test/` (never committed), or a shell observation.
- **for the lead**: a check that needs the deployed `test` service.

Commands and exit codes are at the end of the document.

---

## 1. Owner key and session — SE1, SE2, SE2a, SE3, SE4

**Result: met.** One low finding (L1).

### Code

- `src/worker/security/owner.ts:15` `timingSafeEqual` — encodes both sides, then a fixed
  `diff |=` loop over the full length. `owner.ts:28` `bearerAuths` returns false when
  `env.OWNER_KEY` is undefined — no configured key means no request can authenticate (SE1).
- `src/worker/index.ts:125` `guard` — order is: role ≠ `anyone` and no `OWNER_KEY` → 503;
  body with a non-JSON content type → 415 before authentication (SE3); owner route with no
  credential → 401; cookie-authenticated mutating request whose `Origin` is not the Floor's
  origin → 403 (SE3).
- `src/worker/security/session.ts:37` — the `premise_owner` cookie is `v1.<expiry>.<hmac>`,
  HMAC over `premise_owner.v1.<expiry>` keyed by `OWNER_KEY`, verified with `node:crypto`
  `timingSafeEqual` (`session.ts:10,48`). Cookie flags `HttpOnly; Secure; SameSite=Strict;
  Path=/; Max-Age`.
- `src/worker/routes/session.ts:42` — `unlockBraked(address)` is checked **before** the key
  is compared; a failure is recorded at `session.ts:52`. `src/worker/security/rate-limit.ts:54`
  counts failed unlocks per address in a one-minute sliding window
  (`UNLOCK_FAILS_PER_MIN = 10`, `src/protocol/constants.ts`).
- `src/worker/routes/session.ts:25` — `GET /api/session` is counted under
  `PUBLIC_RATE_PER_MIN` per address (SE21).
- SE4: Durable Objects are reached only through the Worker's `dispatch`
  (`src/worker/index.ts:145-163`); no browser route touches a Trunk tool.

### Tests (all observed passing)

`test/workerd/trunk/session.test.ts`: "SE1: every mutating route answers 503 while
OWNER_KEY is unset"; "SE2: a wrong key answers 401 and the right key mints the HMAC-signed
premise_owner cookie"; "SE2: DELETE /api/session clears the cookie"; "SE3: a body that is
not application/json answers 415 before authentication"; "SE2a: the eleventh wrong key in a
minute answers 429 — and so does the right key"; "SE21: the session read is limited to
PUBLIC_RATE_PER_MIN per client address"; "SE2: POST /api/session without a key field is a
wrong key".
`test/workerd/worker.test.ts`: wrong/missing key → 401; `text/plain` body → 415; right key
reaches the handler; `/api/kill` guard.
`test/workerd/undo/routes.test.ts`: foreign-`Origin` cookie request refused (403).

### Findings

- **L1 (low):** `timingSafeEqual` (`src/worker/security/owner.ts:18`) returns early when the
  two encoded strings differ in length. The table probe asks for "no early return"; the
  content comparison itself has no early exit, so the only timing signal is the key's
  length — the same trade-off `node:crypto`'s own `timingSafeEqual` makes. Smallest fix:
  compare `b` against a same-length mask or document the exception. No leak of key content.

## 2. Tokens and text — SE5, SE5a–SE5c, S2a, AG7, RP1

**Result: met.** One low finding (L2).

### Code

- `src/worker/routes/pools.ts:84,121,214` — the write token Artifacts returns at repo
  creation is discarded where it is returned; the create response carries no token (SE5).
- `src/worker/routes/pools.ts:303` — `read-token` calls `createToken("read",
  READ_TOKEN_TTL_S)`; it is the only route that returns a token, to the owner only (SE5c).
  `grep` for `createToken` across `src/` shows exactly two call sites: this one and
  `src/worker/adapters/token-source/token-source.ts:54`, which mints `"write"` tokens for
  Trunk's push targets only. `createToken` is never called without an explicit scope (S2b).
- S2a: `src/worker/adapters/pool-source/artifacts.ts` (app-server reads) contains no token
  handling at all; the agent's `gate-client.ts`/`trunk-client.ts`/`model-driver.ts` hold no
  repository token (only token *counts*); the verifier is a stub holding nothing (row 6).
  Only Trunk holds pool write tokens.
- SE5a `redact()`: `src/protocol/redact.ts` — one function replaces Artifacts tokens
  (`art_v\d+_[0-9a-f]+`), the `OWNER_KEY` value, `Authorization` header values and URL
  credentials with `[redacted]`.
- Applied before storage/transcript: `src/worker/agent/agent-do.ts:488` (intent text),
  `:536` (prompt rows), `:817/:845/:869` (heads-up/resume rows), `:998/:1234` (tool rows),
  `src/worker/agent/model-driver.ts:295,541` (AG7).
- SE5b: `src/worker/trunk/push.ts:122-149` — `push.retry` carries `error: code` and
  `last_error` stores the code, never raw transport text. `src/worker/adapters/pusher/pusher.ts:46-64`
  maps failures to `ErrCode`s; `ports.ts:38-44` types `PushResult` so per-ref results are
  only `"ok"|"ng"`.
- `green.verified.checks` is typed `VerifyResult["checks"]` (`src/protocol/events.ts:290`)
  with names and codes from the fixed GR8 list (`src/protocol/green.ts:16-45`); `log` is
  capped at `GREEN_LOG_MAX_CHARS` and typed owner-only (`green.ts:10`). No code emits the
  event yet (green line unbuilt, row 6) — the schema constraint holds.
- RP1: `src/worker/floor/floor-do.ts:339-345` — every exported line is tested with
  `redactMatch`; a match answers 409 `redacted` with the line number and family.

### Tests (all observed passing)

- `test/workerd/reads/read-token.test.ts`: "the minted token clones with stock git, cannot
  push, while the write token still can"; the route needs the owner key (401 without).
- `test/workerd/floor/export.test.ts`: "RP1: a line carrying an Artifacts token pattern is
  refused with 409 and its line number"; "RP1: a line carrying the owner key itself is
  refused, family `secret`"; clean export shape (12.3).
- `src/worker/routes/pools.test.ts` (unit): read-token mints scope `read`; create response
  carries no token.
- `src/protocol/redact.test.ts` (unit): the pattern families.
- `test/e2e/shell/replay/no-credentials.spec.ts` (not run — Playwright/browser harness):
  replay uses no credentials and no live sockets.

### Checks

- `npm run check:secrets` — exit 0: "1090 files and 483 commits scanned, nothing found."
  This covers the tree and the whole history; recordings live in the tree.

### Findings

- **L2 (low):** on a rejected push, `src/worker/adapters/pusher/pusher.ts:148` writes the
  remote's per-ref refusal text to `console.warn` unredacted. It goes only to the owner's
  worker log, never to an event (SE5b concerns events/cards/storage), so this is hardening:
  a hostile or odd git server could echo unexpected text into the log. Smallest fix: run
  `redact()` over the logged fields.

## 3. Public surface — 13.2, SE19–SE22, EV7

**Result: met with one gap.** One medium finding (M2).

### Code

- `src/protocol/routes.ts:30-110` — every `role: "anyone"` route is `GET` or the one `WS`
  stream route; mutating routes are `owner`/`key`. No public route exists for an attempt
  repo — `APP_ROUTES` (`routes.ts:81-110`) has no `a_*` source, and
  `src/worker/adapters/pool-source/resolve.ts:48-80` resolves only `main`, `green`,
  `plain`, `<40 hex>` and `p-<40 hex>`; anything else is `null` → 404 (SE22, PV4).
- `src/worker/index.ts:145-163` — `dispatch` sends `anyone` routes to `floor`,
  `app-server` or `assets`; `trunk` is unreachable for a public request (SE19).
- `src/worker/app-server/app.ts:75-82` — `PUBLIC_RATE_PER_MIN` on the no-store routes,
  `APP_FILE_RATE_PER_MIN` on commit-addressed routes counted on cache misses (SE21/AS8);
  `respond.ts:51` `RateLimiter` is per address per route class.
- `src/worker/floor/floor-do.ts:264-275` — a non-upgrade GET on the stream route answers
  200 `{pool, stream}` (FR30); on upgrade, `getWebSockets(address).length >=
  MAX_SOCKETS_PER_ADDR` → 429 `too_many_sockets`; sockets are accepted with
  `ctx.acceptWebSocket(server, [address])` — the client address is the tag — and the only
  per-socket state is the `{after}` attachment (`floor-do.ts:139-146,300`; EV7/FS3).

### Tests (all observed passing)

- `test/workerd/reads/public-reads.test.ts`: public reads never reach Trunk — served-entry
  count stays 0 and answers are identical while Trunk answers 503 (`trunk-down.mjs`).
- `test/tidepool/host/app-server.test.ts:401`: "AS8: the no-store routes are limited to
  PUBLIC_RATE_PER_MIN per address per minute"; `:151` "AS4: unknown sources — attempts,
  bogus segments — do not resolve".
- `test/workerd/floor/floor.test.ts`: hibernated sockets survive eviction; a second client
  message closes the socket; event-source numbering. `src/worker/floor/sockets.test.ts`
  covers the hibernatable socket implementation (EV7).

### Probes (run locally, in `.tmp-test/probe-sockets.test.ts`, exit 0)

- **Ninth socket:** seeded one event, opened 8 sockets from one address, then requested a
  ninth upgrade → **429 `too_many_sockets`** (SE21/MAX_SOCKETS_PER_ADDR met).
- **Handshake limit:** 130 plain GETs on `/api/pools/{pool}/stream` from one address →
  **all 200**. The handshake is not counted under `PUBLIC_RATE_PER_MIN` (see M2). The Floor
  page (`/`, `/p/{pool}`) is served straight from `ASSETS` (`index.ts:152,193`) and is
  likewise uncounted.

### Findings

- **M2 (medium):** SE21 names "the page, the session read, the stream handshake and
  ref-following routes" under `PUBLIC_RATE_PER_MIN`. The session read and the app-server
  routes are limited; the Floor page and the stream handshake are not — the probe shows 130
  handshake requests all answering 200. Impact is bounded (the socket cap still stops a
  ninth open socket, and hibernation keeps an open page from pinning the object), so it is
  not a pool-changing or credential issue — it needs a real flood to matter. Smallest fix:
  count the handshake in `openSocket` (and the page in the Worker's asset path) against
  `PUBLIC_RATE_PER_MIN` per address.

## 4. Spend and kill — SE6–SE12

**Result: met locally; the plan's production checks are for the lead.**

### Code

- `src/worker/gate/gate-do.ts` — one Durable Object named `premise` (MG1); every internal
  call loads `GateState`, applies `src/core/gate`, and stores the result in the same
  transaction before any effect runs (`gate-do.ts:1-16`). The cap is `SPEND_CAP_USD` read on
  every load; absent, non-numeric or negative means cap 0 — every reservation refused
  `spend_cap` (SE7, fail closed; `gate-do.ts:22-24`). Wrangler sets `SPEND_CAP_USD` "30"
  (production) / "10" (test).
- `src/core/gate/reserve.ts` — `reserve`/`settle`/`sweep`; the alarm sweep charges an
  unsettled reservation **in full** at `expires_at` (SE6a): a lost settlement makes the
  ledger over-count to the reserved bound, never under-count.
- Kill: `POST /api/kill` is an owner route (`routes.ts:53` → `dispatch` → gate);
  `gate-do.ts` handles `/internal/kill`, `/api/kill` and `GET /killed`; `killed` is in the
  stored state, so it survives restarts and clears only on `{"killed":false}` (SE10–SE12).
  SE11: a settle of an earlier reservation still works while killed (Trunk pushes are not
  blocked).

### Tests (all observed passing)

- `test/workerd/gate/se6-se7-se8.test.ts`: "SE6: reserve grants; settle with usage charges
  the real cost, idempotently"; "SE6a: the alarm's sweep charges an unsettled reservation in
  full at expires_at" — the ledger over-counts on a lost settlement; "SE7: bound over cap
  answers spend_cap and broadcasts refusing"; "SE8: the 17th kimi call of the minute answers
  retry_after_ms, never a refusal"; "may-start answers the counts pool.state shows".
- `test/workerd/gate/se7-cap-source.test.ts`: "with no SPEND_CAP_USD every reservation is
  refused spend_cap (the gate fails closed)"; "a cap lowered by a new deployment binds the
  stored state at once".
- `test/workerd/gate/se10-se12.test.ts`: "SE2: /api/kill without the owner key answers 401";
  "SE10/SE12: kill is set, durable across the restart, and cleared by killed:false".
- `test/workerd/gate/se9-ev2a-em6.test.ts`: `limits` events per pool with that pool's own
  `source_n`; confirmed duplicates never land twice.
- `src/core/gate/index.test.ts` and `kill.test.ts` (unit): unsettled reservation charged in
  full; settle still works while killed.
- `test/workerd/agent/real/routes.test.ts`: "SE10: POST /api/kill → a reserva seguinte é
  recusada e o agente para `killed`"; "SE6/refusal: o bound do primeiro call excede o cap →
  spend_cap sem nenhum send" (spend-cap refusal with zero model sends).

### For the lead, on `test`

The production checks of plan 2.5 need the deployed service; see the consolidated list at
the end (kill switch end-to-end; spend cap at the `$10` test cap; `limits` events on the
Floor).

### Findings

None.
