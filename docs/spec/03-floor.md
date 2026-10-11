# Premise Floor specification (03-floor)

Status: binding for the implementation of the Floor, the one web page where a person watches and steers. Reconciled on 2026-10-04 with `01-core.md` revision 2, `02-tidepool.md`, `04-build-plan.md`, the platform measurements and the lead's reconciliation decisions. The last section, "Changes in reconciliation (2026-10-04)", lists what changed. Sources: the architecture brief (decisions and vocabulary), the design brief (contest and platform limits), the concept panel (the `stage-first` proposal and the three judges' must-fix lists), and `01-core.md` (types, rules and the event stream).

Scope: the product surface. Layout, components, states, the mapping from events to what is on screen, interface copy, visual language, failure behaviour and Replay. Not in this file: the core rules (`01-core.md`), the tide pool code, the app server that serves it and the Swarm scripts (`02-tidepool.md`), the agent's prompt and tool definitions (`05-agent.md`), and the build order (`04-build-plan.md`). Where this file and `01-core.md` disagree, `01-core.md` wins.

Conventions:

- "MUST", "MUST NOT" and "MAY" are requirements. Rules have ids (`FL1`, `LY3`, `RY2`) so tests can cite them.
- Names in `code` are types, events, rules and constants of `01-core.md` unless marked *(Floor)*. Floor constants are in Appendix A.
- "The stream" is the pool's event stream (`01-core.md` section 12).
- Copy ids such as `status.working` point to section 5. The text in sections 5, 7 and 8 is exact. No other text may appear in the interface. Two kinds of text are data, not interface copy: text from outside (FL8), and the title of a recording (8.2).
- Numbers in examples ("12 agents", "landing 9") are examples. The page shows only what the stream produced.
- Sizes are CSS pixels.
- Ids of this file that were renamed in the reconciliation, because another file used the same id for another thing (finding F30). The numbers did not change: Replay rules are `RY1` to `RY27` (were `RP`); the failure rows of section 7 are `FR1` to `FR32` (were `F`); the recording state of 1.1 is `PS1` to `PS7` (was `P`); the needs of 4.7 are `NP1` to `NP9` (were `TP`). `RP1` now means only the export rule of `01-core.md` 12.3, `F1` to `F7` only the file rows of its decision table, `P1` to `P9` only the pairs of `02-tidepool.md` 9.4, and `TP1` to `TP22` only the rules of `02-tidepool.md`.

---

## 0. Rules for the whole page

