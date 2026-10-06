// `npm run record:export` (04-build-plan 2.10): downloads the owner-only export
// `GET /api/pools/{pool}/replay.ndjson` (01-core 13.6) and commits it as a judge-facing
// static asset — `<out>/<id>.ndjson` byte for byte, plus the `<out>/index.json` list of 8.2.
//
//   npm run record:export -- --pool <pool> --id <id> --title "<title>" [--origin <url>] [--out <dir>]
//
// `<id>` is one of the four fixed ids of 8.2 (`hero`, `rehearsal`, `hero-canned`, `swarm`).
// `--origin` defaults to `PREMISE_URL`; the owner key comes from `PREMISE_OWNER_KEY` and is
// never printed or written (BP7). `build` is the full commit id of `git rev-parse HEAD`.
//
// The download runs the page's own checks before it is written: `parseRecording` of
// src/floor/replay/player.ts (every check of 03-floor 8.3) and the `REPLAY_MAX_BYTES` limit
// of RY6 on the raw bytes. A refusal prints the check's sentence and writes nothing.
// RY27 is checked against the file's own header: a `synthetic: true` recording's title
// must say "scripted agents"; a real one's must not.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRecording,
  replayTimes,
  type RecordingEntry,
  type RecordingIndex,
} from "../../src/floor/replay/player.ts";
import { REPLAY_MAX_BYTES } from "../../src/protocol/constants.ts";
import { replayError } from "../../src/copy/replay.ts";

/** The four recording ids of 03-floor 8.2, in their fixed order. */
export const RECORDING_IDS = ["hero", "rehearsal", "hero-canned", "swarm"] as const;
export type RecordingId = (typeof RECORDING_IDS)[number];

const USAGE =
  'usage: npm run record:export -- --pool <pool> --id <id> --title "<title>" [--origin <url>] [--out <dir>]\n' +
  `       --id is one of ${RECORDING_IDS.join(", ")}; --origin defaults to PREMISE_URL; --out to public/replay\n` +
  "       needs PREMISE_OWNER_KEY in the environment (never printed, never written)";

export type ExportDeps = {
  /** The fetch seam — the tests fake it; nothing else calls the network. */
  get?: typeof fetch;
  /** The recording's `build`: the full commit id. Default: `git rev-parse HEAD`. */
  commit?: () => string;
  /** Environment: PREMISE_URL and PREMISE_OWNER_KEY. Default: process.env. */
  env?: Record<string, string | undefined>;
};

export type ExportResult = { code: number; message: string };

/** The args → options parse. A refusal names what is missing, never a secret. */
function parseArgs(
  args: readonly string[],
  env: Record<string, string | undefined>,
):
  | { ok: true; pool: string; id: RecordingId; title: string; origin: string; outDir: string }
  | { ok: false; message: string } {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) return { ok: false, message: USAGE };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: USAGE };
    opts[arg.slice(2)] = value;
    i += 1;
  }
  const { pool, id, title, origin = env.PREMISE_URL, out = "public/replay" } = opts;
  if (pool === undefined || id === undefined || title === undefined || title === "") {
    return { ok: false, message: USAGE };
  }
  if (!(RECORDING_IDS as readonly string[]).includes(id)) {
    return { ok: false, message: `record:export: --id must be one of ${RECORDING_IDS.join(", ")}` };
  }
  if (origin === undefined || origin === "") {
    return { ok: false, message: "record:export: --origin or PREMISE_URL is required\n" + USAGE };
  }
  return { ok: true, pool, id: id as RecordingId, title, origin: origin.replace(/\/+$/, ""), outDir: out };
}

/**
 * `recordings[]` in the fixed order of 8.2; an entry of another id (the file predates this
 * build) is kept unchanged after them, in its existing order.
 */
function orderedEntries(entries: readonly RecordingEntry[]): RecordingEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const fixed = RECORDING_IDS.map((id) => byId.get(id)).filter((e): e is RecordingEntry => e !== undefined);
  const rest = entries.filter((entry) => !(RECORDING_IDS as readonly string[]).includes(entry.id));
  return [...fixed, ...rest];
}

/** `default` of the index (RY26): `hero` once deployed, `rehearsal` before it; the first
 * entry in the fixed order when neither is present (the specification is silent there). */
function pickDefault(entries: readonly RecordingEntry[]): string {
  const present = new Set(entries.map((entry) => entry.id));
  if (present.has("hero")) return "hero";
  if (present.has("rehearsal")) return "rehearsal";
  const first = orderedEntries(entries)[0];
  return first === undefined ? "" : first.id;
}

