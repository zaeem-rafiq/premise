# Premise "Try it" for visitors (09-try)

Status: binding for implementation. Revision 1, added 2026-10-14 by the owner's decision to let a visitor see the core idea happen live. Read `01-core.md`, `02-tidepool.md` 7.11 and 10.5, and `03-floor.md` first. Where this file and `01-core.md` disagree, `01-core.md` wins.

Scope: one public button that gives a visitor a fresh, private copy of the tide pool in which the canned cast of scripted agents (`02-tidepool.md` 10.5) plays the hero conflict live. The route, its limits, the pool's name, the conductor that drives the pool on the server, what the visitor sees, and the off switch.

Conventions:

- "MUST", "MUST NOT" and "MAY" are requirements. Rules of this file have the id prefix `TY`. No other file uses it.
- Rule ids such as `PL1`, `SWR2`, `SE10` and `FJ1` point to `01-core.md`; section numbers 7.11 and 10.5 point to `02-tidepool.md`.
- "A try" is one accepted `POST /api/try`. "A try pool" is the pool it creates. "The try conductor" is the Workflow instance that drives it.
- Constants are written `LIKE_THIS` and are listed in Appendix A.

---

## 1. What it is, and the choices made

A visitor taps one button. The Worker creates a new pool from seed `tidepool`, starts a Workflow that plays the canned hero conflict in it, and answers the pool's address. The page opens that pool. The visitor watches the jellyfish land by itself, the shared rule wait on its held card and land, the crab and the shrimp get a heads-up with the exact diff, go around and land.

| Point | Choice | Why |
| --- | --- | --- |
| Agents | The canned cast `hero-s`, `hero-c`, `hero-h`, `hero-j` only (scripted, `agent: "synthetic"`) | A scripted agent calls no model, so a try spends nothing (TY5) |
| Who drives the pool | A Workflow on the server (`TryWorkflow`) | The owner's routes need the owner key; the visitor's browser has none |
| Pool | A new pool per try, named `try-<id>` | A visitor's run never disturbs the main pool or another visitor |
| Limits | One per client address per window, a cap per hour, a cap in total, all in the model gate's Durable Object | The deployment's one global object already exists (MG1); the limits survive a restart |
| Off switch | `features.try` (FJ1) and the kill switch (SE10) | The lead switches it on after a live check (BP4); the kill switch stops everything |

## 2. The switch

- **TY1 (`features.try`).** `features.try` (FJ1) is a boolean, `false` unless the lead switches it on. While it is `false`, `POST /api/try` answers HTTP 404 with the error code `feature_off` and the sentence `try.off`, and changes nothing; the page shows no button (TY11).

## 3. The route

- **TY2 (`POST /api/try`).** The route has role `anyone`: no owner key and no cookie. Its body is ignored; SE3's content-type rule applies as for every route with a body. It answers HTTP 200 with `{ "pool": "<pool>", "path": "/p/<pool>" }` once the pool exists and the try conductor has been started. The checks run in this order, and the first that fails answers:

  | Check | Answer |
  | --- | --- |
  | `features.try` is `false` | 404, `feature_off`, `try.off` |
  | The kill switch is on (SE10) | 403, `killed`, `try.killed` |
  | The limits of TY6 | 429, `try_limited`, the sentence of the limit that refused |
  | The pool or the conductor could not be started | 502, `try_failed`, `try.failed` |

  Every error body is `{ "error": { "code": "<code>", "message": "<sentence>" } }`. The sentence is the text of its copy id (`03-floor.md` 5.4).
