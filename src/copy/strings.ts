// 03-floor 5.3 (status and light words), 5.4 (labels, buttons, empty and loading texts) and 5.13
// (screen-reader log lines): one entry per copy id. The text is verbatim, `{braces}` kept (CP5).
//
// Variants the spec gives live on the entry:
//   `visitor` — the CP7 form a visitor, and everyone in Replay, sees;
//   `one`     — the CP5 form for n = 1 where the spec gives a different one;
//   `alt`     — a second sentence the same id speaks in the other direction (`sr.killed`, `sr.swarm`).

import { fill, type CopyVars } from "./fill.ts";
import { DASH } from "./format.ts";
import type { Features } from "../protocol/floor-json.ts";

export type CopyEntry = {
  readonly text: string;
  /** The banner word of a `banner.*` id (5.11): SYNTHETIC, REPLAY, POOL PAUSED, … */
  readonly word?: string;
  /** CP7: what a visitor, and everyone in Replay, reads instead of `text`. */
  readonly visitor?: string;
  /** CP5: the form for `n` = 1 where the spec gives a different one. */
  readonly one?: string;
  /** The counted placeholder for the 1-form; defaults to `n`. */
  readonly oneCount?: string;
  /**
   * A second form of the same id: the "allowed again" / "stopped" direction of `sr.killed` and
   * `sr.swarm`; the `banner.green_red` sentence before its `undo.planned` arrives; the
   * `banner.rebuilding` sentence without the "({done} of {total})" part while `pool.rebuild` is
   * null (5.11).
   */
  readonly alt?: string;
  /** AX8/4.3: the line goes to the assertive live region; unset means polite. */
  readonly urgent?: boolean;
};

