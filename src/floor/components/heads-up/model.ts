// The view model of one heads-up panel (03-floor 3.4): title, cause line, one block per item,
// the dropped edits and the closing line (the agent's statement, `headsup.waits` or
// `headsup.nothing_to_do`). Pure functions of `HeadsUpView` and the attempt — every sentence is
// a copy lookup (5.6), every pool string is carried as text (FL8).

import type { HeadsUpItem } from "../../../protocol/headsup.ts";
import type { AttemptView, HeadsUpView } from "../../../protocol/reducer/state.ts";
import { fill } from "../../../copy/fill.ts";
import { DASH, landingLabel, share } from "../../../copy/format.ts";
import { greenCheckLabel } from "../../../copy/checks.ts";
import { keyLabel } from "../../../copy/names.ts";
import { judgmentSentence } from "../../../copy/sentences.ts";
import { text } from "../../../copy/strings.ts";

/** The edge colour of the panel (3.4): repair red, confirm amber, info neutral, resolved holds. */
export type HeadsUpTone = "changed" | "confirm" | "neutral" | "holds";

/** One use line of `headsup.uses`: the attempt's own line that names the key (01-core 8.2). */
export type UseLine = { path: string; line: number; text: string };

/** One item block of the panel, by `diff.kind` (3.4). Strings are display-ready. */
export type ItemBlock = {
  /** The item's own key label (e.g. "ENERGY_MAX in world/energy.js"). */
  label: string;
  /** The rule sentence of 5.6 (the judgment rows; `pending` items keep the pending row). */
  sentence: string;
  kind: HeadsUpItem["diff"]["kind"];
  /** entity diff: the two sources, `headsup.before_unavailable` when the before is gone. */
  before: string | null;
  after: string | null;
  beforeUnavailable: boolean;
  /** file diff: the unified text under the before/after marks. */
  unified: string | null;
  /** listing/query diffs: member lists as `keyLabel`s, each query entry with its source. */
  added: string[];
  removed: string[];
  context: string[];
  /** check diff: the check's label (5.7). */
  checkLabel: string | null;
  uses: UseLine[];
  truncated: boolean;
};

export type HeadsUpModel = {
  hn: number;
  title: string;
  tone: HeadsUpTone;
  /** The cause line of the panel (`headsup.cause*`), by `cause.type`. */
  cause: string;
  /** The item blocks, or null when `items` is null (a `summary_only` pool, 3.4 error row). */
  items: ItemBlock[] | null;
  /** For `items === null`: the rule sentence of each key, and `headsup.no_diff` follows. */
  keySentences: string[];
  /** The `headsup.dropped` lines of the heads-up's `dropped_ops`. */
  dropped: string[];
  /** The closing line: `headsup.said`, `headsup.waits`, `headsup.nothing_to_do`, or null. */
  tail: { id: string; sentence: string } | null;
};

/** The cause line (3.4): `headsup.cause` names the landing's intent; undo and revert have their own. */
function causeLine(headsup: HeadsUpView): string {
  const cause = headsup.cause;
  switch (cause.type) {
    case "submit":
      return text("headsup.cause.submit");
    case "undo":
      return text("headsup.cause.undo", { landing: landingLabel(cause.seqs[0] ?? 0) });
    case "revert":
      return text("headsup.cause.revert", {
        landings: cause.seqs.map((seq) => landingLabel(seq)).join(", "),
      });
    default: {
      // `landing`: the triggering change's own intent text and seq (cause.changes[0]).
      const first = cause.changes[0];
      return text("headsup.cause", {
        "intent text": first?.intent_text ?? "",
        landing: landingLabel(first?.seq ?? cause.seqs[0] ?? 0),
      });
    }
  }
}

