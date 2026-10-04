// Id prefixes and the ids that are built from other values.
// Source: 01-core 1 (glossary), 4.8 (`call_id`), 4.9 (`submit_id`).

/** Every id begins with a two-letter prefix, then the ULID (01-core 1). */
export const ID_PREFIX = {
  intent: "i_",
  attempt: "a_",
  change: "c_",
  submit: "s_",
  card: "k_",
  headsup: "h_",
  reservation: "r_",
  preview: "p_",
} as const;

/** The id of a tool call: `<attempt_id>:<step>` (4.8). Unique inside its attempt. */
export function callId(attemptId: string, step: number): string {
  return `${attemptId}:${step}`;
}

/**
 * The id of a submission (4.9): the first sixteen characters of the hash of
 * `attempt_id + "|" + revision + "|" + lastOpSeq + "|" + resolved.join(",")`, with `resolved` sorted.
 * `hash` is the same `H` the engine uses (a full hex digest — 64 characters is fine).
 */
export function submitId(
  hash: (text: string) => string,
  input: { attemptId: string; revision: number; lastOpSeq: number; resolved: number[] },
): string {
  const resolved = [...input.resolved].sort((a, b) => a - b).join(",");
  return `${ID_PREFIX.submit}${hash(`${input.attemptId}|${input.revision}|${input.lastOpSeq}|${resolved}`).substring(0, 16)}`;
}
