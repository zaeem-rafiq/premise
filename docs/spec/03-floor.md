# Premise Floor specification (03-floor)

Status: binding for the implementation of the Floor, the one web page where a person watches and steers. Sources: the architecture brief (decisions and vocabulary), the design brief (contest and platform limits), the concept panel (the `stage-first` proposal and the three judges' must-fix lists), and `01-core.md` (types, rules and the event stream).

Scope: the product surface. Layout, components, states, the mapping from events to what is on screen, interface copy, visual language, failure behaviour and Replay. Not in this file: the core rules (`01-core.md`), the tide pool code and the app server that serves it (the tide pool specification), and the Swarm scripts.

Conventions:

- "MUST", "MUST NOT" and "MAY" are requirements. Rules have ids (`FL1`, `LY3`, `RP2`) so tests can cite them.
- Names in `code` are types, events, rules and constants of `01-core.md` unless marked *(Floor)*. Floor constants are in Appendix A.
- "The stream" is the pool's event stream (`01-core.md` section 12).
- Copy ids such as `status.working` point to section 5. The text in sections 5, 7 and 8 is exact. No other text may appear in the interface.
- Numbers in examples ("12 agents", "landing 9") are examples. The page shows only what the stream produced.
- Sizes are CSS pixels.

---

## 0. Rules for the whole page

- **FL1 (pure function).** `FloorState = reduce(events 1..n)` with the reducer of the shared `protocol` module (`01-core.md` EV5). What is on screen is `render(FloorState, ViewState, clock)`. `ViewState` is the local state listed in 4.2 and nothing else. The page MUST NOT read a pool fact from any other source, except the requests listed in 4.5.
- **FL2 (one page).** One page with three views (Floor view, Compare view, Swarm view), two modes (live, Replay) and two roles (owner, visitor). Every beat of section 1 is reachable by taps and keys on this page. No terminal, no second tool.
- **FL3 (landed means on `main`).** The word "Landed", the Landed counter, the Why card, and any change of the live pool frame depend only on `landing.landed` (`01-core.md` LP9 to LP11). Between `landing.accepted` and `landing.landed` the page says "Landing…".
- **FL4 (honest labels).** A pool with scripted agents is always under the SYNTHETIC banner. Replay is always under the REPLAY banner. The plain-merge pool always carries the label `plain.label` and the word "constructed". The real-agent count always shows its limit and the reason for the limit. The page quotes no number that the current stream did not produce.
- **FL5 (plain words).** The owner never needs to read code, a hash or a state name. Ids and hashes appear only in the "show the git" drawer and in tooltips. Every code-level name shown elsewhere goes through `keyLabel` (5.2).
- **FL6.** No text on the page makes a priority claim. The lint list is: "the first", "first to", "no one else", "nobody else", "the only system", "the only tool", "the only product".
- **FL7 (roles).** Controls that change something are absent for a visitor and absent in Replay. The intent box is the one exception: it stays, disabled, with a sentence that says why (3.1).
- **FL8 (untrusted text).** Intent text, summaries, statements, paths, entity names, model names and everything a pool app sends are rendered as text, never as HTML (`01-core.md` SE18, SE16).
- **FL9 (clock).** Every "x seconds ago" and every timer uses the stream clock: in live mode the browser clock corrected by the offset to the newest event's `t`; in Replay the Replay clock (8.4). No component calls the browser clock directly.
- **FL10 (no silent wait).** Every wait on screen has a sentence that says what is being waited for. A spinner alone is not allowed.

Floor terms (used with exactly these meanings in this file and in code):

| Term | Meaning |
| --- | --- |
| Owner | A browser that holds the owner session (`01-core.md` SE2). |
| Visitor | A browser without it. Read-only plus Replay. |
| Header | The top bar: name, view switch, Needs-you badge, kill switch, owner lock. |
| Strip | The row of counters under the header. |
| Banner | A full-width labelled band under the strip. Banners stack. They never cover content. |
| Pool area | The left region: pool frame and file tiles. |
| Rail | The right region: intent box, Needs-you tray, attempt cards. |
| Pool frame | A sandboxed iframe that runs the pool app at one commit. |
| Plain-merge pool | The pool built by `01-core.md` 11.7. The brief's scope list calls it the counterfactual pool. Its label on screen is "Same changes, merged by plain git". |
| Light | One premise of one attempt, drawn as a shape (3.3). |
| Tile | One file of the pool (3.7). |
| Sheet | A panel that opens over the body for one task (a card, a Why card, About). |
| Tray | The "Needs you" list of open cards at the top of the rail. |
| Recording | One Replay file (section 8). |
| Chapter | A named position in a recording (8.5). |
| Run clock | Time since the first `intent.created` of the stream, on the stream clock. |

---

## 1. Beat sheet

The beat sheet is the specification of the page. A component or state that no beat and no row of section 7 needs is out of scope.

### 1.1 State before recording

| # | Item | How the owner checks it on the page |
| --- | --- | --- |
| P1 | The main pool has several creatures that real agents landed earlier, on top of the seed, so Why and Who relies have history. | Landed counter is above 0. Tapping a creature opens a Why card. |
| P2 | The owner session is unlocked. The key is never typed while recording. | Header shows `owner.unlocked`. |
| P3 | Spend is far below the cap. | Strip: Spend. |
| P4 | Agents are allowed. The pool is ready. | No banner. |
| P5 | The recordings load. | Replay menu lists them with their length. |
| P6 | Theme and size are set for the screen in use. | Keys `T` and `Z` (6.6). |
| P7 | The Swarm pool exists and is idle. | Swarm view shows `swarm.empty`. |

Attempt repos are provisioned off the landing path (`01-core.md` AG5), so nothing on screen waits for them.

### 1.2 Submission video (target 7:30, hard limit 10:00)

Rules for the recording:

- **BS1.** One session on the deployed system, in a browser, with no terminal. Cuts remove waiting only. The run clock is on screen in every shot, so every cut is visible.
- **BS2.** Beat 0 is a cut forward from beat 4 of the same session and carries the caption `video.later`.
- **BS3 (the owner sets the pace).** Both catches are paced by cards, not by luck. A change that waits on a card keeps its premises live (`01-core.md` 10.2, RC2). So the owner first lets the changes that will be caught wait on a card, and then lands the change that moves the code under them. No beat depends on two agents finishing in a lucky order.
- **BS4.** The voiceover reads measured numbers from the screen. Where the script says *[read the number]* no number is written in advance.
- **BS5.** If a card closes as out of date before the owner taps it, that is the same catch in the other landing order (`01-core.md` 6.5). The script has a line for it.
- **BS6.** The voiceover of a beat has at most 2.5 words for each second of the beat, and no sentence longer than 25 words.

The requests used (exact texts belong to the tide pool specification; the roles are fixed here):

| Role | Example text | How it is sent | Why it waits or lands |
| --- | --- | --- | --- |
| Starter set | several creature requests | pre-written, one tap | Tier `auto`: each lands by itself. |
| Crab race | "a crab that hides when its energy is low" | typed, then "Race 3" | Race candidates wait on the race card. Their code compares energy with a number, so it references `ENERGY_MAX`. |
| Shared rule | "make energy a fraction from 0 to 1" | typed | Touches a held path: waits for one tap. |
| Sweep | a request that changes a shared rule and edits every creature found by one search | pre-written | Touches a held path: waits for one tap. |
| Late creature | a creature that the sweep's search also matches | pre-written | Tier `auto`: lands by itself. |

| # | Time | On screen | The owner does | Voiceover | Proves |
| --- | --- | --- | --- | --- | --- |
| 0 | 0:00 to 0:20 | Compare view. Left frame: "Premise · main", the crab hides and comes out again. Right frame: "Same changes, merged by plain git · constructed for comparison", the crab never comes out. Caption `video.later`. The thesis sentence under the frames. | Nothing (cut forward). | "Both pools got the same changes from the same agents. Plain git merged them and reported no conflict. The crab on the right is broken. Git records only what an agent wrote. Premise also records what it read." | The plain-merge pool, labelled as constructed. The thesis. |
| 1 | 0:20 to 1:05 | Floor view. The pool runs. Strip: real agents, landed, go-arounds, waiting, green line, spend. Starter cards appear with the tag "Pre-written" and a model name. The crab request appears as a race group of three cards, one per model. Lights switch on, one per thing an agent reads. File tiles show reader and writer marks. Strip: "Real agents 9 of 12 · Limit set by the model rate." A starter card goes "Landing…", then "Landed", and its creature appears in the pool. The three crab cards reach "Waiting for you". | Presses "Send the starter set". Types the crab request and presses "Race 3". | "I can't read code. I type what I want. Each request gets a real agent on Workers AI. Agents see code only through Premise, so every read becomes a light: a premise, pinned to the exact version the agent saw. Nobody claims a file. Nothing is locked. This creature landed by itself as one ordinary commit, because everything it relied on was still true. The crab I asked three models for. Those three wait for me." | Several real agents at once on one codebase. Reads observed by the platform. Landing with no queue and no review step. The stated limit on real agents. |
| 2 | 1:05 to 1:35 | A new card: "make energy a fraction from 0 to 1", "Working". The owner taps the tile `energy`, then "ENERGY_MAX", then "Who relies on this". A panel lists the landed creatures and "In flight (3)": the three crab attempts. The same creatures are outlined in the pool. The same cards and lights are outlined in the rail. | Types the shared-rule request and presses Send. Three taps. | "Now I change a shared rule: energy becomes a fraction. Before it lands, I ask who relies on that rule. Premise knows, because it observed every read. No agent declared anything." | Blog question 1 (how agents and people know what others are doing). Who relies. |
| 3 | 1:35 to 2:50 | Tray: "This change touches shared rules. Land it?" The card sheet shows the pool before and after, and "Landing this sends 3 changes back to their agents: crab (gpt-oss-120b), crab (glm-5.3-flash), crab (kimi-k2.7-code)." The owner taps Land. The card goes "Landing…", then "Landed". In that moment the ENERGY_MAX light on the three crab cards turns into a red diamond and the cards move to the top. Each shows a heads-up: "ENERGY_MAX in world/energy.js changed, and this change uses it." Before `export const ENERGY_MAX = 100;` After `export const ENERGY_MAX = 1;` Its own line: `if (crab.energy < 30)`. Status "Going around · 1 of 3". Then "Editing creatures/crab.js", then the agent's sentence ("… so the hide threshold is 0.3."), the light is a green circle again, and the card returns to "Waiting for you". | Opens the card. Taps Land when it names the three crab attempts. | "Shared rules are a held path, so this change waits for one tap from me. I don't read a diff. I see the pool before and after, and which waiting changes it will send back. It landed. In the same moment, Trunk told every agent that relied on the old value, with the exact diff. That is a heads-up. The name did not change, only its meaning, so an import check and a text merge see nothing. Each agent still has its whole conversation. It adapts and says what it changed. That is a go-around." If the card closed as out of date first: "A creature landed first. So the shared-rule agent got the heads-up instead: a new change now uses the value it is altering." | Blog question 2 (conflicting changes): a conflict is a broken premise, caught when `main` moves. Blog question 3 (review): held path, one tap, before and after, blast radius. Context preservation: the same agents adapt. |
| 4 | 2:50 to 3:35 | Tray: "3 of 3 attempts at 'a crab that hides when its energy is low' are ready. Choose one." The race sheet shows three pool frames side by side, each running one attempt. Under each: model, lights, checks, time taken, cost, "Would send back: 0 changes". The owner taps "Choose this one". It goes "Landing…", "Landed". The other two show "Not chosen". The crab appears in the pool. The owner opens Compare view: on the left the crab hides and comes out; on the right it never comes out. Under the frames: "crab (glm-5.3-flash): went around once after ENERGY_MAX changed. The plain-merge pool has its first version." and "Text conflicts in the plain merge: 0". | Opens the card. One tap. Presses `C`. | "Three models tried the crab. Here are the three results, running side by side. Under each: what it relied on, how long it took, what it cost, and how many waiting changes it would send back. I choose by looking. It lands through the same gate as every other change. The other two are kept. Now the same changes, merged by plain git. No conflict was reported. This crab still compares its energy with thirty." | Compare several attempts at once and decide which ships. The plain-merge pool shows the break to someone who cannot read code. |
| 5 | 3:35 to 4:05 | The sweep card waits in the tray. Its light `the search for "drain(" in creatures/` is a green circle. The late creature lands by itself. The search light turns into a red diamond: "the search for "drain(" in creatures/ has a new match, and this change had edited the earlier matches." The tray row leaves; the sheet, if open, says the card is out of date. The agent edits the new creature too. A new card opens. The owner taps Land. | Sends the sweep request. When its card is in the tray, sends the late creature request. Taps Land on the new card. | "The other direction works too. This agent searched for every creature that drains energy and changed each one. Then a new creature landed. A search result is a premise as well. The agent learns of the new match and finishes the job before I land it." | The second catch: a `query` premise gains a match (`01-core.md` QT1). A card never approves more than it showed. |
| 6 | 4:05 to 4:50 | The owner taps the crab in the pool. The Why card opens: who asked and their words, which model, what it relied on, one go-around and its cause, the agent's sentence, the checks, how it landed. The owner taps "Show the git": commit id, `Change-Id` and `Intent-Id` trailers, the note, two git commands. | Taps the crab. Taps "Show the git". | "Why is this crab like this? I tap it. Who asked, in their words. Which model wrote it. What it relied on. What changed under it, and what it did about that. What the platform checked. This is not a private database. It is an ordinary commit on main in Artifacts, and the record is a git note. Anyone can clone the repository and read it with plain git." | Blog question 4 (why). The record lives in git notes on Artifacts. One record serves landing, review and why. |
| 7 | 4:50 to 5:30 | The owner opens the Why card of the shared-rule change and taps Undo. The sheet says: "This also takes back 1 later change that was built on it: crab. Its agent reopens and adapts." and "{n} later changes only read it. They stay." The owner taps "Undo it". The crab card returns to Working with the tag "Reopened by undo" and the line "Same agent, same conversation." It gets a heads-up with the reversed diff, adapts and lands. The pool keeps running. | Two taps. | "I change my mind. Undo knows which later changes were built on this one, because their premises say so. It takes back exactly those. It wakes the same agent, with the same conversation, to adapt again. Changes that did not depend on it stay." | Causal Undo. Context preservation: a reopened author. |
| 8 | 5:30 to 6:25 | Swarm view. Banner: "SYNTHETIC · 1,024 scripted agents · no model calls · same tools, premises and landing path". Four large numbers: landings per second, time to land, go-around rate, changes waiting behind another change. Smaller: false-abort rate, escape rate, push backlog, last push. A wall of cells, one per scripted agent. The owner raises the collision dial. | Sets agents, presses Start, moves the dial. | "Real agents are limited by the model rate limit, and the screen says so. To measure the landing path itself I use scripted agents. They are labelled synthetic. They make no model calls. They use the same tools, the same premises and one Trunk. These numbers are measured in this run: *[read the four numbers]*. I turn collisions up. *[Read the go-around rate and the waiting number again.]*" | Measured scale on one Trunk, under the SYNTHETIC banner. Changes with nothing in common land in one push. |
| 9 | 6:25 to 7:05 | About sheet. Left: how it runs (Worker, Trunk, Agent and Floor Durable Objects, Workflows, Workers AI, Artifacts). Middle: what was real, what was synthetic, what was constructed in this run, with counts. Right: the limits list and related work. | Opens About. | "It runs on Cloudflare. One Worker. One Durable Object per pool, which alone writes to main. One per agent. Workflows, Workers AI, and Artifacts for every commit and every note. The limits, plainly. JavaScript modules only. One Trunk per pool, small pools. The scale numbers come from scripted agents. The comparison pool is constructed. Related work also checks what agents read. What differs here is on screen: reads observed at entity, listing and search level, checked live, stored as git notes." | Honest limits. Cloudflare use. No priority claim. |
| 10 | 7:05 to 7:30 | The owner locks the page (visitor role). The start card offers the recording. The owner presses "Play the Replay". The REPLAY banner appears and the same page plays the recorded stream. The public address is on screen. | Taps Owner, then Lock. Taps "Play the Replay". | "Everything you saw is recorded as one event stream. Open this address and press Replay. The same page plays it back. No account, no key. Git records what agents wrote. Premise also records what they read." | Replay with no credentials. The page is a function of the stream. |

Why this order is safe (each line is a rule of `01-core.md`):

| Step | Rule that makes it deterministic |
| --- | --- |
| The three crab attempts wait with their premises live. | RC2: a race candidate goes to `held` after its submit, whatever its tier. D1, D3: its reference to `ENERGY_MAX` is a premise from the submit on. |
| The shared-rule card names the three crab attempts. | 11.6: the blast radius is computed with the rule-based rows when the card opens and again at the tap. |
| Landing the shared rule turns the three lights red. | Row E2, T8: a referenced entity changed; a `held` attempt goes around. |
| The plain-merge pool has the crab's first version. | 11.7: it replays the operations the attempt held before its first heads-up. |
| The late creature turns the sweep's search light red. | Row QT1, T8: the sweep had altered earlier matches; its card closes as `stale`. |
| Undo takes back the crab. | UN2: the crab's premise on `ENERGY_MAX` was pinned at the shared-rule landing and is `derived`. |

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

The brief marks the held card, Clef, the green line, Undo and Race as SHOULD. The page and the video MUST still be complete without each of them.

| Not built | The page | The video |
| --- | --- | --- |
| Race | No "Race 3" button. | The crab is one attempt. Beat 3 uses the other landing order, paced by the held card: the owner sends the crab request while the shared-rule card waits. The crab lands by itself, the shared-rule card closes as out of date, its light for "the list of code that uses ENERGY_MAX" turns red, its agent adapts the crab too, a new card opens, and the owner taps Land. Beat 4 keeps only the Compare view. About lists "comparing attempts" under limits. |
| Held card | Shared-rule paths are tier `auto`. No tray entry for them. | With Race: beat 3 starts when the shared-rule change lands by itself; the first two voiceover sentences are dropped. Beat 5 depends on timing and is shown from a rehearsed run. |
| Race and held card | Neither. | Beats 3 and 5 depend on timing. They are recorded until both catches happen, and the Replay recording is that run. |
| Clef | No risk lines. No "Being checked" light. A changed thing the agent only read gives "Needs a confirm" (`01-core.md` 7.3). | No change. The script does not mention Clef. |
| Green line | Strip shows `green.none`. About lists it under limits. | No change. |
| Green line with runtime `static` | Strip shows `green.static`. | No change. |
| Undo | No Undo button. | Beat 7 is replaced by 40 more seconds of beat 6: the Why card of the shared-rule change, and Who relies on a landed entity. |
| No event for the plain-merge pool (4.6, N2) | No Compare view. | Beat 0 opens on the Floor view and beat 4 ends at the landing. The brief lists the comparison as MUST, so N2 has to be settled first. |

### 1.5 Stage variant (10:00, live)

Differences from 1.2, and nothing else:

1. No cuts. Waiting is covered by speaking about what the lights and tiles show. Because of BS3 every catch waits for the owner's tap, so the pace is the owner's.
2. There is no cut forward. The opening is the thesis sentence over the running Floor view (0:00 to 0:40). The Compare view appears once, at its place in beat 4.
3. Times: beat 1 0:40 to 1:40; beat 2 1:40 to 2:40; beat 3 2:40 to 4:20; beat 4 4:20 to 5:20; beat 5 5:20 to 5:50; beat 6 5:50 to 6:40; beat 7 6:40 to 7:30; beat 8 7:30 to 8:40; beat 9 8:40 to 9:25; beat 10 9:25 to 10:00.
4. The sweep request of beat 5 is sent at the start of beat 4, so its card is in the tray when beat 5 begins.
5. The owner taps Land in beat 3 only when the card names the three crab attempts. If fewer are ready after 60 seconds, the owner lands it anyway and says how many were sent back.
6. One fallback. At any stall the owner presses `R`, then the number key of the chapter for the current beat (8.5). Replay plays from there under the REPLAY banner, and the owner says that it is the recording.
7. The Swarm run in beat 8 is started on stage and runs for at least 45 seconds. If it cannot start, the Swarm recording is played under both banners.
8. The key is never typed on stage (P2). The session lasts `SESSION_TTL_S`.
9. Size and theme are set on the venue screen before the talk (P6).
10. No audience input. The audience phone page is a STRETCH item of the brief and is not part of this specification.

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
| Header | 1920×64 | 1440×56 | Name and pool name, view switch, Needs-you badge, kill switch, owner lock. |
| Strip | 1920×72 | 1440×60 | Run clock and six counters (3.8). |
| Banners | 1920×40 each | 1440×36 each | Zero or more, stacked, in the fixed order of 3.18. |
| Body | the rest | the rest | The view. Padding 24 (laptop 16). |
| Pool area (Floor view) | 1152 wide | 832 wide | Caption bar 40, pool frame 16:9 at full width (1152×648; laptop 832×468), file tiles in the rest. |
| Rail (Floor view) | 696 wide | 560 wide | Intent box, tray, tabs, cards. Only the card list scrolls. |
| Replay bar (Replay only) | 1920×56, at the bottom | 1440×48 | Replay controls (3.16). |

- **LY1.** The pool frame keeps 16:9. It uses the full width of the pool area unless the file tiles would get less than one row (64 high); then the frame shrinks and is centred.
- **LY2.** Banners and the Replay bar take height from the body. They never overlap the frame, the cards or a sheet.
- **LY3.** The page never scrolls sideways at any width from 320 up. Only the card list, the tile overflow list, sheets and the git drawer scroll, and only vertically.
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
| world/     [energy  ooo #] [movement o ] [food    ] [time ] | | card (adapting, pinned on top)   | |
| creatures/ [fish     o   ] [snail      ] [crab   #] [eel #] | +----------------------------------+ |
|            [urchin  #    ] [+9 more    ]                    | | card                             | |
| (o = one reader, # = one writer)                            | | card                             | |
+-------------------------------------------------------------+--------------------------------------+
```

### 2.3 Compare view, stage size

The rail is hidden. Opened by the Compare button or key `C`. Closed by the same, or by Esc.

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
+-------------------------------------------------+--------------------------------------------------+
| WHAT DIFFERS                                                                                       |
| crab: went around once after ENERGY_MAX changed. The plain-merge pool has its first version.       |
| eel:  went around once after ENERGY_MAX changed. The plain-merge pool has its first version.       |
| Text conflicts in the plain merge: 0                                        [Back to the Floor]    |
+----------------------------------------------------------------------------------------------------+
```

### 2.4 Card sheet (held change) and race sheet, stage size

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
| 3 of 3 attempts at "a crab that hides when its energy is low" are ready. Choose one.    [Close] |
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

A `choice` card uses the same sheet with no frames: the title, at most two sentences, and two buttons.

### 2.5 Why sheet and the git drawer, stage size

The Why sheet is 760 wide on the right edge, over the rail. The pool area stays visible, so the tapped creature stays in view. The git drawer is 720 wide and opens to the left of the Why sheet.

```
+-----------------------------+-----------------------------------+----------------------------------+
| pool area (440 visible)     | SHOW THE GIT             [Close]  | WHY IS THIS HERE?        [Close] |
|                             | This is an ordinary git commit    | crab · landing 11 · 14:03:44     |
|   (pool frame keeps         | on main, in Artifacts.            | WHO ASKED                        |
|    running; the tapped      | commit  9f2c…e1a7        [Copy]   | owner: "a crab that hides when   |
|    creature is outlined)    | parent  41b0…77c2                 |  its energy is low"              |
|                             | tree    c07d…0b9e                 | WHO WROTE IT                     |
|                             |                                   | A real agent on glm-5.3-flash.   |
|                             | Add a crab that hides when its    | WHAT IT RELIED ON                |
|                             | energy is low                     | (o) ENERGY_MAX in world/energy.js|
|                             |                                   | (o) the file creatures/crab.js   |
|                             | Intent: a crab that hides when…   | WHAT CHANGED UNDER IT            |
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
| ////// SYNTHETIC · 1,024 scripted agents · no model calls · same tools, premises and landing path //|  40
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

```
+----------------------------------------------------------------------------------------------------+
| header 64 (no kill switch, owner lock shows "Visitor")                                             |
| strip 72 (values of the recording at the Replay position)                                          |
| :::::: REPLAY · recorded 10 Oct 2026 · "The conflict, real agents" · nothing here changes a pool ::|  40
+-------------------------------------------------------------+--------------------------------------+
| pool area: frames run the recorded code at the commit of    | rail: the cards of the recording.    |
| the Replay position                                         | The intent box says requests are off.|
+-------------------------------------------------------------+--------------------------------------+
| [Play/Pause] [Restart]  01:42 of 06:10  |--o--------|--------|-----|------|   Speed [1x]  [Close]  |  56
|                          chapters:  Requests  Conflict  Second catch  Why  Undo  Race              |
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
| Pool area and rail | 60% and 40% of the width (832 and 560 at 1440). Pool frame 832×468. |
| File tiles | Compact tiles (88×48), as many rows as fit, then `tiles.more`. |
| Strip | The same seven cells. Labels may wrap to two lines. |
| Card sheet | Width 96% of the window. Held frames 2×(648×364). Race frames 3×(428×241). |
| Why sheet and git drawer | Why sheet 560 wide. The git drawer covers the pool area instead of sitting beside it. |
| Swarm view | The four large numbers stay in one row at 72 high. The wall gets the rest. |

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
| creatures/ [fish][snail][crab][+9 more]     | card / card / card         |
+---------------------------------------------+----------------------------+
```

### 2.9 Narrow layout (below 1100 wide)

One column, in this order: header (view switch becomes a menu), strip (wraps to two rows), banners, intent box, tray, pool frame (full width, 16:9), tabs and cards, file tiles behind a "Files" disclosure. Sheets are full-screen. Compare view stacks the two frames. All functions stay available. This layout is for reading on a small screen; it is not a stage layout.

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
| SYNTHETIC banner, when the pool or the recording is synthetic | Banners |
| REPLAY banner, in Replay | Banners |
| Any failure banner of section 7 | Banners |

---

## 3. Components and their states

Each component lists its inputs (fields of `FloorState`, 4.1, or `ViewState`, 4.2), what it shows, and one row per state. The state names are the same for every component: **empty** (nothing to show yet), **loading** (waiting, with a sentence), **live** (normal), **held** (waiting for a person, or blocked for a stated reason), **error** (something failed; the sentence says what and what to do), **stopped** (ended; no further change expected). "n/a" means the state cannot occur. Copy ids point to section 5.

- **CO1.** A component shows exactly one state at a time, chosen by the first matching row of its table, top to bottom.
- **CO2.** A button that sends a request is disabled from the tap until the response arrives, and shows its `…ing` label. Every such request carries a fresh `request_id` (`01-core.md` 9.8).
- **CO3.** When the connection is lost (7, row F10), every component keeps its last content, dimmed to 60%, and no owner control is enabled.

### 3.1 Intent box

Inputs: owner session, `pool.state`, `limits`, `pool.real_agents`, `pool.max_real_agents`, the draft text, the pre-written requests (static file, 4.5).

Shows: a text field (one to four lines, at most `MAX_INTENT_CHARS` characters), a character count, two buttons (`intent.send`, `intent.race`), and the menu `intent.prewritten` with the button `intent.starter`.

| State | When | Shows | Enabled |
| --- | --- | --- | --- |
| stopped | Replay | `intent.replay` in place of the field | nothing |
| held | visitor | field disabled, `intent.visitor` | nothing |
| held | `limits.killed` | `intent.killed` | nothing |
| held | pool state `paused` or `rebuilding` | `intent.paused` or `intent.rebuilding` | nothing |
| held | spend cap reached (7, row F8) | `intent.cap` | nothing |
| loading | a create request is in flight | field read-only, button label `intent.sending` | nothing |
| loading | the request succeeded and its `intent.created` has not arrived within `SENT_WAIT_MS` | `intent.sent_waiting` | field |
| error | the last request failed | the draft is kept; the error sentence of 5.9 under the field | field, buttons |
| empty | draft is empty | placeholder `intent.placeholder` | field, menu |
| live | draft has 1 to `MAX_INTENT_CHARS` characters | count `intent.count` | all |

Rules:

- **CO4.** A draft longer than the limit cannot be typed: input stops at the limit and the count turns to the warning colour.
- **CO5.** Enter sends. Shift+Enter makes a new line. `intent.race` sends the same text with `race: true`.
- **CO6.** When every agent slot is busy (`real_agents >= max_real_agents`) the box stays enabled and shows `intent.queue`. The new card shows `status.queued`.
- **CO7.** Choosing a pre-written request fills the field and does not send. `intent.starter` sends the starter set in one tap. Every intent created from a pre-written request is tagged `card.tag.prewritten` on its card and in its Why card (needs N15).
- **CO8.** The draft is cleared when the `intent.created` event with the returned `intent_id` arrives, not when the request returns.

### 3.2 Attempt card

Inputs: one `AttemptView` and its intent.

Anatomy, collapsed (stage size 696×132):

```
+--------------------------------------------------------------------+
| owner                                            gpt-oss-120b · 42 s|
| "a crab that hides when its energy is low"                         |
| <> Going around · 1 of 3            Relies on  (o)(o)<!>(o)(o) +3  |
| ENERGY_MAX changed. The diff was sent to the agent.                |
+--------------------------------------------------------------------+
```

Line 1: requester, tags (`card.tag.prewritten`, `card.tag.synthetic`, `card.tag.reopened`, `card.tag.right_of_way`), model short name, time since `opened_t`. Line 2: the intent text, at most two lines, then an ellipsis. Line 3: status shape and word (5.3), go-around count, lights (3.3). Line 4: the activity line (5.5), or the newest heads-up sentence, or the stop sentence.

Expanded (tap or Enter on the card) adds, in this order: heads-up panels (3.4), "Relies on" as a list (3.3), "What it changes" (paths and entities from `ops`), checks (5.7), and for an owner the button `card.stop` (needs N19).

| State | When (`AttemptView.state`) | Status word | Line 4 |
| --- | --- | --- | --- |
| loading | `opened`, slots full | `status.queued` | `card.queue` |
| loading | `opened` | `status.opened` | `card.starting` |
| live | `working` | `status.working` | activity line |
| live | `going_around` | `status.going_around` with `card.goaround_n` | newest unresolved heads-up sentence, then activity |
| live | `needs_confirm` | `status.needs_confirm` | newest unresolved heads-up sentence |
| live | `submitted` | `status.submitted` | `card.waiting_clef` |
| live | `validated` | `status.validated` | `card.next_batch`, or the `tick.skipped` sentence (5.6) |
| held | `held` | `status.held` | `card.open_card` (a link that opens the card sheet) |
| live | `accepted`, or `landed` before its `landing.landed` | `status.accepted` | `card.landing` |
| stopped | `landed` and its `landing.landed` has arrived | `status.landed` | `card.landed_as` |
| stopped | `stopped` | `status.stopped`, or `status.undone`, `status.not_chosen`, `status.declined` | the stop sentence (5.8) |
| error | overlay on any live state: last step failed, a submit was rejected, or the model is slow (7, rows F1 to F3) | unchanged | the error sentence, in the warning colour |
| empty | n/a (the list's empty text is `rail.empty.working`) | | |

Rules:

- **CO9 (order).** In the Working tab, cards whose state is `going_around` or `needs_confirm` are in a group at the top, in the order they entered it. All other cards follow, newest intent first. A card moves only when it enters or leaves the top group. Attempts of one race are one group under their intent text; the group moves as one and is in the top group while any of its attempts is.
- **CO10 (density).** With more than 5 cards the list uses compact cards (72 high: intent on one line; status, lights and model on the second). With more than 9 it scrolls and the footer says `rail.more`.
- **CO11 (auto-expand).** When a heads-up of result `repair` or `confirm` arrives, the card's newest heads-up panel opens by itself. At most `AUTO_EXPAND_MAX` panels are open by themselves at once; the oldest closes first. A panel the owner opened stays open.
- **CO12 (landing).** On `landing.landed` the card shows `status.landed` for 1.2 s, then moves to the Landed tab (6.4). The Landed tab row opens the Why card.
- **CO13.** A reopened attempt (`attempt.reopened`) returns to the Working tab with the tag `card.tag.reopened`. It shows `card.same_agent` when `model_changed` is false and `card.model_changed` when it is true, until it lands or stops (`01-core.md` UN6).

### 3.3 Premise lights

Inputs: `AttemptView.premises`.

One light per premise. The light's state is `PremiseView.light`. Shape and colour both carry the state, so the state is readable without colour.

| Light | Shape | Colour token | Word | When |
| --- | --- | --- | --- | --- |
| `holds` | filled circle | `holds` | `light.holds` | The premise holds. |
| `changed` | filled diamond | `changed` | `light.changed` | Newest judgment is `repair` and its heads-up is not resolved. |
| `confirm` | filled triangle | `confirm` | `light.confirm` | Newest judgment is `confirm` (not a blind spot) and its heads-up is not resolved. |
| `blind_spot` | ring (hollow circle) | `confirm` | `light.blind_spot` | Newest judgment is rule `B1` and its heads-up is not resolved. |
| `checking` | half-filled circle | `checking` | `light.checking` | Newest judgment is of class `triage` with no result yet. |

A premise with `edit` true has a short bar under its light (`light.flag.edit`).

- **CO14 (order and count).** Lights are ordered: `changed`, `blind_spot`, `confirm`, `checking`, then `holds` in the order recorded. A collapsed card shows at most `LIGHTS_MAX` lights, then `light.more`. Lights that are not `holds` are never hidden behind the count.
- **CO15 (size).** A light is 28 across on a card at stage size, 20 in a compact card, 16 in a list.
- **CO16 (name).** Hover, focus or tap on a light shows `keyLabel` (5.2), the word, and the flags (`light.flag.read`, `light.flag.edit`, `light.flag.derived`). The accessible name is the same sentence (6.5).
- **CO17.** The expanded list has one row per premise: light, `keyLabel`, word, flags, the newest judgment sentence (5.6), and the link `who.open`.
- **CO18.** A light changes only on the events listed in 4.3. A light never turns to `holds` because time passed.

### 3.4 Heads-up panel (inside an attempt card)

Inputs: one `HeadsUpView`.

```
+--------------------------------------------------------------------+
| Heads-up 1 · go-around 1 of 3                                      |
| Changed by: "make energy a fraction from 0 to 1" (landing 9)       |
| ENERGY_MAX in world/energy.js changed, and this change uses it.    |
|   Before   export const ENERGY_MAX = 100;                          |
|   After    export const ENERGY_MAX = 1;                            |
|   Its own lines that use it                                        |
|   creatures/crab.js line 9   if (crab.energy < 30) {               |
| The agent said: "Energy is now a fraction from 0 to 1, so the      |
| hide threshold is 0.3."                                            |
+--------------------------------------------------------------------+
```

| State | When | Shows |
| --- | --- | --- |
| live | result `repair`, not resolved | red edge, title `headsup.title.repair`, cause line, one block per item (rule sentence of 5.6, before, after, own lines), dropped edits (`headsup.dropped`) |
| live | result `confirm`, not resolved | amber edge, title `headsup.title.confirm`, the same blocks. A blind spot has no "before". |
| live | result `info` | neutral edge, title `headsup.title.info`, the same blocks, `headsup.nothing_to_do` |
| stopped | resolved | edge in the `holds` colour, the statement under `headsup.said` |
| held | the attempt stopped before resolving it | `headsup.waits` |
| error | the event carries no diff (4.6, N1) | the rule sentence only, and `headsup.no_diff` |
| empty, loading | n/a | |

- **CO19.** Before and after are shown in the code type, at most 12 lines each, then `headsup.show_all`. Characters that differ between before and after are marked with an underline and a background, not with colour alone.

### 3.5 Live pool frame

Inputs: `pool.landed_commit`, `pool.landed_seq`, `pool.state`, `ViewState.pool_paused`.

Shows: a caption bar (`frame.main.caption`) with the buttons `frame.pause` and `frame.compare`, and one iframe.

- **CO20 (sandbox).** The iframe has `sandbox="allow-scripts"` and no other sandbox token, and the `title` of `frame.main.title` (`01-core.md` SE13). Its address is `frameUrl({ pool, repo: "main", commit: pool.landed_commit })` (4.5).
- **CO21 (advance).** When `pool.landed_commit` changes, the Floor waits `FRAME_ADVANCE_DEBOUNCE_MS` (so one batch gives one advance), then asks the app to load the new commit without restarting (needs N18). If the app does not confirm within `FRAME_ADVANCE_TIMEOUT_MS`, the Floor reloads the iframe at the new commit.
- **CO22 (messages).** The Floor accepts a message only when `event.source` is this iframe's window and the shape matches the schema of `01-core.md` SE16. A `tapped` message opens the Why card of the newest landing that wrote that creature's file (3.9).
- **CO23.** An accepted but not yet landed change never appears in the frame (FL3). While any landing is accepted and not landed, the caption bar shows `frame.landing`.

| State | When | Shows |
| --- | --- | --- |
| loading | no commit known yet, or the iframe has not finished loading | `frame.loading` over a still background |
| error | the iframe does not finish loading within `FRAME_LOAD_TIMEOUT_MS`, or reports an error | `frame.error` and the button `frame.reload`. Cards and counters keep working. |
| held | `ViewState.pool_paused` (the Pause button, or the reduced-motion default, 6.4) | the last drawn picture, `frame.paused`, button `frame.play` |
| stopped | pool state `paused` or `rebuilding` | the app keeps running the newest landed commit; caption adds `frame.pool_paused` |
| empty | `pool.landed_seq` is 0 | the seed pool; caption `frame.main.seed` |
| live | otherwise | the pool at the newest landed commit |

### 3.6 Plain-merge pool frame

Inputs: `plain` (4.1), `attempts` that landed after a go-around or a confirm.

Shown only in Compare view, beside the live pool frame, with the same sandbox and message rules (CO20, CO22; a `tapped` message is ignored).

- **CO24 (label).** The caption is always `plain.label` on the first line and `plain.constructed` on the second. Neither can be hidden.
- **CO25 (what differs).** Under the two frames, one line per landed change of kind `change` that had at least one heads-up of result `repair` or `confirm` before it landed: `plain.diff_line`. Then `plain.conflicts` with the count of changes the plain merge skipped. The list is computed from the stream only.

| State | When | Shows |
| --- | --- | --- |
| stopped | the build has no plain-merge pool (`features` in `/floor.json`, 4.5) | the Compare button is absent |
| loading | `plain` is null, or the iframe is loading | `plain.loading` |
| error | iframe time-out or error | `frame.error`, `frame.reload` |
| held | `plain.through_seq` is behind `pool.landed_seq` | the frame at its commit, caption adds `plain.behind` |
| empty | no landed change had a heads-up | both frames run; the list says `plain.same` |
| live | otherwise | the frame at `{ pool, repo: "plain", commit: plain.commit }`, the list of CO25 |

### 3.7 File tiles

Inputs: `files`.

One tile per file that exists at the newest landed commit, grouped by directory. A group starts with a label cell that carries the directory name. A tile shows the file name without its directory and extension, up to 5 reader marks (small rings) and up to 5 writer marks (small filled squares), then `tile.more_marks`. A held path carries the tag `tile.held`.

| State | When | Shows |
| --- | --- | --- |
| loading | no snapshot or event yet | grey cells, `tiles.loading` |
| empty | the file list is not known (4.6, N8) and nothing was read or written yet | `tiles.empty` |
| live | a file with no reader and no writer | name only |
| live | readers or writers present | marks; accessible name `tile.name` |
| live, just landed | a `landing.landed` changed the file | the tile edge glows for 2 s (6.4) |
| held | the path's tier is `held` | tag `tile.held` |
| stopped | a landing removed the file | the tile shows `tile.removed` for 2 s, then leaves |
| error | n/a | |

- **CO26.** A reader mark is one attempt in flight with a premise of kind `entity`, `file` or `query outline:` on the file with `read` true. A writer mark is one attempt in flight with a current operation on the file. A listing premise or a text search over a directory puts one reader mark on the group label.
- **CO27.** Tapping a tile opens the Who relies panel for the file (3.11).
- **CO28.** When there are more files than cells, the last cell is `tiles.more` and opens the full list.

### 3.8 Strip (run clock and counters)

Inputs: `pool`, `counters`, `metrics`, `green`, `limits`.

| Cell | Value | Source |
| --- | --- | --- |
| Run clock | `hh:mm:ss` | stream clock minus the `t` of the first `intent.created` |
| `strip.agents` | `{n} of {max}` and `strip.agents.limit` | `pool.real_agents`, `pool.max_real_agents` |
| `strip.landed` | count | `landing.landed` events whose landing is of kind `change` |
| `strip.goarounds` | count | `attempt.state` events with `to = going_around` and `from` not `going_around` |
| `strip.waiting` | count | `metrics.waiting_behind`; `strip.waiting.backlog` appears when `metrics.push_backlog` is above 0 |
| `strip.green` | `green.at`, `green.static`, `green.red` or `green.none` | `green.verified`, `green.advanced` |
| `strip.spend` | `spend.value` and a bar | `limits` (3.18) |

| State | When | Shows |
| --- | --- | --- |
| loading | before the first event | every value is `strip.dash` |
| empty | a cell whose source event has not arrived | `strip.dash` in that cell |
| live | otherwise | values |
| held | pool state `paused` or `rebuilding` | values frozen, cell labels unchanged; the banner explains |
| error | connection lost | values dimmed, `strip.stale` (CO3) |
| stopped | Replay ended | the final values of the recording |

- **CO29.** Numbers use tabular figures and do not change width when they change value. A counter that changes is underlined for 1 s; it does not flash.
- **CO30.** In a synthetic pool `strip.agents` reads `strip.agents.synthetic` and the limit line is absent.

### 3.9 Why card

Inputs: one `LandingView`, its attempt and intent, `LandingView.note`.

Opened by: tapping a creature in the live pool frame, a row of the Landed tab, a landing number anywhere, or the tile menu. It is the record of one landing (2.5).

Sections, in order: `why.asked` (requester, tag, the intent text in quotes), `why.wrote` (real or synthetic, model), `why.relied` (frozen lights with `keyLabel` and flags), `why.under` (each go-around and confirm: cause, rule sentence, the agent's statement), `why.checked` (count; the list on tap), `why.landed_how` (by itself, or approved by the owner with the time; Clef risk lines when present), `why.changed` (paths and entities written), buttons `why.git`, `who.open`, `undo.open`.

| State | When | Shows |
| --- | --- | --- |
| empty | the tapped thing has no landing after the seed | `why.seed` |
| held | the landing is accepted and not landed | `why.landing` and nothing else (FL3) |
| loading | the landing is older than `UI_DETAIL_WINDOW` and its record is being fetched (live mode) | `why.loading` |
| error | the record cannot be loaded, or Replay has no record for it | the fields the stream gave, then `why.partial` |
| stopped | `LandingView.undone_by` is set | the full card under the notice `why.undone` |
| live | otherwise | the full card |

- **CO31.** A landing of kind `undo` or `revert` has a Why card too: title `why.undo.title`, what it took back, which attempts reopened, which readers were kept.
- **CO32.** Every sentence on the Why card is built from the stream or from the note. The page adds no judgment of its own.

### 3.10 "Show the git" drawer

Inputs: `LandingView` (commit, tree, note; the parent is the commit of the landing before it), `pool.remote` (needs N17).

Shows, in order: `git.commit_is`, the commit id, parent and tree in full, the commit message as git stores it (summary, `Intent:` line, `Change-Id` and `Intent-Id` trailers; `Undoes:` lines for an undo), `git.note_is`, the note as indented JSON, `git.read_yourself` with the two commands of `01-core.md` 3.5 and, when a clone address is known, the clone command. Every id and command has a `git.copy` button.

| State | When | Shows |
| --- | --- | --- |
| live | the note is in `LandingView.note` | everything |
| loading | live mode, the note is being fetched (4.5) | commit lines, `git.loading_note` |
| error | the note cannot be fetched, or Replay has no note | commit lines, `git.no_note`, the two commands |
| held | no clone address is known | everything except the clone command, and `git.no_clone` |
| empty, stopped | n/a | |

- **CO33.** The drawer shows the note text exactly as stored, re-indented only. It never rewrites or shortens it.

### 3.11 Who relies

Inputs: `files`, `attempts`, `landings`, the chosen key.

Opened by: `who.open` on a light, a Why card or a held card; or a tile (then the panel first lists the keys known for that file: every entity key of that path that appears in any premise or write in `FloorState`, and the file itself).

Shows: the title `who.title` with `keyLabel`, then two lists (`01-core.md` 11.6): `who.in_flight` (attempts with a premise `entity:K` or `file:<path of K>`, each with its flags and status word) and `who.landed` (landed, not undone changes with such a frozen premise, each opening its Why card). While the panel is open, the matching cards, lights and tiles are outlined, and the matching creatures are outlined in the pool frame (needs N18).

| State | When | Shows |
| --- | --- | --- |
| empty | no attempt and no landing matches | `who.none` |
| live | otherwise | the two lists with counts |
| held | landings older than `UI_DETAIL_WINDOW` exist | the lists, then `who.window` |
| loading, error, stopped | n/a (computed from `FloorState`) | |

### 3.12 Undo

Inputs: the target `LandingView`, the undo plan (a request, 4.5), `undo` in `FloorState`.

The button `undo.open` is on the Why card of a landing of kind `change` (`01-core.md` 11.3).

| State | When | Shows |
| --- | --- | --- |
| held | visitor or Replay | no button |
| held | the landing is already undone | button absent; the Why card says `why.undone` |
| held | the landing is older than `UNDO_WINDOW` landings | button disabled with `undo.too_old` |
| loading | the plan is being fetched | sheet with `undo.planning` |
| live | the plan arrived | sheet: `undo.title`, `undo.also` (the other landings in the plan), `undo.kept` (kept readers), `undo.in_flight` (attempts in flight that get a heads-up), buttons `undo.confirm` and `undo.cancel` |
| error | the plan was refused, or the request failed | `undo.refused` with the reason sentence (5.9); nothing changed |
| live | `undo.planned` arrived, its landing is not yet landed | undo row in the Landed tab: `undo.landing` |
| stopped | the undo landing landed | undo row: `undo.done`; reopened cards are back in the Working tab (CO13) |
| empty | n/a | |

- **CO34.** An undo or revert that the owner did not start in this browser (another session, the green line, Replay) shows the same row from `undo.planned`, so the page reads the same for everyone.

### 3.13 Held-change card

Inputs: one `CardView` of kind `held`, its attempt, the two frame addresses.

It appears as a row in the tray (title and the button `card.open`) and as the card sheet (2.4). The sheet shows: title and body of the card (5.10), the intent, the frames `held.before` and `held.after`, `held.changes` (paths with tier tags, entities), `held.affects` (the blast radius sentences of 5.10; `held.relied_inflight`, computed live from the stream with `whoRelies` over the keys the change alters; `held.relied_landed`), `held.checked` (checks, lights, blind spots confirmed, Clef risk lines), an optional reason field, and the buttons `held.land` and `held.decline`.

| State | When | Shows |
| --- | --- | --- |
| loading | a frame is loading | `frame.loading` in that frame |
| loading | `card.risk` is null and Clef risk is on | `held.risk_waiting` in place of the risk lines |
| live | card open, owner | buttons enabled |
| held | card open, visitor | no buttons; `held.visitor` |
| error | a frame failed | `frame.error` in that frame; the buttons stay enabled |
| error | `card.risk.error` is set | `held.risk_unavailable` |
| error | the action request failed | the error sentence (5.9); the card stays open |
| stopped | closed by the system as `stale` | `held.stale`; buttons disabled; the sheet closes after `STALE_CARD_MS` |
| stopped | closed by the owner | `held.closed.land` or `held.closed.decline`; the sheet closes after 1.5 s |
| empty | n/a | |

- **CO35.** The blast radius shown is the one in the newest `card.opened` or `card.updated`. The Land request carries the `submit_id` on screen, so an approval cannot apply to a later version (`01-core.md` 10.2).
- **CO36.** "After" shows the attempt's preview. In Replay, or when the address cannot be resolved, the frame shows `held.no_preview` (4.6, N4).
- **CO37.** Land is the primary button. Decline never needs a reason. Esc closes the sheet and does nothing else.

A `choice` card uses the same tray row and sheet without frames: title, at most two sentences, and the buttons of its options (5.10). Its states are live, held (visitor), error and stopped, as above.

### 3.14 Race and choose

Inputs: one `CardView` of kind `race`, its attempts.

In the rail, the race is one group: the intent text, `race.group`, and one compact row per candidate. In the tray it is one row. The sheet (2.4) has one column per candidate: frame, model, lights, checks, `race.took`, `race.cost`, `race.blast`, and the button `race.choose`.

| Candidate state | When | Column shows |
| --- | --- | --- |
| loading | the attempt is not yet `held` | `race.working` with its status word and step count, no frame |
| live | `held` on this card | frame of its preview, facts, `race.choose` |
| error | its frame failed | `frame.error`; facts and button stay |
| stopped | the attempt stopped | `race.stopped` with the stop sentence |
| stopped | another candidate was chosen | `status.not_chosen` |
| stopped | this candidate was chosen | `race.chosen`, then its landing states; the sheet shows `race.closed` and closes after 1.5 s |
| held | visitor | no button |
| empty | n/a | |

- **CO38.** The card can be answered as soon as one candidate is `held`. The card title says how many are ready (5.10).
- **CO39.** A value the stream does not carry is shown as `race.unknown`, never as zero (cost needs N9; the blast radius of each candidate needs N10).
- **CO40.** After the choice, the group stays in the Working tab until the chosen attempt lands; then the whole group moves to the Landed tab with the two other rows marked `status.not_chosen`.

### 3.15 Swarm wall with metrics

Inputs: `swarm`, `metrics`, `metrics_history`, `attempts` of the synthetic pool, `last_push`.

Shows (2.6): the SYNTHETIC banner; four large numbers (`swarm.lps` with a small chart of the last 60 s from `metrics_history`, `swarm.ttl`, `swarm.gar`, `swarm.waiting`); four small ones (`swarm.false_abort`, `swarm.escape`, `swarm.backlog`, `swarm.last_push`); the wall; the controls (`swarm.agents`, `swarm.dial`, `swarm.start`, `swarm.stop`); the lines `swarm.real_limit` and `swarm.shape`.

- **CO41 (wall).** One cell per scripted agent, drawn on one canvas. Cell state: working (outline), going around (diamond in the `changed` colour), landing (half fill), landed (fill in the `holds` colour for 1 s, then outline again for the agent's next change), stopped (cross). The wall redraws at most `WALL_FPS` times per second. Cell size is chosen so that all agents fit.
- **CO42 (numbers).** Each number shows its window (`swarm.window`) and comes from the newest `metrics` event of the synthetic pool. A null value shows `strip.dash`. Rates are whole percents. The page computes no rate that the stream does not define (`01-core.md` section 14).
- **CO43.** Repair latency is not shown on the wall. The line `swarm.repair_note` says it is measured with real agents only (`01-core.md` 14.7).
- **CO44.** The SYNTHETIC banner is present whenever this view shows a pool, running or not, and in every other view of a synthetic pool.

| State | When | Shows |
| --- | --- | --- |
| empty | no `swarm.state` yet | `swarm.empty`, controls (owner) |
| loading | `swarm.running` and no synthetic attempt yet | `swarm.starting` |
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
| error | too many tries (`429`) | `owner.wait` |
| stopped | a request answers `401` while the page believed it was the owner | toast `owner.expired`; the header returns to `owner.visitor`; the dialog opens |
| empty | n/a | |

- **CO45.** The key is typed or pasted into the field only. It is never put in an address, never shown, never stored by the page, and never written to the console. The page sends it only in the body of `POST /api/session` on its own origin. The field has `autocomplete="current-password"` so a password manager can fill it.
- **CO46.** In Replay the header shows `owner.replay` and the dialog cannot open.

### 3.18 Kill switch, spend indicator and banners

Inputs: `limits`, `pool`, `ViewState.connection`.

**Spend indicator** (strip): `spend.value` and a bar. The bar's fill is `spend_usd / cap_usd`.

| State | When | Shows |
| --- | --- | --- |
| empty | no `limits` event yet | `spend.unknown` |
| live | below `SPEND_NEAR_SHARE` of the cap | value and bar in the neutral colour |
| held | at or above `SPEND_NEAR_SHARE` | value and bar in the `confirm` colour, `spend.near` |
| stopped | the cap is reached (7, row F8) | value and bar in the `changed` colour, `spend.reached`, and the banner `banner.cap` |
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
- **CO48.** The page shows agents as stopped only from events (`limits.killed`, `attempt.state`), never from the request's success alone.

**Banners**, in this fixed order from the top. Each has a word in capitals, a sentence, and at most one button.

| # | Banner | When | Colour and pattern |
| --- | --- | --- | --- |
| 1 | `banner.synthetic` | the pool or the recording is synthetic, or any attempt on screen is synthetic | `synthetic` with diagonal stripes |
| 2 | `banner.replay` | Replay | inverse (text colour as background) with a dotted edge |
| 3 | `banner.killed` | `limits.killed` | `changed` |
| 4 | `banner.paused.*` | pool state `paused` | `changed` |
| 5 | `banner.rebuilding` | pool state `rebuilding` | `confirm` |
| 6 | `banner.cap` | the cap is reached | `changed` |
| 7 | `banner.push` | a push has been pending longer than `PUSH_STALL_MS` | `confirm` |
| 8 | `banner.green_red` | the newest `green.verified` failed and its revert has not landed | `confirm` |
| 9 | `banner.offline` | the connection is lost | `confirm` |

- **CO49.** Banners 1 and 2 cannot be closed. The others leave only when their condition ends.
- **CO50.** At most three banners are drawn. Banners 1 and 2 always are; of the rest, the first by number. The others are counted in `banner.more`, which opens the list.

### 3.19 Other parts

| Part | Content | States |
| --- | --- | --- |
| View switch | `nav.floor`, `nav.swarm`, `nav.replay`, `nav.about` | the current view is marked with an underline and `aria-current` |
| Needs-you badge | `needs.badge` with the number of open cards | absent at 0; opens the oldest open card |
| Tray | one row per open card, oldest first | empty: absent |
| Tabs | `rail.tab.working`, `rail.tab.landed`, `rail.tab.stopped` with counts | empty texts `rail.empty.*` |
| Landed tab | one row per landing, newest first: number, kind, change name, time; undo rows (3.12) | opens the Why card |
| About sheet | three columns: `about.how` (a fixed diagram), `about.run` (counts from the stream: real agents at most, models used, landings, go-arounds, scripted agents, spend), `about.limits` (the limits list) and `about.related` | the limits list is built from the same file as the README's limits section |
| Toasts | one sentence, bottom left, for `TOAST_MS`; at most 3 | every toast is also sent to the screen-reader log |
| Shortcut list | key `?` | 6.6 |

---

## 4. From events to what is on screen

### 4.1 `FloorState` (the reducer's output)

The reducer lives in the shared `protocol` module (`01-core.md` EV5). This is the shape the Floor needs from it. Types not defined here (`Card`, `Check`, `Note`, `PremiseKind`, `AttemptState`, `HeadsUp`, `Diff`) are those of `01-core.md`.

```ts
type FloorState = {
  n: number;                                  // last event applied; 0 before any
  t: number;                                  // t of that event
  first_intent_t: number | null;              // start of the run clock
  unknown_events: number;                     // events whose type the reducer does not know (ignored)

  pool: {
    id: string;
    state: "unknown" | "ready" | "rebuilding" | "paused";
    reason: string | null;                    // pause reason
    synthetic: boolean;
    head_seq: number;                         // last accepted landing
    landed_seq: number;                       // last landing confirmed on main
    landed_commit: string | null;             // commit the live pool frame shows
    real_agents: number;
    max_real_agents: number;
    remote: string | null;                    // clone address without credentials, when the stream carries it (N17)
  };

  intents: Record<string, {
    id: string; text: string; requester: string; race: boolean; prewritten: boolean;
    state: "open" | "landed" | "stopped" | "undone"; created_t: number; attempt_ids: string[];
  }>;

  attempts: Record<string, AttemptView>;
  working_order: string[];                    // attempt ids in rail order (CO9)

  landings: Record<number, LandingView>;      // the newest UI_DETAIL_WINDOW landings in full; older ones as digests
  landed_order: number[];                     // seqs, newest first

  cards: Record<string, CardView>;
  open_cards: string[];                       // card ids, oldest first

  files: Record<string, {
    path: string; exists: boolean; tier: "auto" | "held" | null;
    readers: string[]; writers: string[];     // attempt ids in flight
    last_landed_seq: number | null; keys: string[];   // entity keys of this path seen in premises or writes
  }>;
  dirs: Record<string, { readers: string[] }>;         // listing and directory-search readers

  push: { batch_id: number; first_accepted_t: number; tries: number;
          error: string | null; next_try_t: number | null } | null;   // null when nothing is unpushed
  last_push: { batch_id: number; landings: number; tries: number; ms: number } | null;

  green: { seq: number | null; commit: string | null;
           runtime: "browser" | "isolate" | "container" | "static" | null;
           last: { seq: number; ok: boolean; failed_checks: string[] } | null };

  plain: { commit: string; through_seq: number; skipped: number[] } | null;   // N2

  limits: { spend_usd: number; cap_usd: number; killed: boolean; cap_reached: boolean;
            models: Array<{ model: string; per_minute: number; used_last_minute: number }> } | null;

  metrics: MetricsEvent | null;               // newest `metrics` event (the `metrics` member of PoolEvent)
  metrics_history: Array<{ t: number; landings_per_second: number; go_around_rate: number | null }>;  // last 60 s

  swarm: { running: boolean; agents: number; collision_dial: number; ever_ran: boolean } | null;

  undo: Record<string, { request_id: string; cause: "undo" | "revert"; target_seq: number;
                         reverted: number[]; reopened: string[]; kept_readers: number[];
                         landing_seq: number | null }>;

  counters: { landed_changes: number; go_arounds: number };
};

type AttemptView = {
  id: string; intent_id: string; change_id: string;
  agent: "real" | "synthetic"; model: string | null; race: boolean;
  state: AttemptState; stop_reason: string | null;
  go_arounds: number; right_of_way: boolean;
  revision: number; reopened_by: "undo" | "revert" | "retry" | null; model_changed: boolean;
  opened_t: number; last_event_t: number;
  step: { n: number; tool: string | null; target: string | null; ok: boolean; error: string | null; t: number } | null;
  steps: number;
  premises: Record<string, PremiseView>;      // key = kind + " " + key
  ops: Array<{ op_seq: number; op: "write" | "replace"; path: string; dropped: boolean;
               altered: string[]; added: string[]; removed: string[] }>;
  heads_ups: Record<number, HeadsUpView>;
  submit: { submit_id: string | null; status: string; tier: "auto" | "held" | null;
            checks: Check[]; errors: string[]; t: number } | null;
  first_valid_submit_t: number | null;        // for "time taken"
  skipped: { why: "not_disjoint" | "right_of_way"; behind: string | null } | null;
  card_id: string | null;
  approved_t: number | null;                  // set when the owner lands or chooses it on a card
  landed_seq: number | null;                  // set by landing.accepted; "Landed" needs LandingView.landed
  cost_usd: number | null;                    // N9
};

type PremiseView = {
  kind: PremiseKind; key: string;
  read: boolean; edit: boolean; derived: boolean;
  light: "holds" | "changed" | "confirm" | "blind_spot" | "checking";
  judgment: { rule: string; reason: string; cause_seq: number | null;
              clef: { model: string; p: number | null; error: string | null } | null } | null;   // newest
};

type HeadsUpView = {
  hn: number; result: "info" | "confirm" | "repair"; t: number;
  cause: HeadsUp["cause"]; go_around: number | null;
  keys: Array<{ kind: PremiseKind; key: string; rule: string }>;
  items: Array<{ kind: PremiseKind; key: string; rule: string; diff: Diff;
                 uses: Array<{ path: string; entity: string; line: number; text: string }> }> | null;  // N1
  dropped: Array<{ path: string; rule: string }>;
  resolved: { statement: string; t: number } | null;
};

type LandingView = {
  seq: number; kind: "change" | "undo" | "revert"; batch_id: number;
  attempt_id: string | null; change_id: string; intent_id: string | null;
  paths: string[]; writes: Note["writes"];
  accepted_t: number;
  landed: { commit: string; tree: string; note_id: string; t: number; time_to_land_ms: number | null } | null;
  undone_by: number | null;
  premises: PremiseView[];                    // frozen at acceptance, lights as they were (all hold)
  go_arounds: HeadsUpView[];                  // resolved heads-ups of result repair
  confirms: HeadsUpView[];                    // resolved heads-ups of result confirm
  checks: Check[]; tier: "auto" | "held" | null;
  approved: { by: "owner"; t: number } | null;
  risk: RiskAnswers | null;
  note: Note | null;                          // N3
};

type CardView = { card: Card; open: boolean; opened_t: number;
                  closed: { action: string; by: "owner" | "system"; reason: string | null; t: number } | null };
```

- **FE1.** The reducer is total: every event leaves a valid `FloorState`. An event of unknown type changes only `n`, `t` and `unknown_events`.
- **FE2.** The reducer never reads a clock and never performs a request.
- **FE3.** Applying the same events gives the same `FloorState`, in live mode, after a snapshot join and in Replay. A test replays one recorded file through all three paths and compares.
- **FE4.** For a synthetic pool the reducer keeps, per attempt, only the fields the wall needs (`state`, `go_arounds`, `landed_seq`) and drops premises, operations and heads-ups, so memory does not grow with the number of scripted agents.
- **FE7 (one state per pool).** The page keeps one `FloorState` per pool it shows, each from its own stream: the main pool and the Swarm pool (both named in `/floor.json`). Floor view, Compare view and the sheets draw the main pool. Swarm view draws the Swarm pool, and opens its stream when the view is first opened. The spend cell, the kill switch and banners 3 and 6 use the newest `limits` event of either stream.

### 4.2 `ViewState` (local, never from the stream, never sent anywhere)

| Field | Values |
| --- | --- |
| `view` | `floor`, `compare`, `swarm` |
| `mode` | `live`, `replay` |
| `sheet` | none, a card id, a Why card (landing seq), Who relies (key), undo (target seq), About, owner dialog, kill dialog, shortcut list |
| `git_drawer` | open or closed |
| `tab` | `working`, `landed`, `stopped` |
| `expanded` | attempt ids the owner expanded; heads-up panels open by CO11 |
| `draft` | the text in the intent box |
| `pending` | requests in flight, by `request_id` |
| `owner` | whether this browser holds the owner session |
| `connection` | `connecting`, `open`, `lost` with the try count |
| `pool_paused` | whether the viewer paused the pool frames |
| `theme`, `size`, `shortcuts` | `dark` or `light`; `stage` or `laptop`; on or off |
| `replay` | recording id, position (event index), playing, speed, load progress, error |
| `toasts` | up to 3 |

### 4.3 Each event type and what it changes

Every event type of `01-core.md` 12.1 has one row. "State" is the change to `FloorState`. "Seen" is what a person notices. "Said" is the screen-reader log line (5.13); "none" means the event is not announced.

| Event | State | Seen | Said |
| --- | --- | --- | --- |
| `pool.state` | Sets `pool.state`, `reason`, `synthetic`, `head_seq`, `real_agents`, `max_real_agents`. On the first event of a stream also sets `landed_seq` and `landed_commit` from it. | Strip: real agents. Banners 1, 4, 5 appear or leave. The intent box changes state. | `sr.pool_state` when `state` changed |
| `pool.paused` | `pool.state = paused`, `pool.reason` | Banner 4 with the sentence for the reason (7). | `sr.paused` (urgent) |
| `intent.created` | Adds the intent. | A new group in the Working tab with `status.opened`. The draft is cleared when the id matches (CO8). Starts the run clock if it is the first. | `sr.intent` |
| `intent.state` | Sets the intent's state. | `undone`: tag on its rows. `stopped`: the group moves to the Stopped tab once all its attempts are stopped. | none |
| `attempt.opened` | Adds the attempt with state `opened`; links it to its intent. | A card (or a race row) with model name and tags. In a synthetic pool: one wall cell. | none |
| `attempt.state` | Sets `state`, `go_arounds`, `right_of_way`; `stop_reason` when `to = stopped`. Clears `skipped`. `counters.go_arounds += 1` when `to = going_around` and `from` is not `going_around`. Reorders `working_order` (CO9). | The status word and shape change. Entering `going_around` or `needs_confirm` moves the card to the top group. `stopped` moves it to the Stopped tab. `landed` shows "Landed" only if the landing's `landing.landed` has arrived; otherwise "Landing…" (FL3). | `sr.state` for `going_around`, `needs_confirm`, `held`, `stopped` |
| `attempt.reopened` | Sets `revision`, `reopened_by`, `model_changed`. For cause `undo` or `revert`: reloads `premises` and `ops` from the attempt's `LandingView` and removes `landed_seq`. All lights are `holds` until judged; resolved heads-ups move under `card.earlier`. | The card returns to the Working tab with `card.tag.reopened`; `card.model_changed` when true. | `sr.reopened` |
| `attempt.step` | Sets `step`, `steps`, `last_event_t`. | The activity line (5.5). A failed step shows its error sentence (7, F2). | none |
| `premise.recorded` | Inserts or updates the premise (flags from the event). A new premise has light `holds`. Updates `files[path].readers` or `dirs[dir].readers` when `read` is true, and `files[path].keys`. | A new light on the card. A reader mark on the tile or group label. | none |
| `premise.judged` | Sets `judgment`. Light: `result = repair` gives `changed`; `result = confirm` with rule `B1` gives `blind_spot`; other `confirm` gives `confirm`; `result = null` gives `checking`; `result = holds` gives `holds`. Rules `E4`, `F7`, `QR3` remove the premise. | The light changes shape and colour, with one ring pulse (6.4). The expanded list shows the judgment sentence (5.6) and, for triage, the Clef share. | none (the heads-up is announced) |
| `op.recorded` | Appends to `ops`. Adds the attempt to `files[path].writers`. Adds `altered`, `added`, `removed` keys to `files[path].keys`. | A writer mark on the tile. "What it changes" in the expanded card. | none |
| `op.dropped` | Marks the listed operations dropped. Removes the writer mark if no current operation on the path remains. | `headsup.dropped` line in the heads-up panel; the writer mark leaves. | none |
| `headsup.sent` | Adds the `HeadsUpView` (with `items` when present, N1). A premise in its `keys` whose light is still `checking` takes the light of the heads-up's result: `repair` gives `changed`, `confirm` gives `confirm`, `info` gives `holds` (until N5). | `repair`: red-edged panel, opens by itself (CO11). `confirm`: amber-edged panel, opens by itself. `info`: a neutral line on the card, panel closed. | `sr.headsup` |
| `headsup.resolved` | Sets `resolved`. Every premise in that heads-up's `keys` whose light is `changed`, `confirm` or `blind_spot` returns to `holds`. | The panel edge turns to the `holds` colour and shows the agent's statement. Lights turn back to circles. | `sr.resolved` |
| `submit.result` | Sets `submit` (ignored when `duplicate` is true). Sets `first_valid_submit_t` on the first `validated`, `submitted` or `held`. | Line 4 of the card: the submit sentence (5.7). Checks in the expanded card. A rejected submit shows 7, F3. | none |
| `card.opened` | Adds the card; appends to `open_cards`; sets `card_id` on its attempts. | A tray row. The header badge count rises. The attempt shows `status.held`. | `sr.card` (urgent) |
| `card.updated` | Replaces the `Card`. | The open sheet updates in place: risk lines arrive, the blast radius changes. No layout jump: the risk area has a fixed height. | none |
| `card.closed` | `open = false`, sets `closed`; removes from `open_cards`. For a card closed by the owner with action `land`, or a race card closed with an attempt id, sets `approved_t` on that attempt. | The tray row leaves. An open sheet shows its closing state (3.13, 3.14) and then closes. | `sr.card_closed` |
| `landing.accepted` | Adds the `LandingView` (frozen premises, heads-ups, checks, tier, risk copied from the attempt). Sets the attempt's `landed_seq`. `pool.head_seq = seq`. Starts `push` if null. | The card shows `status.accepted`. The caption bar shows `frame.landing`. Nothing else: no counter, no tile glow, no frame change (FL3). | none |
| `landing.landed` | Sets `landed`. `pool.landed_seq`, `pool.landed_commit`. `counters.landed_changes += 1` for kind `change`. Updates `files` from `writes` (created and removed files) and `last_landed_seq`. For kind `undo` or `revert`: sets `undone_by` on the reverted landings and `undo[...].landing_seq`. | "Landed" on the card, then the move to the Landed tab (CO12). The Landed counter. The pool frame advances (CO21). Tiles of the paths glow. The Why card becomes available. A landing of kind `revert` removes banner 8. | `sr.landed` |
| `batch.pushed` | `push = null`. Sets `last_push`. | Banner 7 leaves. `frame.landing` leaves. Swarm view: `swarm.last_push`. | none |
| `push.retry` | Sets `push.tries`, `push.error`, `push.next_try_t`. | Cards of the batch keep "Landing…". After `PUSH_STALL_MS`, banner 7 with the try count and a countdown (7, F5 and F6). | `sr.push` once per batch |
| `tick.skipped` | Sets `skipped` on the attempt. | Line 4 of the card: the skip sentence (5.6). | none |
| `undo.planned` | Adds the `undo` entry. | An undo row in the Landed tab: `undo.landing` or, for cause `revert`, `revert.landing`. | `sr.undo` |
| `green.verified` | Sets `green.runtime` and `green.last`. | Strip: `green.static` when the runtime is `static`. A failed check gives banner 8 (7, F19). | `sr.green_red` when not ok (urgent) |
| `green.advanced` | Sets `green.seq`, `green.commit`. | Strip: `green.at`. | none |
| `metrics` | Sets `metrics`; appends to `metrics_history`. | Strip: waiting. Swarm view: every number and the small chart. | none |
| `limits` | Sets `limits`. `cap_reached` follows 7, F8. | Strip: spend. Banners 3 and 6. The intent box and the kill switch change state. | `sr.killed` or `sr.cap` on change (urgent) |
| `swarm.state` | Sets `swarm`; `ever_ran` once `running` was true. | Banner 1 text (agent count). Swarm controls. | `sr.swarm` on start and stop |

Events proposed in 4.6, when they exist:

| Event | State | Seen |
| --- | --- | --- |
| `plain.updated` (N2) | Sets `plain`. | The plain-merge frame advances (as CO21). `plain.conflicts` and `plain.behind` update. |
| `pool.files` (N8) | Sets `files[path].exists` and `tier` for every path. | All tiles from the start; `tile.held` tags. |
| `premise.removed` (N6) | Removes the premise and its reader mark. | The light leaves. |
| `attempt.repo` (N12) | Counts provisioned and failed attempt repos. | `about.forks`. |

### 4.4 Derived values

Pure functions of `FloorState` and the clock. Each has a unit test.

| Name | Definition |
| --- | --- |
| `runClock` | `clock − first_intent_t`, or `00:00:00` when null. |
| `quietFor(attempt)` | `clock − attempt.last_event_t`, for attempts in `working`, `going_around`, `needs_confirm`. |
| `changeName(attempt)` | 5.2. |
| `lightsInOrder(attempt)` | CO14. |
| `whoRelies(key)` | `01-core.md` 11.6 over `attempts` (in flight) and `landings` (not undone). |
| `whyTarget(path)` | The newest landed, not undone landing whose `paths` contain `path`; none means the seed. |
| `plainDiffers` | Landed landings of kind `change` whose `go_arounds` or `confirms` is not empty (CO25). |
| `pushStalled` | `push != null` and `clock − push.first_accepted_t > PUSH_STALL_MS`. |
| `timeTaken(attempt)` | `first_valid_submit_t − opened_t`. |
| `repairLatency` | `01-core.md` 14.7, real agents only: for each resolved go-around, the `t` of the next `submit.result` with status `validated` minus the `t` of its `headsup.sent`. Shown in About, never on the wall. |
| `chapters(events)` | 8.5. |

### 4.5 Requests the Floor makes

The stream is the only source of pool facts. These requests exist for actions, for static files, and for three reads that a recording cannot hold. `01-core.md` names most of them only by purpose (SE3, 13.2); the paths below are the Floor's proposal and need to be fixed in the `protocol` module (N16).

| Purpose | Method and path (proposed) | Who | Notes |
| --- | --- | --- | --- |
| The page and its assets | `GET /` | anyone | Static assets of the Worker. Every view is a client route of this one page. |
| Static settings | `GET /floor.json` | anyone | *(Floor)* default pool id, Swarm pool id, which SHOULD features are in the build, pre-written requests (`{ id, text, group, race }`), model short names, the limits list, related work. |
| Event stream | WebSocket `GET /api/pools/{pool}/stream` | anyone | Protocol of `01-core.md` 12.2: `{ hello: 1, after: n }`, then a snapshot or event frames. |
| Session state | `GET /api/session` | anyone | Answers whether this browser is the owner. The cookie is HttpOnly, so the page cannot know otherwise. |
| Unlock | `POST /api/session` | anyone with the key | `01-core.md` SE2. |
| Lock | `DELETE /api/session` | owner | Clears the cookie. |
| Create intent | `POST /api/pools/{pool}/intents` | owner | `{ text, race, prewritten, request_id }`. Answers the `intent_id`. |
| Card action | `POST /api/pools/{pool}/cards/{card_id}` | owner | `{ option, submit_ids, reason, request_id }`. |
| Undo plan | `GET /api/pools/{pool}/undo-plan?seq={seq}` | anyone | The plan of `01-core.md` UN4: reverted, reopened, kept readers, attempts in flight that get `repair`. |
| Undo | `POST /api/pools/{pool}/undo` | owner | `{ seq, request_id }`. |
| Stop one agent | `POST /api/pools/{pool}/attempts/{attempt_id}/stop` | owner | Needs N19. |
| Swarm | `POST /api/swarm` | owner | `{ running, agents, collision_dial, request_id }`. |
| Kill switch | `POST /api/kill` | owner | `01-core.md` SE10, SE11: `{ killed, landings }`. |
| Rebuild | `POST /api/pools/{pool}/rebuild` | owner | `01-core.md` LP8. |
| One landing's note | `GET /api/pools/{pool}/landings/{seq}/note` | anyone | Live mode only, when the stream did not carry the note (N3). |
| Recordings | `GET /replay/index.json`, `GET /replay/{id}.ndjson` | anyone | Section 8. |
| Export a recording | `GET /api/pools/{pool}/replay.ndjson` | owner | The Floor Durable Object's events in the format of `01-core.md` 12.3. |
| Pool frames | `frameUrl(address)` | anyone | Served by the app server (the tide pool specification). The Floor needs `FrameAddress = { pool: string; repo: "main" or "plain"; commit: string }` or `{ pool: string; live_attempt: string }`. The first form is immutable and works in Replay. The second is Trunk's live preview of an attempt and works only in live mode. |

- **FE5.** No request other than these is made. In Replay only `GET /floor.json`, the recordings and pool frames are requested.
- **FE6.** A failed request never changes what the page shows as pool state. It produces an error sentence (5.9) next to the control that sent it.

### 4.6 What the Floor needs that `01-core.md` does not define

Each row names a missing or unclear part of the stream or of the interfaces, why a beat needs it, a proposed shape, and what the page does until it exists. None of these is decided here; they are requests to the core.

| # | Needed | For | Proposed | Until then |
| --- | --- | --- | --- | --- |
| N1 | The diff in the stream. `headsup.sent` carries `keys` only: no before and after, no own lines, no dropped operations. | Beat 3, the product's central moment; Replay. | Add `items: Array<{ kind, key, rule, result, diff: Diff, uses }>` and `dropped_ops` to `headsup.sent` (the fields of `HeadsUp`, `01-core.md` 8.2). | The panel shows the rule sentence and `headsup.no_diff`. |
| N2 | An event for the plain-merge pool. 11.7 defines the pool; no event says that it moved, where it is, or how many changes were skipped. | Beats 0 and 4; Compare view. | `plain.updated { commit, through_seq, skipped: number[] }`, emitted after each push of the plain-merge repo. | Compare view cannot address the frame. The Compare button is absent. |
| N3 | The landing's record. `landing.landed.note` is one string (blob id or JSON is not stated). The submit `summary`, the attempt's totals and the attempt repo are in no event. | Why card, git drawer, Replay. | State that `note` is the blob id, and add `note_json: string` to `landing.landed` for real pools (not for synthetic pools). | Live: the note is fetched on demand (4.5). Replay: the Why card is built from the stream and says `why.partial`; the drawer says `git.no_note`. |
| N4 | Frame addresses. A card carries no address for "before" and "after". An attempt's preview is live Trunk state and cannot be replayed. | Held card, Race, Replay. | `Card.preview: { before: FrameAddress; after: Record<attempt_id, FrameAddress> }`. Options for "after", not chosen here: (a) when the card opens, Trunk pushes the preview tree as a commit to the plain-merge repo, off the landing path, so the address is `{ pool, repo: "plain", commit }`; (b) live only, `{ pool, live_attempt }`. | Live: "before" is `main` at `pool.landed_commit`, "after" is `{ pool, live_attempt }`. Replay: `held.no_preview`. |
| N5 | The outcome of a triage. 7.5 says one `premise.judged` per classified premise; the event with `result: null` is the pending one. | "Being checked" lights must resolve; the Clef share on the card. | Emit a second `premise.judged` for the same key when the triage resolves, with `result` and `clef` filled. | The light stays `checking` until the heads-up for it arrives; then it follows the heads-up's result. |
| N6 | Removal of a premise (rows E4, F7, QR3, and rule D2 at an operation). | Lights and reader marks that should leave. | `premise.removed { attempt_id, kind, key, rule }`. | Rules E4, F7, QR3 in `premise.judged` remove it; D2 removals are not seen and the light stays `holds`. |
| N7 | Whether `premise.recorded` is also emitted when only a flag changes (TA7: `edit`, `derived`). | The `edit` bar under a light; blind-spot display. | Emit it for every entry of `ToolResponse.premises`. | Assumed. |
| N8 | The pool's file list and each path's tier. | File tiles from the first second; `tile.held`. | `pool.files { files: Array<{ path, tier }> }` after pool creation and after a policy change; or the same list inside `pool.state`. | Tiles appear when a file is first read, written or landed; no tier tag. |
| N9 | Model cost per attempt. Tokens and cost are in no event. | Race sheet ("cost"), Why card. | `tokens_in`, `tokens_out` on `attempt.step` for model turns, or `cost_usd` on `submit.result`. | `race.unknown`. |
| N10 | Blast radius per race candidate. `Card.blast_radius` is one object. | Race sheet. | `blast_radius: Record<attempt_id, {...}>` for kind `race`. | `race.unknown`. |
| N11 | A way to tell the global spend cap from an attempt's own budget. Both stop an attempt with `budget` (AG4, SE7). `limits` has no reserved amount. | Banner 6; the right sentence on a stopped card. | Stop reason `spend_cap`, and `refusing: boolean` in `limits`. | 7, F8: the cap counts as reached when `spend_usd >= cap_usd × CAP_REACHED_SHARE`. |
| N12 | Attempt-repo provisioning results (metric 14.8). | "Fork throughput is reported separately" (a judge's must-fix). | `attempt.repo { attempt_id, ok, ms, error }`. | About shows `about.forks_unknown`. |
| N13 | Which is authoritative: section 14 says the reducer computes metrics; 12.1 also has a `metrics` event. The event lacks repair latency and "time held". | Strip, Swarm view, About. | State that the `metrics` event is authoritative for 14.1 to 14.6 and that the reducer computes 14.7. | The Floor does exactly that. |
| N14 | For a Swarm over several pools: the pool ids. And the event volume of a synthetic pool (per-step and per-premise events for 1,000 or more agents). | Swarm wall. | `swarm.state.pools: string[]`. For synthetic attempts, emit `attempt.state`, `landing.*`, `metrics` and omit `attempt.step`, `premise.recorded`, `op.recorded`. | The wall shows one pool (the one in `/floor.json`). FE4 keeps memory bounded either way. |
| N15 | Whether an intent was typed or pre-written. | The "Pre-written" tag (honesty). | `prewritten: boolean` on `intent.created`. | The Floor sets the requester to `owner (pre-written)` and reads the tag from that text. |
| N16 | The HTTP paths of 4.5, the session-state read, and the lock action. | Every owner action. | Fix them in `protocol`. | The paths of 4.5. |
| N17 | The pool's clone address, and how a visitor gets a read token. | Git drawer. | `remote` (the address without credentials) in `pool.state`; a README section on read tokens. | `git.no_clone`. |
| N18 | Pool channel messages (SE16 lists `pause`, `resume`, `probe`, `tapped`, `stats`). The Floor also needs: `advance { commit }` (load a commit without restarting), `highlight { paths }` (outline creatures for Who relies), and the file path in `tapped`. | CO21, 3.11, 3.9. | Add them to the fixed schema. | Reload on every landing; no outline in the pool; `tapped.creature` is mapped to `creatures/{creature}.js`. |
| N19 | Owner cancel of one attempt (T20 names it; SE3 lists no route; the stop reason has no name). | `card.stop`. | The route of 4.5; stop reason `cancelled`. | No button. |
| N20 | `Card.reason` has no value for the choice card of UN6 (`reopen_failed`). The values of `card.closed.action` are not listed. | Card texts. | Add `reopen_failed`; define `action` as an option id or `stale`. | Unknown reasons show `card.title` and `card.body` as sent. |
| N21 | When `pool.state` is emitted. | Real-agent counter; the first frame address. | At pool creation with `head_seq = 0` as event 1, and whenever one of its fields changes. | Assumed. |
| N22 | The undo plan before the owner confirms (UN4) has no interface, and a refused undo has no named reasons. | Undo sheet. | The read of 4.5; reasons `too_old`, `already_undone`, `too_many`. | No preview: the sheet says `undo.no_plan` and the owner can still confirm. |
| N23 | The link between `undo.planned` and its landing. Neither event names the other. | Undo row, `undone_by`, Why card of an undo. | `seq` on `undo.planned`. | Matched by order: in one batch, the k-th `undo.planned` belongs to the k-th landing of kind `undo` or `revert` (LP2). |
| N24 | What happens to a race card when one candidate gets `repair` or `confirm` (T8 says an open card closes as `stale`; RC5 says the card stays open while a candidate can be chosen). And whether `card.updated` is emitted when the blast radius of an open card changes. | Beats 3 and 4; the held sheet. | The race card stays open and is updated; a candidate that is not `held` cannot be chosen. `card.updated` on every change of `blast_radius`. | The Floor handles both: a race column shows its attempt's state, and a new `card.opened` replaces the old card. The held sheet adds the live line `held.relied_inflight`. |
| N25 | How the owner resumes a pool paused with reason `owner` (SE11 defines the pause only). Whether an undo landing can itself be undone (11.3 says the target is of kind `change`; UN7 says an undo can be undone). | `kill.allow`; the Undo button. | `POST /api/kill { killed: false }` also resumes landings. Decide UN7. | `kill.allow` sends that request. Undo is offered on landings of kind `change` only. |

### 4.7 What the Floor needs from the tide pool specification

| # | Needed | For |
| --- | --- | --- |
| TP1 | `frameUrl(address)` for the three address forms of 4.5, with the response headers of `01-core.md` SE14. A commit-addressed response never changes. | Every pool frame; Replay. |
| TP2 | The pool app fills its iframe at any size from 320×180 to 1152×648, keeps creatures recognisable at 428×241 (the smallest race frame), and draws nothing but the pool. | Layout (2.1 to 2.8). |
| TP3 | The channel messages of N18: `tapped` with the file path, `advance`, `highlight`, and `pause` and `resume`. | Why card, CO21, Who relies, `frame.pause`. |
| TP4 | The break in the plain-merge pool is visible to someone who cannot read code: a creature whose first version compares energy with a number behaves visibly wrong after energy becomes a fraction (the crab never comes out). | Beats 0 and 4. |
| TP5 | Pre-written requests for the roles of 1.2, which the measured models complete: a starter set on `auto` paths; a crab request whose code compares energy with a number; a sweep that changes a shared rule and edits every creature found by one search; a late creature that the search matches. Their texts and groups go into `/floor.json`. | Beats 1 to 5. |
| TP6 | The policy file marks the shared-rule paths `held` (`01-core.md` 10.1), so the shared-rule change and the sweep wait on a card. | BS3. |
| TP7 | A creature's file can be found from its name, or `tapped` carries the path. | Why card from a tap. |

---

## 5. Interface copy

### 5.1 Rules

- **CP1.** The strings below are exact. They live in one module (`copy`) that the Floor imports; no component holds text of its own. Trunk fills card titles and bodies from the same module (5.10).
- **CP2.** Plain words. Complete sentences of 25 words or fewer for anything that explains. Labels and buttons are short and start with a capital letter. One name per thing (the glossary of `01-core.md` section 1 and the Floor terms of section 0).
- **CP3.** A message about a problem says what happened, then what the page or the owner does next.
- **CP4.** The page does not use these words for its own concepts: branch, pull request, merge queue, claim, reviewer. The owner's tap is "Land", not "approve".
- **CP5.** `{braces}` are filled from `FloorState`. Constants are filled from their values, never typed into a string. Plural forms: each string with `{n}` has a form for 1 and a form for other numbers; both are given where they differ.
- **CP6.** Text from outside (intent text, statements, summaries) is shown in double quotes and is never edited.
- **CP7.** A sentence that tells the owner something is waiting for them (`status.held`, `needs.badge`, `needs.title`, the `held` line of 5.7) is shown with "you" only to the owner in live mode. A visitor, and everyone in Replay, sees the form with "the owner". Both forms are given. A recorded fact (who landed, who declined, who chose) always says "the owner".

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
| `light.tip` | {keyLabel}: {light word}. {flags, joined by ", "}. | | |
| `light.blind_spot.tip` | The new code uses {keyLabel}, and the agent never read it. | | |

### 5.4 Labels, buttons, empty and loading texts

| Id | Text |
| --- | --- |
| `app.name` | Premise |
| `app.thesis` | Git records only what an agent wrote. Premise also records what it read. |
| `video.later` | From later in this recording. |
| `nav.floor` | Floor |
| `nav.swarm` | Swarm |
| `nav.replay` | Replay |
| `nav.about` | About |
| `needs.badge` | Needs you {n} (visitor and Replay: Needs the owner {n}) |
| `needs.title` | Needs you ({n}) (visitor and Replay: Needs the owner ({n})) |
| `card.open` | Open |
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
| `green.none` | not running in this build |
| `strip.spend` | Spend |
| `spend.value` | {spent} of {cap} |
| `spend.unknown` | not reported yet |
| `spend.near` | Spend is near the cap. |
| `spend.reached` | The spend cap is reached. |
| `spend.model_line` | {model}: {used} of {limit} requests in the last minute. |
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
| `intent.queue` | All {max} agent slots are busy. Your request waits for a free slot. |
| `intent.visitor` | Only the owner can send requests. You can watch, open Why cards and play the Replay. |
| `intent.replay` | This is a recording. Requests are off. |
| `intent.killed` | All agents are stopped. Allow agents again to send a request. |
| `intent.paused` | The pool is paused. No request can start. |
| `intent.rebuilding` | The pool is rebuilding from Artifacts. Requests open again when it is ready. |
| `intent.cap` | The spend cap is reached. No model call can start. |
| `rail.tab.working` | Working {n} |
| `rail.tab.landed` | Landed {n} |
| `rail.tab.stopped` | Stopped {n} |
| `rail.empty.working` | No change is in flight. Type a request above. |
| `rail.empty.working.visitor` | No change is in flight. Press Replay to watch a recorded run. |
| `rail.empty.landed` | Nothing has landed yet. |
| `rail.empty.stopped` | No attempt has stopped. |
| `rail.more` | {n} more below. |
| `card.tag.prewritten` | Pre-written |
| `card.tag.synthetic` | SYNTHETIC |
| `card.tag.reopened` | Reopened by {cause: undo, the green line, the owner} |
| `card.same_agent` | Same agent, same conversation. |
| `card.tag.right_of_way` | Right of way |
| `card.model_changed` | A different model is continuing this work. The model that started it was not available. |
| `card.queue` | It starts when an agent slot is free. The limit is {max}. |
| `card.starting` | The agent is starting. |
| `card.goaround_n` | {n} of {GO_AROUND_LIMIT} |
| `card.waiting_clef` | All checks passed. Waiting for Clef. |
| `card.next_batch` | All checks passed. It lands in the next batch. |
| `card.open_card` | Open the card. |
| `card.landing` | Recorded by Trunk. Being pushed to main. |
| `card.landed_as` | On main as landing {seq}. |
| `card.stop` | Stop this agent |
| `card.again` | Send this request again |
| `card.slow` | The model has not answered for {seconds} s. It is tried again by itself. If that fails, the attempt stops. |
| `card.relies` | Relies on |
| `card.changes` | What it changes |
| `card.checks` | What was checked |
| `card.earlier` | Earlier |
| `headsup.title.repair` | Heads-up {hn} · go-around {n} of {GO_AROUND_LIMIT} |
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
| `headsup.added` | New: {list} |
| `headsup.removed` | Gone: {list} |
| `headsup.dropped` | An edit to {path} no longer applies. The agent must make it again. |
| `headsup.nothing_to_do` | The agent was told. Nothing has to change. |
| `headsup.said` | The agent said: "{statement}" |
| `headsup.waits` | The agent stopped before it answered this. |
| `headsup.no_diff` | The exact diff was sent to the agent. This page did not receive it. |
| `headsup.show_all` | Show all {n} lines |
| `frame.main.caption` | Premise · main · {landing} |
| `frame.main.seed` | Premise · main · the seed, before any landing |
| `frame.main.title` | The live pool, running the code on main |
| `frame.pause` | Pause |
| `frame.play` | Play |
| `frame.paused` | Paused. The code still lands; only the picture is still. |
| `frame.compare` | Compare |
| `frame.landing` | {n} landing… |
| `frame.loading` | Loading the pool… |
| `frame.error` | The pool did not load. The cards and numbers are still live. |
| `frame.reload` | Reload the pool |
| `frame.pool_paused` | The pool is paused. This is the last landed state. |
| `frame.replay` | Recorded code at {landing}, running now. |
| `frame.replay_gone` | The recorded pool is no longer stored. The cards and numbers still play. |
| `plain.label` | Same changes, merged by plain git |
| `plain.constructed` | Constructed for comparison · through {landing} |
| `plain.title` | A second pool, built from the same changes with a plain git merge |
| `plain.differs` | What differs |
| `plain.diff_line` | {changeName}: went around once after {keyShort} changed. The plain-merge pool has its first version. |
| `plain.diff_line.many` | {changeName}: went around {n} times. The plain-merge pool has its first version. |
| `plain.diff_line.confirm` | {changeName}: confirmed {keyShort} before landing. The plain-merge pool has its first version. |
| `plain.conflicts` | Text conflicts in the plain merge: {n} |
| `plain.conflicts.tip` | A change that plain git could not apply is left out of the right pool and counted here. |
| `plain.same` | No change has gone around yet. Both pools run the same code. |
| `plain.loading` | Building the plain-merge pool… |
| `plain.behind` | This pool is {n} landings behind. |
| `compare.back` | Back to the Floor |
| `tiles.loading` | Loading the file list… |
| `tiles.empty` | Files appear here when an agent reads or writes them. |
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
| `why.checked.count` | {ok} of {all} checks passed. |
| `why.checked.all` | Show the checks |
| `why.landed_how` | How it landed |
| `why.landed.auto` | By itself. Everything it relied on was still true, and no held path was touched. |
| `why.landed.owner` | The owner tapped Land at {time of day}. It touches a held path. |
| `why.landed.chosen` | The owner chose it from {n} attempts at {time of day}. |
| `why.changed` | What it changed |
| `why.git` | Show the git |
| `why.seed` | This was in the pool before any agent changed it. It is part of the seed. |
| `why.landing` | This change is landing. Its record appears when main has it. |
| `why.loading` | Loading the record… |
| `why.partial` | This is what the page received. The full record is the git note on this commit. |
| `why.undone` | This change was undone by {landing}. |
| `why.undo.title` | Undo of {landing} |
| `why.undo.took_back` | It took back: {list of landings with change names}. |
| `why.undo.reopened` | Reopened, with their agents and conversations: {list}. |
| `why.undo.kept` | Kept, because they only read it: {list}. |
| `why.revert.title` | The green line took back {landings} |
| `git.title` | Show the git |
| `git.commit_is` | This is an ordinary git commit on main, in Artifacts. |
| `git.note_is` | The record above is this git note. |
| `git.read_yourself` | Read it yourself with plain git: |
| `git.copy` | Copy |
| `git.copied` | Copied. |
| `git.loading_note` | Loading the note… |
| `git.no_note` | The note is not loaded here. The two commands below show it. |
| `git.no_clone` | Ask the owner for a read-only clone address. |
| `who.open` | Who relies on this |
| `who.title` | Who relies on {keyLabel} |
| `who.pick` | Choose a part of {path}: |
| `who.in_flight` | In flight ({n}) |
| `who.landed` | Landed ({n}) |
| `who.none` | Nothing relies on this yet. |
| `who.window` | This list covers the newest {UI_DETAIL_WINDOW} landings. |
| `undo.open` | Undo |
| `undo.too_old` | This landing is too far back to undo. Undo covers the newest {UNDO_WINDOW} landings. |
| `undo.planning` | Working out what this undo takes back… |
| `undo.title` | Undo {landing}: "{intent text}"? |
| `undo.also` | This also takes back {n} later changes that were built on it: {names}. Their agents reopen and adapt. |
| `undo.also.none` | No later change was built on it. |
| `undo.kept` | {n} later changes only read it. They stay: {names}. |
| `undo.in_flight` | {n} changes in flight get a heads-up: {names}. |
| `undo.no_plan` | The page could not work out what this takes back. Trunk works it out when you confirm. |
| `undo.confirm` | Undo it |
| `undo.cancel` | Keep it |
| `undo.refused` | Trunk refused the undo: {reason}. Nothing changed. |
| `undo.landing` | Undo of {landing} is landing… |
| `undo.done` | Undo of {landing} landed as {landing}. It took back {n} changes. |
| `revert.landing` | The green line failed. Trunk is taking back {landings}. |
| `held.before` | Before: the pool now |
| `held.after` | After: the pool with this change |
| `held.changes` | What it changes |
| `held.affects` | Who it affects |
| `held.relied_landed` | {n} landed changes rely on what it changes. |
| `held.relied_inflight` | {n} changes in flight have a premise on what it changes: {names}. |
| `held.checked` | What was checked |
| `held.blind` | {n} blind spots confirmed by the agent. |
| `held.reason` | Reason (optional) |
| `held.land` | Land |
| `held.landing` | Landing… |
| `held.decline` | Decline |
| `held.visitor` | Waiting for the owner. |
| `held.risk_waiting` | Clef's answers are on their way. You can decide without them. |
| `held.risk_unavailable` | Clef's answers are not available. Decide from the preview and the checks. |
| `held.stale` | This card is out of date. Something the change relied on has changed. The agent is adapting. A new card opens when it is ready. |
| `held.closed.land` | The owner tapped Land. It lands in the next batch. |
| `held.closed.decline` | The owner declined it. The attempt is stopped and kept. |
| `race.closed` | The owner chose {changeName}. It lands in the next batch. The others are kept. |
| `choice.closed` | The owner chose: {option label}. |
| `held.no_preview` | This preview was not recorded. |
| `race.group` | Race · {n} attempts |
| `race.working` | Still working |
| `race.took` | Took {duration} |
| `race.cost` | Cost {money} |
| `race.blast` | Would send back: {n} changes |
| `race.unknown` | not recorded |
| `race.choose` | Choose this one |
| `race.chosen` | Chosen |
| `race.stopped` | Stopped before it finished. |
| `swarm.lps` | Landings per second |
| `swarm.ttl` | Time to land |
| `swarm.ttl.sub` | median · p99 {duration} |
| `swarm.gar` | Go-around rate |
| `swarm.waiting` | Waiting behind another change |
| `swarm.window` | last {seconds} s |
| `swarm.now` | now |
| `swarm.false_abort` | False-abort rate {share} (target {share}) |
| `swarm.escape` | Escape rate {share} (target {share}) |
| `swarm.backlog` | Push backlog {n} |
| `swarm.last_push` | Last push: 1 push, {n} changes |
| `swarm.agents` | Agents |
| `swarm.dial` | Collisions |
| `swarm.dial.tip` | The share of scripted changes that touch something another scripted change relies on. |
| `swarm.start` | Start |
| `swarm.starting` | Starting {n} scripted agents… |
| `swarm.stop` | Stop |
| `swarm.empty` | No Swarm run yet. A run uses scripted agents and makes no model calls. |
| `swarm.final` | The run has ended. These are its last measured numbers, at {time of day}. |
| `swarm.no_agents` | The Swarm is running and no scripted agent has started yet. Stop it and start again. |
| `swarm.blocked` | The Swarm cannot start while agents are stopped or the pool is paused. |
| `swarm.real_limit` | Real agents in the main pool: {max} at most. The limit is the model rate. |
| `swarm.shape` | This run: {pools} pool, {pools} Trunk, {agents} scripted agents. |
| `swarm.repair_note` | Scripted agents answer at once. Repair time is measured with real agents only and is shown in About. |
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
| `replay.unknown` | This recording has {n} events this page does not know. They are skipped. |
| `start.title` | Watch a recorded run |
| `start.body` | This plays a real recorded run through this same page. You need no account and no key. |
| `start.play` | Play the Replay ({duration}) |
| `start.look` | Look around the live pool |
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
| `about.run.real` | Real agents: at most {max} at once, on {models}. |
| `about.run.landed` | Landed changes: {n}. Go-arounds: {n}. |
| `about.run.repair` | Repair time with real agents: median {duration}, p99 {duration}. |
| `about.run.synthetic` | Scripted agents (SYNTHETIC): {n}. They make no model calls. |
| `about.run.constructed` | Constructed: the plain-merge pool. Trunk builds it from the same changes for comparison. |
| `about.run.spend` | Model spend: {spent} of a cap of {cap}. |
| `about.unknown_events` | This page skipped {n} events of a newer kind. Reload to get the newest page. |
| `about.build` | Page build {build}. Recording made by build {build}. |
| `about.forks_unknown` | Attempt repositories: not reported by this build. |
| `about.forks` | Attempt repositories: {rate} per second, {share} failed. No landing waits for one. |
| `about.limits` | Limits |
| `about.related` | Related work |
| `about.related.body` | STORM (arXiv 2605.20563), CoAgent (arXiv 2606.15376) and the entry "dibs" also check what agents relied on. Premise observes reads at entity, listing and search level, checks them live, and stores the record in git notes. |
| `shortcuts.title` | Keys |
| `shortcuts.toggle` | Single-key shortcuts |
| `banner.more` | {n} more notices |
| `pool.rebuild` | Rebuild from Artifacts |
| `pool.rebuild.title` | Rebuild the pool from Artifacts? |
| `pool.rebuild.body` | Trunk reads main and the notes again. Changes that were landing go back to their agents and land again. |
| `pool.rebuild.confirm` | Rebuild |
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
| `E3`, `F4`, `F6` | `triage_depends` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must adapt. |
| `E3`, `F4`, `F6` | `triage_unsure` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must confirm. |
| `E3`, `F4`, `F6` | `reaffirmed` | {thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent was told. |
| `E3`, `F4`, `F6`, `QT2` | `triage_unavailable` | {thing} changed. Clef was not available, so the agent must confirm. |
| `E3`, `F4`, `F6`, `QT2` | pending (no result yet) | {thing} changed. Clef is judging whether this change depends on it. |
| `E4`, `F7` | `reference_gone` | This change no longer uses {thing}. |
| `F1` | `write_base_changed` | {thing} changed under a whole-file write. |
| `F2` | `cosmetic` | Only comments or spacing changed in {thing}. Nothing to do. |
| `F3` | `referenced_entity_changed` | {thing} changed in a part this change uses. |
| `F5` | `referenced_file_changed` | {thing} changed, and this change uses it. |
| `L1` | `sweep_incomplete` | {thing} gained a file while this change was editing the files there. |
| `L2` | `listing_named` | {thing} changed, and this change names one of those files. |
| `L3` | `listing_unused` | {thing} changed. This change does not depend on it. |
| `QT1` | `sweep_incomplete` | {thing} has a new match, and this change had edited the earlier matches. |
| `QT2` | `triage_depends` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must adapt. |
| `QT2` | `triage_unsure` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must confirm. |
| `QT2` | `reaffirmed` | {thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent was told. |
| `QT3`, `QR2` | `match_lost` | {thing} lost a match. Nothing to do. |
| `QR1` | `new_reference_to_altered_entity` | Another change now uses what this change alters: {added}. |
| `QO1` | `outlined_entity_changed` | {thing} changed in a part this change uses. |
| `QO2` | `outline_unused` | {thing} changed in a part this change does not use. |
| `B1` | `blind_spot` | The new code uses {thing}, and the agent never read it. Trunk showed it the current version. |
| `X0` | `no_patch_yet` | {thing} changed before this change wrote anything. The agent was told. |
| `OP1` | | The text an edit replaced is gone from {path}. |
| `OP2` | | The text an edit replaced now appears more than once in {path}. |
| `OP3` | | The text an edit replaced moved to another part of {path}. |
| `OP4` | | {path} no longer exists. |
| `OP5` | | {path} changed under a whole-file write. |
| any | `checks_failed_at_landing` | The checks failed on the newest code when this change was about to land. |
| any | `push_lost` | The push for this landing was lost when the pool was rebuilt. The change lands again. |
| any other | any other | {thing} changed ({rule}, {reason}). |

One-line form on a collapsed card: "{keyShort} changed. The diff was sent to the agent." for `repair`; "{keyShort} changed. The agent must confirm." for `confirm`; "{keyShort} changed. The agent was told." for `info`.

`tick.skipped`:

| `why` | Sentence |
| --- | --- |
| `not_disjoint` | It overlaps a change in this batch. Trunk checks it against the new code next. |
| `right_of_way` | Waiting behind {changeName of `behind`}, which has right of way. |

### 5.7 Checks and submit results

| Check `name` | Label |
| --- | --- |
| `replay` | The edits apply to the newest code |
| `non_empty` | The change is not empty |
| `parse` | The code parses |
| `imports_resolve` | Every import points at something |
| `globals_allowed` | Only allowed globals are used |
| `premises_hold` | Everything it relied on is still true |
| `policy` | Policy: {detail} |
| any other | {name} |

| `submit.result.status` | Card line |
| --- | --- |
| `validated` | `card.next_batch` |
| `submitted` | `card.waiting_clef` |
| `held` | All checks passed. Waiting for you. (visitor and Replay: All checks passed. Waiting for the owner.) |
| `needs_confirm` | The agent must confirm one thing before this can land. |
| `go_around` | Something it relied on changed. The agent is adapting. |
| `rejected` | The checks sent it back: {error sentence}. The agent is fixing it. |
| `landed`, `stopped` | (no line; the state says it) |

| `SubmitError` | Error sentence |
| --- | --- |
| `empty_change` | the change does nothing |
| `parse_error` | the code does not parse |
| `import_unresolved` | an import points at nothing |
| `banned_global` | it uses something the policy does not allow |
| `banned_import` | it imports from outside the pool |
| `too_large` | the change is too large |

### 5.8 Stop sentences

| `stop_reason` | Sentence |
| --- | --- |
| `go_around_limit` | Stopped after {GO_AROUND_LIMIT} go-arounds. A card asks the owner what to do. |
| `contradiction` | Stopped: two requests change the same thing in different ways. A card asks the owner to choose. |
| `declined` | The owner declined this change. It is kept, not landed. |
| `not_chosen` | Another attempt was chosen. This one is kept. |
| `undone` | The owner undid this change. |
| `budget` | Stopped: it used up its budget of steps or tokens. |
| `spend_cap` | Stopped: the spend cap is reached. |
| `timeout` | Stopped: it ran longer than {ATTEMPT_TIMEOUT_MS as duration}. |
| `model_error` | Stopped: the model failed {MODEL_RETRIES + 1} times in a row. |
| `tool_timeout` | Stopped: Trunk did not answer a tool call. |
| `stalled` | Stopped: it made no progress for {AGENT_WATCHDOG_MS as duration}. |
| `killed` | Stopped by the kill switch. |
| `reopen_failed` | The agent that wrote this could not be reopened. A card offers a new attempt. |
| `cancelled` | The owner stopped this agent. |
| any other | Stopped ({stop_reason}). |

Every stop sentence is followed by "Its work so far is kept." unless the reason is `declined`, `not_chosen` or `undone`.

### 5.9 Request errors

Shown next to the control that sent the request, and as a toast.

| Case | Text |
| --- | --- |
| `401` | The owner key is needed for this. Unlock, then try again. |
| `403` | The server refused this request. Reload the page and try again. |
| `404` | That no longer exists. The page shows the newest state. |
| `409` | This was already answered. The page shows the newest state. |
| `413` or text too long | Use {MAX_INTENT_CHARS} characters or fewer. |
| `429` | Too many requests. Wait a moment, then try again. |
| `503`, no owner key | `owner.not_configured` |
| `503`, pool not ready | The pool is paused. Nothing new can start. |
| Refused: kill switch | All agents are stopped. Allow agents again first. |
| Refused: spend cap | The spend cap is reached. No model call can start. |
| Undo refused: `too_old` (reason names proposed, N22) | that landing is too far back |
| Undo refused: `already_undone` | that landing is already undone |
| Undo refused: `too_many` | it would take back more than {MAX_BATCH} changes at once |
| No answer (network) | The request did not reach the server. Check the connection and try again. |
| Any other status | Something went wrong (status {status}). Nothing was changed. Try again. |

### 5.10 Card texts

Trunk fills `Card.title`, `Card.body` and `Card.options[].label` from these templates in the shared `copy` module. The Floor shows them as sent.

| Kind, reason | Title | Body (at most two sentences) | Options (`id`: label) |
| --- | --- | --- | --- |
| `held`, `held_path` | This change touches shared rules. Land it? | It changes {paths}. {blast sentence} | `land`: Land · `decline`: Decline |
| `held`, `risk` | Clef flagged this change. Land it? | {risk sentence} {blast sentence} | `land`: Land · `decline`: Decline |
| `choice`, `go_around_limit` | This change was sent back {GO_AROUND_LIMIT} times. Try again? | The {changeName} change was sent back {GO_AROUND_LIMIT} times because {keyShort} kept changing. Try once more with right of way, or stop? | `retry`: Try again · `stop`: Stop |
| `choice`, `contradiction` | Two requests change the same thing. Which one stands? | {requester A} asked: "{intent A}". {requester B} asked: "{intent B}". Both change {keyShort}. | `keep_landed`: Keep what landed · `retry`: Adapt the other on top |
| `choice`, `reopen_failed` | The agent could not be reopened. Start a new attempt? | The agent that wrote {changeName} is not available. A new agent would start from the request text. | `retry`: Start a new attempt · `stop`: Leave it stopped |
| `race`, `race` | {ready} of {n} attempts at "{intent text}" are ready. Choose one. | Each ran on a different model. The one you choose lands through the same gate. | one per candidate, `id` = attempt id: Choose this one |

| Sentence | Text |
| --- | --- |
| Blast, repair, n = 1 | Landing this sends 1 change back to its agent: {name}. |
| Blast, repair, n > 1 | Landing this sends {n} changes back to their agents: {names}. |
| Blast, confirm | {n} changes must confirm: {names}. |
| Blast, triage | Clef will judge {n} changes that read it: {names}. |
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
| `banner.synthetic` | SYNTHETIC | {n} scripted agents · no model calls · same tools, premises and landing path | |
| `banner.replay` | REPLAY | Recorded {date} · "{title}" · nothing here changes a pool | |
| `banner.killed` | AGENTS STOPPED | The kill switch is on. No model call starts. Checked changes still land. | `kill.allow` (owner) |
| `banner.killed.landings` | AGENTS STOPPED | The kill switch is on and landings are paused. Nothing changes until you allow agents again. | `kill.allow` (owner) |
| `banner.paused.diverged` | POOL PAUSED | main in Artifacts is not what Trunk expected. Nothing lands until the pool is rebuilt. | Rebuild from Artifacts (owner) |
| `banner.paused.note_seq_mismatch` | POOL PAUSED | A git note does not match its commit. Nothing lands. The owner must look at the repository. | |
| `banner.paused.owner` | POOL PAUSED | The owner paused landings. | `kill.allow` (owner) |
| `banner.rebuilding` | REBUILDING | Trunk is rebuilding its index from Artifacts. Agents wait. Nothing is lost. | |
| `banner.cap` | SPEND CAP | The spend cap of {cap} is reached. No model call starts. Checked changes still land. | |
| `banner.push` | PUSH PENDING | The push of {n} landings has not been confirmed yet. Try {tries}. Next try in {seconds} s. Nothing shows as landed until main has it. | |
| `banner.green_red` | GREEN LINE | The check failed at {landing}: {failed checks}. Trunk is taking back {landings} and reopening their agents. | |
| `banner.offline` | CONNECTION | The connection to the pool is lost. Reconnecting, try {n}. The page shows the state of {duration} ago. | |

### 5.12 About: how it runs, and the limits list

`about.how` is a fixed diagram with these seven labelled boxes and no other text:

| Box | Label |
| --- | --- |
| 1 | Worker: this page, the API, and the app server that serves a pool's files by commit |
| 2 | Trunk (one Durable Object per pool): serves every read, records premises, checks them, and is the only writer of main |
| 3 | Agent (one Durable Object per attempt): the model's tool loop and its whole conversation |
| 4 | Floor (one Durable Object per pool): the event stream this page draws |
| 5 | Workflows: the green line and the Swarm |
| 6 | Workers AI: the coding models, and Clef for judgments |
| 7 | Artifacts: main, the green line, and the notes; one repository per attempt for its conversation |

The limits list is one file in the repository, shown here and in the README from the same source. A line whose condition is false for the build is left out. Starting content:

1. Premise understands JavaScript ES modules. Other files are tracked as whole files.
2. One Trunk serves one pool. A pool is small: each file is at most {MAX_FILE_BYTES} bytes.
3. Real agents are limited by the Workers AI rate limits. This build runs at most {max} at once.
4. Numbers in the Swarm view come from scripted agents. They make no model calls.
5. The plain-merge pool is constructed by Trunk from the same changes. It is a comparison, not a second product.
6. A premise across two pools is not built.
7. The green line checks {runtime sentence}. (Or: The green line is not in this build.)
8. Clef judgments are {on or off} in this build.
9. Not built: text merge, TypeScript parsing, outside agents over MCP, audience input.

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
| `sr.undo` | Undo of {landing} planned. It takes back {n} changes. |
| `sr.push` | A push is being retried. |
| `sr.green_red` | The green line check failed at {landing}. |
| `sr.paused` | The pool is paused. {banner sentence} |
| `sr.pool_state` | The pool is {ready or rebuilding or paused}. |
| `sr.killed` | Agents are stopped. · Agents are allowed again. |
| `sr.cap` | The spend cap is reached. |
| `sr.swarm` | The Swarm started with {n} scripted agents. · The Swarm stopped. |

---

## 6. Visual direction

### 6.1 The language

The page looks like a harbour board at dusk: a still, dark surface, a few large signal shapes, and numbers that can be read from far away.

- **VD1 (still unless something happened).** Nothing moves by itself except the pool app and the slow "working" pulse. Every other movement is caused by one event and ends within 720 ms.
- **VD2 (signals).** The five light shapes (circle, diamond, triangle, ring, half circle) are the identity of the product. They are used for premises and for status only, at every size, in both themes. No other icon set is used; the few other marks (cross, tick, two bars, reader ring, writer square) are drawn in the same weight.
- **VD3 (above and below the water).** The rail holds what is in flight. The pool area holds what is on `main`. A change crosses from the rail to the pool only on `landing.landed`. Colour reinforces this: the rail and sheets use the `surface` tone, the pool area the darker `bg` tone.
- **VD4 (labels that cannot be missed).** SYNTHETIC uses its own hue and a diagonal stripe that nothing else uses. REPLAY uses the inverse band and a dotted edge that nothing else uses.
- **VD5 (few sizes).** Seven type sizes, four weights of emphasis (text, muted, strong, signal), one corner radius (8), one border width (1; 3 for focus and for a heads-up panel's edge).

### 6.2 Type

- **VD6.** Text uses the system interface typeface: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Code, ids and diffs use `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. No font file is bundled or fetched, so there is no licence to check, no network request and no late change of layout.
- **VD7.** Numbers use tabular figures (`font-variant-numeric: tabular-nums`).
- **VD8.** Weight 400 for text; 600 for status words, titles, counters and buttons. No italics. Capitals only for banner words and section labels, with letter spacing 0.06em.

| Role | Stage size | Laptop size | Used for |
| --- | --- | --- | --- |
| Display | 112 | 72 | The four large Swarm numbers |
| Counter | 40 | 32 | Strip values |
| Title | 32 | 26 | Sheet titles, card titles in the sheet |
| Intent | 24 | 19 | Intent text on cards, banner words, the thesis line |
| Status | 22 | 18 | Status words, heads-up before and after (code face) |
| Body | 20 | 16 | Sentences, labels, buttons |
| Small | 16 | 14 | Strip labels, tags, tile names, the git drawer (code face) |

Line height is 1.0 for Display and Counter, 1.3 for the others. Lines of running text in sheets are at most 70 characters.

### 6.3 Colour

Dark is the default for the video. Light is for bright rooms. The page follows the system setting on first load; key `T` switches and the choice is kept in the browser.

"Lowest contrast" is the lowest WCAG contrast ratio of the token against the three background tones of its theme (`bg`, `surface`, `raised`).

| Token | Use | Dark | Lowest contrast | Light | Lowest contrast |
| --- | --- | --- | --- | --- | --- |
| `bg` | Page and pool area | `#0B1720` | | `#F3F6F4` | |
| `surface` | Rail, cards, sheets | `#13242F` | | `#FFFFFF` | |
| `raised` | Panels inside cards, tiles | `#1C3342` | | `#E8EEEC` | |
| `line` | Dividers (decoration only) | `#3A5669` | n/a | `#C9D5DA` | n/a |
| `control` | Borders of fields, buttons, tiles | `#7C98A8` | 4.32 | `#5F727D` | 4.27 |
| `text` | Text | `#EAF2F4` | 11.55 | `#0E1D26` | 14.62 |
| `muted` | Secondary text | `#A8BCC6` | 6.66 | `#465A66` | 6.13 |
| `accent` | Primary button, links, working pulse, writer marks, landing glow | `#6FD6CC` | 7.60 | `#0A6B66` | 5.40 |
| `holds` | Holds, landed, green line | `#5BD68F` | 7.16 | `#17733A` | 5.03 |
| `changed` | Changed, stopped, failure banners | `#FF7A6B` | 5.15 | `#B8281C` | 5.32 |
| `confirm` | Needs a confirm, waiting for the owner, warning banners | `#FFC857` | 8.52 | `#8A5A00` | 5.04 |
| `checking` | Being checked | `#9DB8FF` | 6.70 | `#2450C0` | 5.99 |
| `synthetic` | SYNTHETIC only | `#D7A6FF` | 6.74 | `#6A3BB0` | 6.24 |
| `focus` | Focus ring | `#FFE08A` | 10.17 | `#1B3FA0` | 7.89 |
| `on-fill` | Text on a filled signal colour or on `accent` | `#06141B` | 7.34 (on `changed`) | `#FFFFFF` | 5.92 (on `holds`) |

- **VD9.** A unit test computes these ratios from the token values and fails below: 7 for `text`; 4.5 for every other token used for text; 3 for `control`, `focus` and every signal colour used for a shape.
- **VD10.** No state is carried by colour alone. Each has a shape and a word (3.3, 5.3). Changed characters in a diff have an underline as well as a background.
- **VD11.** The signal colours are used only for their meaning. A decorative use of `changed`, `confirm`, `holds`, `checking` or `synthetic` is a defect.
- **VD12.** The pool app's own colours belong to the pool. The Floor draws a 1-wide `control` border around every pool frame so its edge is visible on any background.

### 6.4 Motion

Easing `cubic-bezier(0.2, 0.8, 0.2, 1)` for everything. "Reduced" is what happens when the system asks for reduced motion (`prefers-reduced-motion: reduce`).

| What | Motion | Reduced |
| --- | --- | --- |
| A change lands | The card shows "Landed" for 1.2 s, shrinks to a chip and travels to the edge of the pool frame (720 ms). The frame's edge glows in `accent` for 1.2 s. | The card shows "Landed" for 2 s and leaves without moving. The frame gets a static `accent` outline for 2 s. |
| A light changes | Cross-fade 200 ms, then one ring that grows and fades (600 ms). | Changes at once. A 2-wide outline for 1.5 s. |
| A card joins or leaves the top group | Slides to its place (240 ms). | Moves at once. |
| A sheet or the drawer opens or closes | Fade and a 16 rise (240 ms). | Appears at once. |
| A tile's file landed | Edge glow that fades over 2 s. | Static outline for 2 s. |
| A counter changes | Underline for 1 s. | The same. |
| Status "Working" | The dot fades between 100% and 50%, one cycle per 2.4 s. | A still dot. |
| A banner appears | Slides down (240 ms) and pushes the body. | Appears at once. |
| The Swarm wall | Redrawn at most `WALL_FPS` times per second. | Redrawn at most twice per second; a landed cell is not filled, it gets a tick. |
| Pool frames | The pool app animates. `frame.pause` is always available. | Frames start paused with `frame.play`. Replay starts paused. |

- **VD13.** Nothing flashes more than three times in one second.
- **VD14.** Apart from CO9 and CO12, nothing moves a control the pointer or the focus is on. New cards are added without shifting the card that has focus out from under it: the list keeps its scroll position relative to the focused card.

### 6.5 Accessibility

| # | Requirement | Test |
| --- | --- | --- |
| AX1 | Contrast as in 6.3 (VD9). | Unit test on tokens. |
| AX2 | Every action in sections 1 and 3 can be done with the keyboard alone, in a logical order: header, strip, banners, pool area, rail. A "Skip to the cards" link is the first focus stop. | Browser test: beats 1 to 7 and 10 with keys only. |
| AX3 | Focus is always visible: a 3-wide ring in `focus`, 2 away from the control. | Screenshot test. |
| AX4 | Sheets and dialogs take focus when they open, keep it inside, close with Esc without doing anything else, and return focus to the control that opened them. | Browser test. |
| AX5 | The pointer is never the only way. Every Why card is reachable from the Landed tab; Who relies from the premise list and the tile menu; tapping a creature is a shortcut, not the only path. | Browser test. |
| AX6 | Landmarks: header (`banner`), view switch (`navigation`), body (`main`), rail (`complementary`, label "Changes"), strip (`region`, label "Counters"). Each sheet is a `dialog` with its title as its name. | Accessibility tree test. |
| AX7 | Names. A light: `light.tip`. A tile: `tile.name`. A pool frame: its `title`. A counter: its label and value as one phrase. A status shape: its word. A button: its text. | Accessibility tree test. |
| AX8 | Two live regions. Polite: the log lines of 5.13 marked as not urgent, at most one per second, with more than five waiting lines merged into "{n} more updates". Assertive: the lines marked urgent in 4.3. Toasts go to the polite region. | Unit test on the announcer. |
| AX9 | The Swarm wall (a canvas) has a text summary, updated every 5 s: "{n} scripted agents: {a} working, {b} going around, {c} landing." The four numbers are real text. | Accessibility tree test. |
| AX10 | Reduced motion as in 6.4. | Browser test with the setting on. |
| AX11 | The page works at 200% browser zoom and with text spacing overrides: it moves to the laptop or narrow layout, and no text is cut off. | Browser test at 960×540 CSS pixels. |
| AX12 | Tap targets are at least 44×44 (LY5). | Layout test. |
| AX13 | Single-key shortcuts are off while a field has focus and can be turned off (`shortcuts.toggle`). | Browser test. |
| AX14 | Nothing times out on the user. A card waits forever. A message that leaves by itself (toast, closed-card notice) stays in the log and on its card. | Review of every timer. |
| AX15 | The page sets `lang="en"`. Text from outside keeps its characters; right-to-left text is isolated with `dir="auto"`. | Unit test. |
| AX16 | In forced-colours mode every shape keeps an outline and every control a border. | Screenshot test. |

### 6.6 Keys

| Key | Does |
| --- | --- |
| `/` | Focus the intent box |
| `F`, `S`, `A` | Floor view, Swarm view, About |
| `C` | Compare view on and off |
| `N` | Open the oldest card that needs the owner |
| `L` | Go to the Landed tab |
| `G` | Open or close the git drawer of the open Why card |
| `P` | Pause or play the pool frames |
| `K` | Open the kill switch dialog (owner) |
| `R` | Open the default recording, paused |
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
- **VD16.** A light is 28 across on a full card. Its shape is recognisable when the screenshot is scaled to one quarter. A screenshot test compares the five shapes at 7 pixels.
- **VD17.** At most 5 full cards, or 9 compact cards, are on screen (CO10). At most 3 banners (CO50). At most 2 heads-up panels open by themselves (CO11).
- **VD18.** Sentences on cards are one line at stage size where the table of 5.6 gives a one-line form. Long sentences live in the expanded card and in sheets.
- **VD19.** Key `Z` switches to stage size on any screen. The setting is kept in the browser. The video and the stage both use stage size.

---

## 7. When something fails

The owner must be able to tell, from the page alone, what happened, whether to wait, and what to tap. Each row: the trigger (from `FloorState`, `ViewState` and the clock), what the page shows, what happens by itself, and what the owner can do.

| # | Failure | Trigger | The page shows | By itself | The owner can |
| --- | --- | --- | --- | --- | --- |
| F1 | The model is slow | `quietFor(attempt) >= QUIET_NOTICE_MS` | The activity line counts seconds: "Thinking · 14 s". From `SLOW_NOTICE_MS` it is in the `confirm` colour and reads `card.slow`. | The Agent retries the model call up to `MODEL_RETRIES` times, then stops (`01-core.md` AG2, AG3). | Wait, or stop the agent (`card.stop`, needs N19). Other cards keep going. |
| F2 | A tool step failed | `attempt.step.ok` is false | The activity line with the reason of 5.5. | The agent tries another way. Each try uses its budget. | Nothing. |
| F3 | The checks sent a change back | `submit.result.status = rejected` | The submit sentence of 5.7 on the card, in the `confirm` colour. It is not a go-around and the count does not rise. | The agent fixes its work and submits again. | Nothing. |
| F4 | An attempt stopped | `attempt.state` to `stopped` with reason `model_error`, `tool_timeout`, `stalled`, `timeout`, `budget`, `killed` | The card moves to the Stopped tab with the stop sentence of 5.8. The Stopped tab count rises. Toast with the same sentence. | Nothing. Its work is kept. | Send the request again from the Stopped card: the button `card.again` fills the intent box. |
| F5 | A push is being retried | `push.retry` | Cards in the batch stay "Landing…". The caption bar shows `frame.landing`. No banner yet. | Trunk retries with growing waits and never gives up (`01-core.md` LP5). | Nothing. |
| F6 | A push is pending for long | `pushStalled` | Banner 7 (`banner.push`) with the try count and a countdown to the next try. The Landed counter and the pool frame do not move (FL3). `strip.waiting.backlog` shows the changes waiting. | The same. When `batch.pushed` arrives the banner leaves and the cards land. | Keep talking: nothing is lost. Agents keep working. |
| F7 | Spend is near the cap | `spend_usd >= cap_usd × SPEND_NEAR_SHARE` | The spend cell in the `confirm` colour with `spend.near`. | Nothing. | Stop the Swarm or let fewer agents run. |
| F8 | The spend cap is reached | `limits` with `spend_usd >= cap_usd × CAP_REACHED_SHARE` (or `refusing`, N11) | Banner 6 (`banner.cap`). The intent box shows `intent.cap`. Attempts stop with the sentence for `budget` or `spend_cap`. | Checked changes still land. No model call starts. | Nothing on the page raises the cap. Replay still works. On stage: press `R`. |
| F9 | The kill switch is on | `limits.killed` | Banner 3 (`banner.killed`, or `banner.killed.landings` when the pool is also paused by the owner). The intent box shows `intent.killed`. Attempts stop with "Stopped by the kill switch." | Checked changes still land unless landings were paused too. | `kill.allow`. |
| F10 | The connection is lost | The socket closed, or no frame for `OFFLINE_AFTER_MS` while the socket is not open | Banner 9 (`banner.offline`) with the try count. Everything is dimmed (CO3). Owner controls are off. | The page reconnects with waits from `WS_RETRY_BASE_MS` doubling to `WS_RETRY_MAX_MS`, and asks for events after its last `n`. It catches up or takes a snapshot. | Wait. On stage: press `R` (a recording that is already loaded plays without the network, except for pool frames). |
| F11 | The pool diverged | `pool.paused` with reason `diverged` | Banner 4 (`banner.paused.diverged`) with the button `pool.rebuild`. Cards in "Landing…" stay so. | Nothing lands. Agents can still read. | `pool.rebuild`, then confirm. |
| F12 | A note does not match its commit | `pool.paused` with reason `note_seq_mismatch` | Banner 4 (`banner.paused.note_seq_mismatch`). | Nothing. | Nothing on the page. This needs a look at the repository. Replay still works. |
| F13 | The owner paused landings | `pool.paused` with reason `owner` | Banner 4 (`banner.paused.owner`). | Nothing lands. | `kill.allow`. |
| F14 | The pool is rebuilding | `pool.state.state = rebuilding` | Banner 5 (`banner.rebuilding`). The intent box shows `intent.rebuilding`. | Agents register again when it is ready; changes that were landing go around and land again (`01-core.md` LP8). | Wait. |
| F15 | A held card went out of date | `card.closed` by `system` with action `stale` | The tray row leaves. An open sheet shows `held.stale` and its buttons are off. The attempt shows "Going around" or "Confirming" with its heads-up. | The agent adapts. A new card opens after its next submit. | Wait for the new card. |
| F16 | A change was sent back too often | `card.opened`, kind `choice`, reason `go_around_limit` | A tray row and the sheet with the text of 5.10. The attempt is in the Stopped tab. | Nothing. | "Try again" (it gets right of way) or "Stop". |
| F17 | Two requests contradict | `card.opened`, kind `choice`, reason `contradiction` | A tray row and the sheet with both requests in the owners' words (5.10). | Nothing. | "Keep what landed" or "Adapt the other on top". |
| F18 | Clef is not available | `premise.judged` with `clef.error`, or `card.risk.error` | The premise shows "Needs a confirm" with the `triage_unavailable` sentence. A held card shows `held.risk_unavailable`. | The agent takes one confirm turn. Nothing lands on a guess. | Decide a held card from the preview. |
| F19 | The green line failed | `green.verified` with `ok` false | Banner 8 (`banner.green_red`) with the failed checks. Strip: `green.red`. Then an undo row `revert.landing`, and the reopened cards. | Trunk takes back the landings since the last green one and reopens their agents (`01-core.md` GR3). The banner leaves when the revert has landed. | Nothing. Open the Why card of the revert to see what it took back. |
| F20 | A pool frame did not load | Time-out `FRAME_LOAD_TIMEOUT_MS` or an error from the iframe | `frame.error` and `frame.reload` inside that frame only. In Replay, when the commit cannot be served: `frame.replay_gone`. | Nothing. | `frame.reload`. |
| F21 | The owner session ended | A request answers `401` | Toast `owner.expired`. Header shows `owner.visitor`. The owner dialog opens. The draft is kept. | Nothing. | Paste the key and tap the control again. |
| F22 | A request was refused or did not arrive | Any other failure of a request of 4.5 | The sentence of 5.9 next to the control and as a toast. The control is enabled again. Nothing on the page changes as if it had worked (FE6). | Nothing. | Try again. |
| F23 | A reopened change has a different author | `attempt.reopened` with `model_changed` true; or stop reason `reopen_failed` | `card.model_changed` on the card and on its Why card. For `reopen_failed`: the stop sentence and a choice card (5.10). | For `model_changed`: the new model continues with the recorded conversation. | For `reopen_failed`: "Start a new attempt" or "Leave it stopped". |
| F24 | The Swarm did not start | The start request failed, or no synthetic attempt within 10 s of `swarm.state.running` | The error sentence, or `swarm.no_agents`. | Nothing. | `swarm.stop`, then `swarm.start`. On stage: play the Swarm recording. |
| F25 | A recording cannot be played | 8.3 | `replay.error` with the reason and `replay.to_live`. | Nothing. | Choose another recording. |
| F26 | All agent slots are busy | `real_agents >= max_real_agents` and an attempt is `opened` | The card shows `status.queued` and `card.queue`. The intent box shows `intent.queue`. | The attempt starts when a slot is free. | Wait. This is the stated limit, not a fault. |
| F27 | The page met an event it does not know | `unknown_events > 0` | About shows `about.unknown_events`. Nothing else changes. | The event is ignored (FE1). | Reload the page to get the newest build. |

- **FA1.** Every row has a recorded fixture stream that produces it, and a screenshot test.
- **FA2.** A failure never removes information: cards, lights and counters keep their last content.
- **FA3.** A failure message never shows a stack trace, a token, a raw response body or an internal id.
- **FA4.** On stage, every failure has the same way out: key `R` (1.5, item 6).

---

## 8. Replay

### 8.1 What it is

Replay plays a recording through the same reducer and the same components as the live stream (`01-core.md` 12.3).

- **RP1.** Replay opens no WebSocket and sends no request that changes anything. Its only requests are `GET /floor.json`, `GET /replay/index.json`, the recording file, and pool frames (FE5).
- **RP2.** Replay needs no key, no account and no cookie. It works when the deployment has no owner key at all.
- **RP3.** The REPLAY banner is on screen from the moment a recording starts loading until Replay is closed. When the recording's header has `synthetic: true`, the SYNTHETIC banner is on screen too.
- **RP4.** Everything that reads is available in Replay: Why cards, the git drawer, Who relies, Compare view, the expanded cards, About, theme, size, keys. Everything that changes something is absent (FL7).
- **RP5.** The same recording gives the same `FloorState` at the same position on every run (FE3).

### 8.2 The recording and the list of recordings

A recording is the NDJSON file of `01-core.md` 12.3, unchanged:

```
{"premise_replay":1,"pool":"tidepool-main","recorded_at":"2026-10-10T18:03:11Z","events":4210,"synthetic":false,"build":"<git commit of the build>","label":"The conflict, real agents"}
{"n":1,"t":1791655391000,"pool":"tidepool-main","src":"trunk","type":"pool.state","head_seq":0,"head_commit":"…","green_seq":0,"state":"ready","reason":null,"real_agents":0,"max_real_agents":12,"synthetic":false}
{"n":2,"t":1791655395120,"pool":"tidepool-main","src":"trunk","type":"intent.created","intent_id":"i_…","text":"make energy a fraction from 0 to 1","requester":"owner","race":false}
…
```

The list of recordings is one static file *(Floor)*:

```json
{
  "v": 1,
  "default": "hero",
  "recordings": [
    { "id": "hero", "file": "/replay/hero.ndjson", "title": "The conflict, real agents",
      "duration_ms": 371000, "events": 4210, "bytes": 1830042, "synthetic": false,
      "recorded_at": "2026-10-10T18:03:11Z" },
    { "id": "swarm", "file": "/replay/swarm.ndjson", "title": "The Swarm, scripted agents",
      "duration_ms": 92000, "events": 48110, "bytes": 11200000, "synthetic": true,
      "recorded_at": "2026-10-10T19:20:02Z" }
  ]
}
```

- **RP6.** The recordings that judges are pointed to are static assets of the Worker (`/replay/*.ndjson`), so they play even when no Durable Object holds any state. A file is at most `REPLAY_MAX_BYTES` (the platform's limit for one static asset).
- **RP7.** `file` may also be the export route of a kept pool (4.5). The page treats both the same.
- **RP8.** The file's header is the truth. The list only decides what the menu shows before the file is loaded.
- **RP9.** A recording of a real pool and a recording of a synthetic pool are separate files, because they are separate pools and separate streams.
- **RP10.** The pool repo and the plain-merge repo of a recorded pool are kept, so the app server can serve their commits to the frames (8.6).

Making a recording (owner, live mode): Replay menu, then `replay.save`. The browser downloads the export of 4.5. A coding agent adds the file and its list entry to the repository and deploys. Nothing in the file is secret: no event carries a token, a key or a full transcript (`01-core.md` 12.1).

### 8.3 Loading and checks

The page downloads the whole file, shows `replay.loading` with the share loaded, and checks it before the first event is applied:

| Check | When it fails, `replay.error` reads |
| --- | --- |
| The file downloads | This recording could not be downloaded. Check the connection and try again. |
| It is at most `REPLAY_MAX_BYTES` | This recording is too large to play here. |
| Line 1 is JSON with `premise_replay` equal to 1 | This file is not a Premise recording. |
| The number of event lines equals `events` | This recording is incomplete: it has {a} events and should have {b}. |
| Every event line is JSON with `n`, `t` and `type` | This recording is damaged at line {line}. |
| `n` runs 1, 2, 3, … with no gap | This recording is damaged: event {n} is missing. |
| `t` never decreases | This recording is damaged: its times go backwards at event {n}. |

- **RP11.** An event type the reducer does not know is not an error. It is counted, skipped, and reported once with `replay.unknown` (FE1).
- **RP12.** A recording made by an older build plays. The header's `build` is shown in About.

### 8.4 Playback

- **RP13 (clock).** The Replay clock starts at the `t` of event 1. While playing it advances by real time multiplied by the speed. An event is applied when the Replay clock reaches its `t`. The stream clock of FL9 is the Replay clock.
- **RP14 (gaps).** When the next event is more than `REPLAY_MAX_GAP_MS` ahead of the Replay clock (at speed 1), the clock jumps to `REPLAY_MAX_GAP_MS` before it and the bar shows `replay.skipped` for 3 s. The run clock shows the recorded time, so a jump is visible.
- **RP15 (speed).** Speeds are `REPLAY_SPEEDS`. The default is 1. Animations of 6.4 keep their own length at every speed; above speed 2 the landing travel is replaced by the reduced form.
- **RP16 (seek).** Jumping to a chapter or dragging the track rebuilds `FloorState` for that position and then plays or stays paused as before. A jump completes within `REPLAY_SEEK_BUDGET_MS` for a recording of 50,000 events. During the rebuild no animation runs and no log line is spoken.
- **RP17 (frames).** After a seek, pool frames load the commit of the position (8.6).
- **RP18 (start).** From the start card or the menu, the recording loads and plays. With reduced motion it loads paused. A direct link `/replay/{id}` does the same.
- **RP19 (end).** After the last event the bar shows `replay.ended`. The page stays on the final state. `replay.again` restarts; `replay.to_live` closes Replay.
- **RP20.** Closing Replay returns to live mode in the same view and reconnects the stream.

### 8.5 Chapters

`chapters(events)` is a pure function. A chapter starts `CHAPTER_LEAD_MS` of recorded time before its first matching event, and exists only if an event matches. Chapters are numbered in order of position; that number is their key (6.6). When two chapters would start at the same event, only the one that comes first in the table is kept.

| Chapter name | Starts at the first | Caption on the Replay bar |
| --- | --- | --- |
| Requests | `intent.created` | Each card is one agent. Each light is something it read. |
| Held change | `card.opened` of kind `held` | A change to shared rules waits for the owner. The card shows the pool before and after. |
| Conflict | `headsup.sent` with result `repair` | A change landed. Agents that relied on the old version get the exact diff and adapt. |
| Second catch | `headsup.sent` with result `repair` and a key of rule `QT1` or `L1` | A search or a file list gained a match. The agent that was sweeping it is told. |
| Choice | `card.opened` of kind `choice` | The owner decides in plain words. |
| Undo | `undo.planned` with cause `undo` | Undo takes back the change and the later changes built on it. Their agents reopen. |
| Race | `card.opened` of kind `race` | Three models tried the same request. The owner chooses one. |
| Green line | `green.verified` with `ok` false | A check failed after landing. Trunk takes the landings back and reopens their agents. |
| Swarm | `swarm.state` with `running` true | Scripted agents on the same landing path. The numbers are measured in this run. |

At any time the bar shows the caption of the current chapter. Captions are part of the `copy` module. A viewer can also open Compare view (key `C`) and any Why card (tap a creature) at any position; the caption of the Conflict chapter ends with "Press C to compare with a plain git merge." when the recording has a plain-merge pool.

### 8.6 Pool frames in Replay

| Frame | Address in Replay |
| --- | --- |
| Live pool frame | `{ pool, repo: "main", commit }` with the commit of the newest `landing.landed` at the position; before the first, `head_commit` of event 1. |
| Plain-merge pool frame | `{ pool, repo: "plain", commit }` from the newest `plain.updated` at the position (N2). |
| "Before" on a held or race card | `{ pool, repo: "main", commit }` with the landed commit at the moment the card opened. |
| "After" on a held or race card | The card's recorded address when it has one (N4, option a). Otherwise `held.no_preview`. |

- **RP21.** The caption of every frame in Replay is `frame.replay`: the code is the recorded code, and it runs now. The positions of creatures are not recorded.
- **RP22.** A frame that cannot be served shows `frame.replay_gone` (7, F20). The rest of Replay continues.

### 8.7 How a judge starts it, with no credentials

Any one of these. None needs a key, an account or a tool.

1. Open the public address. On a quiet pool the start card is in the middle of the pool area. Press "Play the Replay".
2. Open the public address. Press "Replay" in the header. Choose a recording.
3. Open the public address followed by `/replay/hero`. The recording loads and plays.

- **RP23.** The start card is shown to a visitor in live mode when no attempt is in flight and no landing arrived in the last 60 s. It leaves when the visitor chooses either button, and it never covers the rail.
- **RP24.** The run instructions in the README and in the submission form give way 3 as one line.
- **RP25.** A browser test runs way 1 and way 3 with no cookies against a deployment whose owner key is not set, and checks that the recording plays to the end with no request other than those of RP1.

---

## Appendix A. Floor constants

| Constant | Value | Notes |
| --- | --- | --- |
| `UI_DETAIL_WINDOW` | 200 | landings kept in full in `FloorState`; equal to `UNDO_WINDOW` |
| `LIGHTS_MAX` | 14 | lights on a collapsed card |
| `AUTO_EXPAND_MAX` | 2 | heads-up panels open by themselves |
| `CHANGE_NAME_CHARS` | 28 | |
| `QUIET_NOTICE_MS` | 10,000 | the activity line starts counting |
| `SLOW_NOTICE_MS` | 30,000 | equal to `AGENT_WATCHDOG_MS` |
| `SENT_WAIT_MS` | 5,000 | |
| `FRAME_LOAD_TIMEOUT_MS` | 8,000 | |
| `FRAME_ADVANCE_DEBOUNCE_MS` | 150 | one batch, one advance |
| `FRAME_ADVANCE_TIMEOUT_MS` | 1,000 | then reload |
| `STALE_CARD_MS` | 6,000 | |
| `TOAST_MS` | 6,000 | |
| `SPEND_NEAR_SHARE` | 0.8 | |
| `CAP_REACHED_SHARE` | 0.98 | used until N11 is settled |
| `OFFLINE_AFTER_MS` | 3,000 | |
| `WS_RETRY_BASE_MS` | 500 | |
| `WS_RETRY_MAX_MS` | 8,000 | |
| `WALL_FPS` | 10 | |
| `REPLAY_SPEEDS` | 0.5, 1, 2, 4, 8 | |
| `REPLAY_MAX_GAP_MS` | 2,000 | |
| `REPLAY_MAX_BYTES` | 25 MiB | the Workers limit for one static asset |
| `REPLAY_SEEK_BUDGET_MS` | 500 | |
| `CHAPTER_LEAD_MS` | 3,000 | |

Constants of `01-core.md` that the page shows or uses: `GO_AROUND_LIMIT`, `RACE_SIZE`, `MAX_INTENT_CHARS`, `UNDO_WINDOW`, `MAX_BATCH`, `PUSH_STALL_MS`, `MODEL_RETRIES`, `AGENT_WATCHDOG_MS`, `ATTEMPT_TIMEOUT_MS`, `METRICS_WINDOW_MS`, `FALSE_ABORT_TARGET`, `ESCAPE_TARGET`, `SESSION_TTL_S`, `MAX_FILE_BYTES`. The page imports them from `protocol`; it never repeats a value.

## Appendix B. Acceptance checks

Each is a test in the repository. Fixture streams are NDJSON files in the format of 8.2.

| # | Check |
| --- | --- |
| AC1 | One recorded file gives the same `FloorState` through the live path, a snapshot join and Replay (FE3). |
| AC2 | Every event type of 4.3 has a reducer test whose expected state comes from this file, not from the reducer's output. |
| AC3 | A stream with `landing.accepted` and no `landing.landed` shows "Landing…", leaves the Landed counter and the frame address unchanged, and offers no Why card (FL3). |
| AC4 | A synthetic stream shows the SYNTHETIC banner in every view and sheet, and the banner has no close control (FL4, CO49). |
| AC5 | A visitor's page contains no owner control in the document, and Replay contains none (FL7). |
| AC6 | Replay makes only the requests of RP1 (network log in a browser test). |
| AC7 | Every copy id used by a component exists in `copy`; components contain no text of their own (lint). Every id of section 5 is used. |
| AC8 | Intent text, a statement and a path that contain markup are shown as text (FL8). |
| AC9 | The token contrast test of VD9 passes for both themes. |
| AC10 | Beats 1 to 7 and 10 can be completed with the keyboard alone (AX2). |
| AC11 | With reduced motion on, no element moves, and pool frames and Replay start paused (6.4). |
| AC12 | At 1920×1080 the computed sizes meet VD15, and the regions have the sizes of 2.1 within 1 pixel. |
| AC13 | No sideways scroll at widths 320, 768, 1100, 1280, 1440, 1600 and 1920 (LY3). |
| AC14 | The vectors `C04` and `C05` of `premise-cases.json`, turned into event fixtures, turn the expected light to `changed` at the landing and back to `holds` at the resolving submit. |
| AC15 | Each row of section 7 has a fixture and a screenshot (FA1). |
| AC16 | The owner key does not appear in the address, in browser storage, in the console or in any request other than `POST /api/session` (CO45). |
| AC17 | Two fast taps on Land, Undo it, Choose this one or Stop all agents send one request (CO2). |
| AC18 | A recording of 50,000 events loads, and a jump to its last chapter completes within `REPLAY_SEEK_BUDGET_MS` in the CI browser (RP16). |
| AC19 | The limits list in About and in the README are built from the same file and are equal. |
| AC20 | The page text contains none of the phrases of FL6 and none of the words of CP4 (lint over `copy`). |