export const STRINGS: Readonly<Record<string, CopyEntry>> = {
  // ---- 5.3 Status words ----
  "status.opened": { text: "Starting" },
  "status.queued": { text: "Waiting for a free agent" },
  "status.working": { text: "Working" },
  "status.going_around": { text: "Going around" },
  "status.needs_confirm": { text: "Confirming" },
  "status.submitted": { text: "Being checked" },
  "status.validated": { text: "Ready to land" },
  "status.held": { text: "Waiting for you", visitor: "Waiting for the owner" },
  "status.accepted": { text: "Landing…" },
  "status.landed": { text: "Landed" },
  "status.stopped": { text: "Stopped" },
  "status.undone": { text: "Undone" },
  "status.not_chosen": { text: "Not chosen" },
  "status.declined": { text: "Declined" },

  // ---- 5.3 Light words and flags ----
  "light.holds": { text: "Holds" },
  "light.changed": { text: "Changed" },
  "light.confirm": { text: "Needs a confirm" },
  "light.blind_spot": { text: "Blind spot" },
  "light.checking": { text: "Being checked" },
  "light.flag.read": { text: "the agent read it" },
  "light.flag.edit": { text: "this change edits it" },
  "light.flag.derived": { text: "the new code uses it" },
  "light.more": { text: "+{n}" },
  "light.tip": { text: '{keyLabel}: {light word}. {flags, joined by ", "}.' },
  "light.blind_spot.tip": {
    text: "The new code uses {keyLabel}, and the agent never read it.",
  },

  // ---- 5.4 App, navigation, strip ----
  "app.name": { text: "Premise" },
  "app.thesis": {
    text: "Git records only what an agent wrote. Premise also records what it read.",
  },
  "app.settings_failed": { text: "Premise could not load its settings. Reload the page." },
  "nav.floor": { text: "Floor" },
  "nav.swarm": { text: "Swarm" },
  "nav.replay": { text: "Replay" },
  "nav.about": { text: "About" },
  "nav.skip": { text: "Skip to the attempt cards" },
  "nav.label": { text: "Views" },
  "needs.badge": { text: "Needs you {n}", visitor: "Needs the owner {n}" },
  "needs.title": { text: "Needs you ({n})", visitor: "Needs the owner ({n})" },
  "card.open": { text: "Open" },
  "card.close": { text: "Close" },
  "strip.label": { text: "Counters" },
  "strip.clock": { text: "Run clock" },
  "strip.agents": { text: "Real agents" },
  "strip.agents.value": { text: "{n} of {max}" },
  "strip.agents.limit": { text: "Limit set by the model rate." },
  "strip.agents.synthetic": { text: "{n} scripted" },
  "strip.landed": { text: "Landed" },
  "strip.goarounds": { text: "Go-arounds" },
  "strip.waiting": { text: "Waiting behind another change" },
  "strip.waiting.backlog": { text: "{n} waiting for a push" },
  "strip.green": { text: "Green line" },
  "green.at": { text: "landing {seq}" },
  "green.static": { text: "landing {seq} · static checks only" },
  "green.red": { text: "failed at landing {seq}" },
  "green.checking": { text: "checking landing {seq} again" },
  "green.none": { text: "not running in this build" },
  "strip.spend": { text: "Spend" },
  "spend.value": { text: "{spent} of {cap}" },
  "spend.unknown": { text: "not reported yet" },
  "spend.near": { text: "Spend is near the cap." },
  "spend.reached": { text: "The spend cap is reached." },
  "spend.model_line": {
    text: "{model}: {used} of {limit} requests in the last minute.",
    one: "{model}: {used} of {limit} request in the last minute.",
    oneCount: "limit",
  },
  "strip.dash": { text: DASH },
  "strip.stale": { text: "As of {duration} ago." },

  // ---- 5.4 Intent box ----
  "intent.placeholder": { text: "Ask for a change in plain words." },
  "intent.count": { text: "{n} of {max}" },
  "intent.send": { text: "Send" },
  "intent.race": { text: "Race {RACE_SIZE}" },
  "intent.race.tip": {
    text: "Send this request to {RACE_SIZE} different models. You choose one result.",
  },
  "intent.sending": { text: "Sending…" },
  "intent.sent_waiting": { text: "Sent. Waiting for the pool to show it." },
  "intent.prewritten": { text: "Pre-written requests" },
  "intent.starter": { text: "Send the starter set ({n})" },
  "intent.queue": {
    text: "All {max} agent slots are busy. Your request waits for a free slot.",
    one: "The {max} agent slot is busy. Your request waits for a free slot.",
    oneCount: "max",
  },
  "intent.visitor": {
    text: "Only the owner can send requests. You can watch, open Why cards and play the Replay.",
  },
  "intent.replay": { text: "This is a recording. Requests are off." },
  "intent.killed": { text: "All agents are stopped. Allow agents again to send a request." },
  "intent.paused": { text: "The pool is paused. No request can start." },
  "intent.rebuilding": {
    text: "The pool is rebuilding from Artifacts. Requests open again when it is ready.",
  },
  "intent.cap": { text: "The spend cap is reached. No model call can start." },

  // ---- 5.4 Rail and attempt cards ----
  "rail.label": { text: "Changes" },
  "rail.tab.working": { text: "Working {n}" },
  "rail.tab.landed": { text: "Landed {n}" },
  "rail.tab.stopped": { text: "Stopped {n}" },
  "rail.empty.working": { text: "No change is in flight. Type a request above." },
  "rail.empty.working.visitor": {
    text: "No change is in flight. Press Replay to watch a recorded run.",
  },
  "rail.empty.working.replay": { text: "No change is in flight at this point of the recording." },
  "view.failed": {
    text: "This part of the page stopped because of an error. The rest of the page still works. Reload the page to try again.",
  },
  "rail.empty.landed": { text: "Nothing has landed yet." },
  "rail.empty.stopped": { text: "No attempt has stopped." },
  "rail.more": { text: "{n} more below." },
  "rail.summary_only": {
    text: "This pool reports summaries only. Lights, steps and diffs are not in its stream.",
  },
  "attempt.tag.prewritten": { text: "Pre-written" },
  "attempt.tag.synthetic": { text: "SYNTHETIC" },
  "attempt.tag.reopened": { text: "Reopened by {cause: undo, the green line, the owner}" },
  "attempt.same_agent": { text: "Same agent, same conversation." },
  "attempt.tag.right_of_way": { text: "Right of way" },
  "attempt.tag.mcp": { text: "Over MCP" },
  "attempt.model_changed": {
    text: "A different model is continuing this work. The model that started it was not available.",
  },
  "attempt.queue": { text: "It starts when an agent slot is free. The limit is {max}." },
  "attempt.starting": { text: "The agent is starting." },
  "attempt.sent_back_n": { text: "sent back {n} of {GO_AROUND_LIMIT}" },
  "attempt.waiting_clef": { text: "All checks passed. Waiting for Clef." },
  "attempt.next_batch": { text: "All checks passed. It lands in the next batch." },
  "attempt.open_card": { text: "Open the card." },
  "attempt.landing": { text: "Recorded by Trunk. Being pushed to main." },
  "attempt.landed_as": { text: "On main as landing {seq}." },
  "attempt.stop": { text: "Stop this agent" },
  "attempt.stopping": { text: "Stopping…" },
  "attempt.again": { text: "Send this request again" },
  "attempt.slow": {
    text: "The model has not answered for {seconds} s. It is tried again by itself. If that fails, the attempt stops.",
  },
  "attempt.relies": { text: "Relies on" },
  "attempt.changes": { text: "What it changes" },
  "attempt.checks": { text: "What was checked" },
  "attempt.earlier": { text: "Earlier" },

  // ---- 5.4 Heads-up panels ----
  "headsup.title.repair": { text: "Heads-up {hn} · go-around {n}" },
  "headsup.title.confirm": { text: "Heads-up {hn} · one confirm needed" },
  "headsup.title.info": { text: "Heads-up {hn} · for information" },
  "headsup.cause": { text: 'Changed by: "{intent text}" ({landing})' },
  "headsup.cause.undo": { text: "Changed by: the undo of {landing}" },
  "headsup.cause.revert": { text: "Changed by: the green line took back {landings}" },
  "headsup.cause.submit": { text: "Found when the agent submitted." },
  "headsup.before": { text: "Before" },
  "headsup.after": { text: "After" },
  "headsup.now": { text: "Now" },
  "headsup.uses": { text: "Its own lines that use it" },
  "headsup.use_line": { text: "{path} line {line}" },
  "headsup.added": { text: "New: {list}" },
  "headsup.removed": { text: "Gone: {list}" },
  "headsup.context": { text: "Also new or changed in those files" },
  "headsup.check": { text: "The check that failed: {check label}" },
  "headsup.truncated": {
    text: "Some code was too long to show here. The agent reads it from the pool.",
  },
  "headsup.before_unavailable": { text: "The earlier version is not available." },
  "headsup.dropped": {
    text: "An edit to {path} no longer applies. The agent must make it again.",
  },
  "headsup.nothing_to_do": { text: "The agent was told. Nothing has to change." },
  "headsup.said": { text: 'The agent said: "{statement}"' },
  "headsup.waits": { text: "The agent stopped before it answered this." },
  "headsup.no_diff": {
    text: "The exact diff was sent to the agent. This page did not receive it.",
  },
  "headsup.show_all": { text: "Show all {n} lines", one: "Show {n} line" },

  // ---- 5.4 Pool frames ----
  "frame.main.caption": { text: "Premise · main · {landing}" },
  "frame.main.seed": { text: "Premise · main · the seed, before any landing" },
  "frame.main.title": { text: "The live pool, running the code on main" },
  "frame.pause": { text: "Pause" },
  "frame.play": { text: "Play" },
  "frame.paused": { text: "Paused. The code still lands; only the picture is still." },
  "frame.compare": { text: "Compare" },
  "frame.landing": { text: "{n} landing…" },
  "frame.loading": { text: "Loading the pool…" },
  "frame.error": {
    text: "The pool did not load. The attempt cards and the numbers are still live.",
  },
  "frame.reload": { text: "Reload the pool" },
  "frame.pool_paused": { text: "The pool is paused. This is the last landed state." },
  "frame.replay": { text: "Recorded code at {landing}, running now." },
  "frame.replay_gone": {
    text: "The recorded pool is no longer stored. The attempt cards and the numbers still play.",
  },
  "frame.stalled.green": {
    text: "The pool stopped answering. This is the last verified version, {landing}.",
  },
  "frame.stalled.reloaded": { text: "The pool stopped answering and was loaded again." },
  "frame.stalled": {
    text: "The pool stopped answering. The attempt cards and the numbers are still live.",
  },

  // ---- 5.4 Compare view and the plain-merge pool ----
  "plain.label": { text: "Same changes, merged by plain git" },
  "plain.constructed": { text: "Constructed for comparison · through {landing}" },
  "plain.title": {
    text: "A second pool, built from the same changes with a plain git merge",
  },
  "plain.differs": { text: "What differs" },
  "plain.diff_line": {
    text: "{changeName}: went around once after {keyShort} changed. The plain-merge pool has its first version.",
  },
  "plain.diff_line.many": {
    text: "{changeName}: went around {n} times. The plain-merge pool has its first version.",
    one: "{changeName}: went around {n} time. The plain-merge pool has its first version.",
  },
  "plain.diff_line.confirm": {
    text: "{changeName}: confirmed {keyShort} before landing. The plain-merge pool has its first version.",
  },
  "plain.interrupted": {
    text: "{changeName}: its agent was sent back in the middle of its work. The plain-merge pool has its unfinished work.",
  },
  "plain.no_difference": {
    text: "No visible difference in this run. Both pools hold the same files.",
  },
  "plain.conflicts": { text: "Text conflicts in the plain merge: {n} (approximated)" },
  "plain.conflicts.tip": {
    text: "A change that the plain merge could not apply is left out of the right pool and counted here. The count is approximated: Trunk replays each change's edits in order, which is not a full three-way merge.",
  },
  "plain.conflicts.merged": { text: "Text conflicts in the plain merge: {n}" },
  "plain.conflicts.merged.tip": {
    text: "A change that plain git could not merge is left out of the right pool and counted here. Trunk merges each file from three versions, line by line, as git merge-file does. The three are where the agent started, the plain-merge pool, and the agent's own version.",
  },
  "plain.same": { text: "No change has gone around yet." },
  "plain.loading": { text: "Building the plain-merge pool…" },
  "plain.behind": { text: "This pool is {n} landings behind.", one: "This pool is {n} landing behind." },
  "compare.back": { text: "Back to the Floor" },

  // ---- 5.4 Self-test badge ----
  "selftest.running": { text: "Self-test, run in this page: running…" },
  "selftest.pass": { text: "Self-test, run in this page: passed" },
  "selftest.fail": {
    text: "Self-test, run in this page: failed · {n} checks",
    one: "Self-test, run in this page: failed · 1 check",
  },
  "selftest.fail.line": { text: "{check label} ({kind})" },
  "selftest.tip": {
    text: "This page ran the pool's own self-test on the version in this frame. It is not the green line.",
  },

  // ---- 5.4 Tiles ----
  "tiles.loading": { text: "Loading the file list…" },
  "tiles.files": { text: "Files" },
  "tiles.more": { text: "+{n} more" },
  "tile.held": { text: "Held" },
  "tile.held.tip": { text: "A change to this file waits for one tap from the owner." },
  "tile.more_marks": { text: "+{n}" },
  "tile.removed": { text: "Removed" },
  "tile.name": { text: "{path}. {r} reading, {w} writing." },
  "tile.menu.who": { text: "Who relies on this" },
  "tile.menu.why": { text: "Why (newest change)" },

  // ---- 5.4 Why card ----
  "why.title": { text: "Why is this here?" },
  "why.head": { text: "{changeName} · {landing} · {time of day}" },
  "why.asked": { text: "Who asked" },
  "why.asked.line": { text: '{requester}: "{intent text}"' },
  "why.wrote": { text: "Who wrote it" },
  "why.wrote.real": { text: "A real agent on {model}." },
  "why.wrote.synthetic": { text: "A scripted agent (SYNTHETIC). No model was called." },
  "why.relied": { text: "What it relied on" },
  "why.under": { text: "What changed under it" },
  "why.under.none": { text: "Nothing it relied on changed while the agent worked." },
  "why.under.goaround": {
    text: 'Go-around {n}: {rule sentence} ({landing}: "{intent text}").',
  },
  "why.under.confirm": { text: "Confirm: {rule sentence}" },
  "why.checked": { text: "What was checked" },
  "why.checked.count": { text: "{ok} of {all} checks passed.", one: "{ok} of {all} check passed.", oneCount: "all" },
  "why.checked.all": { text: "Show the checks" },
  "why.landed_how": { text: "How it landed" },
  "why.landed.auto": {
    text: "By itself. Everything it relied on was still true, and no held path was touched.",
  },
  "why.landed.owner": { text: "The owner tapped Land at {time of day}. It touches a held path." },
  "why.landed.owner_now": {
    text: "The owner tapped Land now at {time of day}. It did not wait for the change that had right of way.",
  },
  "why.landed.owner_risk": {
    text: "The owner tapped Land at {time of day}. Clef had flagged this change.",
  },
  "why.landed.chosen": {
    text: "The owner chose it from {n} attempts at {time of day}.",
    one: "The owner chose it from {n} attempt at {time of day}.",
  },
  "why.changed": { text: "What it changed" },
  "why.git": { text: "Show the git" },
  "why.seed": {
    text: "This was in the pool before any agent changed it. It is part of the seed.",
  },
  "why.landing": { text: "This change is landing. Its record appears when main has it." },
  "why.loading": { text: "Loading the record…" },
  "why.partial": {
    text: "This is what the page received. The full record is the git note on this commit.",
  },
  "why.unwitnessed": {
    text: "This landing has no git note, so its record is not known. The commit is on main.",
  },
  "why.undone": { text: "This change was undone by {landing}." },
  "why.undo.title": { text: "Undo of {landing}" },
  "why.undo.took_back": { text: "It took back: {list of landings with change names}." },
  "why.undo.reopened": { text: "Reopened, with their agents and conversations: {list}." },
  "why.undo.kept": { text: "Kept, because they only read it: {list}." },
  "why.revert.title": { text: "The green line took back {landings}" },

  // ---- 5.4 "Show the git" drawer ----
  "git.title": { text: "Show the git" },
  "git.commit_is": { text: "This is an ordinary git commit on main, in Artifacts." },
  "git.commit": { text: "Commit" },
  "git.parent": { text: "Parent" },
  "git.tree": { text: "Tree" },
  "git.note_is": { text: "The record above is this git note." },
  "git.read_yourself": { text: "Read it yourself with plain git:" },
  "git.copy": { text: "Copy" },
  "git.copied": { text: "Copied." },
  "git.loading_note": { text: "Loading the note…" },
  "git.no_note": { text: "The note is not loaded here. The two commands below show it." },
  "git.read_token": {
    text: "To clone, ask the owner for a read token. The README says how the owner creates one.",
  },

  // ---- 5.4 Who relies ----
  "who.open": { text: "Who relies on this" },
  "who.title": { text: "Who relies on {keyLabel}" },
  "who.pick": { text: "Choose a part of {path}:" },
  "who.in_flight": { text: "In flight ({n})" },
  "who.landed": { text: "Landed ({n})" },
  "who.none": { text: "Nothing relies on this yet." },
  "who.summary_only": {
    text: "This pool reports summaries only. Who relies is not available here.",
  },
  "who.window": { text: "This list covers the newest {FLOOR_KEEP_LANDINGS} landings." },

  // ---- 5.4 Undo ----
  "undo.open": { text: "Undo" },
  "undo.too_old": {
    text: "This landing is too far back to undo. Undo covers the newest {UNDO_WINDOW} landings.",
  },
  "undo.planning": { text: "Working out what this undo takes back…" },
  "undo.title": { text: 'Undo {landing}: "{intent text}"?' },
  "undo.also": {
    text: "This also takes back {n} later changes that were built on it: {names}. Their agents reopen and adapt.",
    // Beat 7 of 03 1.2 shows the n = 1 form: "1 later change … Its agent reopens and adapts."
    one: "This also takes back {n} later change that was built on it: {names}. Its agent reopens and adapts.",
  },
  "undo.also.none": { text: "No later change was built on it." },
  "undo.kept": {
    text: "{n} later changes only read it. They stay: {names}.",
    one: "{n} later change only read it. It stays: {names}.",
  },
  "undo.in_flight": {
    text: "{n} changes in flight get a heads-up: {names}.",
    one: "{n} change in flight gets a heads-up: {names}.",
  },
  "undo.plan_changed": {
    text: "The pool changed while this was open. This is what the undo takes back now.",
  },
  "undo.confirm": { text: "Undo it" },
  "undo.sending": { text: "Undoing…" },
  "undo.cancel": { text: "Keep it" },
  "undo.refused": { text: "Trunk refused the undo: {reason}. Nothing changed." },
  "undo.landing": { text: "Undo of {landing} is landing…" },
  "undo.done": {
    text: "Undo of {landing} landed as {landing}. It took back {n} changes.",
    one: "Undo of {landing} landed as {landing}. It took back {n} change.",
  },
  "revert.landing": { text: "The green line failed. Trunk is taking back {landings}." },

  // ---- 5.4 Held card sheet and closed cards ----
  "held.before": { text: "Before: the pool now" },
  "held.after": { text: "After: the pool with this change" },
  "held.changes": { text: "What it changes" },
  "held.affects": { text: "Who it affects" },
  "held.relied_landed": {
    text: "{n} landed changes rely on what it changes.",
    one: "{n} landed change relies on what it changes.",
  },
  "held.relied_inflight": {
    text: "{n} changes in flight have a premise on what it changes: {names}.",
    one: "{n} change in flight has a premise on what it changes: {names}.",
  },
  "held.checked": { text: "What was checked" },
  "held.blind": { text: "{n} blind spots confirmed by the agent.", one: "{n} blind spot confirmed by the agent." },
  "held.reason": { text: "Reason (optional)" },
  "held.landing": { text: "Landing…" },
  "held.visitor": { text: "Waiting for the owner." },
  "held.risk_waiting": {
    text: "Clef's answers are on their way. You can decide without them.",
  },
  "held.risk_unavailable": {
    text: "Clef's answers are not available. Decide from the preview and the checks.",
  },
  "held.stale": {
    text: "This card is out of date. Something the change relied on has changed. The agent is adapting. A new card opens when it is ready.",
  },
  "held.closed.land": {
    text: "The owner tapped Land. It lands through the same gate as every other change.",
  },
  "held.closed.land_now": { text: "The owner tapped Land now. It lands in the next batch." },
  "held.closed.decline": { text: "The owner declined it. The attempt is stopped and kept." },
  "race.closed": {
    text: "The owner chose {changeName}. It lands in the next batch. The others are kept.",
  },
  "choice.closed": { text: "The owner chose: {option label}." },
  "held.no_preview": { text: "No preview is available for this change." },
  "held.preview_building": { text: "Building the preview…" },
  "held.land_now.tip": {
    text: "Lands it in the next batch. It does not wait for the change that has right of way.",
  },

  // ---- 5.4 Race ----
  "race.group": { text: "Race · {n} attempts", one: "Race · {n} attempt" },
  "race.working": { text: "Still working" },
  "race.took": { text: "Took {duration}" },
  "race.cost": { text: "Cost {money}" },
  "race.blast": { text: "Would send back: {n} changes", one: "Would send back: {n} change" },
  "race.unknown": { text: "not recorded" },
  "race.chosen": { text: "Chosen" },
  "race.stopped": { text: "Stopped before it finished." },
  "race.superseded": { text: "Every attempt stopped before one was chosen." },

  // ---- 5.4 Swarm view ----
  "swarm.lps": { text: "Landings per second" },
  "swarm.ttl": { text: "Time to land" },
  "swarm.ttl.sub": { text: "median · p99 {duration}" },
  "swarm.gar": { text: "Go-around rate" },
  "swarm.waiting": { text: "Waiting behind another change" },
  "swarm.window": { text: "last {seconds} s" },
  "swarm.now": { text: "now" },
  "swarm.false_abort": { text: "False-abort rate {share} (target {share})" },
  "swarm.false_abort.tip": {
    text: "The share of go-arounds after which the agent changed nothing.",
  },
  "swarm.escape": { text: "Escape rate {share} (target {share})" },
  "swarm.escape.tip": {
    text: "The share of landed changes that the green line later took back.",
  },
  "swarm.backlog": { text: "Push backlog {n}" },
  "swarm.last_push": { text: "Last push: 1 push, {n} changes", one: "Last push: 1 push, {n} change" },
  "swarm.agents": { text: "Agents" },
  "swarm.dial": { text: "Collisions" },
  "swarm.dial.tip": {
    text: "The share of scripted changes that touch something another scripted change relies on.",
  },
  "swarm.start": { text: "Start" },
  "swarm.starting": { text: "Starting {n} scripted agents…", one: "Starting {n} scripted agent…" },
  "swarm.stop": { text: "Stop" },
  "swarm.stopping": { text: "Stopping…" },
  "swarm.empty": {
    text: "No Swarm run yet. A run uses scripted agents and makes no model calls.",
  },
  "swarm.final": {
    text: "The run has ended. These are its last measured numbers, at {time of day}.",
  },
  "swarm.no_agents": {
    text: "The Swarm is running and no scripted agent has started yet. Stop it and start again.",
  },
  "swarm.blocked": {
    text: "The Swarm cannot start while agents are stopped or the pool is paused.",
  },
  "swarm.real_limit": {
    text: "Real agents in the main pool: {max} at most. The limit is the model rate.",
    one: "Real agent in the main pool: {max} at most. The limit is the model rate.",
    oneCount: "max",
  },
  "swarm.shape": {
    text: "This run: {pools} pool, {pools} Trunk, {agents} scripted agents.",
    one: "This run: {pools} pool, {pools} Trunk, {agents} scripted agent.",
    oneCount: "agents",
  },
  "swarm.repair_note": {
    text: "Scripted agents answer at once. Repair time is measured with real agents only and is shown in About.",
  },
  "swarm.wall.summary": {
    text: "{n} scripted agents: {a} working, {b} going around, {c} landing.",
    one: "{n} scripted agent: {a} working, {b} going around, {c} landing.",
  },

  // ---- 5.4 Replay ----
  "replay.menu.title": { text: "Recordings" },
  "replay.menu.item": { text: "{title} · {duration} · recorded {date}" },
  "replay.none": { text: "This deployment has no recording yet." },
  "replay.save": { text: "Save this run as a recording" },
  // The text is the sentence of 8.3 for the check that failed (REPLAY_ERRORS in replay.ts).
  "replay.error": { text: "{reason}" },
  "replay.loading": { text: "Loading the recording… {share}" },
  "replay.play": { text: "Play" },
  "replay.pause": { text: "Pause" },
  "replay.restart": { text: "Restart" },
  "replay.position": { text: "{clock} of {clock}" },
  "replay.speed": { text: "Speed {x}×" },
  "replay.close": { text: "Close Replay" },
  "replay.skipped": { text: "Skipped {duration} with no events." },
  "replay.ended": { text: "The recording has ended." },
  "replay.again": { text: "Watch again" },
  "replay.to_live": { text: "Open the live Floor" },
  "replay.unknown": {
    text: "This recording has {n} events this page does not know. They are skipped.",
    one: "This recording has {n} event this page does not know. It is skipped.",
  },

  // ---- 5.4 Start card, owner, kill switch ----
  "start.title": { text: "Watch a recorded run" },
  "start.body": {
    text: "This plays a recorded run through this same page. You need no account and no key.",
  },
  "start.play": { text: "Play the Replay ({duration})" },
  "start.look": { text: "Look around the live pool" },
  "start.look.repo": { text: "Look around this repository" },
  "owner.visitor": { text: "Visitor" },
  "owner.unlocked": { text: "Owner" },
  "owner.replay": { text: "Replay" },
  "owner.title": { text: "Owner key" },
  "owner.body": {
    text: "The owner key lets this browser send requests and answer cards.",
  },
  "owner.key_label": { text: "Owner key" },
  "owner.unlock": { text: "Unlock" },
  "owner.checking": { text: "Checking…" },
  "owner.cancel": { text: "Cancel" },
  "owner.lock": { text: "Lock" },
  "owner.locked_toast": { text: "Locked. This browser is a visitor now." },
  "owner.wrong": { text: "That key is not right. Paste the owner key again." },
  "owner.not_configured": {
    text: "This deployment has no owner key. Nothing can be changed from this page.",
  },
  "owner.wait": { text: "Too many tries. Wait one minute, then try again." },
  "owner.expired": { text: "Your owner session has ended. Enter the key again." },
  "kill.open": { text: "Stop all agents" },
  "kill.title": { text: "Stop all agents?" },
  "kill.body": {
    text: "No model call starts after this. Each agent stops at its next step. Changes that are already checked still land.",
  },
  "kill.landings": { text: "Also pause landings" },
  "kill.confirm": { text: "Stop all agents" },
  "kill.stopping": { text: "Stopping…" },
  "kill.cancel": { text: "Cancel" },
  "kill.allow": { text: "Allow agents again" },

  // ---- 5.4 About ----
  "about.title": { text: "About this run" },
  "about.how": { text: "How it runs" },
  "about.run": { text: "In this run" },
  "about.run.real": {
    text: "Real agents: at most {max} at once, on {models}.",
    one: "Real agent: at most {max} at once, on {models}.",
    oneCount: "max",
  },
  "about.run.landed": { text: "Landed changes: {n}. Go-arounds: {n}." },
  "about.run.repair": {
    text: "Repair time with real agents: median {duration}, p90 {duration}.",
  },
  "about.run.synthetic": {
    text: "Scripted agents (SYNTHETIC): {n}. They make no model calls.",
    one: "Scripted agent (SYNTHETIC): {n}. It makes no model calls.",
  },
  "about.run.constructed": {
    text: "Constructed: the plain-merge pool. Trunk builds it from the same changes for comparison.",
  },
  "about.run.spend": { text: "Model spend: {spent} of a cap of {cap}." },
  "about.unknown_events": {
    text: "This page skipped {n} events of a newer kind. Reload to get the newest page.",
    one: "This page skipped {n} event of a newer kind. Reload to get the newest page.",
  },
  "about.build": { text: "Page build {build}. Recording made by build {build}." },
  "about.forks_unknown": { text: "Attempt repositories: not reported by this build." },
  "about.forks": {
    text: "Attempt repositories: {rate} per second, {share} failed. No landing waits for one.",
  },
  "about.forks_off": { text: "Attempt repositories are not provisioned in this build." },
  "about.trunk_errors": {
    text: "Trunk recorded {n} internal errors and tried each step again.",
    one: "Trunk recorded {n} internal error and tried the step again.",
  },
  "about.limits": { text: "Limits" },
  "about.related": { text: "Related work" },
  "about.related.body": {
    text: 'STORM (arXiv 2605.20563), CoAgent (arXiv 2606.15376) and the entry "dibs" also check what agents relied on. Premise observes reads at entity, listing and search level, checks them live, and stores the record in git notes.',
  },
  "shortcuts.title": { text: "Keys" },
  "shortcuts.toggle": { text: "Single-key shortcuts" },

  // ---- 5.4 Notices, pool states, toasts ----
  // ---- 5.11 Banners: `word` is the banner word; `text` the sentence ----
  "banner.synthetic": {
    word: "SYNTHETIC",
    text: "{n} scripted agents · they make no model calls · same tools, premises and landing path",
    one: "1 scripted agent · it makes no model calls · same tools, premises and landing path",
  },
  "banner.synthetic.swarm": {
    word: "SYNTHETIC",
    text: "{n} scripted agents · they make no model calls · same tools, premises and landing path · shared rules land without a tap in this pool",
    one: "1 scripted agent · it makes no model calls · same tools, premises and landing path · shared rules land without a tap in this pool",
  },
  "banner.replay": {
    word: "REPLAY",
    text: 'Recorded {date} · "{title}" · nothing here changes a pool',
  },
  "banner.killed": {
    word: "AGENTS STOPPED",
    text: "The kill switch is on. No model call starts. Checked changes still land.",
  },
  "banner.killed.landings": {
    word: "AGENTS STOPPED",
    text: "The kill switch is on and landings are paused. Nothing changes until you allow agents again.",
  },
  "banner.paused.diverged": {
    word: "POOL PAUSED",
    text: "main in Artifacts is not what Trunk expected. Nothing lands until the pool is rebuilt.",
  },
  "banner.paused.push_rejected": {
    word: "POOL PAUSED",
    text: "Artifacts refused the same push {PUSH_REJECT_LIMIT} times. Nothing lands until the pool is rebuilt.",
  },
  "banner.paused.note_seq_mismatch": {
    word: "POOL PAUSED",
    text: "A git note does not match its commit. Nothing lands. The owner must look at the repository.",
  },
  "banner.paused.owner": { word: "POOL PAUSED", text: "The owner paused landings." },
  "banner.rebuilding": {
    word: "REBUILDING",
    text: "Trunk is rebuilding its index ({done} of {total}). Agents wait. Everything that landed is kept.",
    alt: "Trunk is rebuilding its index. Agents wait. Everything that landed is kept.",
  },
  "banner.cap": {
    word: "SPEND CAP",
    text: "The spend cap of {cap} is reached. No model call starts. Checked changes still land.",
  },
  "banner.push": {
    word: "PUSH PENDING",
    text: "The push of {n} landings has not been confirmed yet. Try {tries}. Next try in {seconds} s. Nothing shows as landed until main has it.",
    one: "The push of {n} landing has not been confirmed yet. Try {tries}. Next try in {seconds} s. Nothing shows as landed until main has it.",
  },
  "banner.green_red": {
    word: "GREEN LINE",
    text: "The check failed twice at {landing}: {failed checks}. Trunk is taking back {landings} and reopening their agents.",
    // Before the `undo.planned` of cause `revert` arrives, only its opening sentence shows (5.11).
    alt: "The check failed twice at {landing}: {failed checks}.",
  },
  "banner.offline": {
    word: "CONNECTION",
    text: "The connection to the pool is lost. Reconnecting, try {n}. The page shows the state of {duration} ago.",
  },
  "banner.more": { text: "{n} more notices", one: "{n} more notice" },
  "pool.rebuild": { text: "Rebuild from Artifacts" },
  "pool.rebuild.title": { text: "Rebuild the pool from Artifacts?" },
  "pool.rebuild.body": {
    text: "Trunk reads main and the notes again. Changes that were landing go back to their agents and land again. Open cards close.",
  },
  "pool.rebuild.confirm": { text: "Rebuild" },
  "pool.missing": { text: "There is no pool at this address." },
  "pool.to_default": { text: "Open the default pool" },
  "toast.landed": { text: "{changeName} landed." },
  "toast.sent": { text: "Request sent." },

  // ---- 5.13 Screen-reader log lines ----
  "sr.intent": { text: 'New request from {requester}: "{intent text}".' },
  "sr.state": { text: "{changeName}: {status word}." },
  "sr.headsup": { text: "{changeName}: {one-line form of 5.6}." },
  "sr.resolved": { text: "{changeName}: the agent answered its heads-up." },
  "sr.reopened": { text: "{changeName}: reopened by {cause}." },
  "sr.card": { text: "A card is waiting for the owner: {title}", urgent: true },
  "sr.card_closed": { text: "Card closed: {title}" },
  "sr.landed": { text: "{changeName} landed as {landing}." },
  "sr.undo": {
    text: "Undo of {landing} planned. It takes back {n} changes.",
    one: "Undo of {landing} planned. It takes back {n} change.",
  },
  "sr.push": { text: "A push is being retried." },
  "sr.green_checking": {
    text: "The green line check failed once at {landing}. It is being run again.",
  },
  "sr.green_red": { text: "The green line check failed twice at {landing}.", urgent: true },
  "sr.paused": { text: "The pool is paused. {banner sentence}", urgent: true },
  "sr.pool_state": { text: "The pool is {ready or rebuilding or paused}." },
  "sr.killed": { text: "Agents are stopped.", alt: "Agents are allowed again.", urgent: true },
  "sr.cap": { text: "The spend cap is reached.", urgent: true },
  "sr.swarm": {
    text: "The Swarm started with {n} scripted agents.",
    alt: "The Swarm stopped.",
    one: "The Swarm started with {n} scripted agent.",
  },
  "sr.more": { text: "{n} more updates", one: "{n} more update" },
};

