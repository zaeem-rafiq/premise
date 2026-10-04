// Shared protocol helpers of the scripted patterns (02-tidepool.md 10.3, SW6 and SW8): the fresh
// creature name, tool-result and submit shaping, and the `ENERGY_MAX`/threshold arithmetic the
// energy patterns and the SW2 oracle share. Pure helpers: no clock, no randomness (SY1, SY2).

/** The first free `creatures/s<number>.js` name in the listing, number zero-padded to at least 4
 * digits (02 10.2). */
export function freshName(entries: readonly string[]): string {
  const used = new Set<number>();
  for (const entry of entries) {
    const match = /^s(\d+)\.js$/.exec(entry);
    if (match !== null) used.add(Number(match[1]));
  }
  let n = 0;
  while (used.has(n)) n += 1;
  return `creatures/s${String(n).padStart(4, "0")}.js`;
}

/** The `name` of each `type: "file"` entry of a `list` result. */
export function fileNamesOf(result: object | undefined): string[] {
  if (result === undefined || !("entries" in result)) return [];
  const { entries } = result as { entries: unknown };
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (entry): entry is { name: string; type: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        (entry as { type?: unknown }).type === "file",
    )
    .map((entry) => entry.name);
}

/** The `status` of a `submit` result, or null when the result is not a submit answer. */
export function submitStatus(result: object | undefined): string | null {
  const status = (result as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : null;
}

/** The `acknowledge` and `statement` fields the next `submit` carries (01-core 4.9, CK1). */
export function submitFields(acks: ReadonlyArray<{ hn: number; statement: string }>): {
  acknowledge?: number[];
  statement?: string;
} {
  if (acks.length === 0) return {};
  const hns = [...new Set(acks.map((ack) => ack.hn))].sort((a, b) => a - b);
  const statements = [...new Set(acks.map((ack) => ack.statement))];
  return { acknowledge: hns, statement: statements.join("; ") };
}

/** The entity key `world/bounds.js#bounce` as `read` arguments. */
export function readArgsOf(key: string): { path: string; entity: string } {
  const cut = key.lastIndexOf("#");
  return { path: key.slice(0, cut), entity: key.slice(cut + 1) };
}

/**
 * The value of `ENERGY_MAX` in a source text: the entity's `source` of a `read` result, the
 * `after` of an entity diff, or a whole file of `world/energy.js`. Null when there is no
 * `ENERGY_MAX = <number>` declaration.
 */
export function energyMaxOf(source: string | null | undefined): number | null {
  if (typeof source !== "string") return null;
  const match = /\bENERGY_MAX\s*=\s*(\d+(?:\.\d+)?)/.exec(source);
  return match === null ? null : Number(match[1]);
}

/** `0.3 x V` as the literal the pattern writes (02 10.3: "the text `30` or `0.3`"). */
export function thresholdText(v: number): string {
  return String((v * 3) / 10);
}

/** The `source` of a `read`-entity result, or null for a whole-file result or an error. */
export function sourceOf(result: object | undefined): string | null {
  const source = (result as { source?: unknown } | undefined)?.source;
  return typeof source === "string" ? source : null;
}
