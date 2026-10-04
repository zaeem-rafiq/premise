// Regenerates src/floor/replay/recordings.ts from the canonical fixture files. Replay embeds
// byte-exact copies of tracer, hero-c04 and hero-c05 so the page plays a recording with no
// server; recordings.test.ts pins every entry to test/fixtures/streams/<id>.ndjson.
// Run after write-streams.ts whenever those three fixtures change:
//   node scripts/fixtures/embed-recordings.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const STREAMS = join(ROOT, "test/fixtures/streams");
const OUT = join(ROOT, "src/floor/replay/recordings.ts");

/** The recordings Replay embeds, in the order they appear in the file. `tracer` is a valid
 * identifier and is written unquoted, matching the file's house style. */
const IDS = ["tracer", "hero-c04", "hero-c05"];

const HEADER = `// The streams of \`test/fixtures/streams/\`, embedded so Replay plays a recording with no server
// running (\`npm run dev:floor\`, \`vite preview\`): \`GET /replay/index.json\` and the recording file
// are static assets of the deployment (RY6) that this build does not serve, so the page falls back
// to these bytes for the fixture ids. \`recordings.test.ts\` checks every entry is byte-equal to the
// canonical file, so the copy cannot drift from the stream lane's fixtures.
//
// Generated from the fixture files - do not edit by hand.

/** Embedded recording id to the file's exact bytes (UTF-8 NDJSON). */
export const RECORDING_TEXTS: Readonly<Record<string, string>> = {
`;

/** A JS single-quoted string literal of `text` (the file's exact bytes): backslash,
 * newline and the single quote are the only escapes a single-quoted literal needs. */
function literal(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/'/g, "\\'")}'`;
}

const entries = IDS.map((id) => {
  const text = readFileSync(join(STREAMS, `${id}.ndjson`), "utf8");
  const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id) ? id : `"${id}"`;
  return `  ${key}:\n    ${literal(text)},\n`;
});

writeFileSync(OUT, HEADER + entries.join("") + "};\n");
console.log(`wrote ${OUT} (${IDS.join(", ")})`);
