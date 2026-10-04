// Heads-ups for the model: the run the Agent may show (HU6a), the mapping of a `HeadsUp` to a
// `HeadsUpForModel` (MR6 to MR9, HE3), and the `user` message of SP5. Pure functions.

import type { HeadsUp, HeadsUpItem, Diff } from "../../../protocol/headsup.ts";
import type { HeadsUpForModel } from "../../../protocol/tools.ts";
import { TEXTS, fill, type AgentTexts } from "./texts.ts";
import type { InboxEntry, LoopState } from "./state.ts";

/**
 * HU6a, `inboxNext(shown_hn, inbox)`: the heads-ups the Agent may show now — the run with no gap from
 * `shown_hn + 1` — and whether a gap below a held number asks for a `sync`. Worked table of 01-core
 * 8.3 and `inbox_cases` of premise-cases.json.
 */
export function inboxNext(
  shown_hn: number,
  inbox: readonly { heads_up: HeadsUp }[],
): { show: HeadsUp[]; sync: boolean } {
  const pending = inbox
    .map((entry) => entry.heads_up)
    .filter((hu) => hu.hn > shown_hn)
    .sort((a, b) => a.hn - b.hn);
  const show: HeadsUp[] = [];
  let next = shown_hn + 1;
  for (const hu of pending) {
    if (hu.hn > next) return { show, sync: true };
    show.push(hu);
    next = hu.hn + 1;
  }
  return { show, sync: false };
}

/**
 * Store a pushed heads-up (HU5): deduplicated by `hn`, kept in ascending order, never edited.
 * Returns the entry stored, or the existing one for a duplicate.
 */
export function receiveHeadsUp(state: LoopState, headsUp: HeadsUp, receivedAt: number): InboxEntry {
  const existing = state.inbox.find((entry) => entry.heads_up.hn === headsUp.hn);
  if (existing !== undefined) return existing;
  const entry: InboxEntry = { heads_up: headsUp, shown_step: null, received_at: receivedAt };
  const at = state.inbox.findIndex((e) => e.heads_up.hn > headsUp.hn);
  if (at === -1) state.inbox.push(entry);
  else state.inbox.splice(at, 0, entry);
  return entry;
}

/** The label of a premise key (MR8): the `{thing}` of the `what` sentences. */
export function labelOf(kind: string, key: string): string {
  switch (kind) {
    case "entity":
      return entityLabel(key);
    case "file":
      return `the file ${key}`;
    case "listing":
      return `the directory ${key}`;
    case "check":
      return `the check ${key}`;
    case "query":
      if (key.startsWith("refs:")) return entityLabel(key.slice("refs:".length));
      if (key.startsWith("outline:")) return `the outline of ${key.slice("outline:".length)}`;
      if (key.startsWith("text:")) {
        const rest = key.slice("text:".length);
        const at = rest.indexOf(":");
        return `your search for "${rest.slice(at + 1)}" in ${rest.slice(0, at)}`;
      }
      return `the query ${key}`;
    default:
      return `the ${kind} ${key}`;
  }
}

function entityLabel(key: string): string {
  const at = key.indexOf("#");
  const path = key.slice(0, at);
  const name = key.slice(at + 1);
  if (name.startsWith("(import ") && name.endsWith(")")) {
    return `the imports from ${name.slice("(import ".length, -1)} in ${path}`;
  }
  if (name === "(top)") return `the top-level statements of ${path}`;
  if (name === "default") return `the default export of ${path}`;
  if (name.startsWith("*")) return `the re-export of ${name.slice(1)} in ${path}`;
  return `\`${name}\` in ${path}`;
}

function capitalFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The `what` sentence of one item (MR7, MR8): the first matching row, then the suffixes in order. */
function whatOf(item: HeadsUpItem, cause: HeadsUp["cause"], texts: AgentTexts): string {
  const premise = item.premise;
  let template: string;
  if (item.reason === "push_lost") template = texts.what.push_lost ?? texts.what.fallback ?? "";
  else if (premise.kind === "check" && cause.type === "revert")
    template = texts.what.check_revert ?? texts.what.fallback ?? "";
  else template = texts.what[item.rule] ?? texts.what.fallback ?? "";

  const diff = item.diff as Diff & { changed_entities?: string[]; code?: string };
  const label = labelOf(premise.kind, premise.key);
  const thing = template.startsWith("{thing}") ? capitalFirst(label) : label;
  const list = Array.isArray(diff.changed_entities) ? diff.changed_entities.join(", ") : "";
  const code = typeof diff.code === "string" ? diff.code : "";
  let sentence = fill(template, { thing, list, code });

  for (const reason of ["triage_depends", "triage_unsure", "triage_unavailable", "reaffirmed"]) {
    const suffix = texts.suffix[reason];
    if (item.reason === reason && suffix !== undefined) sentence += ` ${suffix}`;
  }
  if (item.result === "pending") sentence += ` ${texts.suffix.pending}`;
  if (diff.kind === "file") sentence += ` ${texts.suffix.file_diff}`;
  if (diff.kind === "entity" && diff.before_unavailable === true) sentence += ` ${texts.suffix.before_unavailable}`;
  if (item.truncated === true) sentence += ` ${texts.suffix.truncated}`;
  return sentence;
}

/** One `items` entry of `HeadsUpForModel` (MR7): keys in the order of the table. */
function itemForModel(item: HeadsUpItem, cause: HeadsUp["cause"], texts: AgentTexts): HeadsUpForModel["items"][number] {
  const diff = item.diff;
  const out: Record<string, unknown> = {
    what: whatOf(item, cause, texts),
    before: null,
    after: null,
  };
  if (diff.kind === "entity") {
    out.before = diff.before;
    out.after = diff.after;
  } else if (diff.kind === "file") {
    out.before = null;
    out.after = diff.unified;
  }
  if (diff.kind === "listing") {
    out.added = diff.added;
    out.removed = diff.removed;
  } else if (diff.kind === "query") {
    out.added = diff.added.map((entry) => entry.key);
    out.removed = diff.removed;
    const context = [
      ...diff.added
        .filter((entry) => entry.source !== null)
        .map((entry) => ({ key: entry.key, source: entry.source as string })),
      ...diff.context,
    ];
    if (context.length > 0) out.context = context;
  }
  if (item.result === "pending") out.checking = true;
  out.your_lines = item.uses.map((use) => `${use.path}:${use.line} [${use.entity}] ${use.text}`);
  return out as HeadsUpForModel["items"][number];
}

/**
 * MR6, `toHeadsUpForModel(headsUp)`: the `HeadsUp` of 01-core 8.2 as the model reads it. Fields in the
 * order of 4.10. Nothing is shortened or dropped (MR9, HE3); what the type has no field for — hashes,
 * rule and reason ids, sequence numbers, ids, `wake`, timestamps — is left out.
 */
export function toHeadsUpForModel(headsUp: HeadsUp, texts: AgentTexts = TEXTS): HeadsUpForModel {
  const action = headsUp.result === "info" ? "none" : headsUp.result;
  const cause = headsUp.cause;
  const because = texts.because[cause.type]?.[action] ?? "";
  const changedBy = cause.changes
    .filter((change) => change.intent_text !== null)
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((change) => change.intent_text as string)
    .join(" / ");
  return {
    hn: headsUp.hn,
    action,
    because,
    changed_by: changedBy === "" ? null : changedBy,
    items: headsUp.items.map((item) => itemForModel(item, cause, texts)),
    dropped_edits: headsUp.dropped_ops.map((op) => ({
      path: op.path,
      why: fill(texts.dropped[op.rule] ?? "", { n: String(op.op_seq) }),
    })),
  };
}

/** The `user` message that carries heads-ups (SP5): used for a wake, a resume and TL5, nowhere else. */
export function headsUpUserMessage(headsUps: readonly HeadsUp[], texts: AgentTexts = TEXTS): string {
  return JSON.stringify({ heads_ups: headsUps.map((hu) => toHeadsUpForModel(hu, texts)) });
}
