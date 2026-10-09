// `{braces}` filling (03 5.1 CP5). A placeholder is filled from `FloorState` or from a constant of
// `src/protocol/constants.ts`; constant names and constant expressions like `{MODEL_RETRIES + 1}`
// resolve to their values so no constant is ever typed into a string.

import {
  AGENT_WATCHDOG_MS,
  ATTEMPT_TIMEOUT_MS,
  CHANGE_NAME_CHARS,
  FLOOR_KEEP_LANDINGS,
  GO_AROUND_LIMIT,
  MAX_BATCH,
  MAX_FILE_BYTES,
  MAX_INTENT_CHARS,
  MAX_REAL_AGENTS,
  MAX_REVISIONS,
  MODEL_RETRIES,
  PUSH_REJECT_LIMIT,
  RACE_SIZE,
  UNDO_WINDOW,
} from "../protocol/constants.ts";
import { count, duration } from "./format.ts";

/**
 * One placeholder's value. An array is consumed in order: the copy templates `undo.done`,
 * `about.build`, `about.run.repair` and `replay.position` name the same placeholder twice for two
 * different values, so `vars["landing"] = [9, 12]` fills the earliest `{landing}` with 9 and the
 * second with 12 (03 5.4). `visitor` is the CP7 flag, not a placeholder.
 */
export type CopyVar = string | number | readonly (string | number)[];
export type CopyVars = { visitor?: boolean } & Record<string, CopyVar | boolean | undefined>;

/** Placeholders that are constants or constant expressions, resolved from `constants.ts` (CP5). */
const CONSTANT_FILLS: Readonly<Record<string, () => string>> = {
  GO_AROUND_LIMIT: () => count(GO_AROUND_LIMIT),
  MAX_REVISIONS: () => count(MAX_REVISIONS),
  MAX_INTENT_CHARS: () => count(MAX_INTENT_CHARS),
  MAX_BATCH: () => count(MAX_BATCH),
  UNDO_WINDOW: () => count(UNDO_WINDOW),
  FLOOR_KEEP_LANDINGS: () => count(FLOOR_KEEP_LANDINGS),
  RACE_SIZE: () => count(RACE_SIZE),
  PUSH_REJECT_LIMIT: () => count(PUSH_REJECT_LIMIT),
  MAX_FILE_BYTES: () => count(MAX_FILE_BYTES),
  MAX_REAL_AGENTS: () => count(MAX_REAL_AGENTS),
  CHANGE_NAME_CHARS: () => count(CHANGE_NAME_CHARS),
  "MODEL_RETRIES + 1": () => count(MODEL_RETRIES + 1),
  "ATTEMPT_TIMEOUT_MS as duration": () => duration(ATTEMPT_TIMEOUT_MS),
  "AGENT_WATCHDOG_MS as duration": () => duration(AGENT_WATCHDOG_MS),
};

/**
 * Fill `{braces}`: a name found in `vars` takes it; a constant name takes the constant's value;
 * anything else is a bug in the caller and throws, so the page never shows a raw `{name}`.
 */
/**
 * The value name of a placeholder: the spec annotates some with their value set or join rule —
 * `{cause: undo, the green line, the owner}` names `cause`, `{flags, joined by ", "}` names
 * `flags`, `{changeName of `behind`}` names `behind`. The name is the part before the first
 * `:` or `,`, minus a trailing `of …` clause.
 */
function varName(placeholder: string): string {
  const base = placeholder.split(/[:,(]/)[0]!.trim();
  const of = base.match(/^(.*?) of `?[a-zA-Z_]+`?$/);
  return of ? of[1]! : base;
}

export function fill(template: string, vars: CopyVars = {}): string {
  const taken = new Map<string, number>();
  return template.replace(/\{([^{}]+)\}/g, (_match, placeholder: string) => {
    const name = varName(placeholder);
    const value = vars[name];
    if (typeof value === "string") return value;
    if (typeof value === "number") return Number.isInteger(value) ? count(value) : String(value);
    if (Array.isArray(value)) {
      const i = taken.get(name) ?? 0;
      taken.set(name, i + 1);
      const v = value[i];
      if (v === undefined) {
        throw new Error(`copy: {${name}} needs ${i + 1} values but ${value.length} were given`);
      }
      return typeof v === "number" && Number.isInteger(v) ? count(v) : String(v);
    }
    const constant = CONSTANT_FILLS[name] ?? CONSTANT_FILLS[placeholder];
    if (constant !== undefined) return constant();
    throw new Error(`copy: no value for placeholder {${placeholder}}`);
  });
}

/** The placeholder names a template carries, in order of appearance. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? "");
}