/**
 * The command itself. `code` is the exit code; `message` is the one line the command
 * reports — it never carries the key, the recording's bytes or a refused line.
 */
export async function runExport(args: readonly string[], deps: ExportDeps = {}): Promise<ExportResult> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(args, env);
  if (!parsed.ok) return { code: 1, message: parsed.message };
  const { pool, id, title, origin, outDir } = parsed;

  const key = env.PREMISE_OWNER_KEY;
  if (key === undefined || key === "") {
    return { code: 1, message: "record:export: PREMISE_OWNER_KEY is not set\n" + USAGE };
  }

  let build: string;
  try {
    build = (deps.commit ?? (() => execSync("git rev-parse HEAD", { encoding: "utf8" }).trim()))();
  } catch {
    return { code: 1, message: "record:export: `git rev-parse HEAD` failed — run inside the checkout" };
  }

  const url =
    `${origin}/api/pools/${encodeURIComponent(pool)}/replay.ndjson` +
    `?label=${encodeURIComponent(title)}&build=${encodeURIComponent(build)}`;
  const get = deps.get ?? fetch;
  let response: Response;
  try {
    response = await get(url, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    return { code: 1, message: "record:export: the export could not be downloaded" };
  }

  if (response.status === 409) {
    // RP1: the refusal names the line number and the pattern family — never the line.
    const body = (await response.json().catch(() => null)) as {
      error?: { line?: number; family?: string };
    } | null;
    const line = body?.error?.line ?? "?";
    const family = body?.error?.family ?? "unknown";
    return {
      code: 1,
      message: `record:export: the exporter refused — line ${line} matches a ${family} pattern (RP1); nothing was written`,
    };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code === undefined ? "" : ` (${body.error.code})`;
    return { code: 1, message: `record:export: the export answered ${response.status}${code}; nothing was written` };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  // RY6: the limit is on the file's bytes, checked before the text is even decoded.
  if (bytes.byteLength > REPLAY_MAX_BYTES) {
    return { code: 1, message: `record:export: ${replayError("too_large")}` };
  }
  const recording = parseRecording(new TextDecoder().decode(bytes));
  if (!recording.ok) {
    return { code: 1, message: `record:export: ${replayError(recording.failure.check, recording.failure.vars)}` };
  }
  const { header, events } = recording.recording;

  // RY27: a scripted run's title says "scripted agents"; a real run's never does.
  const saysScripted = header.label.includes("scripted agents");
  if (header.synthetic && !saysScripted) {
    return {
      code: 1,
      message: `record:export: "${id}" is a scripted run (synthetic: true); its title must say "scripted agents" (RY27)`,
    };
  }
  if (!header.synthetic && saysScripted) {
    return {
      code: 1,
      message: `record:export: "${id}" is not a scripted run; its title must not say "scripted agents" (RY27)`,
    };
  }

  const times = replayTimes(events);
  const entry: RecordingEntry = {
    id,
    file: `/replay/${id}.ndjson`,
    title: header.label,
    duration_ms: (times[times.length - 1] ?? 0) - (times[0] ?? 0),
    events: events.length,
    bytes: bytes.byteLength,
    synthetic: header.synthetic,
    recorded_at: header.recorded_at,
  };

  const indexPath = join(outDir, "index.json");
  let kept: RecordingEntry[] = [];
  if (existsSync(indexPath)) {
    let prior: RecordingIndex;
    try {
      prior = JSON.parse(readFileSync(indexPath, "utf8")) as RecordingIndex;
    } catch {
      return { code: 1, message: `record:export: ${indexPath} is not readable JSON; refusing to overwrite it` };
    }
    kept = (prior.recordings ?? []).filter((other) => other.id !== id);
  }
  const recordings = orderedEntries([...kept, entry]);
  const index: RecordingIndex = { v: 1, default: pickDefault(recordings), recordings };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${id}.ndjson`), bytes); // byte for byte as downloaded
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return {
    code: 0,
    message:
      `record:export: wrote ${join(outDir, `${id}.ndjson`)} (${bytes.byteLength} bytes, ` +
      `${events.length} events) and ${indexPath} (default: ${index.default})`,
  };
}

// `node scripts/recordings/export.ts` (the `record:export` script): argv, then the result's
// one line — stderr on refusal, stdout on success.
const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("export.ts");
if (isMain) {
  void runExport(process.argv.slice(2)).then(({ code, message }) => {
    if (code === 0) console.log(message);
    else console.error(message);
    process.exitCode = code;
  });
}