- **FL1 (pure function).** `FloorState = reduce(events 1..n)` with the reducer of the shared `protocol` module (`01-core.md` EV5). What is on screen is `render(FloorState, ViewState, clock)`. `ViewState` is the local state listed in 4.2 and nothing else. The page MUST NOT read a pool fact from any other source, except the requests listed in 4.5 and the `stats` messages of its own pool frames (CO22), which say only what that frame is running.
- **FL2 (one page).** One page with four views (Overview, Floor view, Compare view, Swarm view; the Overview was added by the owner's design decision of 2026-10-10), two modes (live, Replay) and two roles (owner, visitor). Every beat of section 1 is reachable by taps and keys on this page. No terminal, no second tool.
- **FL3 (landed means on `main`).** The word "Landed", the Landed counter, the Why card, and any change of the live pool frame depend only on `landing.landed` (`01-core.md` LP9 to LP11). Between `landing.accepted` and `landing.landed` the page says "Landing…".
- **FL4 (honest labels).** A pool in which a synthetic attempt was opened (`pool.synthetic`, `01-core.md` EM1a) is always under the SYNTHETIC banner, whether or not the pool is `summary_only`. Replay is always under the REPLAY banner. The plain-merge pool always carries the label `plain.label` and the word "constructed". The real-agent count always shows its limit and the reason for the limit. The page quotes no number that the current stream did not produce.
- **FL5 (plain words).** The owner never needs to read code, a hash or a state name. Ids and hashes appear only in the "show the git" drawer and in tooltips. Every code-level name shown elsewhere goes through `keyLabel` (5.2).
- **FL6.** No text on the page makes a priority claim. The lint list is: "the first", "first to", "no one else", "nobody else", "the only system", "the only tool", "the only product".
- **FL7 (roles).** Controls that change something are absent for a visitor and absent in Replay. The intent box is the one exception: it stays, disabled, with a sentence that says why (3.1).
- **FL8 (untrusted text).** Intent text, summaries, statements, paths, entity names, kind names, model names and everything a pool app sends are rendered as text, never as HTML (`01-core.md` SE18, SE16).
- **FL9 (clock).** Every "x seconds ago", every timer and every duration uses the stream clock and the event field `ts` (the source's clock when the state change committed), never `t` (`01-core.md` EV5). In live mode the stream clock is the browser clock plus an offset. The offset is the largest value seen on this connection of (`ts` of an event minus the browser clock when that event arrived), so an event that arrives late never moves the clock. In Replay the stream clock is the Replay clock (8.4). No component calls the browser clock directly.
- **FL10 (no silent wait).** Every wait on screen has a sentence that says what is being waited for. A spinner alone is not allowed.

Floor terms (used with exactly these meanings in this file and in code):

| Term | Meaning |
| --- | --- |
| Owner | A browser that holds the owner session (`01-core.md` SE2). |
| Visitor | A browser without it. Read-only plus Replay. |
| Main pool | The pool that Floor view and Compare view show: the pool named in the address (`/p/{pool}`), or the default pool of `/floor.json` at `/` (FE7). |
| Swarm pool | The pool that Swarm view shows. It is named in `/floor.json` and was created with `summary_only: true` (`01-core.md` PL1). |
| Quiet pool | A pool with no attempt in flight and no landing in the last 60 s (RY23). This is a moment, not a setting. It is not the pool flag `summary_only`. |
| Header | The top bar: name, view switch, Needs-you badge, kill switch, owner lock. |
| Strip | The row of counters under the header. |
| Banner | A full-width labelled band under the strip. Banners stack. They never cover content. |
| Pool area | The left region: pool frame and file tiles. |
| Rail | The right region: intent box, Needs-you tray, attempt cards. |
| Attempt card | The rail item that shows one attempt (3.2). Its copy ids start with `attempt.`. It is not a card. |
| Card | A decision for the owner (`01-core.md` 10.3): kinds `held`, `choice`, `race`. It is a row in the tray and a sheet. Written alone, "card" always means this. |
| Pool frame | A sandboxed iframe that runs the pool app. A **live frame** follows the source `main` or `plain` (or `green`, only in the fallback of row FR28) and moves to a new landing by `probe`. A **commit frame** shows one fixed commit: every frame in Replay, and the before and after frames of a card (`01-core.md` SE16a). |
| Plain-merge pool | The pool built by `01-core.md` 11.7. The brief's scope list calls it the counterfactual pool. Its label on screen is "Same changes, merged by plain git". |
| Light | One premise of one attempt, drawn as a shape (3.3). |
| Tile | One file of the pool (3.7). |
| Sheet | A panel that opens over the body for one task (a card, a Why card, About). |
| Tray | The "Needs you" list of open cards at the top of the rail. |
| Recording | One Replay file (section 8). |
| Chapter | A named position in a recording (8.5). |
| Run clock | Time since the `ts` of the first `intent.created` of the stream, on the stream clock. |

---

## 1. Beat sheet

The beat sheet is the specification of the page. A component or state that no beat and no row of section 7 needs is out of scope.

### 1.1 State before recording

| # | Item | How the owner checks it on the page |
| --- | --- | --- |
| PS1 | The main pool has several creatures that real agents landed earlier, on top of the seed, so Why and Who relies have history. None of them comes from a request of the starter set (its files would already exist). | Landed counter is above 0. Tapping a creature opens a Why card. |
| PS2 | The owner session is unlocked. The key is never typed while recording. | Header shows `owner.unlocked`. |
| PS3 | Spend is far below the cap. | Strip: Spend. |
| PS4 | Agents are allowed. The pool is ready. | No banner. |
| PS5 | The recordings load. Before the take the default recording is `rehearsal` (RY26). | Replay menu lists them with their length. |
| PS6 | Theme and size are set for the screen in use. | Keys `T` and `Z` (6.6). |
| PS7 | The Swarm pool exists and is idle. | Swarm view shows `swarm.empty`. |

Attempt repos are provisioned off the landing path (`01-core.md` AG5), so nothing on screen waits for them.

### 1.2 Submission video (target 7:30, hard limit 10:00)

Rules for the recording:

- **BS1.** One session on the deployed system, in a browser, with no terminal. Cuts remove waiting only. The run clock is on screen in every shot, so every cut is visible.
- **BS2.** Beat 0 is a cut forward from beat 4 of the same session. Its caption ("From later in this recording.") is added in the video edit. It is not text of the page, so it has no copy id. The owner confirmed this opening on 2026-10-04 ("cut forward").
- **BS3 (the owner sets the pace).** Both catches are paced by cards, not by luck. A change that waits on a card keeps its premises live (`01-core.md` 10.2, RC2). So the owner first lets the changes that will be caught wait on a card, and then lands the change that moves the code under them. No beat depends on two agents finishing in a lucky order.
- **BS4.** The voiceover reads measured numbers from the screen. Where the script says *[read the number]* no number is written in advance.
- **BS5.** If a card closes as out of date before the owner taps it, that is the same catch in the other landing order (`01-core.md` 6.5). The script has a line for it.
- **BS6.** The voiceover of a beat has at most 2.5 words for each second of the beat, and no sentence longer than 25 words.
- **BS7 (the second catch needs an earlier match).** The owner sends the sweep request only when the shrimp's attempt card reads "Landed", and sends the late creature only when the sweep's card is in the tray. Rule QT1 sends the sweep back only if its search had found a match and the sweep had edited it (`01-core.md` 7.2). The shrimp is that match.

The requests used. Their ids and exact texts are those of `02-tidepool.md` section 9. The owner types the two typed requests word for word.

| Role | Request | How it is sent | Why it waits or lands |
| --- | --- | --- | --- |
| Starter set | The six pre-written requests of group `starter`: A01 (jellyfish), A03 (starfish), A04 (sea urchin), A06 (octopus), A11 (lobster) and P1b (the shrimp that spends 5 energy on each dart). | pre-written, one tap (`intent.starter`) | Tier `auto`: each lands by itself. The shrimp calls `drain(`, so the search of beat 5 has a match on `main`. |
| Crab race | P1a: "a crab that hides in its shell when its energy drops below 30" | typed, then "Race 3" | Race candidates wait on the race card. Each candidate's `spawn` sets `energy: ENERGY_MAX`, so its code references `ENERGY_MAX` (`02-tidepool.md` TP16). The number 30 in the owner's words makes a candidate write its threshold in points (TP21). |
| Shared rule | R01: "make energy a fraction from 0 to 1" | typed | Touches a held path: waits for one tap. |
| Sweep | P9a: it changes `drain` in `world/energy.js` and every caller that a search for `drain(` in `creatures/` finds. | pre-written | Touches a held path: waits for one tap. |
| Late creature | P9b: a new creature that calls `drain(`. | pre-written | Tier `auto`: lands by itself. |

P9a and P9b are the pair that the reconciliation adds to `02-tidepool.md` 9.3 (finding F13). Their texts are fixed there, not here.

| # | Time | On screen | The owner does | Voiceover | Proves |
| --- | --- | --- | --- | --- | --- |
| 0 | 0:00 to 0:20 | Compare view. Left frame: "Premise · main", the crab hides and comes out again. Right frame: "Same changes, merged by plain git · constructed for comparison", the crab never comes out. The thesis sentence is the last line of the view. The caption of BS2 is added in the edit. | Nothing (cut forward). | "Both pools got the same changes from the same agents. Plain git merged them and reported no conflict. The crab on the right is broken. Git records only what an agent wrote. Premise also records what it read." | The plain-merge pool, labelled as constructed. The thesis. |
| 1 | 0:20 to 1:05 | Floor view. The pool runs. Strip: real agents, landed, go-arounds, waiting, green line, spend. The attempt cards of the starter set appear with the tag "Pre-written" and a model name. The crab request appears as a race group of three attempt cards, one per model. Lights switch on, one per thing an agent reads. File tiles show reader and writer marks. Strip: "Real agents 9 of 12 · Limit set by the model rate." A starter attempt card goes "Landing…", then "Landed", and its creature appears in the pool. The three crab attempt cards reach "Waiting for you". | Presses "Send the starter set". Types the crab request (P1a) and presses "Race 3". | "I can't read code. I type what I want. Each request gets a real agent on Workers AI. Agents see code only through Premise, so every read becomes a light: a premise, pinned to the exact version the agent saw. Nobody claims a file. Nothing is locked. This creature landed by itself as one ordinary commit, because everything it relied on was still true. The crab I asked three models for. Those three wait for me." | Several real agents at once on one codebase. Reads observed by the platform. Landing with no queue and no review step. The stated limit on real agents. |
| 2 | 1:05 to 1:35 | A new attempt card: "make energy a fraction from 0 to 1", "Working". The owner taps the tile `energy`, then "ENERGY_MAX", then "Who relies on this". A panel lists the landed creatures and "In flight (3)": the three crab attempts. The same creatures are outlined in the pool. The same attempt cards and lights are outlined in the rail. | Types the shared-rule request (R01) and presses Send. Three taps. | "Now I change a shared rule: energy becomes a fraction. Before it lands, I ask who relies on that rule. Premise knows, because it observed every read. No agent declared anything." | Blog question 1 (how agents and people know what others are doing). Who relies. |
| 3 | 1:35 to 2:50 | Tray: "This change touches shared rules. Land it?" The card sheet shows the pool before and after, and "Landing this sends 3 changes back to their agents: crab (gpt-oss-120b), crab (glm-5.3-flash), crab (kimi-k2.7-code)." The owner taps Land. The shared-rule attempt card goes "Landing…", then "Landed". In that moment the ENERGY_MAX light on the three crab attempt cards turns into a red diamond and they move to the top. Each shows a heads-up: "ENERGY_MAX in world/energy.js changed, and this change uses it." Before `export const ENERGY_MAX = 100;` After `export const ENERGY_MAX = 1;`, each with its comment line ("Energy is counted in points…" becomes "Energy is a fraction…"). Its own lines that use it: the import of `ENERGY_MAX`, and the line in `spawn` that sets `energy: ENERGY_MAX`. Status "Going around · sent back 1 of 3". Then "Editing creatures/crab.js", then the agent's sentence ("… so the crab hides below 0.3."), the light is a green circle again, and the attempt card returns to "Waiting for you". | Opens the card. Taps Land when it names the three crab attempts. | "Shared rules are a held path, so this change waits for one tap from me. I don't read a diff. I see the pool before and after, and which waiting changes it will send back. It landed. In the same moment, Trunk told every agent that relied on the old value, with the exact diff. That is a heads-up. The name did not change, only its meaning, so an import check and a text merge see nothing. Each agent still has its whole conversation. It adapts and says what it changed. That is a go-around." If the card closed as out of date first: "A creature landed first. So the shared-rule agent got the heads-up instead: a new change now uses the value it is altering." | Blog question 2 (conflicting changes): a conflict is a broken premise, caught when `main` moves. Blog question 3 (review): held path, one tap, before and after, blast radius. Context preservation: the same agents adapt. |
| 4 | 2:50 to 3:35 | Tray: "3 of 3 attempts at "a crab that hides in its shell when its energy drops below 30" are ready. Choose one." The race sheet shows three pool frames side by side, each running one attempt. Under each: model, lights, checks, time taken, cost, "Would send back: 0 changes". The owner taps "Choose this one". It goes "Landing…", "Landed". The other two show "Not chosen". The crab appears in the pool. The owner opens Compare view: on the left the crab hides and comes out; on the right it never comes out. Under each frame is its self-test badge. Under the frames: "crab (glm-5.3-flash): went around once after ENERGY_MAX changed. The plain-merge pool has its first version." and "Text conflicts in the plain merge: 0 (approximated)". | Opens the card. One tap. Presses `C`. | "Three models tried the crab. Here are the three results, running side by side. Under each: what it relied on, how long it took, what it cost, and how many waiting changes it would send back. I choose by looking. It lands through the same gate as every other change. The other two are kept. Now the same changes, merged by plain git. No conflict was reported. This crab still compares its energy with thirty." | Compare several attempts at once and decide which ships. The plain-merge pool shows the break to someone who cannot read code. |
| 5 | 3:35 to 4:05 | The sweep's card waits in the tray. On the sweep's attempt card the light `the search for "drain(" in creatures/` is a green circle. The late creature lands by itself. The search light turns into a red diamond: "the search for "drain(" in creatures/ has a new match, and this change had edited the earlier matches." The tray row leaves; the sheet, if open, says the card is out of date. The agent edits the new creature too. A new card opens. The owner taps Land. | When the shrimp reads "Landed", sends the sweep request (P9a). When its card is in the tray, sends the late creature request (P9b). Taps Land on the new card. | "The other direction works too. This agent searched for every creature that drains energy and changed each one. Then a new creature landed. A search result is a premise as well. The agent learns of the new match and finishes the job before I land it." | The second catch: a `query` premise gains a match (`01-core.md` QT1). A card never approves more than it showed. |
| 6 | 4:05 to 4:50 | The owner taps the crab in the pool. The Why card opens: who asked and their words, which model, what it relied on, one go-around and its cause, the agent's sentence, the checks, how it landed. The owner taps "Show the git": commit id, `Change-Id` and `Intent-Id` trailers, the note, two git commands. | Taps the crab. Taps "Show the git". | "Why is this crab like this? I tap it. Who asked, in their words. Which model wrote it. What it relied on. What changed under it, and what it did about that. What the platform checked. This is not a private database. It is an ordinary commit on main in Artifacts, and the record is a git note. Anyone can clone the repository and read it with plain git." | Blog question 4 (why). The record lives in git notes on Artifacts. One record serves landing, review and why. |
| 7 | 4:50 to 5:30 | The owner opens the Why card of the shared-rule change and taps Undo. The sheet names every later change that was built on it, for example: "This also takes back 1 later change that was built on it: crab. Its agent reopens and adapts." and "{n} later changes only read it. They stay." The owner taps "Undo it". The crab's attempt card returns to Working with the tag "Reopened by undo" and the line "Same agent, same conversation." It gets a heads-up with the reversed diff, adapts and lands by itself: it is an ordinary attempt now, not a race candidate (`01-core.md` RC7). The pool keeps running. | Two taps. | "I change my mind. Undo knows which later changes were built on this one, because their premises say so. It takes back exactly those. It wakes the same agent, with the same conversation, to adapt again. Changes that did not depend on it stay." | Causal Undo. Context preservation: a reopened author. |
| 8 | 5:30 to 6:25 | Swarm view. Banner: "SYNTHETIC · 1,024 scripted agents · they make no model calls · same tools, premises and landing path · shared rules land without a tap in this pool". Four large numbers: landings per second, time to land, go-around rate, changes waiting behind another change. Smaller: false-abort rate, escape rate, push backlog, last push. A wall of cells, one per scripted agent. The owner raises the collision dial. | Sets agents, presses Start, moves the dial. | "Real agents are limited by the model rate limit, and the screen says so. To measure the landing path itself I use scripted agents. They are labelled synthetic. They make no model calls. They use the same tools, the same premises and one Trunk. These numbers are measured in this run: *[read the four numbers]*. I turn collisions up. *[Read the go-around rate and the waiting number again.]*" | Measured scale on one Trunk, under the SYNTHETIC banner. Changes with nothing in common land in one push. |
| 9 | 6:25 to 7:05 | About sheet. Left: how it runs (Worker, Trunk, Agent and Floor Durable Objects, Workflows, Workers AI, Artifacts). Middle: what was real, what was synthetic, what was constructed in this run, with counts. Right: the limits list and related work. | Opens About. | "It runs on Cloudflare. One Worker. One Durable Object per pool, which alone writes to main. One per agent. Workflows, Workers AI, and Artifacts for every commit and every note. The limits, plainly. JavaScript modules only. One Trunk per pool, small pools. The scale numbers come from scripted agents. The comparison pool is constructed. Related work also checks what agents read. What differs here is on screen: reads observed at entity, listing and search level, checked live, stored as git notes." | Honest limits. Cloudflare use. No priority claim. |
| 10 | 7:05 to 7:30 | The owner locks the page (visitor role). The start card offers the default recording, which during the take is `rehearsal`: an earlier real-agent run of this same beat sheet (8.2). The owner presses "Play the Replay". The REPLAY banner appears and the same page plays that recorded stream. The public address is on screen. | Taps Owner, then Lock. Taps "Play the Replay". | "A run like this one is recorded as one event stream. Open this address and press Replay. The same page plays it back. No account, no key. Git records what agents wrote. Premise also records what they read." | Replay with no credentials. The page is a function of the stream. |

Why this order is safe (each line is a rule of `01-core.md`):

| Step | Rule that makes it deterministic |
| --- | --- |
| The three crab attempts wait with their premises live. | RC2: a race candidate goes to `held` after its submit, whatever its tier. D1, D3: its reference to `ENERGY_MAX` is a premise from the write on, because D1 pins at every operation. |
| The shared-rule card names the three crab attempts. | 11.6: the blast radius is computed with the rule-based rows when the card opens, at every batch while it is open, and again at the tap. |
| Landing the shared rule turns the three lights red. | Row E2, T8: a referenced entity changed; a `held` attempt goes around. The race card stays open and is updated (RC5). |
| The plain-merge pool has the crab's first version. | PM1, PM2: it replays the operations the attempt held before its first heads-up. |
| The sweep's search has an earlier match that the sweep edited. | The shrimp of the starter set calls `drain(` and has landed before the sweep searches (BS7). QT1 needs at least one earlier match that the sweep altered. |
| The late creature turns the sweep's search light red. | Row QT1, T8: the sweep had altered the earlier matches; its card closes as `stale`. Row QR1 applies in the same heads-up, because the sweep alters `drain` and the new creature uses it. |
| Undo takes back the crab. | UN2: the crab's premise on `ENERGY_MAX` was pinned at the shared-rule landing and is `derived`. Every other later landing with such a premise is taken back too, and the sheet names each one. |
| The reopened crab lands without a card. | RC7: a chosen race candidate is an ordinary attempt. Its tier is `auto`, so its next passing submit goes to the landing queue (vector `C58`). |

What the order does not make certain. Each row is shown honestly by the page, and each is a check of the rehearsals:

| What can happen | What the page shows |
| --- | --- |
| A crab candidate writes its threshold as a share of `ENERGY_MAX`. Its code does not depend on the old scale. | It still goes around (row E2) and its agent changes nothing. If the chosen crab is such a candidate, both pools hold the same files and Compare view says `plain.no_difference` (`02-tidepool.md` TP20, `01-core.md` PM7). The owner chooses a candidate whose heads-up panel says that it changed its number. |
| The shrimp of the starter set has landed before the shared rule changes, and it spends 5 energy on each dart. | No premise is in flight for it, so no heads-up is due (`02-tidepool.md` 7.6, order 2b). Trunk shows the shared-rule agent every piece of code that uses `ENERGY_MAX`, the shrimp included. The after frame of the held card shows whether that agent adapted the shrimp. Premise does not prove that it did (limits list, 5.12). |

### 1.3 Coverage

| Required by the contest or the brief | Beat |
| --- | --- |
| Blog question 1: how do agents know what others are doing | 1, 2, 3 |
| Blog question 2: what happens on conflicting changes | 3, 4, 5 |
| Blog question 3: how do you review everything | 1 (lands by itself), 3 and 5 (held card), 6 (checks) |
| Blog question 4: how do you track why a change was made | 6 |
| Preserve agent context | 3, 7 |
| Compare several changes and decide which ships | 4 |
| Measured scale under the SYNTHETIC banner | 8 |
| Honest limits | 9, and the labels in 0, 1, 4, 8 |
| Replay with no credentials | 10 |
| Several real agents working at once | 1, 3 |
| Workers and Artifacts in use | 6, 9 |

### 1.4 If a SHOULD feature is not in the build

The brief marks the held card, Clef, the green line, Undo and Race as SHOULD. The page and the video MUST still be complete without each of them. Which of them the build has is said by `features` in `/floor.json` (`01-core.md` FJ1). Its keys are `held`, `race`, `undo`, `green`, `clef` and `attempt_repos`, and this file adds none.

| `features` | The page | The video |
| --- | --- | --- |
| `race: false` | No "Race 3" button. | The crab is one attempt. Beat 3 uses the other landing order, paced by the held card: the owner sends the crab request while the shared-rule card waits. The crab lands by itself, the shared-rule card closes as out of date, its light for "the list of code that uses ENERGY_MAX" turns red, its agent adapts the crab too, a new card opens, and the owner taps Land. Beat 4 keeps only the Compare view. The limits list names Race as switched off. |
| `held: false` | The main pool is created from the seed `tidepool-auto` (`01-core.md` PL1), so shared-rule paths are tier `auto` and get no card. A change that still touches a held path gets the card in its minimal form (`01-core.md` HD1; 3.13): the title, the two buttons Land and Decline, no frames, no blast radius, no risk lines and no "Land now". Nothing on a held path lands without the owner's tap in any build. | With Race: beat 3 starts when the shared-rule change lands by itself; the first two voiceover sentences are dropped. Beat 5 depends on timing and is shown from a rehearsed run. |
| `race: false` and `held: false` | Both rows above. | Beats 3 and 5 depend on timing. They are recorded until both catches happen, and the Replay recording is that run. |
| `clef: false` | No risk lines. No "Being checked" light. A changed thing the agent only read gives "Needs a confirm" (`01-core.md` 7.3, TR5). | No change. The script does not mention Clef. |
| `green: "none"` | Strip shows `green.none`. The escape rate shows `strip.dash`. The limits list says so. | No change. |
| `green: "static"` | Strip shows `green.static`. | No change. |
| `undo: false` | No Undo button. | Beat 7 is replaced by 40 more seconds of beat 6: the Why card of the shared-rule change, and Who relies on a landed entity. |
| `attempt_repos: false` | About shows `about.forks_off`. | No change. |

The plain-merge pool is MUST and has no key in `features`. Compare view is absent only for a pool that has no plain-merge repository (`pool.plain_remote` is null, 3.6).

### 1.5 Stage variant (10:00, live)

Differences from 1.2, and nothing else:

1. No cuts. Waiting is covered by speaking about what the lights and tiles show. Because of BS3 every catch waits for the owner's tap, so the pace is the owner's.
2. There is no cut forward. The owner opens by speaking the thesis sentence over the running Floor view (0:00 to 0:40). The sentence is on screen where the page has it: as the last line of Compare view, which appears once, at its place in beat 4.
3. Times: beat 1 0:40 to 1:40; beat 2 1:40 to 2:40; beat 3 2:40 to 4:20; beat 4 4:20 to 5:20; beat 5 5:20 to 5:50; beat 6 5:50 to 6:40; beat 7 6:40 to 7:30; beat 8 7:30 to 8:40; beat 9 8:40 to 9:25; beat 10 9:25 to 10:00.
4. The sweep request of beat 5 is sent at the start of beat 4, so its card is in the tray when beat 5 begins. BS7 still holds: the shrimp has landed by then.
5. The owner taps Land in beat 3 only when the card names the three crab attempts. If fewer are ready after 60 seconds, the owner lands it anyway and says how many were sent back.
6. One fallback. At any stall the owner presses `R`, then the number key of the chapter for the current beat (8.5). Replay plays the default recording from there under the REPLAY banner, and the owner says that it is a recording.
7. The Swarm run in beat 8 is started on stage and runs for at least 45 seconds. If it cannot start, the recording `swarm` is played under both banners.
8. The key is never typed on stage (PS2). The session lasts `SESSION_TTL_S`.
9. Size and theme are set on the venue screen before the talk (PS6).
10. No audience input. The audience phone page is a STRETCH item of the brief and is not part of this specification.
11. On stage the default recording is `hero` (RY26), so beat 10 plays the recording of the submission take, and the owner says so.

---

## 2. Page layout

### 2.1 Regions and sizes

Text inside the wireframes is shortened to fit. Section 5 has the exact text.

Two reference sizes. **Stage size** is 1920×1080 with large type. **Laptop size** is 1440×900 with type at 80%. The page picks the layout from the window width; the owner can force stage type on any width with key `Z`.

| Window width | Layout |
| --- | --- |
| 1600 and wider | Stage layout (2.2 to 2.7), sizes as in the table below. |
| 1100 to 1599 | Laptop layout (2.8): the same regions, pool area 60% of the width, rail 40%. |
| below 1100 | Narrow layout (2.9): one column. |

| Region | Stage size | Laptop size | Content |
| --- | --- | --- | --- |
| Header | 1920×88 | 1440×72 | The masthead: name and pool name, view switch, Needs-you badge, kill switch, owner lock. |
| Strip | 1920×136 (Replay 92) | 1440×112 (Replay 76) | The number band: run clock and six counters (3.8). In Replay it is short, so the pool frame gets the height. |
| Banners | 1920×40 each | 1440×36 each | Zero or more, stacked, in the fixed order of 3.18. |
| Body | the rest | the rest | The view. Padding 24 (laptop 16). |
| Pool area (Floor view) | 1152 wide | 832 wide | Caption bar 40, pool frame 16:9 at full width (1152×648; laptop 832×468), file tiles in the rest. In Replay at stage size the REPLAY banner (40) and the Replay bar (108) leave the pool area 748 high, so LY1 shrinks the frame to 1145×644; each further banner takes its 40 from the frame's height. At laptop size the taller masthead and number band (2026-10-10) leave the frame shorter than 468, so LY1 shrinks it there too. |
| Rail (Floor view) | 696 wide | 560 wide | Intent box, tray, tabs, attempt cards. Only the list of attempt cards scrolls. |
| Replay bar (Replay only) | 1920×108, at the bottom: the transport row (56) above the chapter row (52) | 1440×96 (48 and 48) | Replay controls (3.16) and the chapter caption (8.5). Two rows by the lead's decision of 2026-10-09 (RR11): one row could not hold the named chapter buttons of 3.16 at the 44×44 of LY5 beside the caption of 8.5. |

- **LY1.** The pool frame keeps 16:9. It uses the full width of the pool area unless the file tiles would get less than one row (64 high) at laptop size, or less than two rows of 48-high tiles (112) at stage size; then the frame shrinks and sits flush left under its caption bar.
- **LY2.** Banners and the Replay bar take height from the body. They never overlap the frame, the attempt cards or a sheet.
- **LY3.** The page never scrolls sideways at any width from 320 up. Only the list of attempt cards, the tile overflow list, sheets and the git drawer scroll, and only vertically.
- **LY4.** Sheets leave the header, the strip and the banners visible and usable.
- **LY5.** Tap targets are at least 44×44.

### 2.2 Floor view, stage size

```
+----------------------------------------------------------------------------------------------------+
| PREMISE  tide pool    [Floor] [Swarm] [Replay] [About]      (Needs you 1)  [Stop all agents] [Owner] |  64
+----------------------------------------------------------------------------------------------------+
| 00:03:41 | Real agents | Landed | Go-arounds | Waiting behind   | Green line     | Spend            |  72
| run clock| 10 of 12    |   14   |     3      | another change 0 | landing 12     | $3.12 of $40.00  |
+----------------------------------------------------------------------------------------------------+
| (banners, only when active)                                                                         |  40 each
+-------------------------------------------------------------+--------------------------------------+
| POOL AREA 1152                                              | RAIL 696                             |
| Premise · main · landing 14              [Pause] [Compare]  | +----------------------------------+ |
| +---------------------------------------------------------+ | | Ask for a change in plain words. | |
| |                                                         | | | [.............................]  | |
| |                                                         | | | 0 of 500   [Send]  [Race 3]      | |
| |             pool frame  1152 x 648                      | | | Pre-written requests  v          | |
| |             (sandboxed iframe, main at the              | | +----------------------------------+ |
| |              newest landed commit)                      | | NEEDS YOU (1)                        |
| |                                                         | | > This change touches shared rules.  |
| |                                                         | |   Land it?                  [Open]   |
| |                                                         | | [Working 6] [Landed 14] [Stopped 1]  |
| +---------------------------------------------------------+ | +----------------------------------+ |
| world/     [energy  ooo #] [movement o ] [food    ] [time ] | | attempt card (going around, top) | |
| creatures/ [fish     o   ] [snail      ] [crab   #] [eel #] | +----------------------------------+ |
|            [urchin  #    ] [+9 more    ]                    | | attempt card                     | |
| (o = one reader, # = one writer)                            | | attempt card                     | |
+-------------------------------------------------------------+--------------------------------------+
```

### 2.3 Compare view, stage size

The rail is hidden. Opened by the Compare button or key `C`. Closed by the same, or by Esc. Under each frame is its self-test badge (CO25a). The last line is the thesis sentence (`app.thesis`). The badge on the right is an example: in the run of 1.2 both badges are expected to read passed, because the pool's self-test does not see a crab that never comes out (`02-tidepool.md` 7.8).

```
+----------------------------------------------------------------------------------------------------+
| header 64                                                                                          |
| strip 72                                                                                           |
+-------------------------------------------------+--------------------------------------------------+
| Premise · main · landing 14                     | Same changes, merged by plain git                |
|                                                 | Constructed for comparison · through landing 14  |
| +---------------------------------------------+ | +----------------------------------------------+ |
| |            pool frame 924 x 520             | | |           pool frame 924 x 520               | |
| +---------------------------------------------+ | +----------------------------------------------+ |
| Self-test, run in this page: passed             | Self-test, run in this page: failed · 1 check    |
+-------------------------------------------------+--------------------------------------------------+
| WHAT DIFFERS                                                                                       |
| crab: went around once after ENERGY_MAX changed. The plain-merge pool has its first version.       |
| eel:  went around once after ENERGY_MAX changed. The plain-merge pool has its first version.       |
| Text conflicts in the plain merge: 0 (approximated)                         [Back to the Floor]    |
| Git records only what an agent wrote. Premise also records what it read.                           |
+----------------------------------------------------------------------------------------------------+
```

### 2.4 Card sheet (held change) and race sheet, stage size

Since 2026-10-10 the held frames at stage are 725×408, not the 808×454 the wireframe below draws: the taller masthead and number band (2.1) leave less height, and the decision row must stay in the window.

Centred sheet, 1680 wide, over the body. The same sheet serves kinds `held`, `race` and `choice`.

```
HELD CHANGE
+------------------------------------------------------------------------------------------------+
| This change touches shared rules. Land it?                                              [Close] |
| owner: "make energy a fraction from 0 to 1"                                                     |
| +-------------------------------------------+ +-----------------------------------------------+ |
| | Before: the pool now                      | | After: the pool with this change              | |
| |          frame 808 x 454                  | |          frame 808 x 454                      | |
| +-------------------------------------------+ +-----------------------------------------------+ |
| WHAT IT CHANGES             | WHO IT AFFECTS                    | WHAT WAS CHECKED               |
| world/energy.js  (Held)     | Landing this sends 3 changes back | 7 of 7 checks passed.          |
| ENERGY_MAX                  | to their agents: crab (…) ×3      | Relies on  (o)(o)(o)(o)        |
|                             | 3 changes in flight have a        | Does what was asked: 94%       |
|                             | premise on what it changes.       | Changes the meaning of shared  |
|                             | 8 landed changes rely on it.      | code: 91% · Edits nobody asked |
|                             |                                   | for: 2%                        |
| Reason (optional) [..........................................]         [Decline]   [ Land ]    |
+------------------------------------------------------------------------------------------------+

RACE
+------------------------------------------------------------------------------------------------+
| 2 of 3 attempts at "a crab that hides in its shell when its…" are ready. Choose one.    [Close] |
| +----------------------------+ +----------------------------+ +----------------------------+   |
| |     frame 536 x 302        | |     frame 536 x 302        | |   Still working            |   |
| +----------------------------+ +----------------------------+ +----------------------------+   |
| gpt-oss-120b                 | glm-5.3-flash                 | kimi-k2.7-code                  |
| Relies on (o)(o)(o)          | Relies on (o)(o)(o)(o)        | Working · step 9                |
| 7 of 7 checks passed.        | 7 of 7 checks passed.         |                                 |
| Took 48 s · Cost $0.01       | Took 1 min 12 s · Cost $0.02  |                                 |
| Would send back: 0 changes   | Would send back: 2 changes    |                                 |
| [Choose this one]            | [Choose this one]             |                                 |
| Reason (optional) [.....................................................]                      |
+------------------------------------------------------------------------------------------------+
```

The buttons of a sheet are the options of its card, with the labels that Trunk sent (5.10). The first option is the primary button and sits at the right. A held sheet shows a third button, "Land now", only while its card offers the option `land_now` (CO35a). A `choice` card uses the same sheet with no frames: the title, at most two sentences, and two buttons. A `held` card in a build without `features.held` uses the sheet with no frames either (the minimal form, 3.13).

### 2.5 Why sheet and the git drawer, stage size

The Why sheet is 760 wide on the right edge, over the rail. The pool area stays visible, so the tapped creature stays in view. The git drawer is 720 wide and opens to the left of the Why sheet.

```
+-----------------------------+-----------------------------------+----------------------------------+
| pool area (440 visible)     | SHOW THE GIT             [Close]  | WHY IS THIS HERE?        [Close] |
|                             | This is an ordinary git commit    | crab · landing 11 · 14:03:44     |
|   (pool frame keeps         | on main, in Artifacts.            | WHO ASKED                        |
|    running; the tapped      | commit  9f2c…e1a7        [Copy]   | owner: "a crab that hides in its |
|    creature is outlined)    | parent  41b0…77c2                 |  shell when its energy drops…"   |
|                             | tree    c07d…0b9e                 | WHO WROTE IT                     |
|                             |                                   | A real agent on glm-5.3-flash.   |
|                             | Add a crab that hides when its    | WHAT IT RELIED ON                |
|                             | energy is low                     | (o) ENERGY_MAX in world/energy.js|
|                             |                                   | (o) the file creatures/crab.js   |
|                             | Intent: a crab that hides in its… | WHAT CHANGED UNDER IT            |
|                             |                                   | Go-around 1: ENERGY_MAX in       |
|                             | Change-Id: c_01JB2M8Q…            | world/energy.js changed, and     |
|                             | Intent-Id: i_01JB2M7A…            | this change uses it (landing 9). |
|                             |                                   | The agent said: "Energy is now…" |
|                             | The record above is this git note.| WHAT WAS CHECKED                 |
|                             | { "v": 1, "seq": 11, … }          | 7 of 7 checks passed.            |
|                             |                                   | HOW IT LANDED                    |
|                             | Read it yourself with plain git:  | The owner chose it from 3        |
|                             | git fetch origin refs/notes/…     | attempts at 14:03:20.            |
|                             | git log --notes=premise   [Copy]  | [Show the git] [Who relies] [Undo]|
+-----------------------------+-----------------------------------+----------------------------------+
```

The Who relies panel uses the same slot and width as the Why sheet.

### 2.6 Swarm view, stage size

```
+----------------------------------------------------------------------------------------------------+
| header 64                                                                                          |
| strip 72                                                                                           |
| /// SYNTHETIC · 1,024 scripted agents · they make no model calls · same tools, premises and … ///   |  40
+------------------------+------------------------+------------------------+-----------------------+
| LANDINGS PER SECOND    | TIME TO LAND           | GO-AROUND RATE         | WAITING BEHIND        |
|        41.2            |   180 ms               |      12%               | ANOTHER CHANGE   0    |
| last 10 s              | median · p99 640 ms    | last 10 s              | now                   |
+------------------------+------------------------+------------------------+-----------------------+
| False-abort rate 3% (target 5%) | Escape rate 0% (target 0%) | Push backlog 0 | Last push: 1 push, 37 changes |
+----------------------------------------------------------------------------------------------------+
| WALL: one cell per scripted agent                                                                  |
| [][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] |
| [][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][] |
| ... cell colour and shape = state (working, going around, landing, landed, stopped)               |
+----------------------------------------------------------------------------------------------------+
| Agents [64] [256] [1,024] [2,048]   Collisions [----o-----] 40%   [Start] [Stop]                   |
| Real agents in the main pool: 12 at most. The limit is the model rate. This run: 1 pool, 1 Trunk.  |
+----------------------------------------------------------------------------------------------------+
```

### 2.7 Replay, stage size

Replay uses the same views. It adds the REPLAY banner and the Replay bar. A visitor on a quiet pool sees the start card over the pool area.

The Replay bar has two rows, 108 high in all (the lead's decision of 2026-10-09 under RR11). The transport row (56) is on top. The chapter row (52) below it holds the named chapter buttons and, beside them, the caption of the current chapter (8.5).

```
+----------------------------------------------------------------------------------------------------+
| header 64 (no kill switch, owner lock shows "Visitor")                                             |
| strip 72 (values of the recording at the Replay position)                                          |
| :::::: REPLAY · recorded 10 Oct 2026 · "The conflict, real agents" · nothing here changes a pool ::|  40
+-------------------------------------------------------------+--------------------------------------+
| pool area: frames run the recorded code at the commit of    | rail: the attempt cards of the       |
| the Replay position                                         | recording. Requests are off.         |
+-------------------------------------------------------------+--------------------------------------+
| [Play/Pause] [Restart]  01:42 of 06:10  |--o--------|--------|-----|------|   Speed [1x]  [Close]  |  56
+----------------------------------------------------------------------------------------------------+
| [Requests] [Held change] [Conflict] [Second catch] [Undo] [Race]   A change landed. Agents that    |  52
|                                                                    relied on the old version get…  |
+----------------------------------------------------------------------------------------------------+

START CARD (visitor, quiet pool), 640 wide, centred over the pool area
+--------------------------------------------------------------+
| Watch a recorded run                                         |
| This plays a real recorded run through this same page.       |
| You need no account and no key.                              |
| [Play the Replay (6 min)]      [Look around the live pool]   |
+--------------------------------------------------------------+
```

### 2.8 Laptop layout (1100 to 1599 wide; reference 1440×900)

The regions and their order are the same as in 2.2. Differences:

| Item | Laptop |
| --- | --- |
| Type | 80% of stage type, never below 14 (6.2). |
| Pool area and rail | 60% and 40% of the width (832 and 560 at 1440). Pool frame 16:9 at the width the masthead and number band leave it (LY1). |
| File tiles | Compact tiles (84×48), as many rows as fit, then `tiles.more`. |
| Strip | The same seven cells. Labels may wrap to two lines. |
| Card sheet | Width 96% of the window. Held frames 2×(544×306), so the decision row stays in the window under the masthead and the number band (2026-10-10). Race frames 3×(428×241). |
| Why sheet and git drawer | Why sheet 560 wide. The git drawer covers the pool area instead of sitting beside it. |
| Swarm view | The four large numbers stay in one row at 120 high. The wall gets the rest. |

```
+--------------------------------------------------------------------------+
| PREMISE tide pool [Floor][Swarm][Replay][About] (Needs you 1) [Stop][Owner] | 56
| 00:03:41 | Agents 10/12 | Landed 14 | Go-arounds 3 | Waiting 0 | Green | Spend | 60
+---------------------------------------------+----------------------------+
| Premise · main · landing 14 [Pause][Compare]| Ask for a change…          |
| +-----------------------------------------+ | [...................]      |
| |        pool frame 832 x 468             | | [Send] [Race 3]            |
| +-----------------------------------------+ | NEEDS YOU (1)   [Open]     |
| world/ [energy][movement][food][time]       | [Working][Landed][Stopped] |
| creatures/ [fish][snail][crab][+9 more]     | attempt cards              |
+---------------------------------------------+----------------------------+
```

### 2.9 Narrow layout (below 1100 wide)

One column, in this order: header (view switch becomes a menu), strip (wraps to two rows), banners, intent box, tray, pool frame (full width, 16:9), tabs and attempt cards, file tiles behind the disclosure `tiles.files`. Sheets are full-screen. Compare view stacks the two frames. All functions stay available. This layout is for reading on a small screen; it is not a stage layout.

### 2.11 Overview (owner's design decision of 2026-10-10)

The Overview tells the run the way a product page would: one hero, one sentence, and the rest one key away. A live page opens on it when `/floor.json` says `default_view: "overview"` (the deployments do); Replay opens on the Floor view. Key `O` and `nav.overview` open it; key `F` and `nav.floor` go to the Floor view.

| Part | Content |
| --- | --- |
| Header and banners | As on every view (2.10, FL4). The strip is not drawn: its numbers are in the headline and the facts line. |
| Headline | `overview.landed` then `overview.goarounds`, from `counters.landed_changes` and `counters.go_arounds`; `overview.landed.none` before the first landing; `overview.loading` before the first event. Under it `overview.waiting.none` when `metrics.waiting_behind` is 0 or unknown, else `overview.waiting`. For a visitor on a quiet pool the start card's `start.play` button sits under it (RY23). |
| Hero | The main pool's live frame (3.5), rounded, with its caption bar, Pause and Compare. |
| In flight | `overview.inflight`, then at most 3 attempts in flight, newest event first: status shape and word (5.3), intent, model and elapsed time. A card with an open decision opens its card sheet; any other opens the Floor view. `overview.more` opens the Floor view. |
| Input | The intent box (3.1) with its rules, drawn as one pill. |
| Facts line | Every other strip cell (3.8) as "label value", followed by " — sub" when the cell has a sub-line, joined by " · ", so the run clock, the real-agent limit and its reason (FL4), the waiting count, the green line and the spend stay on screen. |

### 2.10 Always visible

In every view, sheet and mode, at stage and laptop size, these are on screen:

| Item | Where |
| --- | --- |
| Run clock | Strip |
| Real agents and their limit | Strip |
| Landed, go-arounds, waiting behind another change | Strip |
| Green line | Strip |
| Spend and cap | Strip |
| Needs-you badge with the number of open cards | Header |
| Kill switch (owner, live) | Header |
| Owner lock state | Header |
| SYNTHETIC banner, when the pool or the recording is synthetic, and always in Swarm view | Banners |
| REPLAY banner, in Replay | Banners |
| Any failure banner of section 7 | Banners |

---

## 3. Components and their states

Each component lists its inputs (fields of `FloorState`, 4.1, or `ViewState`, 4.2), what it shows, and one row per state. The state names are the same for every component: **empty** (nothing to show yet), **loading** (waiting, with a sentence), **live** (normal), **held** (waiting for a person, or blocked for a stated reason), **error** (something failed; the sentence says what and what to do), **stopped** (ended; no further change expected). "n/a" means the state cannot occur. Copy ids point to section 5.

The component state "held" is a state of a part of the page. It is written as a plain word in the first column of a state table. The attempt state `held`, the tier `held` and the card kind `held` are values of `01-core.md` and are always written in code type.

- **CO1.** A component shows exactly one state at a time, chosen by the first matching row of its table, top to bottom.
- **CO2.** A button that sends a request is disabled from the tap until the response arrives, and shows its `…ing` label. Every such request carries a fresh `request_id` (`01-core.md` 9.8).
- **CO3.** When the connection is lost (7, row FR10), every component keeps its last content, dimmed to 60%, and no owner control is enabled.

### 3.1 Intent box

Inputs: owner session, `pool.state`, `limits`, `pool.real_agents`, `pool.max_real_agents`, the draft text, the pre-written requests and `features.race` (static file, 4.5).

Shows: a text field (one to four lines, at most `MAX_INTENT_CHARS` characters), a character count, two buttons (`intent.send`, `intent.race`), and the menu `intent.prewritten` with the button `intent.starter`. The button `intent.race` is absent when `features.race` is false.

| State | When | Shows | Enabled |
| --- | --- | --- | --- |
| stopped | Replay | `intent.replay` in place of the field | nothing |
| held | visitor | field disabled, `intent.visitor` | nothing |
| held | `limits.killed` | `intent.killed` | nothing |
| held | pool state `paused` or `rebuilding` | `intent.paused` or `intent.rebuilding` | nothing |
| held | spend cap reached (7, row FR8) | `intent.cap` | nothing |
| loading | a create request is in flight | field read-only, button label `intent.sending` | nothing |
| loading | the request succeeded and its `intent.created` has not arrived within `SENT_WAIT_MS` | `intent.sent_waiting` | field |
| error | the last request failed | the draft is kept; the error sentence of 5.9 under the field | field, buttons |
| empty | draft is empty | placeholder `intent.placeholder` | field, menu |
| live | draft has 1 to `MAX_INTENT_CHARS` characters | count `intent.count` | all |

Rules:

- **CO4.** A draft longer than the limit cannot be typed: input stops at the limit and the count turns to the warning colour.
- **CO5.** Enter sends. Shift+Enter makes a new line. `intent.race` sends the same text with `race: true`.
- **CO6.** When every agent slot is busy (`real_agents >= max_real_agents`) the box stays enabled and shows `intent.queue`. The new attempt card shows `status.queued`.
- **CO7.** Choosing a pre-written request fills the field and does not send. `intent.starter` sends the starter set in one tap: one create request, with its own `request_id`, for each pre-written request whose `group` is `starter`, in the order of `/floor.json` (the six requests of 1.2). The button is disabled until every one of those requests has answered, and it is absent once an intent with the text of a starter request exists in `intents`, so a second tap cannot send the set twice. Every create request for a pre-written request carries `prewritten: true`. Its intent is tagged `attempt.tag.prewritten` on its attempt card and in its Why card (`intent.created.prewritten`).
- **CO8.** The draft is cleared when the `intent.created` event with the returned `intent_id` arrives, not when the request returns.

### 3.2 Attempt card

Inputs: one `AttemptView` and its intent.

Anatomy, collapsed (stage size 696×132):

```
+--------------------------------------------------------------------+
| owner                                            gpt-oss-120b · 42 s|
| "a crab that hides in its shell when its energy drops below 30"    |
| <> Going around · sent back 1 of 3  Relies on  (o)(o)<!>(o)(o) +3  |
| ENERGY_MAX changed. The diff was sent to the agent.                |
+--------------------------------------------------------------------+
```

Line 1: requester, tags (`attempt.tag.prewritten`, `attempt.tag.synthetic`, `attempt.tag.reopened`, `attempt.tag.right_of_way`, and `attempt.tag.mcp` for an outside agent, `07-mcp.md` MC24, added 2026-10-10 by the owner's decision to build the extensions), model short name, time since `opened_ts`. Line 2: the intent text, at most two lines, then an ellipsis. Line 3: status shape and word (5.3), then `attempt.sent_back_n` when `go_arounds + pull_backs` is above 0, then the lights (3.3). Line 4: the activity line (5.5), or the newest heads-up sentence, or the stop sentence.

Expanded (tap or Enter on the attempt card) adds, in this order: heads-up panels (3.4), "Relies on" as a list (3.3), "What it changes" (paths and entities from `ops`), checks (5.7), and for an owner the button `attempt.stop` (the stop route of 4.5). While the stop request is in flight the button is disabled and reads `attempt.stopping` (FL10, amended 2026-10-07).

| State | When (`AttemptView.state`) | Status word | Line 4 |
| --- | --- | --- | --- |
| loading | `opened`, slots full | `status.queued` | `attempt.queue` |
| loading | `opened` | `status.opened` | `attempt.starting` |
| live | `working` | `status.working` | activity line |
| live | `going_around` | `status.going_around` | newest unresolved heads-up sentence, then activity |
| live | `needs_confirm` | `status.needs_confirm` | newest unresolved heads-up sentence |
| live | `submitted` | `status.submitted` | `attempt.waiting_clef` |
| live | `validated` | `status.validated` | `attempt.next_batch`, or the `tick.skipped` sentence (5.6) |
| held | `held` | `status.held` | `attempt.open_card` (a link that opens the card sheet) |
| live | `accepted`, or `landed` before its `landing.landed` | `status.accepted` | `attempt.landing` |
| stopped | `landed` and its `landing.landed` has arrived | `status.landed` | `attempt.landed_as` |
| stopped | `stopped` | `status.stopped`, or `status.undone`, `status.not_chosen`, `status.declined` | the stop sentence (5.8) |
| error | overlay on any live state: last step failed, a submit was rejected, or the model is slow (7, rows FR1 to FR3) | unchanged | the error sentence, in the warning colour |
| empty | n/a (the list's empty text is `rail.empty.working`) | | |

Rules:

- **CO9 (order).** In the Working tab, attempt cards whose state is `going_around` or `needs_confirm` are in a group at the top, in the order they entered it. All other attempt cards follow, newest intent first. An attempt card moves only when it enters or leaves the top group. Attempts of one race are one group under their intent text; the group moves as one and is in the top group while any of its attempts is.
- **CO10 (density).** With more than 5 attempt cards the list uses compact attempt cards (72 high: intent on one line; status, lights and model on the second). With more than 9 it scrolls and the footer says `rail.more`.
- **CO11 (auto-expand).** When a heads-up of result `repair` or `confirm` arrives, the attempt card's newest heads-up panel opens by itself. At most `AUTO_EXPAND_MAX` panels are open by themselves at once; the oldest closes first. A panel the owner opened stays open.
- **CO12 (landing).** On `landing.landed` the attempt card shows `status.landed` for 1.2 s, then moves to the Landed tab (6.4). The Landed tab row opens the Why card.
- **CO13 (reopened).** A reopened attempt (`attempt.reopened`) returns to the Working tab with the tag `attempt.tag.reopened`. It shows `attempt.same_agent` when `model_changed` is false and `attempt.model_changed` when it is true, until it lands or stops (`01-core.md` UN6; in this build no rule lets another model take over, so `model_changed` is always false). A reopened attempt that was the chosen candidate of a race returns as one attempt card of its own, not as a race group: it is an ordinary attempt (`01-core.md` RC7). If its agent cannot be started again, the attempt stops with `reopen_failed` and a card opens (`01-core.md` RS4; row FR23).
- **CO13a (a `summary_only` pool).** In a pool whose `pool.summary_only` is true, the stream carries no steps, premises or operations (`01-core.md` EV6). An attempt card there shows lines 1 to 3 without lights, and the list ends with the line `rail.summary_only`.

### 3.3 Premise lights

Inputs: `AttemptView.premises`.

One light per premise. The light's state is `PremiseView.light`. Shape and colour both carry the state, so the state is readable without colour.

| Light | Shape | Colour token | Word | When |
| --- | --- | --- | --- | --- |
| `holds` | filled circle | `holds` | `light.holds` | The premise holds. |
| `changed` | filled diamond | `changed` | `light.changed` | Newest judgment is `repair` and its heads-up is not resolved. |
| `confirm` | filled triangle | `confirm` | `light.confirm` | Newest judgment is `confirm` (not a blind spot) and its heads-up is not resolved. |
| `blind_spot` | ring (hollow circle) | `confirm` | `light.blind_spot` | Newest judgment is rule `B1` and its heads-up is not resolved. |
| `checking` | half-filled circle | `checking` | `light.checking` | Newest judgment is of class `triage` with no result yet. Its heads-up item has result `pending`. |

A premise with `edit` true has a short bar under its light (`light.flag.edit`).

- **CO14 (order and count).** Lights are ordered: `changed`, `blind_spot`, `confirm`, `checking`, then `holds` in the order recorded. A collapsed attempt card shows at most `LIGHTS_MAX` lights, then `light.more`. Lights that are not `holds` are never hidden behind the count.
- **CO14a (holds counted).** When a collapsed attempt card has more than 3 `holds` lights (counting those behind `light.more`), it draws none of them: it draws the other lights, then one small circle in the `holds` colour with `light.holds_count`. The expanded card and the card sheet still list every premise. (Owner's design decision of 2026-10-10: show the exceptions, count the rest.)
- **CO15 (size).** A light is 28 across on an attempt card at stage size, 20 in a compact attempt card, 16 in a list.
- **CO16 (name).** Hover, focus or tap on a light shows `keyLabel` (5.2), the word, and the flags (`light.flag.read`, `light.flag.edit`, `light.flag.derived`). The accessible name is the same sentence (6.5).
- **CO17.** The expanded list has one row per premise: light, `keyLabel`, word, flags, the newest judgment sentence (5.6), and the link `who.open`.
- **CO18.** A light changes only on the events listed in 4.3. A light never turns to `holds` because time passed. A light leaves only on `premise.removed`.

### 3.4 Heads-up panel (inside an attempt card)

Inputs: one `HeadsUpView`.

```
+--------------------------------------------------------------------+
| Heads-up 1 · go-around 1                                           |
| Changed by: "make energy a fraction from 0 to 1" (landing 9)       |
| ENERGY_MAX in world/energy.js changed, and this change uses it.    |
|   Before   // Energy is counted in points, from 0 (empty) to …     |
|            export const ENERGY_MAX = 100;                          |
|   After    // Energy is a fraction, from 0 (empty) to …            |
|            export const ENERGY_MAX = 1;                            |
|   Its own lines that use it                                        |
|   creatures/crab.js line 1                                         |
|     import { ENERGY_MAX } from "../world/energy.js";               |
|   creatures/crab.js line 8                                         |
|     return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, … };      |
| The agent said: "Energy is now a fraction from 0 to 1, so the      |
| crab hides below 0.3."                                             |
+--------------------------------------------------------------------+
```

The lines under `headsup.uses` are the `uses` of the item: the attempt's own lines that reference the key (`01-core.md` 8.2). For the crab these are its import and the line in `spawn`. The line that holds the old number (`crab.energy < 30`) does not name `ENERGY_MAX`, is not in `uses`, and is not shown here. The agent connects the two, and its statement says what it changed.

| State | When | Shows |
| --- | --- | --- |
| live | result `repair`, not resolved | red edge, title `headsup.title.repair`, cause line, one block per item, dropped edits (`headsup.dropped`) |
| live | result `confirm`, not resolved | amber edge, title `headsup.title.confirm`, the same blocks. A blind spot has no "before". |
| live | result `info` | neutral edge, title `headsup.title.info`, the same blocks, `headsup.nothing_to_do` |
| stopped | resolved | edge in the `holds` colour, the statement under `headsup.said` |
| held | the attempt stopped before resolving it (a parked attempt keeps its waiting heads-ups, `01-core.md` GL3a) | `headsup.waits` |
| error | `items` is null (a `summary_only` pool) | the rule sentence of each key only, and `headsup.no_diff` |
| empty, loading | n/a | |

One block per item (`HeadsUpItem`, `01-core.md` 8.2), by the kind of its `diff`:

| `diff.kind` | The block shows |
| --- | --- |
| `entity` | the rule sentence of 5.6; `headsup.before` and `headsup.after` with the two sources (`headsup.now` alone when `before` is null); `headsup.before_unavailable` when `before_unavailable` is set; `headsup.uses` |
| `file` | the rule sentence; the unified diff under `headsup.before` and `headsup.after` marks; `headsup.uses` |
| `listing` | the rule sentence; `headsup.added`, `headsup.removed` |
| `query` | the rule sentence; `headsup.added` with the source of each new member; `headsup.removed`; `headsup.context` with the source of each `context` entry (for the hero in the other landing order this is the entity that holds the old number) |
| `check` | the rule sentence for `checks_failed_at_landing`, or for a revert `headsup.check`, with the label of the check (5.7) |

An item whose result is `pending` shows the pending sentence of 5.6. An item with `truncated: true` adds `headsup.truncated`.

- **CO19.** Before and after are shown in the code type, at most 12 lines each, then `headsup.show_all`. Characters that differ between before and after are marked with an underline and a background, not with colour alone.

### 3.5 Live pool frame

Inputs: `pool.landed_commit`, `pool.landed_seq`, `pool.state`, `green`, `ViewState.pool_paused`, `ViewState.frames`.

Shows: a caption bar (`frame.main.caption`) with the buttons `frame.pause` and `frame.compare`, and one iframe.

- **CO20 (sandbox and address).** The iframe has `sandbox="allow-scripts"` and no other sandbox token, and the `title` of `frame.main.title` (`01-core.md` SE13). In live mode it is a live frame on the source `main`: its address is `/pool/{pool}/main/` with the page parameter `seed` (`02-tidepool.md` 4.2, 4.5). In live mode it is never addressed by commit. In Replay it is a commit frame (8.6).
- **CO21 (a new landing).** When `landing.landed` arrives, the Floor waits `FRAME_ADVANCE_DEBOUNCE_MS` (so one batch gives one message) and then posts `{ type: "probe" }` to the frame (`01-core.md` SE16a). The host looks for the new version, swaps it in without a page reload (`02-tidepool.md` 4.6, 4.7) and answers with `stats`. The frame is current when `stats.version` is `c-` followed by `pool.landed_commit`. If the answer names an older version, the Floor posts `probe` once more after `FRAME_PROBE_RETRY_MS`; the host's own check every `HEAD_POLL_MS` covers a lost message. The Floor never reloads a live frame because a landing arrived, and never sends a live frame `advance`.
- **CO22 (messages).** The Floor accepts a message only when `event.source` is this iframe's window and the shape matches the schema of `01-core.md` SE16. A `tapped { creature, path }` message opens the Why card of `whyTarget(path)` (3.9). A `stats` message is kept in `ViewState.frames` and is used for three things only: the check that a frame runs the version it should (CO21, RY17), the stall watch (7, row FR28) and the self-test badge (CO25a). Every string in a message is text (FL8).
- **CO23.** An accepted but not yet landed change never appears in the frame (FL3). While any landing is accepted and not landed, the caption bar shows `frame.landing`.
- **CO23a (pause).** `frame.pause` posts `{ type: "pause" }` to every pool frame on screen and `frame.play` posts `{ type: "resume" }`. The Floor also pauses a frame that is not visible (`02-tidepool.md` AS14).
- **CO23b (outline).** While the Who relies panel is open, the Floor posts `{ type: "highlight", kinds }` to the frame, with the kinds of the creature files in the panel's lists (the file name without directory and extension, for files directly in `creatures/`). It posts `{ type: "highlight", kinds: [] }` when the panel closes.

| State | When | Shows |
| --- | --- | --- |
| loading | no commit known yet, or the iframe has not finished loading | `frame.loading` over a still background |
| error | the iframe does not finish loading within `FRAME_LOAD_TIMEOUT_MS`, or reports an error | `frame.error` and the button `frame.reload`. Attempt cards and counters keep working. |
| error | the frame sent no `stats` for `POOL_STALL_MS` while it was visible and not paused (7, row FR28) | the fallback of row FR28: `frame.stalled.green`, or `frame.stalled.reloaded`, or `frame.stalled`, each with the button `frame.reload` |
| held | `ViewState.pool_paused` (the Pause button, or the reduced-motion default, 6.4) | the last drawn picture, `frame.paused`, button `frame.play` |
| stopped | pool state `paused` or `rebuilding` | the app keeps running the newest landed commit; caption adds `frame.pool_paused` |
| empty | `pool.landed_seq` is 0 | the seed pool; caption `frame.main.seed` |
| live | otherwise | the pool at the newest landed commit |

### 3.6 Plain-merge pool frame and Compare view

Inputs: `plain` (4.1), `pool.plain_remote`, `landings`, `ViewState.frames`.

Shown only in Compare view, beside the live pool frame, with the same sandbox and message rules (CO20, CO22; a `tapped` message is ignored). In live mode it is a live frame on the source `plain`: its address is `/pool/{pool}/plain/`. The Floor posts `probe` to it when `plain.updated` arrives, and CO21 applies with `p-` followed by `plain.commit` (`01-core.md` PM6, SE16a).

- **CO24 (label).** The caption is always `plain.label` on the first line and `plain.constructed` on the second. Neither can be hidden.
- **CO24a (the same start).** Compare view has its own two frames. When the view opens, the Floor sets the `src` of both in the same task and gives both the same `seed` (`02-tidepool.md` AS13), so both pools start from the same world and differ only by their code. The frame of Floor view is paused while Compare view is open (CO23a).
- **CO25 (what differs).** Under the two frames and their badges, in this order:
  1. The title `plain.differs`.
  2. One line per landed change of kind `change` that had at least one heads-up of result `repair` or `confirm` before it landed: `plain.diff_line`, `plain.diff_line.many` or `plain.diff_line.confirm`. For a landing whose `seq` is in `plain.interrupted`, the line is `plain.interrupted` instead: its agent was sent back in the middle of its work, so the plain-merge pool holds unfinished work for it (`01-core.md` PM4).
  3. `plain.no_difference`, only when the two pools hold the same files: `plain.tree` equals `landed.tree` of the landing `plain.through_seq` (`01-core.md` PM7). The page never says this from what the frames draw. When that landing is no longer held in full, the line is not shown.
  4. `plain.conflicts`, with the number of entries in `plain.skipped`. The words "(approximated)" are part of the text (`01-core.md` PM3), and the tooltip `plain.conflicts.tip` says why. While `features.text_merge` is on, the line is `plain.conflicts.merged` with the tooltip `plain.conflicts.merged.tip` instead: the count is that of a three-way merge (`01-core.md` PM3a), so the page does not say "approximated" (added 2026-10-10 by the owner's decision to build the extensions).
  5. The button `compare.back`.
  6. The thesis sentence `app.thesis`, as the last line of the view.

  The list is computed from the stream only.
- **CO25a (self-test badge).** Under each of the two frames is one badge. It is fed only by that frame's `stats.selftest` (`02-tidepool.md` 5.5). When both frames have reported `stats`, and after every swap while Compare view is open, the Floor posts `{ type: "probe", selftest: true }` to each frame. A badge shows `selftest.running` until `stats.selftest.version` equals that frame's `stats.version`, and then `selftest.pass`, or `selftest.fail` followed by one line `selftest.fail.line` per failed check: its label (5.7) and, in brackets, the kind it names. The badge is the pool's own self-test, run in this page. It is not the green line and never moves it; the tooltip `selftest.tip` says so. The badge also works in Replay, where a `probe` to a commit frame runs the self-test and nothing else.

| State | When | Shows |
| --- | --- | --- |
| stopped | `pool.plain_remote` is null (the pool has no plain-merge repository) | the Compare button is absent |
| loading | `plain` is null, or the iframe is loading | `plain.loading` |
| error | iframe time-out or error, or no `stats` for `POOL_STALL_MS` (7, rows FR20 and FR28) | `frame.error` or `frame.stalled`, and `frame.reload` |
| held | `plain.through_seq` is behind `pool.landed_seq` | the frame at its commit, caption adds `plain.behind` |
| empty | no landed change had a heads-up of result `repair` or `confirm` | both frames run; the list says `plain.same`, then the lines 3 to 6 of CO25 |
| live | otherwise | the frame, the badges and the list of CO25 |

### 3.7 File tiles

When every file of a directory has the tier `held`, the directory's label carries the one `tile.held` tag and its files carry none (owner's design decision of 2026-10-10). The root's label is not a directory: its files keep their own tags.

Inputs: `files`.

One tile per file that exists at the newest landed commit, grouped by directory. A group starts with a label cell that carries the directory name. A tile shows the file name without its directory and extension (in a pool made from a repository, `06-repos.md` IR12, with its extension, because such a pool often holds files that differ only by extension, for example `index.js` and `index.d.ts`; added 2026-10-05), up to 5 reader marks (small rings) and up to 5 writer marks (small filled squares), then `tile.more_marks`. A held path carries the tag `tile.held`. The file list and each path's tier come from `pool.files`.

| State | When | Shows |
| --- | --- | --- |
| loading | no `pool.files` event yet | grey cells, `tiles.loading` |
| live | a file with no reader and no writer | name only |
| live | readers or writers present | marks; accessible name `tile.name` |
| live, just landed | a `landing.landed` changed the file | the tile edge glows for 2 s (6.4) |
| held | the path's tier is `held` | tag `tile.held` |
| stopped | a landing removed the file | the tile shows `tile.removed` for 2 s, then leaves |
| empty, error | n/a | |

- **CO26.** A reader mark is one attempt in flight with a premise of kind `entity`, `file` or `query outline:` on the file with `read` true. A writer mark is one attempt in flight with a current operation on the file. A listing premise or a text search over a directory puts one reader mark on the group label. In a `summary_only` pool there are no marks, because its stream carries no premises and no operations.
- **CO27.** Tapping a tile opens the Who relies panel for the file (3.11).
- **CO28.** When there are more files than cells, the last cell is `tiles.more` and opens the full list.

### 3.8 Strip (run clock and counters)

Inputs: `pool`, `counters`, `metrics`, `green`, `limits`, `features.green`.

| Cell | Value | Source |
| --- | --- | --- |
| Run clock | `hh:mm:ss` | stream clock minus the `ts` of the first `intent.created` |
| `strip.agents` | `{n} of {max}` and `strip.agents.limit` | `pool.real_agents`, `pool.max_real_agents` |
| `strip.landed` | count | `landing.landed` events whose landing is of kind `change` |
| `strip.goarounds` | count | `counters.go_arounds`: the go-arounds that started, counted from the field `go_arounds` of `attempt.state` (4.3) |
| `strip.waiting` | count | `metrics.waiting_behind`; `strip.waiting.backlog` appears when `metrics.push_backlog` is above 0 |
| `strip.green` | `green.at`, `green.static`, `green.checking`, `green.red` or `green.none` | `green.verified`, `green.advanced`, `features.green` (see below) |
| `strip.spend` | `spend.value` and a bar | `limits` (3.18) |

The green-line cell, first matching row:

| When | The cell reads |
| --- | --- |
| `features.green` is `"none"` | `green.none` |
| `green.last` has `ok: false` and `confirmed: true`, and its revert has not landed | `green.red` |
| `green.last` has `ok: false` and `confirmed: false` | `green.checking`. The check is being run again on the same commit. Nothing on the page says that a change is being taken back (`01-core.md` GR3). |
| `green.seq` is null | `strip.dash` |
| `green.runtime` is `static` | `green.static` |
| otherwise | `green.at` |

| State | When | Shows |
| --- | --- | --- |
| loading | before the first event | every value is `strip.dash` |
| empty | a cell whose source event has not arrived | `strip.dash` in that cell |
| live | otherwise | values |
| held | pool state `paused` or `rebuilding` | values frozen, cell labels unchanged; the banner explains |
| error | connection lost | values dimmed, `strip.stale` (CO3) |
| stopped | Replay ended | the final values of the recording |

- **CO29.** Numbers use tabular figures and do not change width when they change value. A counter that changes is underlined for 1 s; it does not flash.
- **CO30.** In a synthetic pool (`pool.synthetic`) with no real attempt in flight, `strip.agents` reads `strip.agents.synthetic` with the number of synthetic attempts in flight, and the limit line is absent. With real attempts in flight as well, the cell shows both lines.

### 3.9 Why card

Inputs: one `LandingView`, its attempt and intent, `LandingView.note`.

Opened by: tapping a creature in the live pool frame, a row of the Landed tab, a landing number anywhere, or the tile menu. It is the record of one landing (2.5).

Sections, in order: `why.asked` (requester, tag, the intent text in quotes), `why.wrote` (real or synthetic, model), `why.relied` (frozen lights with `keyLabel` and flags), `why.under` (each go-around and confirm: cause, rule sentence, the agent's statement), `why.checked` (count; the list on tap), `why.landed_how` (`why.landed.auto`, `why.landed.owner`, `why.landed.owner_now`, `why.landed.owner_risk` or `why.landed.chosen`, from `LandingView.approved` and the card's reason; Clef risk lines when present), `why.changed` (paths and entities written), buttons `why.git`, `who.open`, `undo.open`.

| State | When | Shows |
| --- | --- | --- |
| empty | the tapped thing has no landing after the seed | `why.seed` |
| held | the landing is accepted and not landed | `why.landing` and nothing else (FL3) |
| loading | the landing is older than `FLOOR_KEEP_LANDINGS` and its record is being fetched (live mode) | `why.loading` |
| error | the landing is listed in `pool.unwitnessed` (its commit has no note, `01-core.md` 3.6) | the commit lines, then `why.unwitnessed` |
| error | the record cannot be loaded (the note route answers 404 in a `summary_only` pool), or Replay has no record for it | the fields the stream gave, then `why.partial` |
| stopped | `LandingView.undone_by` is set | the full card under the notice `why.undone` |
| live | otherwise | the full card |

- **CO31.** A landing of kind `undo` or `revert` has a Why card too: title `why.undo.title` or `why.revert.title`, what it took back, which attempts reopened, which readers were kept.
- **CO32.** Every sentence on the Why card is built from the stream or from the note. The page adds no judgment of its own.

### 3.10 "Show the git" drawer

Inputs: `LandingView` (commit, tree, note; the parent is the commit of the landing before it), `pool.remote`.

Shows, in order: `git.commit_is`, the commit id, parent and tree in full, the commit message as git stores it (summary, `Intent:` line, `Change-Id` and `Intent-Id` trailers; `Undoes:` lines for an undo), `git.note_is`, the note as indented JSON, `git.read_yourself` with the two commands of `01-core.md` 3.5, the clone command with `pool.remote` (the address without credentials), and `git.read_token`. Every id and command has a `git.copy` button. The page never shows or holds a repository token (`01-core.md` SE5c).

| State | When | Shows |
| --- | --- | --- |
| live | the note is in `LandingView.note` | everything |
| loading | live mode, the note is being fetched (4.5) | commit lines, `git.loading_note` |
| error | the note cannot be fetched (404 in a `summary_only` pool), or Replay has no note | commit lines, `git.no_note`, the commands |
| empty, held, stopped | n/a | |

- **CO33.** The drawer shows the note text exactly as stored, re-indented only. It never rewrites or shortens it.

### 3.11 Who relies

Inputs: `files`, `attempts`, `landings`, the chosen key.

Opened by: `who.open` on a light, a Why card or a held card; or a tile (then the panel first lists the keys known for that file: every entity key of that path that appears in any premise or write in `FloorState`, and the file itself).

Shows: the title `who.title` with `keyLabel`, then two lists (`01-core.md` 11.6): `who.in_flight` (attempts with a premise `entity:K` or `file:<path of K>`, each with its flags and status word) and `who.landed` (landed, not undone changes with such a frozen premise, each opening its Why card). While the panel is open, the matching attempt cards, lights and tiles are outlined, and the matching creatures are outlined in the pool frame (CO23b).

| State | When | Shows |
| --- | --- | --- |
| held | the pool is `summary_only` | `who.summary_only`: the stream of such a pool carries no premises |
| empty | no attempt and no landing matches | `who.none` |
| live | otherwise | the two lists with counts |
| held | landings older than `FLOOR_KEEP_LANDINGS` exist | the lists, then `who.window` |
| loading, error, stopped | n/a (computed from `FloorState`) | |

### 3.12 Undo

Inputs: the target `LandingView`, the undo plan (`UndoPlanResponse`, a request of 4.5), `undo` in `FloorState`, `features.undo`.

The button `undo.open` is on the Why card of a landing of kind `change` (`01-core.md` 11.3). An undo landing and a revert landing have no such button: they cannot be undone.

| State | When | Shows |
| --- | --- | --- |
| held | visitor or Replay, or `features.undo` is false | no button |
| held | the landing is already undone | button absent; the Why card says `why.undone` |
| held | the landing is older than `UNDO_WINDOW` landings | button disabled with `undo.too_old` |
| loading | the plan is being fetched | sheet with `undo.planning` |
| live | the plan arrived (`ok: true`) | sheet: `undo.title`, `undo.also` (the landings of `plan.reverted` other than the target; `undo.also.none` when there is none), `undo.kept` (`plan.kept_readers`), `undo.in_flight` (`plan.repairs`), buttons `undo.confirm` and `undo.cancel` |
| loading | the confirm is in flight | the same sheet with both buttons disabled; `undo.confirm` reads `undo.sending` (FL10, amended 2026-10-07) |
| live | the confirm was refused with `plan_changed` | the same sheet with the new plan of the response, under the notice `undo.plan_changed`. Nothing was queued. `undo.confirm` is enabled again and now carries the new plan (7, row FR31). |
| error | the plan was refused (`ok: false`), the confirm was refused with another reason, or a request failed | `undo.refused` with the reason sentence (5.9), or the request error; nothing changed |
| live | `undo.planned` arrived, its landing is not yet landed | undo row in the Landed tab: `undo.landing` |
| stopped | the undo landing landed | undo row: `undo.done`; reopened attempt cards are back in the Working tab (CO13) |
| empty | n/a | |

- **CO34.** An undo or revert that the owner did not start in this browser (another session, the green line, Replay) shows the same row from `undo.planned`, so the page reads the same for everyone.
- **CO34a (confirm against the plan).** The confirm request carries `expect_reverted`: the `reverted` list of the plan that is on screen (`01-core.md` UN5). The owner can never confirm an undo whose plan the sheet did not show. A landing that neither depends on the target nor read what it wrote is in no list of the sheet.

### 3.13 Held-change card

Inputs: one `CardView` of kind `held`, its attempt, `Card.preview`, `features.held`.

It appears as a row in the tray (title and the button `card.open`) and as the card sheet (2.4). The sheet shows: title and body of the card (5.10), the intent, the frames `held.before` and `held.after`, `held.changes` (paths with tier tags, entities), `held.affects` (the blast radius sentences of 5.10, from `Card.blast_radius` of the card's attempt; `held.relied_inflight`, computed live from the stream with `whoRelies` over the keys the change alters; `held.relied_landed`), `held.checked` (checks, lights, blind spots confirmed, Clef risk lines), an optional reason field (`held.reason`), and one button per entry of `Card.options`, with the label that Trunk sent (5.10). The first option is the primary button.

| State | When | Shows |
| --- | --- | --- |
| loading | a frame is loading | `frame.loading` in that frame |
| loading | `features.held` is true, and `Card.preview` is null or has no `after` entry for the attempt and no `error` (the preview commit is being built, `01-core.md` PV1) | `held.preview_building` in the after frame; the buttons stay enabled |
| loading | `Card.risk` is null and `features.clef` is true | `held.risk_waiting` in place of the risk lines |
| live | `features.held` is false (the minimal form, `01-core.md` HD1) | the sheet without frames, without `held.affects` and without risk lines: title, body, the intent, `held.changes`, the checks and lights, the reason field, and the two buttons of `land` and `decline` (for a visitor: no buttons, and `held.visitor`) |
| live | card open, owner | buttons enabled |
| held | card open, visitor | no buttons; `held.visitor` |
| error | a frame failed | `frame.error` in that frame; the buttons stay enabled |
| error | `Card.preview.error` is set (7, row FR32) | `held.no_preview` in the after frame; the buttons stay enabled |
| error | `Card.risk.error` is set | `held.risk_unavailable` |
| error | the action request failed | the error sentence (5.9); the card stays open |
| stopped | closed by the system as `stale` | `held.stale`; buttons disabled; the sheet closes after `STALE_CARD_MS` |
| stopped | closed by the owner | `held.closed.land`, `held.closed.land_now` or `held.closed.decline`; the sheet closes after 1.5 s |
| empty | n/a | |

- **CO35.** The blast radius shown is the one in the newest `card.opened` or `card.updated`: `Card.blast_radius[attempt_id]`. The request carries the id of the option, the `submit_ids` on screen, the typed reason and a `request_id`, so an approval cannot apply to a later version (`01-core.md` 10.2, 13.6). The id, not the label, is what the route accepts (`01-core.md` CD4, CD5).
- **CO35a (right of way).** When the card's blast radius lists an attempt under `right_of_way`, the sheet shows the sentence "Blast, right of way" of 5.10, and Trunk offers the third option `land_now`. Land then waits until that change has landed (`01-core.md` RW5). "Land now" does not wait; its tooltip is `held.land_now.tip`. The button is on screen only while `Card.options` holds `land_now`. The Floor never adds an option of its own.
- **CO36.** "Before" is `Card.preview.before` and "After" is `Card.preview.after[attempt_id]`. Both are commit frames built with `frameUrl` (4.5). They never change, so they also play in Replay (`01-core.md` PV2). No frame shows a live attempt view.
- **CO37.** The button of `land` is the primary button. Decline never needs a reason. Esc closes the sheet and does nothing else.

A `choice` card uses the same tray row and sheet without frames: title, at most two sentences, and the buttons of its options (5.10). Its states are live, held (visitor), error and stopped, as above. Its closing sentence is `choice.closed`.

### 3.14 Race and choose

Inputs: one `CardView` of kind `race`, its attempts, `features.race`.

In the rail, the race is one group: the intent text, `race.group`, and one compact row per candidate. In the tray it is one row. The sheet (2.4) has one column per candidate: frame, model, lights, checks, `race.took` (from `Card.candidates[id].seconds`), `race.cost` (from `Card.candidates[id].cost_usd`), `race.blast` (the number of attempts under `repair` in `Card.blast_radius[id]`), and a button with the label of the card's one option, `choose`.

| Candidate state | When | Column shows |
| --- | --- | --- |
| loading | `Card.candidates[id].can_choose` is false and the attempt is not stopped | `race.working` with its status word and step count, no frame |
| live | `can_choose` is true | frame of its preview (`Card.preview.after[id]`), facts, the button |
| error | its frame failed, or the card has no preview for it | `frame.error` or `held.no_preview`; facts and button stay |
| stopped | the attempt stopped | `race.stopped` with the stop sentence |
| stopped | another candidate was chosen | `status.not_chosen` |
| stopped | this candidate was chosen | `race.chosen`, then its landing states; the sheet shows `race.closed` and closes after 1.5 s |
| stopped | the card closed as `superseded` (every candidate stopped) | `race.superseded` |
| held | visitor | no button |
| empty | n/a | |

- **CO38.** Trunk opens the race card when the race starts, with no candidate ready (`01-core.md` RC1). The tray row and the Needs-you badge count the card only while at least one candidate has `can_choose: true`. From then on the card can be answered. The card title says how many are ready (5.10).
- **CO38a (the request).** Every button of the sheet sends the option `choose`. The request carries the column's `attempt_id` (`01-core.md` 13.6). The typed reason, when there is one, goes in `reason` and nowhere else.
- **CO39.** A value that the card carries as null is shown as `race.unknown`, never as zero.
- **CO40.** After the choice, the group stays in the Working tab until the chosen attempt lands; then the whole group moves to the Landed tab with the two other rows marked `status.not_chosen`. If the chosen attempt goes around before it lands, or is reopened later, it is shown as an ordinary attempt (CO13).

### 3.15 Swarm wall with metrics

Inputs: `swarm`, `metrics`, `metrics_history`, `attempts` of the Swarm pool, `last_push`, `features.green`.

Shows (2.6): the SYNTHETIC banner; four large numbers (`swarm.lps` with a small chart of the last 60 s from `metrics_history`, `swarm.ttl`, `swarm.gar`, `swarm.waiting`); four small ones (`swarm.false_abort`, `swarm.escape`, `swarm.backlog`, `swarm.last_push`); the wall; the controls (`swarm.agents`, `swarm.dial`, `swarm.start`, `swarm.stop`); the lines `swarm.real_limit` and `swarm.shape`.

- **CO41 (wall).** One cell per scripted agent, drawn on one canvas. Cell state: working (outline), going around (diamond in the `changed` colour), landing (half fill), landed (fill in the `holds` colour for 1 s, then outline again for the agent's next change), stopped (cross). The wall redraws at most `WALL_FPS` times per second. Cell size is chosen so that all agents fit.
- **CO42 (numbers).** Each number shows its window (`swarm.window`) and comes from the newest `metrics` event of the Swarm pool. A null value shows `strip.dash`. Rates are whole percents. The page computes no rate that the stream does not define (`01-core.md` section 14).
- **CO42a (the two small rates).** `swarm.false_abort` is `metrics.false_abort_rate`: the share of go-arounds after which the agent changed nothing (`01-core.md` 14.4, from `headsup.resolved.changed`, so it exists in a `summary_only` pool). `swarm.escape` is `metrics.escape_rate`: the share of landed changes that the green line later took back (`01-core.md` 14.5). It is null, and shown as `strip.dash`, when `features.green` is `"none"`. The tooltips `swarm.false_abort.tip` and `swarm.escape.tip` give these two definitions. The checks of a scripted run against the scripts' own answers (the truth-label rate and the ground-truth escape count) are not in the stream and not on this page. The soak results publish them (`04-build-plan.md`, VE6).
- **CO43.** Repair latency is not shown on the wall. The line `swarm.repair_note` says it is measured with real agents only (`01-core.md` 14.7).
- **CO44.** The SYNTHETIC banner is present whenever this view is open, running or not, with the sentence `banner.synthetic.swarm`. It is also present in every other view of a synthetic pool (FL4).
- **CO44a (the requests).** The controls send `SwarmRequest` (`01-core.md` SWR1) for the Swarm pool. Start sends the whole `SwarmConfig`: `agents` and `collision_dial` from the controls, the other fields from `swarm_defaults` of `/floor.json`. Moving the dial during a run sends `{ pool, running: true, collision_dial, request_id }`. Stop sends `{ pool, running: false, request_id }`. The page shows the dial and the agent count of the newest `swarm.state`, not of its own request (CO48).

| State | When | Shows |
| --- | --- | --- |
| empty | no `swarm.state` yet | `swarm.empty`, controls (owner) |
| loading | `swarm.running` and no synthetic attempt yet | `swarm.starting` |
| loading | a start or stop request is in flight | the controls disabled; the start button reads `swarm.starting` with the requested `agents`, the stop button `swarm.stopping` (FL10, amended 2026-10-07) |
| live | `swarm.running` | live numbers and wall |
| stopped | `swarm.running` is false after a run | the last numbers, frozen, with `swarm.final` |
| held | visitor | everything except the controls |
| held | kill switch on, or pool paused | controls disabled with `swarm.blocked` |
| error | the start or stop request failed | the error sentence (5.9) |

### 3.16 Replay controls

Inputs: `ViewState.replay`.

The Replay menu (header) lists the recordings. The Replay bar (2.7) has `replay.play` or `replay.pause`, `replay.restart`, the position (`replay.position`), a track with chapter marks, the chapter buttons, `replay.speed`, and `replay.close`.

| State | When | Shows |
| --- | --- | --- |
| empty | the list of recordings is empty | `replay.none` |
| loading | the file is downloading or being checked | `replay.loading` with the share loaded |
| held | loaded, paused | the position; `replay.play` |
| live | playing | the position moves; `replay.pause` |
| stopped | the last event was applied | `replay.ended`, buttons `replay.again` and `replay.to_live` |
| error | the file is missing or fails a check of 8.3 | `replay.error` with the reason; `replay.to_live` |

Section 8 has the rules.

### 3.17 Owner-key entry

Inputs: the session state (4.5), `ViewState.owner_dialog`.

Header button: `owner.visitor` (locked) or `owner.unlocked`. The dialog has one field of type password with the label `owner.key_label`, the buttons `owner.unlock` and `owner.cancel`, and, when unlocked, `owner.lock`.

| State | When | Shows |
| --- | --- | --- |
| held | no session | header `owner.visitor`; the dialog on tap |
| loading | the key is being checked | `owner.checking` |
| live | session present | header `owner.unlocked`; owner controls appear |
| error | the key is wrong | `owner.wrong`; the field is cleared |
| error | the deployment has no key (`503`) | `owner.not_configured`; the field is disabled |
| error | too many failed tries from this address in one minute (`429`, `01-core.md` SE2a) | `owner.wait` |
| stopped | a request answers `401` while the page believed it was the owner | toast `owner.expired`; the header returns to `owner.visitor`; the dialog opens |
| empty | n/a | |

- **CO45.** The key is typed or pasted into the field only. It is never put in an address, never shown, never stored by the page, and never written to the console. The page sends it only in the body of `POST /api/session` on its own origin. The field has `autocomplete="current-password"` so a password manager can fill it.
- **CO46.** In Replay the header shows `owner.replay` and the dialog cannot open.

### 3.18 Kill switch, spend indicator and banners

From 1100 wide, the banners share one row side by side instead of stacking; each keeps its own colour, stripe or dotted edge (VD4) and its sentence ends in an ellipsis when the row is short (owner's design decision of 2026-10-10).

Inputs: `limits`, `pool`, `green`, `undo`, `ViewState.connection`.

**Spend indicator** (strip): `spend.value` and a bar. The bar's fill is `spend_usd / cap_usd`.

| State | When | Shows |
| --- | --- | --- |
| empty | no `limits` event yet | `spend.unknown` |
| live | below `SPEND_NEAR_SHARE` of the cap | value and bar in the neutral colour |
| held | at or above `SPEND_NEAR_SHARE` | value and bar in the `confirm` colour, `spend.near` |
| stopped | the cap is reached: `limits.refusing` is true (7, row FR8) | value and bar in the `changed` colour, `spend.reached`, and the banner `banner.cap` |
| error | connection lost | dimmed (CO3) |

Hover or focus on the cell lists each model's use (`spend.model_line`).

**Kill switch** (header, owner, live mode): the button `kill.open`. It opens a dialog: `kill.title`, `kill.body`, the checkbox `kill.landings`, the buttons `kill.confirm` and `kill.cancel`.

| State | When | Shows |
| --- | --- | --- |
| live | `limits.killed` is false | the button `kill.open` |
| loading | the request is in flight | `kill.stopping` |
| stopped | `limits.killed` is true | the banner `banner.killed` with the button `kill.allow`; the header button becomes `kill.allow` |
| error | the request failed | the error sentence (5.9); the dialog stays open |
| held | visitor or Replay | no button. The banner still shows when `limits.killed` is true. |
| empty | n/a | |

- **CO47.** The kill switch needs two taps (open, confirm) and no typing. Key `K` opens the dialog; Enter confirms.
- **CO48.** The page shows what a request changed only from events (`limits.killed`, `attempt.state`, `swarm.state`), never from the request's success alone.

**Banners**, in this fixed order from the top. Each has a word in capitals, a sentence, and at most one button.

| # | Banner | When | Colour and pattern |
| --- | --- | --- | --- |
| 1 | `banner.synthetic` | `pool.synthetic` is true for the pool on screen, or the recording is synthetic, or Swarm view is open (then `banner.synthetic.swarm`) | `synthetic` with diagonal stripes |
| 2 | `banner.replay` | Replay | inverse (text colour as background) with a dotted edge |
| 3 | `banner.killed` | `limits.killed` | `changed` |
| 4 | `banner.paused.*` | pool state `paused`; the sentence follows `pool.reason` | `changed` |
| 5 | `banner.rebuilding` | pool state `rebuilding` | `confirm` |
| 6 | `banner.cap` | `limits.refusing` | `changed` |
| 7 | `banner.push` | a push has been pending longer than `PUSH_STALL_MS` | `confirm` |
| 8 | `banner.green_red` | the newest `green.verified` has `ok: false` and `confirmed: true`, and its revert has not landed. A first failed run (`confirmed: false`) gives no banner (3.8). | `confirm` |
| 9 | `banner.offline` | the connection is lost | `confirm` |

- **CO49.** Banners 1 and 2 cannot be closed. The others leave only when their condition ends.
- **CO50.** At most three banners are drawn. Banners 1 and 2 always are; of the rest, the first by number. The others are counted in `banner.more`, which opens the list.

### 3.19 Other parts

| Part | Content | States |
| --- | --- | --- |
| View switch | `nav.overview`, `nav.floor`, `nav.swarm`, `nav.replay`, `nav.about` | the current view is marked with an underline and `aria-current` |
| Needs-you badge | `needs.badge` with the number of open cards that can be answered (CO38) | absent at 0; opens the oldest open card |
| Tray | one row per open card that can be answered, oldest first | empty: absent |
| Tabs | `rail.tab.working`, `rail.tab.landed`, `rail.tab.stopped` with counts | empty texts `rail.empty.*` |
| Landed tab | one row per landing, newest first: number, kind, change name, time; undo rows (3.12) | opens the Why card |
| About sheet | three columns: `about.how` (a fixed diagram), `about.run` (counts from the stream: real agents at most, models used (`about.run.real`, or `about.run.real.none` while no model has been called; amended 2026-10-10), landings, go-arounds, repair time, scripted agents, spend; for attempt repositories `about.forks`, or `about.forks_unknown` before the first `attempt.repo` event, or `about.forks_off` when `features.attempt_repos` is false; `about.trunk_errors` when the count is above 0), `about.limits` (the limits list) and `about.related` | the limits list is built from the same file as the README's limits section |
| Toasts | one sentence, bottom left, for `TOAST_MS`; at most 3 | every toast is also sent to the screen-reader log |
| Shortcut list | key `?` | 6.6 |
| Unknown pool | the stream of the pool named in the address answers 404 | `pool.missing` and the link `pool.to_default` (7, row FR30) |

---

## 4. From events to what is on screen

### 4.1 `FloorState` (the reducer's output)

The reducer lives in the shared `protocol` module (`01-core.md` EV5). This is the shape the Floor needs from it. Types not defined here (`Card`, `CardOption`, `Check`, `Note`, `PremiseKind`, `AttemptState`, `HeadsUp`, `HeadsUpItem`, `RiskAnswers`) are those of `01-core.md`. A field whose name ends in `_ts` holds the `ts` of the event that set it.

```ts
type FloorState = {
  n: number;                                  // last event applied; 0 before any
  ts: number;                                 // the largest ts applied so far (the Replay time of event n, RY13)
  first_intent_ts: number | null;             // start of the run clock
  unknown_events: number;                     // events whose type the reducer does not know (ignored)
  trunk_errors: number;                       // trunk.error events (About)

  pool: {
    id: string;
    state: "unknown" | "ready" | "rebuilding" | "paused";
    reason: string | null;                    // pause reason
    epoch: number;                            // rises after a rebuild from Artifacts (RB5)
    synthetic: boolean;                       // a synthetic attempt was opened here (EM1a): the SYNTHETIC banner
    summary_only: boolean;                    // the pool's flag (EV6): FE4
    head_seq: number;                         // last accepted landing
    landed_seq: number;                       // last landing confirmed on main
    landed_commit: string | null;             // the commit that the source `main` means
    real_agents: number;
    max_real_agents: number;
    remote: string | null;                    // clone address without credentials
    plain_remote: string | null;              // null: the pool has no plain-merge repository
    rebuild: { done: number; total: number } | null;
    unwitnessed: number[];                    // landings whose commit has no note
  };

  intents: Record<string, {
    id: string; text: string; requester: string; race: boolean; prewritten: boolean;
    state: "open" | "landed" | "stopped" | "undone"; created_ts: number; attempt_ids: string[];
  }>;

  attempts: Record<string, AttemptView>;
  working_order: string[];                    // attempt ids in rail order (CO9)

  landings: Record<number, LandingView>;      // the newest FLOOR_KEEP_LANDINGS landings in full; older ones as digests
  landed_order: number[];                     // seqs, newest first

  cards: Record<string, CardView>;
  open_cards: string[];                       // card ids, oldest first

  files: Record<string, {
    path: string; exists: boolean; tier: "auto" | "held" | null;
    readers: string[]; writers: string[];     // attempt ids in flight
    last_landed_seq: number | null; keys: string[];   // entity keys of this path seen in premises or writes
  }>;
  dirs: Record<string, { readers: string[] }>;         // listing and directory-search readers

  push: { batch_id: number; first_accepted_ts: number; tries: number;
          error: string | null; next_try_ts: number | null } | null;   // null when nothing is unpushed
  last_push: { batch_id: number; landings: number; tries: number; ms: number } | null;

  green: { seq: number | null; commit: string | null;
           runtime: "browser" | "isolate" | "container" | "static" | null;
           last: { seq: number; ok: boolean;
                   confirmed: boolean;       // GR3: false for a first failed run; nothing is announced for it
                   failed: Array<{ name: string; code: string }> } | null };   // names and codes of GR8

  plain: { commit: string; tree: string; through_seq: number;
           skipped: number[]; interrupted: number[] } | null;   // PM6, PM7

  limits: { spend_usd: number; reserved_usd: number; cap_usd: number; killed: boolean;
            refusing: boolean;               // SE7: the cap refused the last request
            ts: number;
            models: Array<{ model: string; per_minute: number; used_last_minute: number }> } | null;

  metrics: MetricsEvent | null;               // newest `metrics` event (the `metrics` member of PoolEvent)
  metrics_history: Array<{ ts: number; landings_per_second: number; go_around_rate: number | null }>;  // last 60 s

  swarm: { running: boolean; agents: number; collision_dial: number; pools: string[];
           ever_ran: boolean } | null;

  undo: Record<string, { request_id: string; cause: "undo" | "revert"; target_seq: number;
                         reverted: number[]; reopened: string[]; kept_readers: number[];
                         landing_seq: number | null }>;          // keyed by request_id (EM4)

  repair_ms: number[];                        // 14.7: one value per ended go-around of a real attempt
  repos: { ok: number; failed: number; first_ts: number | null; last_ts: number | null };   // 14.8

  counters: { landed_changes: number; go_arounds: number };
};

type AttemptView = {
  id: string; intent_id: string; change_id: string;
  agent: "real" | "synthetic"; model: string | null;
  race: boolean;                              // how the attempt started (attempt.opened.race); it never changes (RC7)
  state: AttemptState; stop_reason: string | null;
  go_arounds: number; pull_backs: number; right_of_way: boolean;
  revision: number; reopened_by: "undo" | "revert" | "retry" | null; model_changed: boolean;
  opened_ts: number; last_event_ts: number;
  step: { n: number; tool: string | null; target: string | null; ok: boolean; error: string | null; ts: number } | null;
  steps: number;
  premises: Record<string, PremiseView>;      // key = kind + " " + key
  ops: Array<{ op_seq: number; op: "write" | "replace"; path: string; dropped: boolean;
               altered: string[]; added: string[]; removed: string[] }>;
  heads_ups: Record<number, HeadsUpView>;
  submit: { submit_id: string | null; status: string; tier: "auto" | "held" | null;
            checks: Check[]; ts: number } | null;
  repair_open_ts: number | null;              // 14.7: ts of the `repair` heads-up that started the open go-around
  skipped: { why: "not_disjoint" | "right_of_way" | "checks_failed" | "held"; behind: string | null } | null;
  card_id: string | null;
  approved_ts: number | null;                 // set when the owner lands or chooses it on a card
  landed_seq: number | null;                  // set by landing.accepted; "Landed" needs LandingView.landed
  cost_usd: number | null;                    // sum of attempt.step.cost_usd; null until a model turn reported one
};

type PremiseView = {
  kind: PremiseKind; key: string;
  hash: string | null;                        // the pin as the newest premise.recorded gave it (`absent` for a file the attempt created, 5.2 changeName); null until one arrives
  read: boolean; edit: boolean; derived: boolean;
  light: "holds" | "changed" | "confirm" | "blind_spot" | "checking";
  judgment: { rule: string; reason: string; result: "holds" | "confirm" | "repair" | null;
              cause_seq: number | null;
              clef: { model: string; p: number | null; error: string | null } | null } | null;   // newest
};

type HeadsUpView = {
  hn: number; result: "info" | "confirm" | "repair"; wake: boolean; ts: number;
  cause: HeadsUp["cause"]; go_around: number | null;
  keys: Array<{ kind: PremiseKind | "check"; key: string; rule: string }>;
  items: HeadsUpItem[] | null;                // as sent (01-core 8.2); null in a summary_only pool
  dropped_ops: HeadsUp["dropped_ops"];
  resolved: { statement: string; changed: boolean; ts: number } | null;
};

type LandingView = {
  seq: number; kind: "change" | "undo" | "revert"; batch_id: number;
  attempt_id: string | null; change_id: string; intent_id: string | null;
  request_id: string | null;                  // for kind undo or revert: the request_id of its undo.planned (EM4)
  paths: string[]; writes: Note["writes"];
  accepted_ts: number;
  landed: { commit: string; tree: string; note_id: string; ts: number; time_to_land_ms: number | null } | null;
  undone_by: number | null;
  premises: PremiseView[];                    // frozen at acceptance, lights as they were (all hold)
  go_arounds: HeadsUpView[];                  // resolved heads-ups of result repair
  confirms: HeadsUpView[];                    // resolved heads-ups of result confirm
  checks: Check[]; tier: "auto" | "held" | null;
  approved: { by: "owner"; option: "land" | "land_now" | "choose";
              card_reason: Card["reason"]; ts: number } | null;
  risk: RiskAnswers | null;
  note: Note | null;                          // parsed from landing.landed.note_json; null in a summary_only pool
};

type CardView = { card: Card; open: boolean; opened_ts: number;
                  closed: { action: CardOption | "stale" | "superseded"; by: "owner" | "system";
                            attempt_id: string | null;         // the chosen candidate when action is "choose"
                            reason: string | null;             // only the reason the owner typed
                            ts: number } | null };
```

- **FE1.** The reducer is total: every event leaves a valid `FloorState`. An event of unknown type changes only `n`, `ts` and `unknown_events`.
- **FE2.** The reducer never reads a clock and never performs a request.
- **FE3.** Applying the same events gives the same `FloorState`, in live mode, after a snapshot join and in Replay. A test replays one recorded file through all three paths and compares.
- **FE4 (`summary_only` pools).** For a pool whose `pool.summary_only` is true the reducer keeps, per attempt, only what the wall and the counters need: `state`, `stop_reason`, `go_arounds`, `pull_backs`, `landed_seq` and its last heads-up without items. It keeps no premises, operations or steps; the stream of such a pool does not carry them (`01-core.md` EV6, FS1). A `premise.judged` event of such a pool changes nothing, because there is no premise to hold the judgment. Memory therefore does not grow with the number of scripted agents. The rule follows the pool's flag, not the kind of agent. A canned cast on a pool that is not `summary_only` is reduced in full: its attempt cards show lights, operations, heads-up diffs and Why cards, under the SYNTHETIC banner.
- **FE7 (one state per pool).** The page keeps one `FloorState` per pool it shows, each from its own stream: the main pool and the Swarm pool. The main pool is the pool named in the address (`/p/{pool}`), or the default pool of `/floor.json` at `/`. The Swarm pool is named in `/floor.json`. Floor view, Compare view and the sheets draw the main pool. Swarm view draws the Swarm pool, and opens its stream when the view is first opened. The model gate and the Swarm launcher send `limits` and `swarm.state` to the stream of every pool (`01-core.md` EV2a, EM6). So the spend cell, the kill switch and banners 3 and 6 use the `limits` state with the larger `ts` of the two streams.
- **FE8 (features).** `features` comes from `/floor.json` only (`01-core.md` FJ1), never from the stream. A part of the page whose feature is off is absent (1.4). The Floor adds no key to `features`.

### 4.2 `ViewState` (local, never from the stream, never sent anywhere)

| Field | Values |
| --- | --- |
| `pool` | the id of the main pool, from the address (FE7) |
| `settings` | the content of `/floor.json` (4.5), read once: pool ids, `features`, pre-written requests |
| `view` | `floor`, `compare`, `swarm` |
| `mode` | `live`, `replay` |
| `sheet` | none, a card id, a Why card (landing seq), Who relies (key), undo (target seq, with the plan on screen), About, owner dialog, kill dialog, shortcut list |
| `git_drawer` | open or closed |
| `tab` | `working`, `landed`, `stopped` |
| `expanded` | attempt ids the owner expanded; heads-up panels open by CO11 |
| `draft` | the text in the intent box |
| `pending` | requests in flight, by `request_id` |
| `owner` | whether this browser holds the owner session |
| `connection` | `connecting`, `open`, `lost` with the try count |
| `pool_paused` | whether the viewer paused the pool frames |
| `frames` | for each pool frame on screen: its newest `stats` message, when it arrived, and whether the frame fell back after a stall (7, row FR28) |
| `theme`, `size`, `shortcuts` | `dark` or `light`; `stage` or `laptop`; on or off |
| `replay` | recording id, position (event index), playing, speed, load progress, error |
| `toasts` | up to 3 |

### 4.3 Each event type and what it changes

Every event type of `01-core.md` 12.1 has one row: 35 types. "State" is the change to `FloorState`. "Seen" is what a person notices. "Said" is the screen-reader log line (5.13); "none" means the event is not announced. Every row also sets `n` and `ts`.

| Event | State | Seen | Said |
| --- | --- | --- | --- |
| `pool.state` | Sets `pool.state`, `reason`, `epoch`, `synthetic`, `summary_only`, `head_seq`, `landed_seq`, `landed_commit`, `real_agents`, `max_real_agents`, `remote`, `plain_remote`, `rebuild`, `unwitnessed`. When `epoch` is higher than the stored one (a rebuild from Artifacts, `01-core.md` RB5): every open card is closed as `stale` by `system`. | Strip: real agents. Banners 1, 4, 5 appear or leave. The intent box changes state. Banner 5 shows the progress of `rebuild`. | `sr.pool_state` when `state` changed |
| `pool.files` | Sets `files[path].exists` and `tier` for every listed path. A path that is not listed no longer exists. | All tiles; `tile.held` tags. | none |
| `pool.paused` | `pool.state = paused`, `pool.reason` | Banner 4 with the sentence for the reason (7, rows FR11 to FR13). | `sr.paused` (urgent) |
| `trunk.error` | `trunk_errors += 1` | About: `about.trunk_errors`. Nothing else. The code is not shown. | none |
| `intent.created` | Adds the intent, with `prewritten`. Sets `first_intent_ts` if it is the first. | A new group in the Working tab with `status.opened`. The draft is cleared when the id matches (CO8). Starts the run clock if it is the first. | `sr.intent` |
| `intent.state` | Sets the intent's state. | `undone`: tag on its rows. `stopped`: the group moves to the Stopped tab once all its attempts are stopped. | none |
| `attempt.opened` | Adds the attempt with state `opened`; links it to its intent. | An attempt card (or a race row) with model name and tags. In Swarm view: one wall cell. | none |
| `attempt.state` | Sets `state`, `go_arounds`, `pull_backs`, `right_of_way`; `stop_reason` (the event's `reason`) when `to = stopped`. Clears `skipped`. `counters.go_arounds += 1` when the event starts a go-around: `to = going_around`, and either the event's `go_arounds` is greater than the stored value or `from = stopped`. This follows `01-core.md` GA1: a new go-around in `going_around` has `from = to` and a higher count (T10a); a `repair` that joins the current go-around has `from = to` and the same count (T10); "Try again" resets the count and starts one (T21). Reorders `working_order` (CO9). | The status word and shape change, and `attempt.sent_back_n`. Entering `going_around` or `needs_confirm` moves the attempt card to the top group. `stopped` moves it to the Stopped tab. `landed` shows "Landed" only if the landing's `landing.landed` has arrived; otherwise "Landing…" (FL3). | `sr.state` for `going_around`, `needs_confirm`, `held`, `stopped` |
| `attempt.reopened` | Sets `revision`, `reopened_by`, `model_changed`. For cause `undo` or `revert`: reloads `premises` and `ops` from the attempt's `LandingView` and removes `landed_seq`. All lights are `holds` until judged; resolved heads-ups move under `attempt.earlier`. For cause `retry`: nothing else; a parked attempt kept its premises (`01-core.md` GL3a). | The attempt card returns to the Working tab with `attempt.tag.reopened`; `attempt.model_changed` when true. | `sr.reopened` |
| `attempt.step` | Sets `step`, `steps`, `last_event_ts`. Adds `cost_usd` to the attempt's `cost_usd` when the event carries one. | The activity line (5.5). A failed step shows its error sentence (7, FR2). | none |
| `attempt.repo` | `repos.ok += 1` or `repos.failed += 1`; sets `repos.first_ts` and `repos.last_ts`. | About: `about.forks`. | none |
| `premise.recorded` | Inserts or updates the premise (flags from the event). A new premise has light `holds`. Updates `files[path].readers` or `dirs[dir].readers` when `read` is true, and `files[path].keys`. | A new light on the attempt card. A reader mark on the tile or group label. | none |
| `premise.removed` | Removes the premise and its reader mark. | The light leaves. | none |
| `premise.judged` | Sets `judgment`. Light: `result = repair` gives `changed`; `result = confirm` with rule `B1` gives `blind_spot`; other `confirm` gives `confirm`; `result = null` gives `checking`; `result = holds` gives `holds`. A second event for the same key closes a pending triage (`01-core.md` JE1). | The light changes shape and colour, with one ring pulse (6.4). The expanded list shows the judgment sentence (5.6) and, for triage, the share. | none (the heads-up is announced) |
| `op.recorded` | Appends to `ops`. Adds the attempt to `files[path].writers`. Adds `altered`, `added`, `removed` keys to `files[path].keys`. | A writer mark on the tile. "What it changes" in the expanded attempt card. | none |
| `op.dropped` | Marks the listed operations dropped. Removes the writer mark if no current operation on the path remains. | `headsup.dropped` line in the heads-up panel; the writer mark leaves. | none |
| `headsup.sent` | Adds the `HeadsUpView`, with `items` as sent. For each item, the premise's light follows the item's result: `repair` gives `changed`; `confirm` gives `confirm` (`blind_spot` for rule `B1`); `pending` gives `checking`; `holds` gives `holds`. When `items` is null, nothing but the heads-up is stored. For a real attempt whose `repair_open_ts` is null, a heads-up of result `repair` sets `repair_open_ts` to its `ts`. | `repair`: red-edged panel, opens by itself (CO11). `confirm`: amber-edged panel, opens by itself. `info`: a neutral line on the attempt card, panel closed. | `sr.headsup` |
| `headsup.resolved` | Sets `resolved`, with `changed`. Every premise in that heads-up's `keys` whose light is `changed`, `confirm` or `blind_spot` returns to `holds`. A light that is `checking` stays. | The panel edge turns to the `holds` colour and shows the agent's statement. Lights turn back to circles. | `sr.resolved` |
| `submit.result` | Sets `submit` (ignored when `duplicate` is true). When `repair_open_ts` is set and the status is `validated`, `submitted` or `held`: appends `ts − repair_open_ts` to `repair_ms` and clears `repair_open_ts` (`01-core.md` 14.7). | Line 4 of the attempt card: the submit sentence (5.7). Checks in the expanded attempt card. A rejected submit shows 7, FR3. | none |
| `card.opened` | Adds the card; appends to `open_cards`; sets `card_id` on its attempts. | A tray row, once the card can be answered (CO38). The header badge count rises. A held attempt shows `status.held`. | `sr.card` (urgent), when the card can be answered (CO38) |
| `card.updated` | Replaces the `Card`. | The open sheet updates in place: the preview arrives, risk lines arrive, the blast radius changes, a race candidate becomes ready. No layout jump: the risk area has a fixed height. | `sr.card` (urgent) when this update makes a race card answerable for the first time; otherwise none |
| `card.closed` | `open = false`, sets `closed` (action, by, `attempt_id`, reason); removes from `open_cards`. For action `land` or `land_now`: sets `approved_ts` on the card's attempt. For action `choose`: sets `approved_ts` on the attempt named by `attempt_id`. | The tray row leaves. An open sheet shows its closing state (3.13, 3.14) and then closes. | `sr.card_closed` |
| `landing.accepted` | Adds the `LandingView` (frozen premises, heads-ups, checks, tier, risk and approval copied from the attempt and its card; `request_id` from the event). Sets the attempt's `landed_seq`. `pool.head_seq = seq`. Starts `push` if null. | The attempt card shows `status.accepted`. The caption bar shows `frame.landing`. Nothing else: no counter, no tile glow, no frame change (FL3). | none |
| `landing.landed` | Sets `landed`. Parses `note_json` into `note` when it is not null. `pool.landed_seq`, `pool.landed_commit`. `counters.landed_changes += 1` for kind `change`. Updates `files` from `writes` (created and removed files) and `last_landed_seq`. For kind `undo` or `revert`: sets `undone_by` on the reverted landings, and `landing_seq` on the `undo` entry with the landing's `request_id`. | "Landed" on the attempt card, then the move to the Landed tab (CO12). The Landed counter. The Floor posts `probe` to the live pool frame (CO21). Tiles of the paths glow. The Why card becomes available. A landing of kind `revert` removes banner 8. | `sr.landed` |
| `batch.pushed` | `push = null`. Sets `last_push`. | Banner 7 leaves. `frame.landing` leaves. Swarm view: `swarm.last_push`. | none |
| `push.retry` | Sets `push.tries`, `push.error`, and `push.next_try_ts` to `ts + next_try_ms`. | Attempt cards of the batch keep "Landing…". After `PUSH_STALL_MS`, banner 7 with the try count and a countdown (7, FR5 and FR6). | `sr.push` once per batch |
| `tick.skipped` | Sets `skipped` on the attempt. | Line 4 of the attempt card: the skip sentence (5.6). | none |
| `undo.planned` | Adds the `undo` entry under its `request_id`. | An undo row in the Landed tab: `undo.landing` or, for cause `revert`, `revert.landing`. For cause `revert`, banner 8 names the landings. | `sr.undo` |
| `undo.refused` | None. | Nothing new. The browser that sent the request already shows the sentence of the response (3.12). | none |
| `plain.updated` | Sets `plain`: `commit`, `tree`, `through_seq`, `skipped`, `interrupted`. | The Floor posts `probe` to the plain-merge frame (3.6). `plain.conflicts`, `plain.interrupted`, `plain.no_difference` and `plain.behind` update. | none |
| `green.verified` | Sets `green.runtime` and `green.last` (`seq`, `ok`, `confirmed`, the failed checks with their codes). | Strip: `green.static` when the runtime is `static`. A failed run with `confirmed: false`: the strip reads `green.checking` and nothing else changes. A failed run with `confirmed: true`: banner 8 and `green.red` (7, FR19). | `sr.green_checking` when `ok` is false and `confirmed` is false. `sr.green_red` (urgent) when `ok` is false and `confirmed` is true. |
| `green.advanced` | Sets `green.seq`, `green.commit`. | Strip: `green.at`. | none |
| `metrics` | Sets `metrics`; appends to `metrics_history`. | Strip: waiting. Swarm view: every number and the small chart. | none |
| `limits` | Sets `limits`, with the event's `ts`. | Strip: spend. Banners 3 and 6. The intent box and the kill switch change state. | `sr.killed` or `sr.cap` on change (urgent) |
| `swarm.state` | Sets `swarm`; `ever_ran` once `running` was true. | Banner 1 text (agent count). Swarm controls, dial and agent count. | `sr.swarm` on start and stop |

### 4.4 Derived values

Pure functions of `FloorState` and the clock. Each has a unit test. Every difference of times is a difference of `ts` values.

| Name | Definition |
| --- | --- |
| `runClock` | `clock − first_intent_ts`, or `00:00:00` when null. |
| `quietFor(attempt)` | `clock − attempt.last_event_ts`, for attempts in `working`, `going_around`, `needs_confirm`. |
| `changeName(attempt)` | 5.2. |
| `sentBack(attempt)` | `go_arounds + pull_backs` (`01-core.md` GA3). This is the number in `attempt.sent_back_n`, and the number that the limit of `GO_AROUND_LIMIT` counts. |
| `lightsInOrder(attempt)` | CO14. |
| `whoRelies(key)` | `01-core.md` 11.6 over `attempts` (in flight) and `landings` (not undone). |
| `whyTarget(path)` | The newest landed, not undone landing whose `paths` contain `path`; none means the seed. |
| `plainDiffers` | Landed landings of kind `change` whose `go_arounds` or `confirms` is not empty (CO25). |
| `plainSame` | True when `plain` is not null, the landing `plain.through_seq` is held in full, and `plain.tree` equals its `landed.tree` (`01-core.md` PM7). Otherwise false. |
| `pushStalled` | `push != null` and `clock − push.first_accepted_ts > PUSH_STALL_MS`. |
| `capReached` | `limits.refusing` (`01-core.md` SE7). |
| `greenRed` | `green.last` has `ok: false` and `confirmed: true`, and no landing of kind `revert` has landed after it. |
| `repairLatency` | `01-core.md` 14.7, real agents only: the p50 and the p90 of `repair_ms`. One value is the `ts` of the first `submit.result` with status `validated`, `submitted` or `held` after a go-around started, minus the `ts` of the `headsup.sent` of result `repair` that started it. Shown in About, never on the wall. |
| `forkThroughput` | `01-core.md` 14.8, from `repos`: repositories per second between `first_ts` and `last_ts`, and the share that failed. |
| `chapters(events)` | 8.5. |

### 4.5 Requests the Floor makes

The stream is the only source of pool facts. These requests exist for actions, for static files, and for three reads that a recording cannot hold. The paths and the bodies are fixed by `01-core.md` 13.6 and the `protocol` module; this table says how the Floor uses them.

| Purpose | Method and path | Who | Notes |
| --- | --- | --- | --- |
| The page and its assets | `GET /` | anyone | Static assets of the Worker. Every view is a client route of this one page. The main pool is the default pool of `/floor.json`. |
| The page for a named pool | `GET /p/{pool}` | anyone | A client route of the same page: that pool is the main pool (FE7). The browser checks of the build plan use it, and so does a canned cast on a second pool. |
| The page on a recording | `GET /replay/{id}` | anyone | A client route of the same page: it loads that recording and plays it (RY18). |
| Static settings | `GET /floor.json` | anyone | `FloorJson`, below. |
| Event stream | WebSocket `GET /api/pools/{pool}/stream` | anyone | Protocol of `01-core.md` 12.2. The page sends exactly one message, `{ hello: 1, after: n }`, then receives a snapshot or event frames. A second client message closes the socket, so the page never sends one. An unknown pool answers 404 (7, row FR30). |
| Session state | `GET /api/session` | anyone | Answers `{ owner }`. The cookie is HttpOnly, so the page cannot know otherwise. |
| Unlock | `POST /api/session` | anyone with the key | `{ key }` (`01-core.md` SE2). Answers 429 after too many failed tries (SE2a). |
| Lock | `DELETE /api/session` | owner | Clears the cookie. |
| Create intent | `POST /api/pools/{pool}/intents` | owner | `{ text, race, prewritten, request_id }`. Answers the `intent_id`. `race: true` is refused with `feature_off` when `features.race` is false. |
| Card action | `POST /api/pools/{pool}/cards/{card_id}` | owner | `{ option, submit_ids, attempt_id?, reason?, request_id }`. `option` is an id from `Card.options` (`01-core.md` CD4). `attempt_id` is sent only with `choose`. `reason` is the text the owner typed. |
| Undo plan | `GET /api/pools/{pool}/undo-plan?seq={seq}` | owner | Answered by Trunk with `UndoPlanResponse` (`01-core.md` UN4). It is not a public read: a public request never reaches Trunk (SE19). |
| Undo | `POST /api/pools/{pool}/undo` | owner | `{ seq, expect_reverted, request_id }`. Answers `UndoResponse`; a refusal with `plan_changed` carries the new plan (UN5). |
| Stop one agent | `POST /api/pools/{pool}/attempts/{attempt_id}/stop` | owner | `{ request_id }`. The attempt stops with reason `cancelled`. |
| Swarm | `POST /api/swarm` | owner | `SwarmRequest` (`01-core.md` SWR1): `{ pool, running, request_id }` and the fields of `SwarmConfig` (CO44a). The Floor never sends `patterns` or `release`; those are for the conductor and the tests. |
| Kill switch | `POST /api/kill` | owner | `01-core.md` SE10 to SE12: `{ killed, landings? }`. `{ killed: false }` also resumes a pool that the owner paused. |
| Rebuild | `POST /api/pools/{pool}/rebuild` | owner | `{ request_id }` (`01-core.md` LP8). |
| One landing's note | `GET /api/pools/{pool}/landings/{seq}/note` | anyone | Live mode only, for a landing that the page no longer holds in full. Answered by the Floor Durable Object. 404 in a `summary_only` pool. |
| Recordings | `GET /replay/index.json`, `GET /replay/{id}.ndjson` | anyone | Section 8. |
| Export a recording | `GET /api/pools/{pool}/replay.ndjson` | owner | The Floor Durable Object's events in the format of `01-core.md` 12.3. |
| Pool frames | the app-server routes of `02-tidepool.md` 4.2 | anyone | A live frame uses the page address of a moving source: `/pool/{pool}/main/`, `/pool/{pool}/plain/`, and `/pool/{pool}/green/` for the fallback of row FR28. A commit frame uses `frameUrl(address)` of the `protocol` module with `FrameAddress = { repo: "main" or "plain"; commit }` (`01-core.md` 10.3, PV5): `/pool/{pool}/{40 hex}/` or `/pool/{pool}/p-{40 hex}/`. There is no address for a live attempt view (PV4). |

```ts
type FloorJson = {                      // (Floor) the static settings; built with the deployment
  default_pool: string;                 // the main pool at `/`
  swarm_pool: string;                   // the pool of Swarm view; created with summary_only: true
  features: Features;                   // `01-core.md` FJ1; this file adds no key
  prewritten: Array<{ id: string;       // the id of `02-tidepool.md` section 9, for example "A01", "P1b", "P9a"
                      text: string; group: "starter" | null; race: boolean }>;
  swarm_defaults: { seed: number; launch_per_second: number;
                    think_ms: [number, number]; rescale_every_s: number };   // the SwarmConfig fields the page has no control for
  models: Record<string, string>;       // model id -> short name
  limits: string[];                     // the limits list of 5.12, lines whose condition is false left out
  related: string;                      // the text of `about.related.body`, so the page and the README show the same words
  default_view?: "floor" | "overview"; // 2.11: the view a live page opens on; absent means the Floor view
};
```

- **FE5.** No request other than these is made. In Replay only `GET /floor.json`, the recordings and pool frames are requested.
- **FE6.** A failed request never changes what the page shows as pool state. It produces an error sentence (5.9) next to the control that sent it.

### 4.6 What the Floor asked of `01-core.md`, and where it is settled

The first version of this file listed 25 things the stream or the interfaces did not define (N1 to N25), each with a behaviour "until then". `01-core.md` revision 2 settled all of them. No interim behaviour is built. The numbers are kept because other texts cite them.

| # | What was missing | Settled by (`01-core.md`) |
| --- | --- | --- |
| N1 | The diff in the stream | `headsup.sent.items` and `dropped_ops` (12.1); `items` is null only in a `summary_only` pool (EV6). |
| N2 | An event for the plain-merge pool | `plain.updated { commit, tree, through_seq, skipped, interrupted }` (PM6, PM7). |
| N3 | The landing's record | `landing.landed.note` is the blob id; `note_json` is the note itself, null in a `summary_only` pool. |
| N4 | Frame addresses of a card | Option (a): preview commits. `Card.preview` with `FrameAddress` (PV1 to PV5). No live attempt view exists. |
| N5 | The outcome of a triage | A second `premise.judged` when a pending triage is closed (JE1). |
| N6 | Removal of a premise | `premise.removed` (EM2). |
| N7 | `premise.recorded` when only a flag changes | Emitted for every entry of `ToolResponse.premises` (EM2). |
| N8 | The pool's file list and tiers | `pool.files` (EM1). |
| N9 | Model cost per attempt | `tokens_in`, `tokens_out`, `cost_usd` on `attempt.step`; `Card.candidates[id].cost_usd` on a race card. |
| N10 | Blast radius per race candidate | `Card.blast_radius` is a record per attempt, with `right_of_way` (10.3). |
| N11 | The spend cap as opposed to an attempt's own budget | Stop reason `spend_cap`; `limits.refusing` and `limits.reserved_usd` (SE7). The constant `CAP_REACHED_SHARE` is deleted. |
| N12 | Attempt-repo provisioning results | `attempt.repo` (AG5, 14.8). |
| N13 | Which metrics are authoritative | The `metrics` event for 14.1 to 14.6; the reducer computes 14.7 and 14.8 (EM5). |
| N14 | Pools of a Swarm, and its event volume | `swarm.state.pools`; EV6 for `summary_only` pools. |
| N15 | Typed or pre-written | `intent.created.prewritten`. |
| N16 | The HTTP paths | 13.6. |
| N17 | The clone address | `pool.state.remote`; read tokens are an owner action (SE5c). |
| N18 | Pool channel messages | SE16: `advance { version }`, `highlight { kinds }`, `tapped` with `path`; SE16a says which frame gets which. |
| N19 | Owner cancel of one attempt | The stop route of 13.6; stop reason `cancelled`. |
| N20 | Card reasons and close actions | `Card.reason` includes `revert_limit` and `reopen_failed`; `card.closed.action` is a `CardOption`, `stale` or `superseded` (CD1, CD4). |
| N21 | When `pool.state` is emitted | EM1: event 1 of every stream, and at every change. |
| N22 | The undo plan and its refusals | `UndoPlanResponse`, `UndoResponse`, `UndoRefusal` (UN4, UN5). |
| N23 | The link between `undo.planned` and its landing | `landing.accepted.request_id` (EM4). |
| N24 | A race card when a candidate is sent back | RC5: the card stays open and is updated; `card.updated` on every change (CD2). |
| N25 | Resuming a pool the owner paused; undoing an undo | `{ killed: false }` resumes (SE12). An undo landing cannot be undone (11.3). |

### 4.7 What the Floor needs from the tide pool specification

| # | Needed | For |
| --- | --- | --- |
| NP1 | The page addresses of the moving sources `main`, `plain` and `green`, and the commit addresses that `frameUrl` builds for the two forms of `FrameAddress` (`01-core.md` PV5), all with the response headers of SE14. A commit-addressed response never changes. | Every pool frame; Replay. |
| NP2 | The pool app fills its iframe at any size from 320×180 to 1152×648, keeps creatures recognisable at 428×241 (the smallest race frame), and draws nothing but the pool. | Layout (2.1 to 2.8). |
| NP3 | The host side of the channel of `01-core.md` SE16 (`02-tidepool.md` 4.5): `tapped` with the file path; `probe`, also with `selftest`; `advance { version }` in a commit frame; `highlight { kinds }`; `pause` and `resume`; `stats` every `STATS_EVERY_MS`, after every swap and in answer to every `probe`. | Why card, CO21, CO23a, CO23b, RY17. |
| NP4 | The break in the plain-merge pool is visible to someone who cannot read code: a creature whose first version compares energy with a number behaves visibly wrong after energy becomes a fraction (the crab never comes out). | Beats 0 and 4. |
| NP5 | Pre-written requests for the roles of 1.2, which the measured models complete: the group `starter` (A01, A03, A04, A06, A11, P1b); the crab request P1a, whose words carry the number 30; the sweep P9a, which changes a shared rule and edits every creature found by one search; the late creature P9b, which that search matches. Their ids, texts and groups go into `/floor.json`. | Beats 1 to 5. |
| NP6 | The policy file marks the shared-rule paths `held` (`01-core.md` 10.1), so the shared-rule change and the sweep wait on a card. The seed variant `tidepool-auto` is used only while `features.held` is false (`01-core.md` PL1). | BS3; 1.4. |
| NP7 | `tapped` carries the path of the creature's file. | Why card from a tap. |
| NP8 | The in-page self-test (`02-tidepool.md` 5.5): after a `probe` with `selftest: true`, the host reports the result in `stats.selftest`, in a live frame and in a commit frame. | The badges of Compare view (CO25a). |
| NP9 | A frame whose pool code never returns sends no `stats`. The Floor's watchdog is `POOL_STALL_MS` (`02-tidepool.md` HO8). | 7, row FR28. |

---

## 5. Interface copy

### 5.1 Rules

- **CP1.** The strings below are exact. They live in one module (`copy`) that the Floor imports; no component holds text of its own. Trunk fills card titles, bodies and option labels from the same module (5.10; `01-core.md` CD5). The module is pure: it imports nothing from the page, the browser or Cloudflare, so the engine may import it (`04-build-plan.md` 1.3).
- **CP2.** Plain words. Complete sentences of 25 words or fewer for anything that explains. Labels and buttons are short and start with a capital letter. One name per thing (the glossary of `01-core.md` section 1 and the Floor terms of section 0).
- **CP3.** A message about a problem says what happened, then what the page or the owner does next.
- **CP4.** The page does not use these words for its own concepts: branch, pull request, merge queue, claim, reviewer. The owner's tap is "Land", not "approve". This rule covers the `copy` module. The README and the submission texts may use "branch", "pull request" and "merge queue" where they state what a change replaces (lead decision; `04-build-plan.md` BP11).
- **CP5.** `{braces}` are filled from `FloorState`. Constants are filled from their values, never typed into a string. Plural forms: each string with `{n}` has a form for 1 and a form for other numbers; both are given where they differ.
- **CP6.** Text from outside (intent text, statements, summaries) is shown in double quotes and is never edited.
- **CP7.** A sentence that tells the owner something is waiting for them (`status.held`, `needs.badge`, `needs.title`, the `held` line of 5.7) is shown with "you" only to the owner in live mode. A visitor, and everyone in Replay, sees the form with "the owner". Both forms are given. A recorded fact (who landed, who declined, who chose) always says "the owner".
- **CP8 (one name per thing on the page).** The rail item is an "attempt card"; "card" alone is a decision that waits for the owner. A `repair` is a "go-around". Go-arounds and pull-backs together are "sent back". An undo or a revert "takes back" a landed change. An agent without a model is a "scripted agent", and its pool is "SYNTHETIC". The pool's own test is the "self-test"; the platform's check after landing is the "green line". The second pool of Compare view is the "plain-merge pool". No string uses a second word for any of these.

### 5.2 Naming things

`keyLabel(kind, key)` turns a premise key into words. `keyShort` is the first part only, for one-line sentences.

| Key | `keyLabel` | `keyShort` |
| --- | --- | --- |
| `entity` `world/energy.js#ENERGY_MAX` | ENERGY_MAX in world/energy.js | ENERGY_MAX |
| `entity` `creatures/fish.js#(import ../world/energy.js)` | the imports from ../world/energy.js in creatures/fish.js | imports in fish.js |
| `entity` `main.js#(top)` | the top-level code of main.js | top-level code |
| `entity` `pen.js#default` | the default export of pen.js | default export |
| `entity` `world/index.js#*./energy.js` | the re-export of ./energy.js in world/index.js | re-export |
| `file` `world/energy.js` | the file world/energy.js | energy.js |
| `listing` `creatures/` | the list of files in creatures/ | files in creatures/ |
| `listing` `/` | the list of files at the top of the pool | top-level files |
| `query` `text:creatures/:drain(` | the search for "drain(" in creatures/ | search "drain(" |
| `query` `text:/:drain(` | the search for "drain(" in the whole pool | search "drain(" |
| `query` `refs:world/energy.js#ENERGY_MAX` | the list of code that uses ENERGY_MAX in world/energy.js | uses of ENERGY_MAX |
| `query` `outline:world/energy.js` | the outline of world/energy.js | outline of energy.js |
| `check` `not_exhausted` (an item of rule `CKL` or of a revert, not a premise) | the check "No kind of creature rests too much of the time" (the label of 5.7) | a check |

| Function | Rule | Example |
| --- | --- | --- |
| `changeName(attempt)` | If the attempt has exactly one `file` premise pinned at `absent` with `edit` true: that file's name without directory and extension. Otherwise the intent text cut at a word end to `CHANGE_NAME_CHARS` characters, with "…", in quotes. A race candidate adds its model name in brackets. | crab · "make energy a fraction…" · "add day and night" (glm-5.3-flash) |
| `modelName(id)` | The last segment of the model id. | gpt-oss-120b |
| Count | Digits with a comma every three places. | 1,024 |
| Share | Whole percent. Null shows `strip.dash`. | 12% |
| Money | Dollars with two decimals. Below one cent: "less than $0.01". | $3.12 |
| Duration | Below 1 s: milliseconds. Below 60 s: seconds. Otherwise minutes and seconds. | 640 ms · 42 s · 1 min 12 s |
| Clock | `hh:mm:ss`. | 00:03:41 |
| Time of day | The viewer's local time, 24-hour, with seconds. | 14:03:44 |
| Landing | "landing {seq}". | landing 9 |

### 5.3 Status words and light words

| Id | Text | Shape | Colour token |
| --- | --- | --- | --- |
| `status.opened` | Starting | dotted ring | `muted` |
| `status.queued` | Waiting for a free agent | dotted ring | `muted` |
| `status.working` | Working | small filled circle | `accent` |
| `status.going_around` | Going around | diamond | `changed` |
| `status.needs_confirm` | Confirming | triangle | `confirm` |
| `status.submitted` | Being checked | half-filled circle | `checking` |
| `status.validated` | Ready to land | ring | `holds` |
| `status.held` | Waiting for you (visitor and Replay: Waiting for the owner) | two upright bars | `confirm` |
| `status.accepted` | Landing… | half-filled circle | `holds` |
| `status.landed` | Landed | circle with a tick | `holds` |
| `status.stopped` | Stopped | cross | `changed` |
| `status.undone` | Undone | cross | `muted` |
| `status.not_chosen` | Not chosen | cross | `muted` |
| `status.declined` | Declined | cross | `muted` |
| `light.holds` | Holds | | |
| `light.changed` | Changed | | |
| `light.confirm` | Needs a confirm | | |
| `light.blind_spot` | Blind spot | | |
| `light.checking` | Being checked | | |
| `light.flag.read` | the agent read it | | |
| `light.flag.edit` | this change edits it | | |
| `light.flag.derived` | the new code uses it | | |
| `light.more` | +{n} | | |
| `light.holds_count` | {n} hold | circle | `holds` |
| `light.tip` | {keyLabel}: {light word}. {flags, joined by ", "}. | | |
| `light.blind_spot.tip` | The new code uses {keyLabel}, and the agent never read it. | | |

### 5.4 Labels, buttons, empty and loading texts

| Id | Text |
| --- | --- |
| `app.name` | Premise |
| `app.thesis` | Git records only what an agent wrote. Premise also records what it read. |
| `app.settings_failed` | Premise could not load its settings. Reload the page. |
| `nav.floor` | Floor |
| `nav.swarm` | Swarm |
| `nav.overview` | Overview |
| `overview.label` | Overview |
| `overview.loading` | Waiting for the pool to report. |
| `overview.landed` | {n} changes landed. (for 1: {n} change landed.) |
| `overview.landed.none` | No change has landed yet. |
| `overview.goarounds` | {n} went around. |
| `overview.waiting.none` | Nobody waited. Every landing is one ordinary commit on main. |
| `overview.waiting` | {n} waiting behind another change. Every landing is one ordinary commit on main. |
| `overview.inflight` | In flight |
| `overview.inflight.none` | Nothing is in flight. |
| `overview.latest` | Latest landings |
| `overview.more` | Every attempt and detail is in the Floor view. |
| `nav.replay` | Replay |
| `nav.about` | About |
| `nav.skip` | Skip to the attempt cards |
| `nav.label` | Views |
| `needs.badge` | Needs you {n} (visitor and Replay: Needs the owner {n}) |
| `needs.title` | Needs you ({n}) (visitor and Replay: Needs the owner ({n})) |
| `card.open` | Open |
| `card.close` | Close |
| `strip.label` | Counters |
| `strip.clock` | Run clock |
| `strip.agents` | Real agents |
| `strip.agents.value` | {n} of {max} |
| `strip.agents.limit` | Limit set by the model rate. |
| `strip.agents.synthetic` | {n} scripted |
| `strip.landed` | Landed |
| `strip.goarounds` | Go-arounds |
| `strip.waiting` | Waiting behind another change |
| `strip.waiting.backlog` | {n} waiting for a push |
| `strip.green` | Green line |
| `green.at` | landing {seq} |
| `green.static` | landing {seq} · static checks only |
| `green.red` | failed at landing {seq} |
| `green.checking` | checking landing {seq} again |
| `green.none` | not running in this build |
| `strip.spend` | Spend |
| `spend.value` | {spent} of {cap} |
| `spend.unknown` | not reported yet |
| `spend.near` | Spend is near the cap. |
| `spend.reached` | The spend cap is reached. |
| `spend.model_line` | {model}: {used} of {limit} requests in the last minute. (for 1: {model}: {used} of {limit} request in the last minute.) |
| `strip.dash` | – |
| `strip.stale` | As of {duration} ago. |
| `intent.placeholder` | Ask for a change in plain words. |
| `intent.count` | {n} of {max} |
| `intent.send` | Send |
| `intent.race` | Race {RACE_SIZE} |
| `intent.race.tip` | Send this request to {RACE_SIZE} different models. You choose one result. |
| `intent.sending` | Sending… |
| `intent.sent_waiting` | Sent. Waiting for the pool to show it. |
| `intent.prewritten` | Pre-written requests |
| `intent.starter` | Send the starter set ({n}) |
| `intent.queue` | All {max} agent slots are busy. Your request waits for a free slot. (for 1: The {max} agent slot is busy. Your request waits for a free slot.) |
| `intent.visitor` | Only the owner can send requests. You can watch, open Why cards and play the Replay. |
| `intent.replay` | This is a recording. Requests are off. |
| `intent.killed` | All agents are stopped. Allow agents again to send a request. |
| `intent.paused` | The pool is paused. No request can start. |
| `intent.rebuilding` | The pool is rebuilding from Artifacts. Requests open again when it is ready. |
| `intent.cap` | The spend cap is reached. No model call can start. |
| `rail.label` | Changes |
| `rail.tab.working` | Working {n} |
| `rail.tab.landed` | Landed {n} |
| `rail.tab.stopped` | Stopped {n} |
| `rail.empty.working` | No change is in flight. Type a request above. |
| `rail.empty.working.visitor` | No change is in flight. Press Replay to watch a recorded run. |
| `rail.empty.working.replay` | No change is in flight at this point of the recording. |
| `view.failed` | This part of the page stopped because of an error. The rest of the page still works. Reload the page to try again. |
| `rail.empty.landed` | Nothing has landed yet. |
| `rail.empty.stopped` | No attempt has stopped. |
| `rail.more` | {n} more below. |
| `rail.summary_only` | This pool reports summaries only. Lights, steps and diffs are not in its stream. |
| `attempt.tag.prewritten` | Pre-written |
| `attempt.tag.synthetic` | SYNTHETIC |
| `attempt.tag.reopened` | Reopened by {cause: undo, the green line, the owner} |
| `attempt.same_agent` | Same agent, same conversation. |
| `attempt.tag.right_of_way` | Right of way |
| `attempt.tag.mcp` | Over MCP |
| `attempt.model_changed` | A different model is continuing this work. The model that started it was not available. |
| `attempt.queue` | It starts when an agent slot is free. The limit is {max}. |
| `attempt.starting` | The agent is starting. |
| `attempt.sent_back_n` | sent back {n} of {GO_AROUND_LIMIT} |
| `attempt.waiting_clef` | All checks passed. Waiting for Clef. |
| `attempt.next_batch` | All checks passed. It lands in the next batch. |
| `attempt.open_card` | Open the card. |
| `attempt.landing` | Recorded by Trunk. Being pushed to main. |
| `attempt.landed_as` | On main as landing {seq}. |
| `attempt.stop` | Stop this agent |
| `attempt.stopping` | Stopping… |
| `attempt.again` | Send this request again |
| `attempt.slow` | The model has not answered for {seconds} s. It is tried again by itself. If that fails, the attempt stops. |
| `attempt.relies` | Relies on |
| `attempt.changes` | What it changes |
| `attempt.checks` | What was checked |
| `attempt.earlier` | Earlier |
| `headsup.title.repair` | Heads-up {hn} · go-around {n} |
| `headsup.title.confirm` | Heads-up {hn} · one confirm needed |
| `headsup.title.info` | Heads-up {hn} · for information |
| `headsup.cause` | Changed by: "{intent text}" ({landing}) |
| `headsup.cause.undo` | Changed by: the undo of {landing} |
| `headsup.cause.revert` | Changed by: the green line took back {landings} |
| `headsup.cause.submit` | Found when the agent submitted. |
| `headsup.before` | Before |
| `headsup.after` | After |
| `headsup.now` | Now |
| `headsup.uses` | Its own lines that use it |
| `headsup.use_line` | {path} line {line} |
| `headsup.added` | New: {list} |
| `headsup.removed` | Gone: {list} |
| `headsup.context` | Also new or changed in those files |
| `headsup.check` | The check that failed: {check label} |
| `headsup.truncated` | Some code was too long to show here. The agent reads it from the pool. |
| `headsup.before_unavailable` | The earlier version is not available. |
| `headsup.dropped` | An edit to {path} no longer applies. The agent must make it again. |
| `headsup.nothing_to_do` | The agent was told. Nothing has to change. |
| `headsup.said` | The agent said: "{statement}" |
| `headsup.waits` | The agent stopped before it answered this. |
| `headsup.no_diff` | The exact diff was sent to the agent. This page did not receive it. |
| `headsup.show_all` | Show all {n} lines (for 1: Show {n} line) |
| `frame.main.caption` | Premise · main · {landing} |
| `frame.main.seed` | Premise · main · the seed, before any landing |
| `frame.main.title` | The live pool, running the code on main |
| `frame.pause` | Pause |
| `frame.play` | Play |
| `frame.paused` | Paused. The code still lands; only the picture is still. |
| `frame.compare` | Compare |
| `frame.landing` | {n} landing… |
| `frame.loading` | Loading the pool… |
| `frame.error` | The pool did not load. The attempt cards and the numbers are still live. |
| `frame.reload` | Reload the pool |
| `frame.pool_paused` | The pool is paused. This is the last landed state. |
| `frame.replay` | Recorded code at {landing}, running now. |
| `frame.replay_gone` | The recorded pool is no longer stored. The attempt cards and the numbers still play. |
| `frame.stalled.green` | The pool stopped answering. This is the last verified version, {landing}. |
| `frame.stalled.reloaded` | The pool stopped answering and was loaded again. |
| `frame.stalled` | The pool stopped answering. The attempt cards and the numbers are still live. |
| `plain.label` | Same changes, merged by plain git |
| `plain.constructed` | Constructed for comparison · through {landing} |
| `plain.title` | A second pool, built from the same changes with a plain git merge |
| `plain.differs` | What differs |
| `plain.diff_line` | {changeName}: went around once after {keyShort} changed. The plain-merge pool has its first version. |
| `plain.diff_line.many` | {changeName}: went around {n} times. The plain-merge pool has its first version. (for 1: {changeName}: went around {n} time. The plain-merge pool has its first version.) |
| `plain.diff_line.confirm` | {changeName}: confirmed {keyShort} before landing. The plain-merge pool has its first version. |
| `plain.interrupted` | {changeName}: its agent was sent back in the middle of its work. The plain-merge pool has its unfinished work. |
| `plain.no_difference` | No visible difference in this run. Both pools hold the same files. |
| `plain.conflicts` | Text conflicts in the plain merge: {n} (approximated) |
| `plain.conflicts.tip` | A change that the plain merge could not apply is left out of the right pool and counted here. The count is approximated: Trunk replays each change's edits in order, which is not a full three-way merge. |
| `plain.conflicts.merged` | Text conflicts in the plain merge: {n} |
| `plain.conflicts.merged.tip` | A change that plain git could not merge is left out of the right pool and counted here. Trunk merges each file from three versions, line by line, as git merge-file does. The three are where the agent started, the plain-merge pool, and the agent's own version. |
| `plain.same` | No change has gone around yet. |
| `plain.loading` | Building the plain-merge pool… |
| `plain.behind` | This pool is {n} landings behind. (for 1: This pool is {n} landing behind.) |
| `compare.back` | Back to the Floor |
| `selftest.running` | Self-test, run in this page: running… |
| `selftest.pass` | Self-test, run in this page: passed |
| `selftest.fail` | Self-test, run in this page: failed · {n} checks (for 1: failed · 1 check) |
| `selftest.fail.line` | {check label} ({kind}) |
| `selftest.tip` | This page ran the pool's own self-test on the version in this frame. It is not the green line. |
| `tiles.loading` | Loading the file list… |
| `tiles.files` | Files |
| `tiles.more` | +{n} more |
| `tile.held` | Held |
| `tile.held.tip` | A change to this file waits for one tap from the owner. |
| `tile.more_marks` | +{n} |
| `tile.removed` | Removed |
| `tile.name` | {path}. {r} reading, {w} writing. |
| `tile.menu.who` | Who relies on this |
| `tile.menu.why` | Why (newest change) |
| `why.title` | Why is this here? |
| `why.head` | {changeName} · {landing} · {time of day} |
| `why.asked` | Who asked |
| `why.asked.line` | {requester}: "{intent text}" |
| `why.wrote` | Who wrote it |
| `why.wrote.real` | A real agent on {model}. |
| `why.wrote.synthetic` | A scripted agent (SYNTHETIC). No model was called. |
| `why.relied` | What it relied on |
| `why.under` | What changed under it |
| `why.under.none` | Nothing it relied on changed while the agent worked. |
| `why.under.goaround` | Go-around {n}: {rule sentence} ({landing}: "{intent text}"). |
| `why.under.confirm` | Confirm: {rule sentence} |
| `why.checked` | What was checked |
| `why.checked.count` | {ok} of {all} checks passed. (for 1: {ok} of {all} check passed.) |
| `why.checked.all` | Show the checks |
| `why.landed_how` | How it landed |
| `why.landed.auto` | By itself. Everything it relied on was still true, and no held path was touched. |
| `why.landed.owner` | The owner tapped Land at {time of day}. It touches a held path. |
| `why.landed.owner_now` | The owner tapped Land now at {time of day}. It did not wait for the change that had right of way. |
| `why.landed.owner_risk` | The owner tapped Land at {time of day}. Clef had flagged this change. |
| `why.landed.chosen` | The owner chose it from {n} attempts at {time of day}. (for 1: The owner chose it from {n} attempt at {time of day}.) |
| `why.changed` | What it changed |
| `why.git` | Show the git |
| `why.seed` | This was in the pool before any agent changed it. It is part of the seed. |
| `why.landing` | This change is landing. Its record appears when main has it. |
| `why.loading` | Loading the record… |
| `why.partial` | This is what the page received. The full record is the git note on this commit. |
| `why.unwitnessed` | This landing has no git note, so its record is not known. The commit is on main. |
| `why.undone` | This change was undone by {landing}. |
| `why.undo.title` | Undo of {landing} |
| `why.undo.took_back` | It took back: {list of landings with change names}. |
| `why.undo.reopened` | Reopened, with their agents and conversations: {list}. |
| `why.undo.kept` | Kept, because they only read it: {list}. |
| `why.revert.title` | The green line took back {landings} |
| `git.title` | Show the git |
| `git.commit_is` | This is an ordinary git commit on main, in Artifacts. |
| `git.commit` | Commit |
| `git.parent` | Parent |
| `git.tree` | Tree |
| `git.note_is` | The record above is this git note. |
| `git.read_yourself` | Read it yourself with plain git: |
| `git.copy` | Copy |
| `git.copied` | Copied. |
| `git.loading_note` | Loading the note… |
| `git.no_note` | The note is not loaded here. The two commands below show it. |
| `git.read_token` | To clone, ask the owner for a read token. The README says how the owner creates one. |
| `who.open` | Who relies on this |
| `who.title` | Who relies on {keyLabel} |
| `who.pick` | Choose a part of {path}: |
| `who.in_flight` | In flight ({n}) |
| `who.landed` | Landed ({n}) |
| `who.none` | Nothing relies on this yet. |
| `who.summary_only` | This pool reports summaries only. Who relies is not available here. |
| `who.window` | This list covers the newest {FLOOR_KEEP_LANDINGS} landings. |
| `undo.open` | Undo |
| `undo.too_old` | This landing is too far back to undo. Undo covers the newest {UNDO_WINDOW} landings. |
| `undo.planning` | Working out what this undo takes back… |
| `undo.title` | Undo {landing}: "{intent text}"? |
| `undo.also` | This also takes back {n} later changes that were built on it: {names}. Their agents reopen and adapt. (for 1: This also takes back {n} later change that was built on it: {names}. Its agent reopens and adapts.) |
| `undo.also.none` | No later change was built on it. |
| `undo.kept` | {n} later changes only read it. They stay: {names}. (for 1: {n} later change only read it. It stays: {names}.) |
| `undo.in_flight` | {n} changes in flight get a heads-up: {names}. (for 1: {n} change in flight gets a heads-up: {names}.) |
| `undo.plan_changed` | The pool changed while this was open. This is what the undo takes back now. |
| `undo.confirm` | Undo it |
| `undo.sending` | Undoing… |
| `undo.cancel` | Keep it |
| `undo.refused` | Trunk refused the undo: {reason}. Nothing changed. |
| `undo.landing` | Undo of {landing} is landing… |
| `undo.done` | Undo of {landing} landed as {landing}. It took back {n} changes. (for 1: Undo of {landing} landed as {landing}. It took back {n} change.) |
| `revert.landing` | The green line failed. Trunk is taking back {landings}. |
| `held.before` | Before: the pool now |
| `held.after` | After: the pool with this change |
| `held.changes` | What it changes |
| `held.affects` | Who it affects |
| `held.relied_landed` | {n} landed changes rely on what it changes. (for 1: {n} landed change relies on what it changes.) |
| `held.relied_inflight` | {n} changes in flight have a premise on what it changes: {names}. (for 1: {n} change in flight has a premise on what it changes: {names}.) |
| `held.checked` | What was checked |
| `held.blind` | {n} blind spots confirmed by the agent. (for 1: {n} blind spot confirmed by the agent.) |
| `held.reason` | Reason (optional) |
| `held.landing` | Landing… |
| `held.visitor` | Waiting for the owner. |
| `held.risk_waiting` | Clef's answers are on their way. You can decide without them. |
| `held.risk_unavailable` | Clef's answers are not available. Decide from the preview and the checks. |
| `held.stale` | This card is out of date. Something the change relied on has changed. The agent is adapting. A new card opens when it is ready. |
| `held.closed.land` | The owner tapped Land. It lands through the same gate as every other change. |
| `held.closed.land_now` | The owner tapped Land now. It lands in the next batch. |
| `held.closed.decline` | The owner declined it. The attempt is stopped and kept. |
| `race.closed` | The owner chose {changeName}. It lands in the next batch. The others are kept. |
| `choice.closed` | The owner chose: {option label}. |
| `held.no_preview` | No preview is available for this change. |
| `held.preview_building` | Building the preview… |
| `held.land_now.tip` | Lands it in the next batch. It does not wait for the change that has right of way. |
| `race.group` | Race · {n} attempts (for 1: Race · {n} attempt) |
| `race.working` | Still working |
| `race.took` | Took {duration} |
| `race.cost` | Cost {money} |
| `race.blast` | Would send back: {n} changes (for 1: Would send back: {n} change) |
| `race.unknown` | not recorded |
| `race.chosen` | Chosen |
| `race.stopped` | Stopped before it finished. |
| `race.superseded` | Every attempt stopped before one was chosen. |
| `swarm.lps` | Landings per second |
| `swarm.ttl` | Time to land |
| `swarm.ttl.sub` | median · p99 {duration} |
| `swarm.gar` | Go-around rate |
| `swarm.waiting` | Waiting behind another change |
| `swarm.window` | last {seconds} s |
| `swarm.now` | now |
| `swarm.false_abort` | False-abort rate {share} (target {share}) |
| `swarm.false_abort.tip` | The share of go-arounds after which the agent changed nothing. |
| `swarm.escape` | Escape rate {share} (target {share}) |
| `swarm.escape.tip` | The share of landed changes that the green line later took back. |
| `swarm.backlog` | Push backlog {n} |
| `swarm.last_push` | Last push: 1 push, {n} changes (for 1: Last push: 1 push, {n} change) |
| `swarm.agents` | Agents |
| `swarm.dial` | Collisions |
| `swarm.dial.tip` | The share of scripted changes that touch something another scripted change relies on. |
| `swarm.start` | Start |
| `swarm.starting` | Starting {n} scripted agents… (for 1: Starting {n} scripted agent…) |
| `swarm.stop` | Stop |
| `swarm.stopping` | Stopping… |
| `swarm.empty` | No Swarm run yet. A run uses scripted agents and makes no model calls. |
| `swarm.final` | The run has ended. These are its last measured numbers, at {time of day}. |
| `swarm.no_agents` | The Swarm is running and no scripted agent has started yet. Stop it and start again. |
| `swarm.blocked` | The Swarm cannot start while agents are stopped or the pool is paused. |
| `swarm.real_limit` | Real agents in the main pool: {max} at most. The limit is the model rate. (for 1: Real agent in the main pool: {max} at most. The limit is the model rate.) |
| `swarm.shape` | This run: {pools} pool, {pools} Trunk, {agents} scripted agents. (for 1: This run: {pools} pool, {pools} Trunk, {agents} scripted agent.) |
| `swarm.repair_note` | Scripted agents answer at once. Repair time is measured with real agents only and is shown in About. |
| `swarm.wall.summary` | {n} scripted agents: {a} working, {b} going around, {c} landing. (for 1: {n} scripted agent: {a} working, {b} going around, {c} landing.) |
| `replay.menu.title` | Recordings |
| `replay.menu.item` | {title} · {duration} · recorded {date} |
| `replay.none` | This deployment has no recording yet. |
| `replay.save` | Save this run as a recording |
| `replay.error` | (the sentence of 8.3 for the check that failed) |
| `replay.loading` | Loading the recording… {share} |
| `replay.play` | Play |
| `replay.pause` | Pause |
| `replay.restart` | Restart |
| `replay.position` | {clock} of {clock} |
| `replay.speed` | Speed {x}× |
| `replay.close` | Close Replay |
| `replay.skipped` | Skipped {duration} with no events. |
| `replay.ended` | The recording has ended. |
| `replay.again` | Watch again |
| `replay.to_live` | Open the live Floor |
| `replay.unknown` | This recording has {n} events this page does not know. They are skipped. (for 1: This recording has {n} event this page does not know. It is skipped.) |
| `start.title` | Watch a recorded run |
| `start.body` | This plays a real recorded run through this same page. You need no account and no key. |
| `start.play` | Play the Replay ({duration}) |
| `start.look` | Look around the live pool |
| `start.look.repo` | Look around this repository |
| `owner.visitor` | Visitor |
| `owner.unlocked` | Owner |
| `owner.replay` | Replay |
| `owner.title` | Owner key |
| `owner.body` | The owner key lets this browser send requests and answer cards. |
| `owner.key_label` | Owner key |
| `owner.unlock` | Unlock |
| `owner.checking` | Checking… |
| `owner.cancel` | Cancel |
| `owner.lock` | Lock |
| `owner.locked_toast` | Locked. This browser is a visitor now. |
| `owner.wrong` | That key is not right. Paste the owner key again. |
| `owner.not_configured` | This deployment has no owner key. Nothing can be changed from this page. |
| `owner.wait` | Too many tries. Wait one minute, then try again. |
| `owner.expired` | Your owner session has ended. Enter the key again. |
| `kill.open` | Stop all agents |
| `kill.title` | Stop all agents? |
| `kill.body` | No model call starts after this. Each agent stops at its next step. Changes that are already checked still land. |
| `kill.landings` | Also pause landings |
| `kill.confirm` | Stop all agents |
| `kill.stopping` | Stopping… |
| `kill.cancel` | Cancel |
| `kill.allow` | Allow agents again |
| `about.title` | About this run |
| `about.how` | How it runs |
| `about.run` | In this run |
| `about.run.real` | Real agents: at most {max} at once, on {models}. (for 1: Real agent: at most {max} at once, on {models}.) |
| `about.run.real.none` | Real agents: at most {max} at once. No model has been called yet. (for 1: Real agent: at most {max} at once. No model has been called yet.) |
| `about.run.landed` | Landed changes: {n}. Go-arounds: {n}. |
| `about.run.repair` | Repair time with real agents: median {duration}, p90 {duration}. |
| `about.run.synthetic` | Scripted agents (SYNTHETIC): {n}. They make no model calls. (for 1: Scripted agent (SYNTHETIC): {n}. It makes no model calls.) |
| `about.run.constructed` | Constructed: the plain-merge pool. Trunk builds it from the same changes for comparison. |
| `about.run.spend` | Model spend: {spent} of a cap of {cap}. |
| `about.unknown_events` | This page skipped {n} events of a newer kind. Reload to get the newest page. (for 1: This page skipped {n} event of a newer kind. Reload to get the newest page.) |
| `about.build` | Page build {build}. Recording made by build {build}. |
| `about.forks_unknown` | Attempt repositories: not reported by this build. |
| `about.forks` | Attempt repositories: {rate} per second, {share} failed. No landing waits for one. |
| `about.forks_off` | Attempt repositories are not provisioned in this build. |
| `about.trunk_errors` | Trunk recorded {n} internal errors and tried each step again. (for 1: Trunk recorded {n} internal error and tried the step again.) |
| `about.limits` | Limits |
| `about.related` | Related work |
| `about.related.body` | STORM (arXiv 2605.20563), CoAgent (arXiv 2606.15376) and the entry "dibs" also check what agents relied on. Premise observes reads at entity, listing and search level, checks them live, and stores the record in git notes. |
| `shortcuts.title` | Keys |
| `shortcuts.toggle` | Single-key shortcuts |
| `banner.more` | {n} more notices (for 1: {n} more notice) |
| `pool.rebuild` | Rebuild from Artifacts |
| `pool.rebuild.title` | Rebuild the pool from Artifacts? |
| `pool.rebuild.body` | Trunk reads main and the notes again. Changes that were landing go back to their agents and land again. Open cards close. |
| `pool.rebuild.confirm` | Rebuild |
| `pool.missing` | There is no pool at this address. |
| `pool.to_default` | Open the default pool |
| `toast.landed` | {changeName} landed. |
| `toast.sent` | Request sent. |

### 5.5 The activity line

Built from `attempt.step`. `{target}` goes through `keyLabel` when it is a key, and is shown as given when it is a path, a directory or a search text.

| `tool` | Text |
| --- | --- |
| null (a model turn) | Thinking |
| `outline` | Looking at the outline of {target} |
| `read` | Reading {target} |
| `list` | Listing {target} |
| `search` | Searching for "{target}" |
| `write` | Writing {target} |
| `replace` | Editing {target} |
| `submit` | Submitting |

After `QUIET_NOTICE_MS` without a new event the line adds " · {seconds} s". A failed step reads "{line} did not work: {reason}. The agent tries another way." with the reason below.

| `error` | Reason |
| --- | --- |
| `not_found` | it does not exist |
| `not_a_module` | it is not a JavaScript module |
| `read_first` | the agent must read the file first |
| `no_match` | the text to replace was not found |
| `ambiguous` | the text to replace appears more than once |
| `no_change` | it changes nothing |
| `parse_error` | the result does not parse |
| `heads_up_first` | the agent must read its heads-up first |
| `too_large`, `limit_reached` | it is over a size limit |
| `pool_not_ready` | the pool is paused |
| `timeout` | Trunk did not answer in time |
| `invalid_path`, `invalid_args`, `binary`, `attempt_unknown`, `attempt_closed` | the call was not valid ({error}) |

### 5.6 Heads-up and judgment sentences

One sentence per rule of `01-core.md` 7.2. `{thing}` is `keyLabel`. Used in heads-up panels, in the expanded premise list and on the Why card.

| Rule | Reason | Sentence |
| --- | --- | --- |
| `E1` | `edited_entity_changed` | Another change edited {thing}, and this change edits it too. |
| `E2` | `referenced_entity_changed` | {thing} changed, and this change uses it. |
| `E2m`, `F3m` | `module_reference_changed` | {thing} changed, and other code in a file this change edits uses it. The agent must confirm. |
| `E3`, `F4`, `F6` | `triage_depends` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must adapt. |
| `E3`, `F4`, `F6` | `triage_unsure` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must confirm. |
| `E3`, `F4`, `F6` | `reaffirmed` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent was told. |
| `E3`, `F4`, `F6`, `QT2` | `triage_unavailable` | {thing} changed. Clef was not available, so the agent must confirm. |
| `E3`, `F4`, `F6`, `QT2` | pending (no result yet; the reasons `read_not_referenced` and `search_gained_match`) | {thing} changed. Clef is judging whether this change depends on it. |
| `E4`, `F7` | `reference_gone` | This change no longer uses {thing}. |
| any | `premise_gone` | This change no longer relies on {thing}. |
| `F1` | `write_base_changed` | {thing} changed under a whole-file write. |
| `F2` | `cosmetic` | Only comments or spacing changed in {thing}. Nothing to do. |
| `F3` | `referenced_entity_changed` | {thing} changed in a part this change uses. |
| `F3`, `F5` | `referenced_file_changed` | {thing} changed, and this change uses it. |
| `L1` | `sweep_incomplete` | {thing} gained a file while this change was editing the files there. |
| `L2` | `listing_named` | {thing} changed, and this change names one of those files. |
| `L3` | `listing_unused` | {thing} changed. This change does not depend on it. |
| `QT1` | `sweep_incomplete` | {thing} has a new match, and this change had edited the earlier matches. |
| `QT2` | `triage_depends` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must adapt. |
| `QT2` | `triage_unsure` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must confirm. |
| `QT2` | `reaffirmed` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent was told. |
| `QT3`, `QR2` | `match_lost` | {thing} lost a match. Nothing to do. |
| `QR1` | `new_reference_to_altered_entity` | Another change now uses what this change alters: {added}. |
| `QR1m` | `referrer_module_changed` | A file that uses what this change alters was changed. The agent must confirm. |
| `QR4` | pending (the reason `reader_landed`) | A change whose agent had read {entity} landed. Clef is judging whether it depends on the version this change replaces. |
| `QR4` | `triage_depends` | A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent must adapt. |
| `QR4` | `triage_unsure` | A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent must confirm. |
| `QR4` | `reaffirmed` | A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent was told. |
| `QR4` | `triage_unavailable` | A change whose agent had read {entity} landed. Clef was not available, so the agent must confirm. |
| `QO1` | `outlined_entity_changed` | {thing} changed in a part this change uses. |
| `QO2` | `outline_unused` | {thing} changed in a part this change does not use. |
| `B1` | `blind_spot` | The new code uses {thing}, and the agent never read it. Trunk showed it the current version. |
| `X0` | `no_patch_yet` | {thing} changed before this change wrote anything. The agent was told. |
| `Z1` | `unclassified` | {thing} changed in a way that no rule covers. The agent must confirm. |
| `E1`, `E2`, `F1` | `reopened_dep_changed` | {thing} changed back when an earlier change was undone, and this change was built on it. |
| `OP1` | | The text an edit replaced is gone from {path}. |
| `OP2` | | The text an edit replaced now appears more than once in {path}. |
| `OP3` | | The text an edit replaced moved to another part of {path}. |
| `OP4` | | {path} no longer exists. |
| `OP5` | | {path} changed under a whole-file write. |
| `CKL` | `checks_failed_at_landing` | The checks failed on the newest code when this change was about to land. |
| any | `push_lost` | The push for this landing was lost when the pool was rebuilt. The change lands again. |
| any other | any other | {thing} changed ({rule}, {reason}). |

In the `QR4` rows `{entity}` is the `keyLabel` of the entity that the `refs:` premise is about. The `reopened_dep_changed` row is the heads-up of an attempt that Undo reopened (`01-core.md` UN2, UN6; added 2026-10-10: the scripted rehearsal showed the catch-all form "(E2, reopened_dep_changed)" in beat 7).

Scripted answers. A synthetic attempt never calls Clef: its triage is answered from the script's own list of what the change depends on, and the judgment carries `clef.model = "scripted"` (`01-core.md` TR8). The page then uses these sentences instead of the ones that name Clef, and shows no share:

| Reason, when `clef.model` is `scripted` | Sentence |
| --- | --- |
| `triage_depends` | {thing} changed. The script lists it as something this change depends on. The agent must adapt. |
| `reaffirmed` | {thing} changed. The script does not list it as something this change depends on. The agent was told. |
| `triage_unavailable` | {thing} changed. No answer was available, so the agent must confirm. |

One-line form on a collapsed attempt card: "{keyShort} changed. The diff was sent to the agent." for `repair`; "{keyShort} changed. The agent must confirm." for `confirm`; "{keyShort} changed. The agent was told." for `info`.

`tick.skipped`:

| `why` | Sentence |
| --- | --- |
| `not_disjoint` | It overlaps a change in this batch. Trunk checks it against the new code next. |
| `right_of_way` | Waiting behind {changeName of `behind`}, which has right of way. |
| `checks_failed` | The checks failed on the newest code. The agent gets the reason and adapts. |
| `held` | Under the newest policy this change touches a held path. A card asks the owner. |

### 5.7 Checks and submit results

Checks of a submit (`Check.name`, `01-core.md` 4.9):

| Check `name` | Label |
| --- | --- |
| `replay` | The edits apply to the newest code |
| `non_empty` | The change is not empty |
| `fits` | The pool stays within its size limits |
| `parse` | The code parses |
| `imports_resolve` | Every import points at something |
| `globals_allowed` | Only allowed globals are used |
| `premises_hold` | Everything it relied on is still true |
| `policy` | Policy: {detail} |
| any other | {name} |

| `submit.result.status` | Line on the attempt card |
| --- | --- |
| `validated` | `attempt.next_batch` |
| `submitted` | `attempt.waiting_clef` |
| `held` | All checks passed. Waiting for you. (visitor and Replay: All checks passed. Waiting for the owner.) |
| `needs_confirm` | The agent must confirm one thing before this can land. |
| `go_around` | Something it relied on changed. The agent is adapting. |
| `rejected` | The checks sent it back: {error sentence}. The agent is fixing it. |
| `accepted`, `landed`, `stopped` | (no line; the state says it) |

The event `submit.result` carries the checks, not the error codes of the tool result. The error sentence of a rejected submit is that of its first check with `ok: false`:

| Failed check | Error sentence |
| --- | --- |
| `non_empty` | the change does nothing |
| `fits` | the change is too large |
| `parse` | the code does not parse |
| `imports_resolve` | an import points at nothing, or at something outside the pool |
| `globals_allowed` | it uses something the policy does not allow |
| any other | the check "{label}" failed |

Checks of the green line and of the in-page self-test. The names and codes are the fixed list of `01-core.md` GR8. They are shown in banner 8, on the Why card of a revert, in a revert heads-up and under a self-test badge. A failed check is shown by its label; a kind name that comes with it is shown as text in brackets.

| Check `name` (and `code`) | Label |
| --- | --- |
| `selftest_ran` (`no_verdict`) | The self-test did not finish in time |
| `selftest_ran` (`bad_verdict`) | The self-test gave no readable result |
| `selftest_ran` (`harness_error`) | The pool's code did not load, or the test stopped with an error |
| `files` | Every creature file has its three parts |
| `no_errors` | No creature causes an error |
| `in_bounds` | Every creature stays in the water |
| `energy_range` | Energy stays between empty and full |
| `population` | The number of creatures is right |
| `not_exhausted` | No kind of creature rests too much of the time |
| `state_is_data` | The pool's state is plain data |
| `pen_rules` | Drawing follows the rules of the pen |
| `visible` | Every creature can be seen |
| `within_reach` | Every creature draws near its own place |
| `draw_is_pure` | Drawing changes nothing in the pool |
| `deterministic` | The same start gives the same result |
| `parse` | The code parses |
| `imports_resolve` | Every import points at something |
| `policy_invariants` | The rules of the policy file hold |

### 5.8 Stop sentences

One sentence for each of the 17 stop reasons of `01-core.md` 9.1.

| `stop_reason` | Sentence |
| --- | --- |
| `go_around_limit` | Stopped after it was sent back {GO_AROUND_LIMIT} times. A card asks the owner what to do. |
| `contradiction` | Stopped: two requests change the same thing in different ways. A card asks the owner to choose. |
| `revert_limit` | Stopped: this change landed and was taken back {MAX_REVISIONS} times. A card asks the owner what to do. |
| `reopen_failed` | The agent that wrote this could not be reopened. A card offers a new attempt. |
| `declined` | The owner declined this change. It is kept, not landed. |
| `not_chosen` | Another attempt was chosen. This one is kept. |
| `undone` | The owner undid this change. |
| `lost` | Stopped: its agent could not be reached after the pool was rebuilt. |
| `budget` | Stopped: it used up its budget of steps or tokens. |
| `spend_cap` | Stopped: the spend cap is reached. |
| `timeout` | Stopped: it ran longer than {ATTEMPT_TIMEOUT_MS as duration}. |
| `model_error` | Stopped: the model failed {MODEL_RETRIES + 1} times in a row. |
| `tool_timeout` | Stopped: Trunk did not answer a tool call. |
| `stalled` | Stopped: it made no progress for {AGENT_WATCHDOG_MS as duration}. |
| `killed` | Stopped by the kill switch. |
| `cancelled` | The owner stopped this agent. |
| `withdrawn` | The agent withdrew this change. Another change had already done the same work, or the change was no longer wanted. |
| any other | Stopped ({stop_reason}). |

Every stop sentence is followed by "Its work so far is kept." unless the reason is `declined`, `not_chosen`, `undone`, `lost` or `withdrawn`.

### 5.9 Request errors

Shown next to the control that sent the request, and as a toast.

| Case | Text |
| --- | --- |
| `401` | The owner key is needed for this. Unlock, then try again. |
| `403` | The server refused this request. Reload the page and try again. |
| `404` with the code `feature_off` | This build does not have that feature. |
| `404` | That no longer exists. The page shows the newest state. |
| `409` | This was already answered. The page shows the newest state. |
| `413` or text too long | Use {MAX_INTENT_CHARS} characters or fewer. |
| `429` | Too many requests. Wait a moment, then try again. |
| `503`, no owner key | `owner.not_configured` |
| `503`, pool not ready | The pool is paused. Nothing new can start. |
| Refused: kill switch | All agents are stopped. Allow agents again first. |
| Refused: spend cap | The spend cap is reached. No model call can start. |
| Undo refused: `not_a_change` | that landing is an undo or a revert, and those cannot be undone |
| Undo refused: `already_undone` | that landing is already undone |
| Undo refused: `too_old` | that landing is too far back |
| Undo refused: `too_many` | it would take back more than {MAX_BATCH} changes at once |
| Undo refused: `plan_changed` | the pool changed while the plan was open (the sheet then shows the new plan, 3.12) |
| No answer (network) | The request did not reach the server. Check the connection and try again. |
| Any other status | Something went wrong (status {status}). Nothing was changed. Try again. |

The five undo reasons are the values of `UndoRefusal` (`01-core.md` 11.3). They fill `{reason}` of `undo.refused`.

### 5.10 Card texts

Trunk fills `Card.title`, `Card.body` and `Card.options[].label` from these templates in the shared `copy` module (`01-core.md` CD5). The Floor shows them as sent. The option ids are the values of `CardOption` in `01-core.md` 10.3, and the options of each card are those of rule CD4, in that order. No other id exists. The card route accepts the id, never the label.

| Kind, reason | Title | Body (at most two sentences) | Options (`id`: label) |
| --- | --- | --- | --- |
| `held`, `held_path` | This change touches shared rules. Land it? | It changes {paths}. {blast sentence} | `land`: Land · `land_now`: Land now · `decline`: Decline |
| `held`, `risk` | Clef flagged this change. Land it? | {risk sentence} {blast sentence} | `land`: Land · `land_now`: Land now · `decline`: Decline |
| `race`, `race` | {ready} of {n} attempts at "{intent text}" are ready. Choose one. | Each ran on a different model. The one you choose lands through the same gate. | `choose`: Choose this one |
| `choice`, `go_around_limit` | This change was sent back {GO_AROUND_LIMIT} times. Try again? | The {changeName} change was sent back {GO_AROUND_LIMIT} times because {keyShort} kept changing. Try once more with right of way, or stop? | `retry`: Try again · `stop`: Stop |
| `choice`, `contradiction` | Two requests change the same thing. Which one stands? | {requester A} asked: "{intent A}". {requester B} asked: "{intent B}". Both change {keyShort}. | `keep_landed`: Keep what landed · `retry`: Adapt the other on top |
| `choice`, `revert_limit` | This change was taken back {MAX_REVISIONS} times. Try again? | The {changeName} change landed and was taken back {MAX_REVISIONS} times. Let its agent try once more, or stop? | `retry`: Try again · `stop`: Stop |
| `choice`, `reopen_failed` | The agent could not be reopened. Start a new attempt? | The agent that wrote {changeName} is not available. A new agent would start from the request text. | `new_attempt`: Start a new attempt · `stop`: Leave it stopped |

Notes on the options:

- `land_now` is in `Card.options` only while the blast radius lists an attempt with right of way under `repair` or `confirm`, and only when `features.held` is true (`01-core.md` 10.2 steps 4 and 5, CD4). At every other time a held card has the two options `land` and `decline`.
- A race card has the one option `choose`. The sheet draws its label once per candidate that can be chosen, and the request names the candidate in `attempt_id` (CO38a). An attempt id is never an option id.
- On the card of reason `reopen_failed`, `new_attempt` starts a new agent from the request text. It is not `retry`: `retry` resumes the same agent (`01-core.md` UN6a).
- On the card of reason `revert_limit`, `retry` resumes the same agent on current facts, and the next revert of that change asks the owner again (`01-core.md` GL6).
- In the minimal form of a held card (`features.held` is false, `01-core.md` HD1) the body is "It changes {paths}." alone. Trunk computes no blast radius there, so the card makes no statement about one.
- The race title while no candidate is ready: {n} attempts at "{intent text}" are still working. (for 1: 1 attempt at "{intent text}" is still working.) With one ready: 1 of {n} attempts at "{intent text}" is ready. Choose it, or wait for the others. (for 1: 1 of 1 attempt at "{intent text}" is ready. Choose it.)

| Sentence | Text |
| --- | --- |
| Blast, repair, n = 1 | Landing this sends 1 change back to its agent: {name}. |
| Blast, repair, n > 1 | Landing this sends {n} changes back to their agents: {names}. |
| Blast, confirm | {n} changes must confirm: {names}. (for 1: {n} change must confirm: {names}.) |
| Blast, triage | Clef will judge {n} changes that read it: {names}. (for 1: Clef will judge {n} change that reads it: {names}.) |
| Blast, right of way | Landing this sends {name} around again. It will wait until that change has landed. |
| Blast, none | No change in flight relies on what this changes. |
| Risk, `does_what_asked` low | Clef doubts that it does what was asked ({share}). |
| Risk, `unrelated_edits` high | Clef sees edits that nobody asked for ({share}). |
| Risk, `changes_shared_meaning` high | Clef sees a change to the meaning of shared code ({share}). |
| Risk, unavailable | Clef's answers were not available, so this waits for you. |

Risk lines on the held card (from `Card.risk`, each a whole percent, or "not available"):

| Field | Line |
| --- | --- |
| `does_what_asked` | Does what was asked: {share} |
| `changes_shared_meaning` | Changes the meaning of shared code: {share} |
| `unrelated_edits` | Includes edits nobody asked for: {share} |
| footer | Judged by Clef ({model}). These numbers inform you. They never land or decline a change. |

### 5.11 Banners

| Id | Word | Sentence | Button |
| --- | --- | --- | --- |
| `banner.synthetic` | SYNTHETIC | {n} scripted agents · they make no model calls · same tools, premises and landing path (for 1: 1 scripted agent · it makes no model calls · same tools, premises and landing path) | |
| `banner.synthetic.swarm` | SYNTHETIC | {n} scripted agents · they make no model calls · same tools, premises and landing path · shared rules land without a tap in this pool (for 1: 1 scripted agent · it makes no model calls · same tools, premises and landing path · shared rules land without a tap in this pool) | |
| `banner.replay` | REPLAY | Recorded {date} · "{title}" · nothing here changes a pool | |
| `banner.killed` | AGENTS STOPPED | The kill switch is on. No model call starts. Checked changes still land. | `kill.allow` (owner) |
| `banner.killed.landings` | AGENTS STOPPED | The kill switch is on and landings are paused. Nothing changes until you allow agents again. | `kill.allow` (owner) |
| `banner.paused.diverged` | POOL PAUSED | main in Artifacts is not what Trunk expected. Nothing lands until the pool is rebuilt. | `pool.rebuild` (owner) |
| `banner.paused.push_rejected` | POOL PAUSED | Artifacts refused the same push {PUSH_REJECT_LIMIT} times. Nothing lands until the pool is rebuilt. | `pool.rebuild` (owner) |
| `banner.paused.note_seq_mismatch` | POOL PAUSED | A git note does not match its commit. Nothing lands. The owner must look at the repository. | |
| `banner.paused.owner` | POOL PAUSED | The owner paused landings. | `kill.allow` (owner) |
| `banner.rebuilding` | REBUILDING | Trunk is rebuilding its index ({done} of {total}). Agents wait. Everything that landed is kept. | |
| `banner.cap` | SPEND CAP | The spend cap of {cap} is reached. No model call starts. Checked changes still land. | |
| `banner.push` | PUSH PENDING | The push of {n} landings has not been confirmed yet. Try {tries}. Next try in {seconds} s. Nothing shows as landed until main has it. (for 1: The push of {n} landing has not been confirmed yet. Try {tries}. Next try in {seconds} s. Nothing shows as landed until main has it.) | |
| `banner.green_red` | GREEN LINE | The check failed twice at {landing}: {failed checks}. Trunk is taking back {landings} and reopening their agents. | |
| `banner.offline` | CONNECTION | The connection to the pool is lost. Reconnecting, try {n}. The page shows the state of {duration} ago. | |

`banner.synthetic.swarm` is the sentence of Swarm view: the Swarm pool uses the policy variant under which shared rules are tier `auto` (`02-tidepool.md` section 6). `banner.green_red` appears only for a failure that a second run on the same commit confirmed (`01-core.md` GR3); its second sentence appears when the `undo.planned` of cause `revert` has arrived and names the landings. In `banner.rebuilding` the part in brackets is left out while `pool.rebuild` is null.

### 5.12 About: how it runs, and the limits list

`about.how` is a fixed diagram with these seven labelled boxes and no other text:

| Box | Label |
| --- | --- |
| 1 | Worker: this page, the API, and the app server that serves a pool's files by commit |
| 2 | Trunk (one Durable Object per pool): serves every read, records premises, checks them, and is the only writer of main and the green line |
| 3 | Agent (one Durable Object per attempt): the model's tool loop and its whole conversation |
| 4 | Floor (one Durable Object per pool): the event stream this page draws |
| 5 | Workflows: the Swarm |
| 6 | Workers AI: the coding models, and Clef for judgments |
| 7 | Artifacts: main, the green line, and the notes; one repository per attempt for its conversation |

A box names a part only when the build has it: box 2 ends "is the only writer of main" when `features.green` is `"none"`; box 3 adds ", or the calls of an outside agent over MCP" when `features.mcp` is true (`07-mcp.md` MC24, added 2026-10-10 by the owner's decision to build the extensions); box 6 leaves out ", and Clef for judgments" when `features.clef` is false; box 7 reads "Artifacts: main and the notes" in place of "Artifacts: main, the green line, and the notes" when `features.green` is `"none"`, and leaves out "; one repository per attempt for its conversation" when `features.attempt_repos` is false (amended 2026-10-07: the fixed diagram named parts that the limits list of the same sheet says are off). Box 5 names the Swarm only (amended 2026-10-10 by the owner's decision to build the extensions: the green line runs on Trunk's `green` timer, `01-core.md` 3.3 and GR1, and Trunk moves its ref, GR2; no Workflow is part of it).

The limits list is one file in the repository, shown here and in the README from the same source. A line whose condition is false for the build is left out. Content:

1. Premise understands JavaScript, TypeScript, Python and Go modules: .js and .mjs in the tide pool, and .js, .mjs, .cjs, .jsx, .ts, .mts, .cts, .tsx, .py and .go in a pool imported from a repository. Other files are tracked as whole files.
2. One Trunk serves one pool. Agents read and write files of at most {MAX_FILE_BYTES} bytes. A repository with more than {IMPORT_MAX_ENTRIES} entries or {IMPORT_MAX_TEXT_BYTES} bytes of text is not imported, and a larger file in an imported repository is kept but cannot be read.
3. Real agents are limited by the Workers AI rate limits. This build runs at most {max} at once.
4. Numbers in the Swarm view come from scripted agents. They make no model calls.
5. The plain-merge pool is constructed by Trunk from the same changes. It is a comparison, not a second product, and its count of text conflicts is approximated. (Or, while `features.text_merge` is on: The plain-merge pool is constructed by Trunk from the same changes. It is a comparison, not a second product. Each change is merged as git merges a file from three versions, and the version its agent started from is taken from the pool's history.)
6. A premise across two pools is not built.
7. The green line checks {runtime sentence}. (Or: The green line is not in this build.)
8. Clef judgments are {on or off} in this build.
9. Not built: audience input.
10. References are direct. Code that depends on a shared value only through another function it calls holds no premise on that value. A package import or a tsconfig path alias is external and gives no premise.
11. In Python and Go, references are found by name and can be wrong both ways. Every Python or Go file an agent reads from is also watched as a whole, so any change to it asks the agent to confirm.
12. A number written with no reference to the shared quantity is not caught by rule. If its agent read the quantity, Clef judges it, or the agent takes one confirm turn. If it did not, only the self-test could notice, and that test checks the pool's health, not what a creature was asked to do.
13. Premise shows an agent every piece of code that uses what it changes. It does not prove that the agent adapted all of it.
14. A sweep is recognised from the edits an agent makes, not from the words of the request.
15. After a rebuild from Artifacts, open cards close and agents in flight register again. Landed history is rebuilt in full.
16. Switched off in this build: {the names of the features that are off}. (Left out when none is off.)
17. An outside agent over MCP counts as a real agent. Premise sees only its calls of the seven tools: not what it read elsewhere, and not what its own model cost. (Only when `features.mcp` is true.)

Lines 10 and 12 to 14 are the stated limits of `01-core.md` 6.5 (HC3) and of `02-tidepool.md` 7.6. Lines 1 and 2 follow `06-repos.md` LG1 and IR4, line 9 names what is not built, and line 10 also states the blind spot of LG3 (amended 2026-10-07). Line 11 states the blind spot of LG4, and Python and Go left line 9 for lines 1 and 11 when step 3 was built (amended 2026-10-10). A number in a line is written with a comma every three places. Line 15 is the limit of `01-core.md` RB0. In line 16 the names are: "the held card with previews" (`features.held`), "comparing attempts" (`features.race`), "Undo" (`features.undo`), "attempt repositories" (`features.attempt_repos`), "outside agents over MCP" (`features.mcp`), "text merge" (`features.text_merge`). Line 17 is the blind spot of `07-mcp.md`; outside agents over MCP left line 9 for line 16 when they were built, and so did text merge (`01-core.md` PM3a), whose own blind spot is in line 5's other form (added 2026-10-10 by the owner's decision to build the extensions). The green line and Clef have their own lines, 7 and 8. In line 7 the runtime sentence is "every landing with static checks only" when `features.green` is `"static"` (`01-core.md` GR5) and "every landing by running the pool's self-test in a sandboxed isolate" when it is `"full"` (amended 2026-10-10, when the green line was switched on with the static runtime).

### 5.13 Screen-reader log lines

Sent to the polite live region, or to the assertive one where 4.3 says urgent (6.5).

| Id | Text |
| --- | --- |
| `sr.intent` | New request from {requester}: "{intent text}". |
| `sr.state` | {changeName}: {status word}. |
| `sr.headsup` | {changeName}: {one-line form of 5.6}. |
| `sr.resolved` | {changeName}: the agent answered its heads-up. |
| `sr.reopened` | {changeName}: reopened by {cause}. |
| `sr.card` | A card is waiting for the owner: {title} |
| `sr.card_closed` | Card closed: {title} |
| `sr.landed` | {changeName} landed as {landing}. |
| `sr.undo` | Undo of {landing} planned. It takes back {n} changes. (for 1: Undo of {landing} planned. It takes back {n} change.) |
| `sr.push` | A push is being retried. |
| `sr.green_checking` | The green line check failed once at {landing}. It is being run again. |
| `sr.green_red` | The green line check failed twice at {landing}. |
| `sr.paused` | The pool is paused. {banner sentence} |
| `sr.pool_state` | The pool is {ready or rebuilding or paused}. |
| `sr.killed` | Agents are stopped. · Agents are allowed again. |
| `sr.cap` | The spend cap is reached. |
| `sr.swarm` | The Swarm started with {n} scripted agents. · The Swarm stopped. (for 1: The Swarm started with {n} scripted agent.) |
| `sr.more` | {n} more updates (for 1: {n} more update) |

---

## 6. Visual direction

### 6.1 The language

The page looks like a poster at night: ink rules on a dark ground, numbers set like headlines, and plain words in spaced capitals. The light theme is the same poster on paper. (Owner's choice of 2026-10-10, direction "E dark" of the Figma file "Premise Floor: visual directions"; set in one family, the system face, since the owner's "all five" of 2026-10-11.)

- **VD1 (still unless something happened).** Nothing moves by itself except the pool app and the slow "working" pulse. Every other movement is caused by one event and ends within 720 ms.
- **VD2 (signals).** The five light shapes (circle, diamond, triangle, ring, half circle) are the identity of the product. They are used for premises and for status only, at every size, in both themes. No other icon set is used; the few other marks (cross, tick, two bars, reader ring, writer square) are drawn in the same weight.
- **VD3 (above and below the water).** The rail holds what is in flight. The pool area holds what is on `main`. A change crosses from the rail to the pool only on `landing.landed`. One vertical ink rule separates the two regions; the pool frame is an ink-edged plate.
- **VD4 (labels that cannot be missed).** SYNTHETIC uses its own hue and a diagonal stripe that nothing else uses. REPLAY uses the inverse band and a dotted edge that nothing else uses.
- **VD5 (few sizes).** Seven type sizes, four weights of emphasis (text, muted, strong, signal), square corners (radius 0), two rule widths: 2 (`--rule`, in the `text` colour) between regions and around sheets; 1 between rows and around buttons. No rules between the strip's counters: space separates them. 3 for focus and for a heads-up panel's edge. A faint 40-wide column grid lies behind the page. Capitals only for labels, banner words and status words; buttons and tabs are in sentence case (owner's design decision of 2026-10-10: one thing shouts at a time).

### 6.2 Type

- **VD6.** Every text, number and title uses the system interface typeface: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` (SF Pro on a Mac), so the Overview and the Floor view read as one product. Code, ids and diffs use `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. No font file is fetched.
- **VD7.** Numbers use tabular figures (`font-variant-numeric: tabular-nums`).
- **VD8.** Numbers, titles, intent text and the masthead name are set at weight 600 to 700 with tight letter spacing (−0.02 to −0.035em). Text is weight 400; status words, labels and buttons 600 to 800. Capitals with letter spacing 0.06 to 0.1em for banner words, section labels and status words. No italics.

| Role | Stage size | Laptop size | Used for |
| --- | --- | --- | --- |
| Display | 168 | 120 | The four large Swarm numbers |
| Counter | 84 | 56 | The two hero numbers, Landed and Go-arounds; from 1100 to 1599 wide they follow the window (3.9vw, at least 40). The other strip values, and every strip value in Replay, are at Title size. |
| Title | 40 | 32 | Sheet titles, card titles in the sheet, headings, the masthead name |
| Intent | 30 | 24 | Intent text on attempt cards, the pool frame's caption, banner words, the thesis line |
| Status | 22 | 18 | Status words, heads-up before and after (code face) |
| Body | 20 | 16 | Sentences, labels, links |
| Small | 16 | 14 | Strip labels, tags, tile names, command buttons (capitals), the git drawer (code face) |

Line height is 0.9 for Display and Counter, 1.1 to 1.3 for the others. Lines of running text in sheets are at most 70 characters.

### 6.3 Colour

Dark is the default for the video. Light is for bright rooms. The page follows the system setting on first load; key `T` switches and the choice is kept in the browser.

"Lowest contrast" is the lowest WCAG contrast ratio of the token against the three background tones of its theme (`bg`, `surface`, `raised`).

| Token | Use | Dark | Lowest contrast | Light | Lowest contrast |
| --- | --- | --- | --- | --- | --- |
| `bg` | Page and pool area | `#0C0D10` | | `#F1ECE2` | |
| `surface` | Rail, attempt cards, sheets | `#101216` | | `#F7F3EC` | |
| `raised` | Panels inside attempt cards, tiles | `#1A1D23` | | `#EBE6DC` | |
| `line` | Dividers between rows (decoration only) | `#2E323B` | n/a | `#CFC7B8` | n/a |
| `control` | Borders of fields, disabled buttons | `#8A8F99` | 5.20 | `#6B665C` | 4.59 |
| `text` | Text, and the 2-wide ink rules | `#F2F2EE` | 15.04 | `#121212` | 15.06 |
| `muted` | Secondary text | `#9EA3AC` | 6.66 | `#57534B` | 6.15 |
| `accent` | Primary button, links, the active view number, working pulse, writer marks, landing glow | `#FF5A1F` | 5.41 | `#B83A08` | 4.63 |
| `holds` | Holds, landed, green line | `#5BD68F` | 9.21 | `#17733A` | 4.76 |
| `changed` | Changed, stopped, failure banners | `#FF7A6B` | 6.63 | `#B8281C` | 5.03 |
| `confirm` | Needs a confirm, waiting for the owner, warning banners | `#FFC857` | 10.97 | `#8A5A00` | 4.77 |
| `checking` | Being checked | `#9DB8FF` | 8.63 | `#2450C0` | 5.66 |
| `synthetic` | SYNTHETIC only | `#D7A6FF` | 8.67 | `#6A3BB0` | 5.89 |
| `focus` | Focus ring | `#FFE08A` | 13.09 | `#1B3FA0` | 7.45 |
| `on-fill` | Text on a filled signal colour or on `accent` | `#0C0D10` | 6.23 (on `accent`) | `#FFFFFF` | 5.76 (on `accent`) |

- **VD9.** A unit test computes these ratios from the token values and fails below: 7 for `text`; 4.5 for every other token used for text; 3 for `control`, `focus` and every signal colour used for a shape.
- **VD10.** No state is carried by colour alone. Each has a shape and a word (3.3, 5.3). Changed characters in a diff have an underline as well as a background.
- **VD11.** The signal colours are used only for their meaning. A decorative use of `changed`, `confirm`, `holds`, `checking` or `synthetic` is a defect.
- **VD12.** The pool app's own colours belong to the pool. The Floor draws a 2-wide border in the `text` colour around every pool frame so its edge is visible on any background.

### 6.4 Motion

Easing `cubic-bezier(0.2, 0.8, 0.2, 1)` for everything. "Reduced" is what happens when the system asks for reduced motion (`prefers-reduced-motion: reduce`).

| What | Motion | Reduced |
| --- | --- | --- |
| A change lands | The attempt card shows "Landed" for 1.2 s, shrinks to a chip and travels to the edge of the pool frame (720 ms). The frame's edge glows in `accent` with a soft halo that fades over 1.2 s, and the Landed value glows once in `holds`. | The attempt card shows "Landed" for 2 s and leaves without moving. The frame gets a static `accent` outline for 2 s. |
| A light changes | Cross-fade 200 ms, then one ring that grows and fades (600 ms). | Changes at once. A 2-wide outline for 1.5 s. |
| An attempt card joins or leaves the top group | Slides to its place (240 ms). | Moves at once. |
| A sheet or the drawer opens or closes | Fade and a 16 rise (240 ms). | Appears at once. |
| A tile's file landed | Edge glow that fades over 2 s. | Static outline for 2 s. |
| A counter changes | Underline for 1 s. | The same. |
| Status "Working" | The dot fades between 100% and 50%, one cycle per 2.4 s. | A still dot. |
| A banner appears | Slides down (240 ms) and pushes the body. | Appears at once. |
| The Swarm wall | Redrawn at most `WALL_FPS` times per second. | Redrawn at most twice per second; a landed cell is not filled, it gets a tick. |
| Pool frames | The pool app animates. `frame.pause` is always available. | Frames start paused with `frame.play`. Replay starts paused. |

- **VD13.** Nothing flashes more than three times in one second.
- **VD14.** Apart from CO9 and CO12, nothing moves a control the pointer or the focus is on. New attempt cards are added without shifting the attempt card that has focus out from under it: the list keeps its scroll position relative to the focused attempt card.

### 6.5 Accessibility

| # | Requirement | Test |
| --- | --- | --- |
| AX1 | Contrast as in 6.3 (VD9). | Unit test on tokens. |
| AX2 | Every action in sections 1 and 3 can be done with the keyboard alone, in a logical order: header, strip, banners, pool area, rail. The link `nav.skip` is the first focus stop. | Browser test: beats 1 to 7 and 10 with keys only. |
| AX3 | Focus is always visible: a 3-wide ring in `focus`, 2 away from the control. | Screenshot test. |
| AX4 | Sheets and dialogs take focus when they open, keep it inside, close with Esc without doing anything else, and return focus to the control that opened them. | Browser test. |
| AX5 | The pointer is never the only way. Every Why card is reachable from the Landed tab; Who relies from the premise list and the tile menu; tapping a creature is a shortcut, not the only path. | Browser test. |
| AX6 | Landmarks: header (`banner`), view switch (`navigation`), body (`main`), rail (`complementary`, label `rail.label`), strip (`region`, label `strip.label`). Each sheet is a `dialog` with its title as its name. | Accessibility tree test. |
| AX7 | Names. A light: `light.tip`. A tile: `tile.name`. A pool frame: its `title`. A counter: its label and value as one phrase. A status shape: its word. A button: its text. | Accessibility tree test. |
| AX8 | Two live regions. Polite: the log lines of 5.13 marked as not urgent, at most one per second, with more than five waiting lines merged into `sr.more`. Assertive: the lines marked urgent in 4.3. Toasts go to the polite region. | Unit test on the announcer. |
| AX9 | The Swarm wall (a canvas) has a text summary, updated every 5 s: `swarm.wall.summary`. The four numbers are real text. | Accessibility tree test. |
| AX10 | Reduced motion as in 6.4. | Browser test with the setting on. |
| AX11 | The page works at 200% browser zoom and with text spacing overrides: it moves to the laptop or narrow layout, and no text is cut off. | Browser test at 960×540 CSS pixels. |
| AX12 | Tap targets are at least 44×44 (LY5). | Layout test. |
| AX13 | Single-key shortcuts are off while a field has focus and can be turned off (`shortcuts.toggle`). | Browser test. |
| AX14 | Nothing times out on the user. A card waits forever. A message that leaves by itself (toast, closed-card notice) stays in the log and on its attempt card. | Review of every timer. |
| AX15 | The page sets `lang="en"`. Text from outside keeps its characters; right-to-left text is isolated with `dir="auto"`. | Unit test. |
| AX16 | In forced-colours mode every shape keeps an outline and every control a border. | Screenshot test. |

### 6.6 Keys

| Key | Does |
| --- | --- |
| `/` | Focus the intent box |
| `O`, `F`, `S`, `A` | Overview, Floor view, Swarm view, About |
| `C` | Compare view on and off |
| `N` | Open the oldest card that needs the owner |
| `L` | Go to the Landed tab |
| `G` | Open or close the git drawer of the open Why card |
| `P` | Pause or play the pool frames |
| `K` | Open the kill switch dialog (owner) |
| `R` | Open the default recording (RY26), paused |
| `T` | Switch theme |
| `Z` | Switch between stage size and laptop size type |
| `?` | Show this list |
| `Esc` | Close the sheet, the drawer, or Compare view |
| Replay: `Space` | Play or pause |
| Replay: `1` to `9` | Jump to that chapter |
| Replay: `←`, `→` | Previous chapter, next chapter |
| Replay: `,`, `.` | Slower, faster |
| Replay: `0` | Restart |

### 6.7 Reading it from the back of a room

- **VD15.** At stage size no text is smaller than 16. Everything the voiceover points at is 22 or larger: intent text, status words, counters, banner words, card titles, the before and after of a heads-up, the Swarm numbers, the frame captions. A layout test reads the computed sizes at 1920×1080.
- **VD16.** A light is 28 across on a full attempt card. Its shape is recognisable when the screenshot is scaled to one quarter. A screenshot test compares the five shapes at 7 pixels.
- **VD17.** At most 5 full attempt cards, or 9 compact ones, are on screen (CO10). At most 3 banners (CO50). At most 2 heads-up panels open by themselves (CO11).
- **VD18.** Sentences on attempt cards are one line at stage size where the table of 5.6 gives a one-line form. Long sentences live in the expanded attempt card and in sheets.
- **VD19.** Key `Z` switches to stage size on any screen. The setting is kept in the browser. The video and the stage both use stage size.

---

## 7. When something fails

The owner must be able to tell, from the page alone, what happened, whether to wait, and what to tap. Each row: the trigger (from `FloorState`, `ViewState` and the clock), what the page shows, what happens by itself, and what the owner can do.

| # | Failure | Trigger | The page shows | By itself | The owner can |
| --- | --- | --- | --- | --- | --- |
| FR1 | The model is slow | `quietFor(attempt) >= QUIET_NOTICE_MS`, for an attempt whose agent calls a model: not a scripted agent (it calls none) and not an outside agent over MCP (its client is not retried; MC21 stops a silent one). Amended 2026-10-10: a held scripted agent read "The model has not answered". | The activity line counts seconds: "Thinking · 14 s". From `SLOW_NOTICE_MS` it is in the `confirm` colour and reads `attempt.slow`. | The Agent retries the model call up to `MODEL_RETRIES` times, then stops (`01-core.md` AG2, AG3). | Wait, or stop the agent (`attempt.stop`). Other attempt cards keep going. |
| FR2 | A tool step failed | `attempt.step.ok` is false | The activity line with the reason of 5.5. | The agent tries another way. Each try uses its budget. | Nothing. |
| FR3 | The checks sent a change back | `submit.result.status = rejected` | The submit sentence of 5.7 on the attempt card, in the `confirm` colour. It is not a go-around and the count does not rise. | The agent fixes its work and submits again. | Nothing. |
| FR4 | An attempt stopped | `attempt.state` to `stopped` with reason `model_error`, `tool_timeout`, `stalled`, `timeout`, `budget`, `spend_cap`, `killed` or `lost` | The attempt card moves to the Stopped tab with the stop sentence of 5.8. The Stopped tab count rises. Toast with the same sentence. | Nothing. | Send the request again from the Stopped attempt card: the button `attempt.again` fills the intent box. |
| FR5 | A push is being retried | `push.retry` | Attempt cards in the batch stay "Landing…". The caption bar shows `frame.landing`. No banner yet. | Trunk retries with growing waits (`01-core.md` LP5a). | Nothing. |
| FR6 | A push is pending for long | `pushStalled` | Banner 7 (`banner.push`) with the try count and a countdown to the next try. The Landed counter and the pool frame do not move (FL3). `strip.waiting.backlog` shows the changes waiting. | The same. When `batch.pushed` arrives the banner leaves and the changes land. If Artifacts refuses the same push `PUSH_REJECT_LIMIT` times, the pool pauses (row FR11). | Keep talking: nothing is lost. Agents keep working. |
| FR7 | Spend is near the cap | `spend_usd >= cap_usd × SPEND_NEAR_SHARE` | The spend cell in the `confirm` colour with `spend.near`. | Nothing. | Stop the Swarm or let fewer agents run. |
| FR8 | The spend cap is reached | `limits.refusing` is true | Banner 6 (`banner.cap`). The intent box shows `intent.cap`. Attempts stop with the sentence for `spend_cap`. | Checked changes still land. No model call starts. | Nothing on the page raises the cap. Replay still works. On stage: press `R`. |
| FR9 | The kill switch is on | `limits.killed` | Banner 3 (`banner.killed`, or `banner.killed.landings` when the pool is also paused by the owner). The intent box shows `intent.killed`. Attempts stop with "Stopped by the kill switch." | Checked changes still land unless landings were paused too. | `kill.allow`. |
| FR10 | The connection is lost | The socket closed, or no frame for `OFFLINE_AFTER_MS` while the socket is not open. An open socket that carries no frame for `STREAM_SILENCE_MS` is closed by the page and counts as closed: the Floor sends `metrics` to every open socket each `METRICS_EVERY_MS` (`01-core.md` EM5), so that silence means a dead connection that no close event reports (added 2026-10-05: a live run's socket went silent after a network drop and stayed open) | Banner 9 (`banner.offline`) with the try count. Everything is dimmed (CO3). Owner controls are off. | The page reconnects with waits from `WS_RETRY_BASE_MS` doubling to `WS_RETRY_MAX_MS`, and asks for events after its last `n`. It catches up or takes a snapshot. | Wait. On stage: press `R` (a recording that is already loaded plays without the network, except for pool frames). |
| FR11 | The pool diverged, or Artifacts refuses its push | `pool.paused` with reason `diverged` or `push_rejected` | Banner 4 (`banner.paused.diverged` or `banner.paused.push_rejected`) with the button `pool.rebuild`. Attempt cards in "Landing…" stay so. | Nothing lands. Agents can still read. | `pool.rebuild`, then confirm (`01-core.md` LP8). |
| FR12 | A note does not match its commit | `pool.paused` with reason `note_seq_mismatch` | Banner 4 (`banner.paused.note_seq_mismatch`). | Nothing. | Nothing on the page. This needs a look at the repository. Replay still works. |
| FR13 | The owner paused landings | `pool.paused` with reason `owner` | Banner 4 (`banner.paused.owner`). | Nothing lands. | `kill.allow`. |
| FR14 | The pool is rebuilding | `pool.state.state = rebuilding` | Banner 5 (`banner.rebuilding`) with the progress. The intent box shows `intent.rebuilding`. | After a rebuild from Artifacts, agents register again, open cards close as out of date, and changes that were landing go around and land again (`01-core.md` 3.6, LP8). After a deploy, the index is built again and nothing else changes. | Wait. |
| FR15 | A held card went out of date | `card.closed` by `system` with action `stale` | The tray row leaves. An open sheet shows `held.stale` and its buttons are off. The attempt shows "Going around", "Confirming" or "Working" with its heads-up or its newest edit. | The agent adapts. A new card opens after its next submit. | Wait for the new card. |
| FR16 | A change was sent back too often | `card.opened`, kind `choice`, reason `go_around_limit` | A tray row and the sheet with the text of 5.10. The attempt is in the Stopped tab. | Nothing. Its heads-ups wait for it (`headsup.waits`). | "Try again": Trunk starts the same agent again, with right of way, and it answers every heads-up it missed (`01-core.md` GL5, RS1). Or "Stop". If the agent cannot be started, row FR23 applies. |
| FR17 | Two requests contradict | `card.opened`, kind `choice`, reason `contradiction` | A tray row and the sheet with both requests in the owners' words (5.10). | Nothing. | "Keep what landed" or "Adapt the other on top". |
| FR18 | Clef is not available | `premise.judged` with `clef.error`, or `Card.risk.error` | The premise shows "Needs a confirm" with the `triage_unavailable` sentence. A held card shows `held.risk_unavailable`. | The agent takes one confirm turn. Nothing lands on a guess. | Decide a held card from the preview. |
| FR19 | The green line failed | `green.verified` with `ok: false` and `confirmed: true`. A first failed run (`confirmed: false`) is not this row: the strip reads `green.checking` and nothing else is shown (`01-core.md` GR3). | Banner 8 (`banner.green_red`) with the failed checks. Strip: `green.red`. Then an undo row `revert.landing`, and the reopened attempt cards. | Trunk takes back the landings since the last green one and reopens their agents (`01-core.md` GR3). The banner leaves when the revert has landed. | Nothing. Open the Why card of the revert to see what it took back. |
| FR20 | A pool frame did not load | Time-out `FRAME_LOAD_TIMEOUT_MS` or an error from the iframe | `frame.error` and `frame.reload` inside that frame only. In Replay, when the commit cannot be served: `frame.replay_gone`. | Nothing. | `frame.reload`. |
| FR21 | The owner session ended | A request answers `401` | Toast `owner.expired`. Header shows `owner.visitor`. The owner dialog opens. The draft is kept. | Nothing. | Paste the key and tap the control again. |
| FR22 | A request was refused or did not arrive | Any other failure of a request of 4.5 | The sentence of 5.9 next to the control and as a toast. The control is enabled again. Nothing on the page changes as if it had worked (FE6). | Nothing. | Try again. |
| FR23 | A reopened change cannot go on with its author | Stop reason `reopen_failed` (the agent did not start again, `01-core.md` RS4); or `attempt.reopened` with `model_changed` true | For `reopen_failed`: the stop sentence and a card of reason `reopen_failed` (5.10). For `model_changed`: `attempt.model_changed` on the attempt card and on its Why card. | For `model_changed`: the new model continues with the recorded conversation. | For `reopen_failed`: "Start a new attempt" or "Leave it stopped". |
| FR24 | The Swarm did not start | The start request failed, or no synthetic attempt within 10 s of `swarm.state.running` | The error sentence, or `swarm.no_agents`. | Nothing. | `swarm.stop`, then `swarm.start`. On stage: play the recording `swarm`. |
| FR25 | A recording cannot be played | 8.3 | `replay.error` with the reason and `replay.to_live`. | Nothing. | Choose another recording. |
| FR26 | All agent slots are busy | `real_agents >= max_real_agents` and an attempt is `opened` | The attempt card shows `status.queued` and `attempt.queue`. The intent box shows `intent.queue`. | The attempt starts when a slot is free. | Wait. This is the stated limit, not a fault. |
| FR27 | The page met an event it does not know | `unknown_events > 0` | About shows `about.unknown_events`. Nothing else changes. | The event is ignored (FE1). | Reload the page to get the newest build. |
| FR28 | A pool frame stopped answering | A live frame that is visible and not paused sent no `stats` for `POOL_STALL_MS` (`02-tidepool.md` HO8). Pool code that never returns cannot be stopped from inside the frame. | The live pool frame, when a green commit exists (`green.commit` is not null): the Floor loads the frame again on the source `green`, and the caption reads `frame.stalled.green`. When no green commit exists: the Floor loads the frame again on `main`, once, and the caption reads `frame.stalled.reloaded`; if it stops again, the frame shows `frame.stalled`. Any other frame (plain-merge, a card's before or after, Replay): loaded again once at its own address, then `frame.stalled`. Each case has the button `frame.reload`. | Attempt cards, counters and landings are not affected. A frame on `green` gets `probe` when `green.advanced` arrives. The Floor never loads `green` while no green commit exists, so the seed is never shown as "the last verified version". | `frame.reload` loads the frame again on `main`. |
| FR29 | A change was taken back too often | `card.opened`, kind `choice`, reason `revert_limit` | A tray row and the sheet with the text of 5.10. The attempt is in the Stopped tab with the sentence for `revert_limit`. Its landing stays taken back. | Nothing. | "Try again": the same agent resumes on current facts; the next time the change is taken back, the owner is asked again (`01-core.md` GL6). Or "Stop". |
| FR30 | The address names no pool | The stream of the pool in `/p/{pool}` answers 404 | `pool.missing` and the link `pool.to_default` in place of the body. The header stays. | Nothing. | Open the default pool. |
| FR31 | The undo plan changed | The undo request is refused with `plan_changed` (a landing arrived between the plan and the tap) | The undo sheet stays open, shows the new plan of the response under `undo.plan_changed`, and enables `undo.confirm` again (3.12). | Nothing was queued and nothing changed. | Read the new plan, then "Undo it" or "Keep it". |
| FR32 | A card's preview could not be built | `Card.preview.error` is set | `held.no_preview` in the after frame. The rest of the sheet is complete and the buttons stay enabled. | Nothing. The card stays usable (`01-core.md` PV3). | Decide from what the change touches, whom it affects and the checks. Or decline. |
| FR33 | A view fails while it draws | An error is thrown while the floor body, Compare view, Swarm view or an open sheet renders | That view alone shows `view.failed`. The header, the strip, the banners and the other views keep working. The error goes to the browser console. | Nothing. | Reload the page. On stage: press `R` (added 2026-10-05: a throw in one component once blanked the whole page). |

- **FA1.** Every row has a fixture that produces it and a screenshot test. The fixture is a recorded stream; where the trigger is not in the stream (FR10, FR20 to FR22, FR28, FR30, FR31), it is a scripted response, socket or frame.
- **FA2.** A failure never removes information: attempt cards, lights and counters keep their last content.
- **FA3.** A failure message never shows a stack trace, a token, a raw response body or an internal id.
- **FA4.** On stage, every failure has the same way out: key `R` (1.5, item 6).

---

## 8. Replay

### 8.1 What it is

Replay plays a recording through the same reducer and the same components as the live stream (`01-core.md` 12.3).

- **RY1.** Replay opens no WebSocket and sends no request that changes anything. Its only requests are `GET /floor.json`, `GET /replay/index.json`, the recording file, and pool frames (FE5).
- **RY2.** Replay needs no key, no account and no cookie. It works when the deployment has no owner key at all.
- **RY3.** The REPLAY banner is on screen from the moment a recording starts loading until Replay is closed. When the recording's header has `synthetic: true`, the SYNTHETIC banner is on screen too.
- **RY4.** Everything that reads is available in Replay: Why cards, the git drawer, Who relies, Compare view with its self-test badges, the expanded attempt cards, About, theme, size, keys. Everything that changes something is absent (FL7).
- **RY5.** The same recording gives the same `FloorState` at the same position on every run (FE3).

### 8.2 The recording and the list of recordings

A recording is the NDJSON file of `01-core.md` 12.3, unchanged. Its header has `"premise_replay":2`, and every event line carries both `t` (arrival at the Floor) and `ts` (the source's clock):

```
{"premise_replay":2,"pool":"tidepool","recorded_at":"2026-10-12T18:03:11Z","events":4210,"synthetic":false,"build":"<git commit of the build>","label":"The conflict, real agents"}
{"n":1,"t":1791828191000,"ts":1791828190950,"pool":"tidepool","src":"trunk","type":"pool.state","head_seq":0,"head_commit":"…","green_seq":0,"landed_seq":0,"landed_commit":"…","state":"ready","reason":null,"epoch":1,"remote":"…","plain_remote":"…","rebuild":null,"unwitnessed":[],"real_agents":0,"max_real_agents":12,"synthetic":false,"summary_only":false}
{"n":2,"t":1791828195120,"ts":1791828195090,"pool":"tidepool","src":"trunk","type":"intent.created","intent_id":"i_…","text":"make energy a fraction from 0 to 1","requester":"owner","race":false,"prewritten":false}
…
```

The values of `src` are `trunk`, `agent`, `gate`, `swarm` and `floor` (`01-core.md` EV2a). The page does not branch on `src`.

The list of recordings is one static file *(Floor)*. Titles, dates and sizes below are examples; the four ids are fixed:

```json
{
  "v": 1,
  "default": "hero",
  "recordings": [
    { "id": "hero", "file": "/replay/hero.ndjson", "title": "The conflict, real agents",
      "duration_ms": 450000, "events": 4210, "bytes": 1830042, "synthetic": false,
      "recorded_at": "2026-10-12T18:03:11Z" },
    { "id": "rehearsal", "file": "/replay/rehearsal.ndjson", "title": "A rehearsal of the same run, real agents",
      "duration_ms": 371000, "events": 3980, "bytes": 1710000, "synthetic": false,
      "recorded_at": "2026-10-11T17:40:02Z" },
    { "id": "hero-canned", "file": "/replay/hero-canned.ndjson", "title": "The conflict, scripted agents",
      "duration_ms": 95000, "events": 620, "bytes": 410000, "synthetic": true,
      "recorded_at": "2026-10-11T16:12:40Z" },
    { "id": "swarm", "file": "/replay/swarm.ndjson", "title": "The Swarm, scripted agents",
      "duration_ms": 92000, "events": 48110, "bytes": 11200000, "synthetic": true,
      "recorded_at": "2026-10-11T19:20:02Z" }
  ]
}
```

The four recordings (finding F10 fixed which run each one is):

| Id | Which run it is | `synthetic` | Made |
| --- | --- | --- | --- |
| `hero` | The session of the submission take itself: the main pool, real agents, the beats of 1.2. | false | Exported after the take (`04-build-plan.md` SC7). It cannot exist while the take is being recorded. |
| `rehearsal` | A real-agent rehearsal of the same beat sheet on the deployed system, made before the take. Beat 10 of the video plays it. | false | The day before the take (`04-build-plan.md`, Day 8). |
| `hero-canned` | The conductor's run of the hero conflict with the canned cast (`02-tidepool.md` 7.11), on a pool that is not `summary_only`, so it shows lights, diffs and Why cards under the SYNTHETIC banner. It is the recording used when no model repairs the crab or writes a number in points (`04-build-plan.md` RR6, RR18). | true | With the rehearsal. |
| `swarm` | A Swarm run on the Swarm pool, which is `summary_only`. | true | With the rehearsal. |

- **RY6.** The recordings that judges are pointed to are static assets of the Worker (`/replay/*.ndjson`), so they play even when no Durable Object holds any state. A file is at most `REPLAY_MAX_BYTES` (the platform's limit for one static asset).
- **RY7.** `file` may also be the export route of a kept pool (4.5). The page treats both the same.
- **RY8.** The file's header is the truth. The list only decides what the menu shows before the file is loaded.
- **RY9.** A recording of a real pool and a recording of a synthetic pool are separate files, because they are separate pools and separate streams.
- **RY10.** The pool repo and the plain-merge repo of a recorded pool are kept, so the app server can serve their commits to the frames (8.6).
- **RY26 (the default recording).** `default` in the list is `hero` once that file is deployed, and `rehearsal` before. The start card, key `R` and way 1 of 8.7 play the default. During the take the default is `rehearsal`: the take plays a recording made earlier, so the voiceover of beat 10 says "a run like this one" and never "this run". After the take, `hero` is added and becomes the default, and the address `/replay/hero` of 8.7 plays the take itself.
- **RY27 (titles).** The title of a recording is data of the list and of the file's header (`label`). It is shown in quotes in the REPLAY banner and in the Replay menu. A title never calls a scripted run real: the titles of `hero-canned` and `swarm` say "scripted agents".

Making a recording (owner, live mode): Replay menu, then `replay.save`. The browser downloads the export of 4.5. A coding agent adds the file and its list entry to the repository and deploys. Adding a recording is one of the two reasons for which the production deployment may change after the take (`04-build-plan.md` BP12); this is how `hero` gets there. Nothing in the file is secret: no event carries a token, a key or a full transcript (`01-core.md` 12.1), and the exporter refuses a file in which a line matches a token pattern (`01-core.md` RP1).

### 8.3 Loading and checks

The page downloads the whole file, shows `replay.loading` with the share loaded, and checks it before the first event is applied:

| Check | When it fails, `replay.error` reads |
| --- | --- |
| The file downloads | This recording could not be downloaded. Check the connection and try again. |
| It is at most `REPLAY_MAX_BYTES` | This recording is too large to play here. |
| Line 1 is JSON with `premise_replay` equal to 2 | This file is not a Premise recording that this page can play. |
| The number of event lines equals `events` | This recording is incomplete: it has {a} events and should have {b}. |
| Every event line is JSON with `n`, `t`, `ts` and `type` | This recording is damaged at line {line}. |
| `n` runs 1, 2, 3, … with no gap | This recording is damaged: event {n} is missing. |
| `t` never decreases | This recording is damaged: its times go backwards at event {n}. |

`ts` may be lower than the `ts` of an earlier line: events of different sources are ordered by arrival, and each source has its own clock (`01-core.md` EV4). That is not damage, and RY13 handles it.

- **RY11.** An event type the reducer does not know is not an error. It is counted, skipped, and reported once with `replay.unknown` (FE1).
- **RY12.** A recording made by an older build with the same header version plays. The header's `build` is shown in About.

### 8.4 Playback

- **RY13 (clock).** Playback is spaced by `ts`, never by `t` (`01-core.md` 12.3). The replay time of event *k* is the largest `ts` among events 1 to *k*, so replay times never go backwards. The Replay clock starts at the replay time of event 1. While playing it advances by real time multiplied by the speed. An event is applied when the Replay clock reaches its replay time. The stream clock of FL9 is the Replay clock, so every duration on screen is a difference of recorded `ts` values.
- **RY14 (gaps).** When the next event is more than `REPLAY_MAX_GAP_MS` ahead of the Replay clock (at speed 1), the clock jumps to `REPLAY_MAX_GAP_MS` before it and the bar shows `replay.skipped` for 3 s. The run clock shows the recorded time, so a jump is visible.
- **RY15 (speed).** Speeds are `REPLAY_SPEEDS`. The default is 1. Animations of 6.4 keep their own length at every speed; above speed 2 the landing travel is replaced by the reduced form.
- **RY16 (seek).** Jumping to a chapter or dragging the track rebuilds `FloorState` for that position and then plays or stays paused as before. A jump completes within `REPLAY_SEEK_BUDGET_MS` for a recording of 50,000 events. During the rebuild no animation runs and no log line is spoken.
- **RY17 (frames).** Every pool frame in Replay is a commit frame (8.6). While playing, when the commit of a frame's position changes, the Floor waits `FRAME_ADVANCE_DEBOUNCE_MS` and posts `{ type: "advance", version }` with the version token of the new commit (`c-` or `p-` followed by the commit id, `01-core.md` PV5), so the pool steps on without a page reload. If no `stats` with that version arrives within `FRAME_ADVANCE_TIMEOUT_MS`, the Floor loads the frame again at the commit address. After a seek the frames are loaded at the commit of the new position. A frame in Replay is never sent `probe` to look for a new version.
- **RY18 (start).** From the start card or the menu, the recording loads and plays. With reduced motion it loads paused. A direct link `/replay/{id}` does the same.
- **RY19 (end).** After the last event the bar shows `replay.ended`. The page stays on the final state. `replay.again` restarts; `replay.to_live` closes Replay.
- **RY20.** Closing Replay returns to live mode in the same view and reconnects the stream.

### 8.5 Chapters

`chapters(events)` is a pure function. A chapter starts `CHAPTER_LEAD_MS` of recorded time before its first matching event, and exists only if an event matches. Chapters are numbered in order of position; that number is their key (6.6). When two chapters would start at the same event, only the one that comes first in the table is kept.

| Chapter name | Starts at the first | Caption on the Replay bar |
| --- | --- | --- |
| Requests | `intent.created` | Each attempt card is one agent. Each light is something it read. |
| Held change | `card.opened` of kind `held` | A change to shared rules waits for the owner. The card shows the pool before and after. |
| Conflict | `headsup.sent` with result `repair` | A change landed. Agents that relied on the old version get the exact diff and adapt. |
| Second catch | `headsup.sent` with result `repair` and a key of rule `QT1` or `L1` | A search or a file list gained a match. The agent that was sweeping it is told. |
| Choice | `card.opened` of kind `choice` | The owner decides in plain words. |
| Undo | `undo.planned` with cause `undo` | Undo takes back the change and the later changes built on it. Their agents reopen. |
| Race | `card.opened` of kind `race` | Three models tried the same request. The owner chooses one. |
| Green line | `green.verified` with `ok` false and `confirmed` true | A check failed twice after landing. Trunk takes the landings back and reopens their agents. |
| Swarm | `swarm.state` with `running` true | Scripted agents on the same landing path. The numbers are measured in this run. |

At any time the bar shows the caption of the current chapter. Chapter names and captions are part of the `copy` module. A viewer can also open Compare view (key `C`) and any Why card (tap a creature) at any position; the caption of the Conflict chapter ends with "Press C to compare with a plain git merge." when the recording has a plain-merge pool.

### 8.6 Pool frames in Replay

Every frame in Replay is a commit frame. Its address comes from `frameUrl` with a `FrameAddress` (4.5), so it names one tree that never changes.

| Frame | `FrameAddress` in Replay |
| --- | --- |
| Live pool frame | `{ repo: "main", commit }` with the commit of the newest `landing.landed` at the position; before the first, `landed_commit` of event 1 (`pool.state`). |
| Plain-merge pool frame | `{ repo: "plain", commit }` from the newest `plain.updated` at the position. Before the first: `plain.loading`. |
| "Before" on a held or race card | `Card.preview.before`: `{ repo: "main", commit }` with the landed commit at the moment the card opened. |
| "After" on a held or race card | `Card.preview.after[attempt_id]`: `{ repo: "plain", commit }` with the preview commit. When the card has none: `held.no_preview`. |

- **RY21.** The caption of every frame in Replay is `frame.replay`: the code is the recorded code, and it runs now. The positions of creatures are not recorded.
- **RY22.** A frame that cannot be served shows `frame.replay_gone` (7, FR20). The rest of Replay continues.

### 8.7 How a judge starts it, with no credentials

Any one of these. None needs a key, an account or a tool.

1. Open the public address. On a quiet pool the start card is in the middle of the pool area. Press "Play the Replay".
2. Open the public address. Press "Replay" in the header. Choose a recording.
3. Open the public address followed by `/replay/hero`. The recording loads and plays.

- **RY23.** The start card is shown to a visitor in live mode on a quiet pool: no attempt is in flight and no landing arrived in the last 60 s. It leaves when the visitor chooses either button, and it never covers the rail.
- **RY24.** The run instructions in the README and in the submission form give way 3 as one line.
- **RY25.** A browser test runs way 1 and way 3 with no cookies against a deployment whose owner key is not set, and checks that the recording plays to the end with no request other than those of RY1.

---

## Appendix A. Floor constants

| Constant | Value | Notes |
| --- | --- | --- |
| `LIGHTS_MAX` | 14 | lights on a collapsed attempt card |
| `AUTO_EXPAND_MAX` | 2 | heads-up panels open by themselves |
| `CHANGE_NAME_CHARS` | 28 | |
| `QUIET_NOTICE_MS` | 10,000 | the activity line starts counting |
| `SLOW_NOTICE_MS` | 30,000 | equal to `AGENT_WATCHDOG_MS` |
| `SENT_WAIT_MS` | 5,000 | |
| `FRAME_LOAD_TIMEOUT_MS` | 8,000 | |
| `FRAME_ADVANCE_DEBOUNCE_MS` | 150 | one batch gives one `probe` (live frame) or one `advance` (Replay) |
| `FRAME_PROBE_RETRY_MS` | 1,000 | CO21: the second `probe` when a live frame answered with an older version |
| `FRAME_ADVANCE_TIMEOUT_MS` | 1,000 | Replay only (RY17): then the frame is loaded again at the commit address |
| `STALE_CARD_MS` | 6,000 | |
| `TOAST_MS` | 6,000 | |
| `SPEND_NEAR_SHARE` | 0.8 | |
| `OFFLINE_AFTER_MS` | 3,000 | |
| `STREAM_SILENCE_MS` | 5,000 | FR10: an open socket with no frame this long is given up; five ticks of EM5 |
| `WS_RETRY_BASE_MS` | 500 | |
| `WS_RETRY_MAX_MS` | 8,000 | |
| `WALL_FPS` | 10 | |
| `REPLAY_SPEEDS` | 0.5, 1, 2, 4, 8 | |
| `REPLAY_MAX_GAP_MS` | 2,000 | |
| `REPLAY_MAX_BYTES` | 25 MiB | the Workers limit for one static asset |
| `REPLAY_SEEK_BUDGET_MS` | 500 | |
| `CHAPTER_LEAD_MS` | 3,000 | |

Deleted in the reconciliation: `UI_DETAIL_WINDOW` (the one name for that window is `FLOOR_KEEP_LANDINGS` of `01-core.md`, 200, equal to `UNDO_WINDOW`) and `CAP_REACHED_SHARE` (the cap is reached when `limits.refusing` is true).

Constants of `01-core.md` that the page shows or uses: `GO_AROUND_LIMIT`, `MAX_REVISIONS`, `RACE_SIZE`, `MAX_INTENT_CHARS`, `FLOOR_KEEP_LANDINGS`, `UNDO_WINDOW`, `MAX_BATCH`, `PUSH_STALL_MS`, `PUSH_REJECT_LIMIT`, `MODEL_RETRIES`, `AGENT_WATCHDOG_MS`, `ATTEMPT_TIMEOUT_MS`, `METRICS_WINDOW_MS`, `FALSE_ABORT_TARGET`, `ESCAPE_TARGET`, `SESSION_TTL_S`, `MAX_FILE_BYTES`. Constants of `02-tidepool.md` Appendix B that the page uses: `POOL_STALL_MS`, `HEAD_POLL_MS`, `STATS_EVERY_MS`. The page imports them from `protocol`; it never repeats a value.

## Appendix B. Acceptance checks

Each is a test in the repository. Fixture streams are NDJSON files in the format of 8.2.

| # | Check |
| --- | --- |
| AC1 | One recorded file gives the same `FloorState` through the live path, a snapshot join and Replay (FE3). |
| AC2 | Every one of the 35 event types of 4.3 has a reducer test whose expected state comes from this file, not from the reducer's output. |
| AC3 | A stream with `landing.accepted` and no `landing.landed` shows "Landing…", leaves the Landed counter and the pool frame unchanged, and offers no Why card (FL3). |
| AC4 | A stream whose `pool.state` has `synthetic: true` shows the SYNTHETIC banner in every view and sheet, and the banner has no close control (FL4, CO49). |
| AC5 | A visitor's page contains no owner control in the document, and Replay contains none (FL7). |
| AC6 | Replay makes only the requests of RY1 (network log in a browser test). |
| AC7 | Every copy id used by a component exists in `copy`; components contain no text of their own (lint). Every id of section 5 is used. |
| AC8 | Intent text, a statement, a path and a kind name that contain markup are shown as text (FL8). |
| AC9 | The token contrast test of VD9 passes for both themes. |
| AC10 | Beats 1 to 7 and 10 can be completed with the keyboard alone (AX2). |
| AC11 | With reduced motion on, no element moves, and pool frames and Replay start paused (6.4). |
| AC12 | At 1920×1080 the computed sizes meet VD15, and the regions have the sizes of 2.1 within 1 pixel. |
| AC13 | No sideways scroll at widths 320, 768, 1100, 1280, 1440, 1600 and 1920 (LY3). |
| AC14 | The vectors `C04` and `C05` of `premise-cases.json`, turned into event fixtures, turn the expected light to `changed` at the landing and back to `holds` at the resolving submit. |
| AC15 | Each row of section 7 has a fixture and a screenshot (FA1). |
| AC16 | The owner key does not appear in the address, in browser storage, in the console or in any request other than `POST /api/session` (CO45). |
| AC17 | Two fast taps on Land, Undo it, Choose this one or Stop all agents send one request (CO2). |
| AC18 | A recording of 50,000 events loads, and a jump to its last chapter completes within `REPLAY_SEEK_BUDGET_MS` in the CI browser (RY16). |
| AC19 | The limits list in About and in the README are built from the same file and are equal. |
| AC20 | The text of the `copy` module contains none of the phrases of FL6 and none of the words of CP4 (lint over `copy`). The same lint checks the FL6 phrases, and only those, in the README and the submission texts (`04-build-plan.md` BP11). |
| AC21 | A fixture with `green.verified` of `ok: false`, `confirmed: false` shows `green.checking` in the strip, no banner 8, and no sentence that says a change is taken back. The next event, with `confirmed: true`, shows banner 8 and `green.red` (`01-core.md` GR3). |
| AC22 | For each card kind and reason of `01-core.md` CD4, a `card.opened` fixture gives exactly the buttons of `Card.options`, in order, and a tap sends that option's id; a tap in a race column sends `choose` with that column's `attempt_id`. No request carries an id outside `CardOption`. |
| AC23 | In live mode a `landing.landed` makes the page post `probe` to the frame on `main`, and a `plain.updated` to the frame on `plain`; the `src` of neither iframe changes and no `advance` is posted. In Replay the page posts `advance` with a version token and no `probe` for a new version (`01-core.md` SE16a). |
| AC24 | In Compare view, a fixture in which `plain.updated.tree` equals the `tree` of the landing `through_seq` shows `plain.no_difference`; one in which they differ does not. `plain.conflicts` carries "(approximated)"; with `features.text_merge` on, the line is `plain.conflicts.merged`, without it (added 2026-10-10). A landing in `plain.interrupted` shows `plain.interrupted`. Each badge follows its frame's `stats.selftest`. The last line is `app.thesis`. |
| AC25 | `/p/{pool}` shows that pool as the main pool; `/` shows the default pool of `/floor.json`; an unknown pool shows `pool.missing` (row FR30). |
| AC26 | A stream of a `summary_only` pool (no premise, operation or step events; `items: null`) reduces to attempts without premises and shows `rail.summary_only`. A stream of a synthetic pool that is not `summary_only` shows lights, heads-up diffs and Why cards under the SYNTHETIC banner (FE4). |
| AC27 | The reducer counts go-arounds as `01-core.md` GA1 does: on a fixture made from vector `C39` a `repair` that arrives in `going_around` after the previous one was delivered adds 1 and one that joins adds 0; on a fixture made from vector `C32`, "Try again" adds 1 (4.3). A fixture made from vector `C47` counts a pull-back in `attempt.sent_back_n` and not in the Go-arounds counter. An attempt card shows `attempt.sent_back_n` with `go_arounds + pull_backs`. |
| AC28 | The undo request carries `expect_reverted` equal to the `reverted` list on screen. A response `plan_changed` shows the new plan under `undo.plan_changed` and queues nothing (row FR31). The undo-plan request is sent only by an owner. |
| AC29 | A live frame that sends no `stats` for `POOL_STALL_MS` is loaded on `green` when a green commit exists and on `main` when none exists, with the captions of row FR28. |
| AC30 | A recording with header version 1, or an event line without `ts`, is refused with the sentence of 8.3. Playback order and spacing follow RY13 on a fixture whose `ts` values are not in order. |

## Changes in reconciliation (2026-10-04)

Inputs: the lead's decisions, the cross-document critic's findings F01 to F43, the architect's corrections for this file, the notes of the `01-core.md` reconciliation, and the platform record. `01-core.md` wins wherever the two files met. Rule ids kept their numbers. Four id prefixes changed (finding F30): `RP` to `RY`, the failure rows `F` to `FR`, the recording state `P` to `PS`, the needs `TP` to `NP`. New rules have new ids: BS7, CO13a, CO23a, CO23b, CO24a, CO25a, CO34a, CO35a, CO38a, CO42a, CO44a, FE8, CP8, RY26, RY27, FR28 to FR32, NP8, NP9, AC21 to AC30.

### Lead decisions

| Decision | What changed in this file | Section |
| --- | --- | --- |
| 1. Live pool frame | Live frames use the sources `main` and `plain` and get `probe` on `landing.landed` and `plain.updated`. Commit addresses and `advance` are used only in Replay and in card previews. | 0 (terms), 3.5 CO20 to CO23b, 3.6, 4.5, 8.4 RY17, 8.6, Appendix A, AC23 |
| 2. Card options | 5.10 is rewritten from `CardOption` and rule CD4: `land`, `land_now`, `decline`; `choose` with `attempt_id`; `retry`, `stop`; `keep_landed`, `retry`; `new_attempt`, `stop`; the `revert_limit` card (GL6). Buttons are drawn from `Card.options`. | 5.10, 3.13, 3.14, 4.5, FR29, AC22 |
| 4. Stopping from the Agent side | Stop sentence for `withdrawn`; 17 stop reasons | 5.8 |
| GP1 | Commit frames of the plain-merge repository use `p-<40 hex>` through `frameUrl` | 4.5, 8.4, 8.6 |
| GP2 | The Swarm controls send `SwarmRequest` with `pool` | 3.15 CO44a, 4.5 |
| GP3 | The request roles of the beat sheet name their rows of `02-tidepool.md` section 9: the group `starter`, P1a, R01, P9a, P9b. BS7 paces the second catch. | 1.2, 3.1 CO7, 4.7 NP5 |
| GP4 | Without the held card the main pool uses the seed `tidepool-auto` | 1.4, 4.7 NP6 |
| GP5 | `summary_only` replaces "synthetic pool" wherever events or note fields are left out. `pool.synthetic` alone decides the SYNTHETIC banner. "Quiet pool" keeps its own meaning. | 0 (FL4, terms), 3.2 CO13a, 3.7, 3.11, 4.1 FE4, 4.3, AC26 |
| Held tier in every build | The minimal form of the held card when `features.held` is false | 1.4, 2.4, 3.13, 5.10 |
| Words banned by BP11 | CP4 covers the `copy` module; the README and the submission texts may say what a change replaces | 5.1 CP4, AC20 |
| Fonts | No change: VD6 already uses the system font stack and bundles no font file | 6.2 |
| Related work wording | No change needed: FL6 and `about.related.body` already name STORM, CoAgent and dibs and make no priority claim | 0, 5.4 |

### Critic findings

| Finding | What changed in this file | Section |
| --- | --- | --- |
| F01 | As decision 1 | 3.5, 3.6, 8.4, 8.6 |
| F02 | As decision 2. The held card gains `land_now` with the sentence "Blast, right of way". | 5.10, 3.13 CO35a |
| F04 | The sentence for `withdrawn` | 5.8 |
| F06 | "Try again" and a reopen start the same agent with `resume`; a failure gives `reopen_failed` and a card | 3.2 CO13, FR16, FR23 |
| F07 | A reopened chosen race candidate is an ordinary attempt card and lands without a card (RC7) | 1.2 beat 7, 3.2 CO13, 3.14 CO40 |
| F08 | Compare view gains the self-test badges, "(approximated)", `plain.interrupted`, `plain.no_difference`; `FloorState.plain` gains `tree` and `interrupted` | 2.3, 3.6, 4.1, 4.3, 4.4, 5.4, AC24 |
| F09 | The client route `/p/{pool}`; the main pool is the pool of the address | 0 (terms), 4.1 FE7, 4.5, FR30, AC25 |
| F10 | Four recordings: `hero` (the take, exported after it), `rehearsal` (played in beat 10), `hero-canned`, `swarm`. Beat 10 says "A run like this one is recorded". | 1.1 PS5, 1.2 beat 10, 1.5, 8.2 RY26, RY27 |
| F12 | The crab request is P1a word for word; the reason is that `spawn` sets `energy: ENERGY_MAX`. The heads-up shows the import line and the `spawn` line, not the line with 30. | 1.2, 2.4, 2.5, 3.2, 3.4 |
| F13 | The starter set has members (A01, A03, A04, A06, A11, P1b); the sweep is P9a and the late creature P9b; the shrimp is the earlier match that QT1 needs | 1.2 (BS7, requests, beat 5, "why this order is safe"), 3.1 CO7, 4.7 NP5 |
| F14 | The false-abort rate comes from `metrics` in every pool. The escape rate on screen is green-line reverts only. Truth-label numbers are not on the page. `HeadsUpView.resolved` gains `changed`. | 3.15 CO42a, 4.1, 5.4 |
| F15 | `limits` and `swarm.state` reach every pool's stream; the `src` values of EV2a | 4.1 FE7, 8.2 |
| F16 | Sentences for a scripted triage answer, which never name Clef | 5.6 |
| F17 | CP1: the `copy` module is pure, so the engine may import it | 5.1 |
| F18 | The undo-plan read is an owner route answered by Trunk; no public request of the page reaches Trunk | 4.5 |
| F19 | Labels for the fixed check names and codes of GR8; a kind name is shown as text | 5.7, 3.6 CO25a |
| F20 | `green.last.confirmed`. Banner 8, `green.red` and `sr.green_red` only for a confirmed failure; a first failed run shows `green.checking`. | 3.8, 3.18, 4.1, 4.3, 5.4, 5.11, 5.13, FR19, 8.5, AC21 |
| F21 | `features` is the type of FJ1 with its six keys. The plain-merge pool has no key: Compare view follows `pool.plain_remote`. | 1.4, 3.6, 4.1 FE8, 4.5 |
| F26 | `banner.paused.push_rejected` with the Rebuild button; the undo sheet state and sentences for `plan_changed` and `not_a_change`; the stalled-frame row | 5.11, 3.12, 5.9, FR11, FR28, FR31 |
| F27 | As GP5, with the lead's name `summary_only` | as GP5 |
| F28 | The page sends one message on the stream socket and never a second | 4.5 |
| F29 (a) | Go-arounds are counted from the field `go_arounds` (T10a has `from = to`) | 4.3, 3.8, AC27 |
| F29 (b) | `AttemptView.pull_backs`; the attempt card shows "sent back n of 3" | 3.2, 4.1, 4.4, 5.4 |
| F29 (c) | `tick.skipped.why` values `checks_failed` and `held` | 4.1, 5.6 |
| F29 (d) | Rows for `trunk.error` and `undo.refused`; all 35 event types have a row | 4.3 |
| F29 (e) | Sentences for E2m, F3m, QR1m, QR4, Z1; stop sentences for `revert_limit`, `lost`, `withdrawn` | 5.6, 5.8 |
| F29 (f) | The clock, durations and playback use `ts` | 0 FL9, 3.8, 4.1, 4.4, 8.3, 8.4 |
| F29 (g) | `FLOOR_KEEP_LANDINGS` is the one name; `UI_DETAIL_WINDOW` and `CAP_REACHED_SHARE` are deleted | Appendix A, 3.9, 3.11, 3.18 |
| F30 | Ids renamed as stated above; the rail item is the "attempt card" with copy ids `attempt.*`; the component state "held" is told apart from the values `held` | header, 0, 3, 5, 7, 8 |
| F32 | Repair time is p50 and p90 and ends at the first submit of status `validated`, `submitted` or `held` | 4.3, 4.4, 5.4 |
| F35 | `card.closed.attempt_id`; `reason` is only the typed reason | 4.1, 4.3, 3.14 CO38a |
| F36 | `app.thesis` is the last line of Compare view; `video.later` is removed and the caption is added in the video edit | 1.2 BS2, 1.5, 2.3, 3.6, 5.4 |
| F37 | Three limit lines: direct references; a number with no reference; every user of a changed thing is shown, not proven adapted | 5.12 |
| F40 | A preview that is missing or failed has its own states | 3.13, FR32 |
| F42 | The 429 of the unlock is defined by SE2a | 3.17, 4.5 |
| F43 | The limit line on a rebuild from Artifacts | 5.12 |
| F11 | Deploying the recording `hero` after the take is named as an allowed change of production (BP12) | 8.2 |
| F22 | The undo sheet states that a landing which neither depends on the target nor read what it wrote is in no list | 3.12 CO34a |
| F03, F05, F23 to F25, F31, F33, F34, F38, F39, F41 | No change in this file. Their corrections are in `01-core.md`, `02-tidepool.md`, `04-build-plan.md` or `05-agent.md`. | |

### Architect's corrections and the notes of the core reconciliation

| Item | What changed in this file | Section |
| --- | --- | --- |
| 4.3 `attempt.state` | As F29 (a) and (b) | 4.3 |
| 4.5 undo plan, `expect_reverted`, `plan_changed`, no `live_attempt` address | The route table follows `01-core.md` 13.6; `FrameAddress` has one form | 4.5, 3.12, 3.13 CO36 |
| 8.2 and 8.3: header 2 and `ts` | The header check, the example lines, RY13 | 8.2, 8.3, 8.4, AC30 |
| Reducer and copy | `submit.result` status `accepted`; item result `pending`; `card.closed.action` values; `Card.blast_radius` per attempt with `right_of_way`; `land_now`; stop reasons `spend_cap`, `cancelled`, `lost`, `revert_limit`; card reasons `revert_limit`, `reopen_failed`; the events `premise.removed`, `pool.files`, `attempt.repo`, `plain.updated`, `undo.refused`, `trunk.error` | 3.3, 3.4, 4.1, 4.3, 5.6 to 5.10 |
| 4.6 | N1 to N25 are listed as settled; no interim behaviour is built | 4.6 |
| `submit.result` carries checks, not error codes | The error sentence of a rejected submit comes from its first failed check | 5.7 |
| `pool.state` fields | `epoch` (open cards close after a rebuild), `plain_remote`, `rebuild`, `unwitnessed` | 4.1, 4.3, 3.9, 5.11 |
| `model_changed` | Kept, with the note that this build never sets it | 3.2 CO13 |

### Copy ids

| Change | Ids |
| --- | --- |
| Renamed | The 20 ids of the attempt card: `card.*` to `attempt.*` (`card.open` and the events `card.opened`, `card.updated`, `card.closed` keep their names: they belong to cards). `card.goaround_n` to `attempt.sent_back_n`. `git.no_clone` to `git.read_token`. |
| Removed | `video.later`, `tiles.empty`, `undo.no_plan`, `held.land`, `held.decline`, `race.choose` (the last three are now the labels of `Card.options`, 5.10) |
| New | `nav.skip`, `strip.label`, `rail.label`, `rail.summary_only`, `green.checking`, `headsup.context`, `headsup.check`, `headsup.truncated`, `headsup.before_unavailable`, `frame.stalled.green`, `frame.stalled.reloaded`, `frame.stalled`, `plain.interrupted`, `plain.no_difference`, `selftest.running`, `selftest.pass`, `selftest.fail`, `selftest.fail.line`, `selftest.tip`, `tiles.files`, `why.landed.owner_now`, `why.landed.owner_risk`, `why.unwitnessed`, `who.summary_only`, `undo.plan_changed`, `held.preview_building`, `held.land_now.tip`, `held.closed.land_now`, `race.superseded`, `swarm.false_abort.tip`, `swarm.escape.tip`, `swarm.wall.summary`, `about.forks_off`, `about.trunk_errors`, `pool.missing`, `pool.to_default`, `banner.synthetic.swarm`, `banner.paused.push_rejected`, `sr.green_checking`, `sr.more` |
| Reworded | `headsup.title.repair`, `frame.error`, `frame.replay_gone`, `plain.conflicts`, `plain.conflicts.tip`, `plain.same`, `held.no_preview`, `held.closed.land`, `about.run.repair`, `pool.rebuild.body`, `banner.synthetic`, `banner.rebuilding`, `banner.green_red`, `sr.green_red`; the stop sentence for `go_around_limit`; the caption of the chapters Requests and Green line |
