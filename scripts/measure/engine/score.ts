// One engine run's `RunRecord` (6.8) from its `Observation` and the landed commit's files. The
// outcome words are the engine rows of ME8: `landed` only from the stream (a `landing.landed` of
// the first attempt, no card action, no second attempt); `not_counted` when the creature landed
// before the heads-up that ME7 requires. The hero class and the energy checks reuse the early
// variant's pure scorers — nothing here executes the model's code (ME6).

import { ATTEMPT_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import { GUIDE_PATH } from "../../../src/protocol/agent-prompt.ts";
import type { Note } from "../../../src/protocol/note.ts";
import { classifyHero, referencesEnergyMax } from "../early/score.ts";
import type { IntentSpec } from "../early/intents.ts";
import type { RunRecord } from "../early/run.ts";
import { passingSubmit, type Observation, type HeadsUpObs } from "./observe.ts";

export type ConfirmWindow = {
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  ms: number;
};

export type ScoredRun = {
  record: RunRecord;
  /** ME7: the run counts for its set's measure. `additive`/`shared` runs always count. */
  counted: boolean;
  /** Set `confirm`: the headsup.sent -> headsup.resolved window of the E2m item, if it resolved. */
  confirm: ConfirmWindow | null;
  rateLimited: number;
};

const RETRIED = new Set(["model_rate_limited", "model_timeout", "model_unavailable", "model_bad_output"]);

/** `waited_ms`: the waits of TL12 are not events; the gap between a failed model try's step and the
 * next step's call start (`ts` of the next step minus its `ms`) is the wait. Only model turns. */
function waitedMs(obs: Observation): number {
  const model = obs.steps.filter((s) => s.tool === null);
  let waited = 0;
  for (let i = 1; i < model.length; i++) {
    const prev = model[i - 1] as StepObs;
    const next = model[i] as StepObs;
    if (prev.error !== null && RETRIED.has(prev.error)) {
      waited += Math.max(0, next.ts - next.ms - prev.ts);
    }
  }
  return waited;
}

type StepObs = Observation["steps"][number];

/** The heads-up ME7 counts a run by: `repair` for `hero`, `confirm` with rule E2m for `confirm`. */
function qualifyingHeadsUp(obs: Observation, spec: IntentSpec): HeadsUpObs | undefined {
  if (spec.set === "hero") return obs.headsUps.find((h) => h.result === "repair");
  if (spec.set === "confirm") {
    return obs.headsUps.find((h) => h.result === "confirm" && h.keys.some((k) => k.rule === "E2m"));
  }
  return undefined;
}

/**
 * `before`: the creature file as the heads-up found it — the run's own operations replayed in
 * order, up to the ones recorded before `headsup.sent`. The ops' texts come from the landing's
 * note (`NT1`); an op already dropped anywhere is not in the note and does not count toward the
 * boundary. `null` when the text cannot be reconstructed (no note, an oid-form replace of NT2, or
 * a stale `old`).
 */
function beforeSource(opts: {
  obs: Observation;
  note: Note | null;
  creaturePath: string;
  hu: HeadsUpObs;
  files: Record<string, string>;
  seedFiles: ReadonlyMap<string, string>;
}): string | null {
  const { obs, note, creaturePath, hu, files, seedFiles } = opts;
  if (note === null) return null;
  const recordedBefore = obs.opsRecorded.filter(
    (o) => o.path === creaturePath && o.n < hu.n && !obs.opsDropped.has(o.op_seq),
  ).length;
  const onPath = note.ops.filter((o) => o.path === creaturePath);
  if (onPath.length < recordedBefore) return null;
  let current: string | undefined = seedFiles.get(creaturePath);
  for (const op of onPath.slice(0, recordedBefore)) {
    if (op.op === "write") {
      if ("delete" in op && op.delete === true) current = undefined;
      else if ("content" in op) current = op.content;
      else current = files[creaturePath]; // `blob`: this write is the file's final content
    } else {
      // replace: `targets` bound `old` to entities; the replay applies the first occurrence.
      if (!("old" in op) || current === undefined) return null;
      const at = current.indexOf(op.old);
      if (at < 0) return null;
      current = current.slice(0, at) + op.new + current.slice(at + op.old.length);
    }
  }
  return current ?? null;
}

/** The creature file the run wrote: the intent's Writes path when it landed, else the first
 * `creatures/*.js` among the recorded ops (a model may name its kind file differently). */
function creaturePathOf(obs: Observation, spec: IntentSpec): string {
  const written = obs.opsRecorded.map((o) => o.path);
  if (written.includes(spec.writes)) return spec.writes;
  return written.find((p) => /^creatures\/[^/]+\.js$/.test(p)) ?? spec.writes;
}

/**
 * The record of one attempt of one run. `files` is the landed commit's text of every path the run
 * wrote (empty when the run never landed); `ended` is how the watch loop closed.
 */
export function scoreRun(opts: {
  obs: Observation;
  spec: IntentSpec;
  runIndex: number;
  files: Record<string, string>;
  seedFiles: ReadonlyMap<string, string>;
  ended: "landed" | "stopped" | "paused" | "deadline";
}): ScoredRun {
  const { obs, spec, ended } = opts;
  const hu = qualifyingHeadsUp(obs, spec);
  // ME7: a hero/confirm run in which the creature landed without its heads-up is `not_counted`.
  const landedBeforeHeadsUp =
    (spec.set === "hero" || spec.set === "confirm") &&
    obs.accepted !== null &&
    (hu === undefined || hu.n > obs.accepted.n);
  const counted = !landedBeforeHeadsUp;

  let outcome: RunRecord["outcome"];
  if (landedBeforeHeadsUp) {
    outcome = "not_counted";
  } else if (obs.landed !== null && obs.openedCount === 1 && obs.ownerCardActions === 0) {
    outcome = "landed";
  } else {
    outcome = "not_completed";
  }

  const stopReason =
    obs.stopped !== null
      ? (obs.stopped.reason ?? "stopped")
      : ended === "paused"
        ? `paused:${obs.paused?.reason ?? "unknown"}`
        : ended === "deadline"
          ? "timeout"
          : null;

  const modelSteps = obs.steps.filter((s) => s.tool === null);
  const toolSteps = obs.steps.filter((s) => s.tool !== null);
  const countedCalls = modelSteps.filter((s) => s.error !== "model_rate_limited");
  const firstOkTool = toolSteps.find((s) => s.ok);
  const wholeFileReads = new Set<string>();
  for (const s of toolSteps) {
    if (s.tool === "read" && s.ok && s.target !== null && !s.target.includes("#")) {
      wholeFileReads.add(s.target);
    }
  }
  const writtenPaths = new Set(obs.opsRecorded.map((o) => o.path));
  for (const path of writtenPaths) wholeFileReads.delete(path);

  // The hero block (ME8): only when the run counts and the intent is a hero intent.
  let hero: RunRecord["hero"] = null;
  if (spec.set === "hero" && outcome !== "not_counted") {
    const creaturePath = creaturePathOf(obs, spec);
    let note: Note | null = null;
    if (obs.landed?.note_json != null) {
      try {
        note = JSON.parse(obs.landed.note_json) as Note;
      } catch {
        note = null;
      }
    }
    const firstSubmitPassed = obs.submits.some((s) => passingSubmit(s.status));
    const before =
      hu === undefined
        ? null
        : beforeSource({ obs, note, creaturePath, hu, files: opts.files, seedFiles: opts.seedFiles });
    const finalSource = opts.files[creaturePath] ?? null;
    const secondSubmitPassed = hu !== undefined && obs.submits.some((s) => passingSubmit(s.status) && s.n > hu.n);
    const cls = classifyHero({
      intent: spec.id as "P1a" | "P1b",
      creaturePath,
      firstSubmitPassed,
      before,
      finalSource,
      secondSubmitPassed,
    });
    const resolved = hu === undefined ? undefined : obs.resolved.find((r) => r.hn === hu.n);
    const repairSubmit = hu === undefined ? undefined : obs.submits.find((s) => passingSubmit(s.status) && s.n > hu.n);
    hero = {
      class: cls,
      judged_by: cls === "unclear" ? "person" : "rule",
      before,
      statement: resolved?.statement ?? null,
      repair_ms: hu !== undefined && repairSubmit !== undefined ? repairSubmit.ts - hu.ts : null,
    };
  }

  // The confirm window of 6.6 (E2m): headsup.sent -> headsup.resolved.
  let confirm: ConfirmWindow | null = null;
  if (spec.set === "confirm" && counted && hu !== undefined) {
    const resolved = obs.resolved.find((r) => r.hn === hu.n && r.result === "confirm");
    if (resolved !== undefined) {
      const inside = obs.steps.filter((s) => s.ts >= hu.ts && s.ts <= resolved.ts);
      confirm = {
        model_calls: inside.filter((s) => s.tool === null && s.error !== "model_rate_limited").length,
        tokens_in: inside.reduce((sum, s) => sum + (s.tokens_in ?? 0), 0),
        tokens_out: inside.reduce((sum, s) => sum + (s.tokens_out ?? 0), 0),
        cost_usd: inside.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0),
        ms: resolved.ts - hu.ts,
      };
    }
  }

  const record: RunRecord = {
    intent: spec.id,
    run: opts.runIndex,
    outcome,
    stop_reason: stopReason,
    seconds: obs.landed !== null && obs.intentCreatedTs !== null ? (obs.landed.ts - obs.intentCreatedTs) / 1000 : null,
    waited_ms: waitedMs(obs),
    model_calls: countedCalls.length,
    tool_calls: toolSteps.length,
    tool_errors: toolSteps.filter((s) => !s.ok).length,
    nudges: modelSteps.filter((s) => s.error === "no_tool_call").length,
    tokens_in: modelSteps.reduce((sum, s) => sum + (s.tokens_in ?? 0), 0),
    tokens_out: modelSteps.reduce((sum, s) => sum + (s.tokens_out ?? 0), 0),
    cost_usd: modelSteps.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0),
    first_tool:
      firstOkTool === undefined
        ? null
        : firstOkTool.tool === "read" && firstOkTool.target === GUIDE_PATH
          ? "read GUIDE.md"
          : firstOkTool.tool,
    whole_file_reads: [...wholeFileReads].sort(),
    files: opts.files,
    hero,
  };
  return {
    record,
    counted: outcome !== "not_counted",
    confirm,
    rateLimited: modelSteps.filter((s) => s.error === "model_rate_limited").length,
  };
}

export { ATTEMPT_TIMEOUT_MS };