/** The words `{cause}` of `attempt.tag.reopened` and `sr.reopened` take (03 5.4, `attempt.reopened`). */
export const REOPENED_CAUSE: Readonly<Record<string, string>> = {
  undo: "undo",
  revert: "the green line",
  retry: "the owner",
};

/**
 * The rows of the shortcut list (03 6.6): `key` as it is shown and the "Does" column. "Replay:"
 * marks a key that works only in Replay.
 */
export const SHORTCUT_ROWS: ReadonlyArray<{ key: string; does: string }> = [
  { key: "/", does: "Focus the intent box" },
  { key: "F, S, A", does: "Floor view, Swarm view, About" },
  { key: "C", does: "Compare view on and off" },
  { key: "N", does: "Open the oldest card that needs the owner" },
  { key: "L", does: "Go to the Landed tab" },
  { key: "G", does: "Open or close the git drawer of the open Why card" },
  { key: "P", does: "Pause or play the pool frames" },
  { key: "K", does: "Open the kill switch dialog (owner)" },
  { key: "R", does: "Open the default recording, paused" },
  { key: "T", does: "Switch theme" },
  { key: "Z", does: "Switch between stage size and laptop size type" },
  { key: "?", does: "Show this list" },
  { key: "Esc", does: "Close the sheet, the drawer, or Compare view" },
  { key: "Replay: Space", does: "Play or pause" },
  { key: "Replay: 1 to 9", does: "Jump to that chapter" },
  { key: "Replay: ←, →", does: "Previous chapter, next chapter" },
  { key: "Replay: ,, .", does: "Slower, faster" },
  { key: "Replay: 0", does: "Restart" },
];