/** The item's rule sentence (5.6): pending keeps its pending row; everything else judges. */
function itemSentence(item: HeadsUpItem, scripted: boolean): string {
  return fill(judgmentSentence(item.rule, item.reason, scripted), {
    thing: keyLabel(item.premise.kind, item.premise.key),
    share: DASH, // an item's judgment names no share; Clef's p lives on the premise's judgment
    path: item.premise.key,
    entity:
      item.premise.kind === "query" && item.premise.key.startsWith("refs:")
        ? keyLabel("entity", item.premise.key.slice(5))
        : keyLabel(item.premise.kind, item.premise.key),
    added:
      item.diff.kind === "query"
        ? item.diff.added.map((entry) => keyLabel("entity", entry.key)).join(", ")
        : keyLabel(item.premise.kind, item.premise.key),
    rule: item.rule,
    reason: item.reason,
  });
}

/** One item as a block (3.4), by the kind of its `diff`. */
function itemBlock(item: HeadsUpItem, scripted: boolean): ItemBlock {
  const diff = item.diff;
  const source = (s: string | null): string => (s === null ? "" : ` (${s})`);
  return {
    label: keyLabel(item.premise.kind, item.premise.key),
    sentence: itemSentence(item, scripted),
    kind: diff.kind,
    before: diff.kind === "entity" ? diff.before : null,
    after: diff.kind === "entity" ? diff.after : null,
    beforeUnavailable: diff.kind === "entity" && diff.before_unavailable === true,
    unified: diff.kind === "file" ? diff.unified : null,
    added:
      diff.kind === "listing"
        ? diff.added
        : diff.kind === "query"
          ? diff.added.map((entry) => `${keyLabel("entity", entry.key)}${source(entry.source)}`)
          : [],
    removed:
      diff.kind === "listing"
        ? diff.removed
        : diff.kind === "query"
          ? diff.removed.map((key) => keyLabel("entity", key))
          : [],
    context:
      diff.kind === "query"
        ? diff.context.map((entry) => `${keyLabel("entity", entry.key)}${source(entry.source)}`)
        : [],
    checkLabel: diff.kind === "check" ? greenCheckLabel(diff.check, diff.code) : null,
    uses: item.uses.map((use) => ({ path: use.path, line: use.line, text: use.text })),
    truncated: item.truncated === true,
  };
}

/** The whole panel (3.4). `attempt.state === "stopped"` marks the `headsup.waits` row. */
export function headsUpModel(headsup: HeadsUpView, attempt: AttemptView): HeadsUpModel {
  const scripted = attempt.agent === "synthetic";
  const tone: HeadsUpTone =
    headsup.resolved !== null
      ? "holds"
      : headsup.result === "repair"
        ? "changed"
        : headsup.result === "confirm"
          ? "confirm"
          : "neutral";
  const titleId =
    headsup.result === "repair"
      ? "headsup.title.repair"
      : headsup.result === "confirm"
        ? "headsup.title.confirm"
        : "headsup.title.info";
  const tail: HeadsUpModel["tail"] =
    headsup.resolved !== null
      ? { id: "headsup.said", sentence: text("headsup.said", { statement: headsup.resolved.statement }) }
      : attempt.state === "stopped"
        ? { id: "headsup.waits", sentence: text("headsup.waits") }
        : headsup.result === "info"
          ? { id: "headsup.nothing_to_do", sentence: text("headsup.nothing_to_do") }
          : null;
  const keySentences =
    headsup.items === null
      ? headsup.keys.map((key) =>
          fill(judgmentSentence(key.rule, null), {
            thing: keyLabel(key.kind, key.key),
            share: DASH,
            path: key.key,
            entity: keyLabel(key.kind, key.key),
            added: keyLabel(key.kind, key.key),
            rule: key.rule,
            reason: "",
          }),
        )
      : [];
  return {
    hn: headsup.hn,
    title: text(titleId, { hn: headsup.hn, n: headsup.go_around ?? 1 }),
    tone,
    cause: causeLine(headsup),
    items: headsup.items === null ? null : headsup.items.map((item) => itemBlock(item, scripted)),
    keySentences,
    dropped: headsup.dropped_ops.map((op) => text("headsup.dropped", { path: op.path })),
    tail,
  };
}