- **TY3 (the pool's name).** The pool is named `try-` followed by `TRY_ID_LENGTH` characters drawn uniformly from `a-z0-9` by the Worker's cryptographic random source. The name matches PL1's pattern. The visitor names nothing: no field of the request reaches the name.
- **TY4 (the pool).** The try pool is created exactly as `POST /api/pools` creates a pool (PL1): seed `tidepool`, `summary_only: false`, its repository, its Trunk, its Floor and both registrations. It is an ordinary pool afterwards: a visitor of `/p/<pool>` has the visitor role, reads every event, opens Why cards, the Compare view and its Replay. Because its attempts are synthetic, the page shows the SYNTHETIC banner (EM1a).

## 4. No model, ever

- **TY5 (scripted agents only).** A try starts no real agent, sends no intent and calls neither the `AI` binding nor the model gate's `reserve`. Its agents are the four patterns of the canned cast, launched as SWR2 launches them (scripted, `driver: "scripted"`), and their triage is the scripted triage of TR8. A try therefore spends nothing of `SPEND_CAP_USD`. A test MUST bind an `AI` stand-in that fails when called and drive a try to its last landing.

## 5. Limits

- **TY6 (the limits).** Before anything is created the route asks the model gate object (MG1) to record the try. The gate refuses when one of these holds, in this order:

  | Limit | Refused when | Sentence |
  | --- | --- | --- |
  | Per client address | A try from the same client address was recorded within the last `TRY_ADDRESS_WINDOW_S` seconds | `try.limited.address` |
  | Per hour | `TRY_PER_HOUR` tries were recorded within the last hour, all addresses together | `try.limited.hour` |
  | In total | `TRY_TOTAL` tries have been recorded since the deployment began | `try.limited.total` |

  A refused try records nothing. A recorded try counts even if the pool then fails to start: the count is spent when it is recorded.
- **TY6a (the client address is not kept).** The client address is SE21's (`cf-connecting-ip`). The gate keeps only a salted SHA-256 hash of it, with a salt the gate draws once and never answers. A hash is erased once its try is older than `TRY_ADDRESS_WINDOW_S`; the time of the try is kept for the hourly count and dropped after an hour. Neither the address nor its hash appears in an event, a log line, a response or a recording.
- **TY7 (the kill switch).** A try is refused while the kill switch is on (TY2). A try conductor that finds the kill switch on before a start ends without starting anything more; agents already started stop as SE10 stops every agent.

## 6. The try conductor

- **TY8 (the script).** The try conductor plays the conductor of 7.11 with these rows. It uses the pattern ids of 10.5 and the same `hold_before_submit` and `release` of SWR3:

  | # | The conductor does | Then waits for |
  | --- | --- | --- |
  | 0 | Nothing. | `batch.pushed` (the seed is on the remote, PL1). |
  | 1 | Starts `hero-j`, `hero-c` and `hero-h`; `hero-c` and `hero-h` are listed in `hold_before_submit`. | `op.recorded` for `creatures/crab.js` and for `creatures/shrimp.js`, and `landing.landed` for `hero-j`. |
  | 2 | Starts `hero-s`. | `card.opened` of kind `held`. |
  | 3 | Taps Land on that card (option `land`, the card's `submit_ids`). | `headsup.sent` with result `repair` for `hero-c` and for `hero-h`; `landing.landed` for `hero-s`. |
  | 4 | Releases `hero-c` and `hero-h`. | `landing.landed` for `hero-c` and for `hero-h`. |

  The jellyfish reads nothing of `world/energy.js`, so it lands by itself and gets no heads-up. Before the actions of rows 1 to 4 the conductor waits `TRY_BEAT_MS`, so a visitor who has just opened the pool sees each step. A tap that the card answers `stale` is tapped again on the newest open held card of `hero-s`.
- **TY9 (the Workflow).** The try conductor is one instance of `TryWorkflow` (binding `TRY`), whose id is the pool's name. Every action and every read of the pool's events is a durable step, so a restart resumes the run where it stopped and repeats no launch (the attempt ids derive from the request id, 9.8). It reads the pool's events from the pool's Floor object. It ends when the last row is complete, when the pool reports `pool.paused` or `trunk.error`, when the kill switch is on (TY7), or after `TRY_DEADLINE_MS`, whichever comes first. It never retries a try from the beginning.

## 7. What the visitor sees

- **TY10 (the visitor's view).** After a 200 the page navigates to `path`. The try pool is shown like any pool, live, with the visitor role (TY4).
- **TY11 (the button).** For a visitor, and only while `features.try` is on and the page is live (not Replay), the button `try.button` appears in two places: under the Overview's headline, and in the start card beside `start.play`. While the request is open the button is disabled and the sentence `try.starting` is shown under it. A 429 shows the sentence of the error's `message`, and the button stays disabled for the rest of the page's life; any other failure shows `try.failed` and the button can be tapped again. The button's tap target is at least 44 by 44 CSS pixels in both themes.

---

## Appendix A. Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `TRY_ID_LENGTH` | 10 | Characters after `try-` in a try pool's name (TY3) |
| `TRY_ADDRESS_WINDOW_S` | 600 | One try per client address per this many seconds (TY6) |
| `TRY_PER_HOUR` | 20 | Tries per hour across the deployment (TY6) |
| `TRY_TOTAL` | 300 | Tries in total for the deployment (TY6) |
| `TRY_BEAT_MS` | 6000 | The pause before each conductor row's actions (TY8) |
| `TRY_DEADLINE_MS` | 600000 | The longest a try conductor runs (TY9) |