/**
 * The labels of the seven boxes of the `about.how` diagram (03 5.12) for this build's features. The
 * diagram carries no other text.
 */
export function aboutHowBoxes(
  features: Pick<Features, "green" | "clef" | "attempt_repos"> & Partial<Pick<Features, "mcp">>,
): readonly string[] {
  // 5.12: a box names a part only when the build has it.
  const green = features.green !== "none";
  return [
    "Worker: this page, the API, and the app server that serves a pool's files by commit",
    "Trunk (one Durable Object per pool): serves every read, records premises, checks them, and is the only writer of main",
    "Agent (one Durable Object per attempt): the model's tool loop and its whole conversation" +
      (features.mcp === true ? ", or the calls of an outside agent over MCP" : ""),
    "Floor (one Durable Object per pool): the event stream this page draws",
    green ? "Workflows: the green line and the Swarm" : "Workflows: the Swarm",
    features.clef ? "Workers AI: the coding models, and Clef for judgments" : "Workers AI: the coding models",
    (green ? "Artifacts: main, the green line, and the notes" : "Artifacts: main and the notes") +
      (features.attempt_repos ? "; one repository per attempt for its conversation" : ""),
  ];
}

/** The seven boxes of 5.12 as the table writes them: every part the table names (outside agents
 * over MCP add to box 3 by an amendment of the text below the table, 07-mcp MC24). */
export const ABOUT_HOW_BOXES: readonly string[] = aboutHowBoxes({ green: "full", clef: true, attempt_repos: true });

/**
 * The copy 06-repos.md names (IR12). These ids are amendments: they are not in the tables of
 * 03-floor section 5, so they cannot live in STRINGS (AC7 counts exactly the tables' ids there).
 * `text()` and `template()` resolve them the same way.
 */
export const REPO_STRINGS: Readonly<Record<string, CopyEntry>> = {
  // IR12: the caption bar of a pool made from a repository — it has no live picture.
  "frame.no_app": {
    text: "This repository has no live picture. Its files and the changes to them are below.",
  },
};

/** Copy additions authorized by the VE8 shell brief; the specification is read-only. */
export const SHELL_REVIEW_STRINGS: Readonly<Record<string, CopyEntry>> = {
  "swarm.last_push.unknown": { text: "Last push: –" },
};

/**
 * `text(id, vars)` gives the string of a copy id, filled. `vars.visitor` picks the CP7 form a
 * visitor (and everyone in Replay) reads; the entry's counted value of 1 picks the `one` form.
 * Constant placeholders resolve to their values (CP5). Throws when the id is unknown.
 */
export function text(id: string, vars: CopyVars = {}): string {
  const entry = STRINGS[id] ?? REPO_STRINGS[id] ?? SHELL_REVIEW_STRINGS[id];
  if (entry === undefined) throw new Error(`copy: unknown id "${id}"`);
  let template = entry.text;
  if (vars.visitor === true && entry.visitor !== undefined) template = entry.visitor;
  if (vars[entry.oneCount ?? "n"] === 1 && entry.one !== undefined) template = entry.one;
  return fill(template, vars);
}

/** The unfilled template of a copy id, or undefined when the id does not exist. */
export function template(id: string): string | undefined {
  return (STRINGS[id] ?? REPO_STRINGS[id] ?? SHELL_REVIEW_STRINGS[id])?.text;
}
