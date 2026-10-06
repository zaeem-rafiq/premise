// `record:export` (scripts/recordings/export.ts) with a fake `fetch` — no network, no git.
// The served bodies are the canonical fixtures under test/fixtures/streams/; the expected
// index fields are read off the fixtures' own headers and event times (8.2, RY26, RY27).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPLAY_MAX_BYTES } from "../../src/protocol/constants.ts";
import { runExport, type ExportDeps } from "./export.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STREAMS = join(ROOT, "test/fixtures/streams");
const TMP = join(ROOT, ".tmp-test", "record-export-");

const HERO = readFileSync(join(STREAMS, "hero-c04.ndjson"), "utf8"); // synthetic: false, 47 events
const SYNTHETIC = readFileSync(join(STREAMS, "pool-synthetic.ndjson"), "utf8"); // synthetic: true

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ENV = { PREMISE_URL: "https://premise.test", PREMISE_OWNER_KEY: "test-key-never-real" };

/** A fresh output directory per test, inside `.tmp-test/` — unique per run. */
function outDir(): string {
  return mkdtempSync(TMP);
}

/** A fake `fetch` answering `body` with `status`; records the request it got. */
function fakeFetch(
  body: string | Uint8Array,
  status = 200,
): { get: typeof fetch; seen: { url: string; auth: string | null }[] } {
  const seen: { url: string; auth: string | null }[] = [];
  const get = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    seen.push({ url: String(input), auth: headers.authorization ?? headers.Authorization ?? null });
    return new Response(body, { status });
  }) as typeof fetch;
  return { get, seen };
}

const deps = (get: typeof fetch, env: Record<string, string | undefined> = ENV): ExportDeps => ({
  get,
  env,
  commit: () => COMMIT,
});

const run = (args: string[], d: ExportDeps) => runExport(["--pool", "tidepool", "--title", "a real run", ...args], d);

describe("record:export", () => {
  it("writes <id>.ndjson byte for byte and the index entry derived from the file (8.2)", async () => {
    const dir = outDir();
    const { get, seen } = fakeFetch(HERO);
    const result = await run(["--id", "hero", "--out", dir], deps(get));
    expect(result.code).toBe(0);

    // The request: the export route of the pool, label and the commit as build, Bearer auth.
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/api/pools/tidepool/replay.ndjson");
    expect(url.searchParams.get("label")).toBe("a real run");
    expect(url.searchParams.get("build")).toBe(COMMIT);
    expect(seen[0]!.auth).toBe("Bearer test-key-never-real");

    // Byte for byte as downloaded.
    const written = readFileSync(join(dir, "hero.ndjson"));
    expect(Buffer.compare(written, Buffer.from(HERO, "utf8"))).toBe(0);

    // The index entry is derived from the file's own header and event times.
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
      v: number;
      default: string;
      recordings: Record<string, unknown>[];
    };
    expect(index.v).toBe(1);
    expect(index.recordings).toEqual([
      {
        id: "hero",
        file: "/replay/hero.ndjson",
        title: "hero-c04: shared rule lands first",
        duration_ms: 11_000, // last replay time minus the first on the fixture (RY13)
        events: 47,
        bytes: 13_028,
        synthetic: false,
        recorded_at: "2024-01-01T00:01:00.000Z",
      },
    ]);
    expect(index.default).toBe("hero"); // RY26
  });

  it("RY26: rehearsal is the default before hero is exported; entries keep the fixed order", async () => {
    const dir = outDir();
    const { get } = fakeFetch(HERO);
    const d = deps(get);
    expect((await run(["--id", "rehearsal", "--out", dir], d)).code).toBe(0);
    let index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
      default: string;
      recordings: { id: string; title?: string }[];
    };
    expect(index.default).toBe("rehearsal");
    expect((await run(["--id", "hero", "--out", dir], d)).code).toBe(0);
    index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
      default: string;
      recordings: { id: string; title?: string }[];
    };
    expect(index.recordings.map((entry) => entry.id)).toEqual(["hero", "rehearsal"]);
    expect(index.default).toBe("hero");
    expect(index.recordings[1]!.title).toBe("hero-c04: shared rule lands first");
  });

  it("keeps the entries of other ids unchanged and picks the first fixed-order id when hero and rehearsal are absent", async () => {
    const dir = outDir();
    const { get } = fakeFetch(HERO);
    const d = deps(get);
    // seed an index with a foreign entry first
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({ v: 1, default: "old", recordings: [{ id: "old", title: "kept" }] }) + "\n",
    );
    const synthetic = { get: fakeFetch(syntheticWithLabel("the swarm with scripted agents")).get };
    expect((await run(["--id", "swarm", "--out", dir], deps(synthetic.get))).code).toBe(0);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
      default: string;
      recordings: { id: string; title?: string }[];
    };
    expect(index.recordings.map((entry) => entry.id)).toEqual(["swarm", "old"]);
    expect(index.recordings[1]!.title).toBe("kept");
    expect(index.default).toBe("swarm"); // spec-silent: the first entry in the fixed order
  });

  it("refuses an --id that is not one of the four fixed ids", async () => {
    const { get, seen } = fakeFetch(HERO);
    const result = await runExport(["--pool", "p", "--id", "other", "--title", "t"], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("hero, rehearsal, hero-canned, swarm");
    expect(seen).toHaveLength(0); // no request was even sent
  });

  it("RP1: a 409 prints the refused line number and family — never the line", async () => {
    const { get } = fakeFetch(JSON.stringify({ error: { code: "redacted", line: 5, family: "artifacts_token" } }), 409);
    const result = await run(["--id", "hero", "--out", outDir()], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("line 5");
    expect(result.message).toContain("artifacts_token");
  });

  it("any other non-200 prints the status and the body's code", async () => {
    const { get } = fakeFetch(JSON.stringify({ error: { code: "not_configured" } }), 503);
    const result = await run(["--id", "hero", "--out", outDir()], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("503");
    expect(result.message).toContain("not_configured");
  });

  it("refuses a file that fails an 8.3 check, with the check's sentence", async () => {
    const bad = HERO.replace('"premise_replay":2', '"premise_replay":1');
    const { get } = fakeFetch(bad);
    const result = await run(["--id", "hero", "--out", outDir()], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("This file is not a Premise recording that this page can play.");
  });

  it("refuses a file larger than REPLAY_MAX_BYTES (RY6)", async () => {
    const { get } = fakeFetch(new Uint8Array(REPLAY_MAX_BYTES + 1));
    const result = await run(["--id", "hero", "--out", outDir()], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("This recording is too large to play here.");
  });

  it("RY27: a synthetic file needs 'scripted agents' in its title; a real one refuses it", async () => {
    const synthetic = fakeFetch(syntheticWithLabel());
    const refused = await run(["--id", "swarm", "--out", outDir()], deps(synthetic.get));
    expect(refused.code).toBe(1);
    expect(refused.message).toContain("scripted agents");

    const labelled = fakeFetch(syntheticWithLabel("the swarm with scripted agents"));
    const ok = await run(["--id", "swarm", "--out", outDir()], deps(labelled.get));
    expect(ok.code).toBe(0);

    const real = fakeFetch(
      HERO.replace('"label":"hero-c04: shared rule lands first"', '"label":"with scripted agents"'),
    );
    const refusedReal = await run(["--id", "hero", "--out", outDir()], deps(real.get));
    expect(refusedReal.code).toBe(1);
    expect(refusedReal.message).toContain("scripted agents");
  });

  it("needs PREMISE_OWNER_KEY and an origin, and sends no request without them", async () => {
    const { get, seen } = fakeFetch(HERO);
    const noKey = await run(["--id", "hero", "--out", outDir()], deps(get, { PREMISE_URL: "https://x.test" }));
    expect(noKey.code).toBe(1);
    expect(noKey.message).toContain("PREMISE_OWNER_KEY");
    const noOrigin = await run(["--id", "hero", "--out", outDir()], deps(get, { PREMISE_OWNER_KEY: "k" }));
    expect(noOrigin.code).toBe(1);
    expect(noOrigin.message).toContain("PREMISE_URL");
    expect(seen).toHaveLength(0);
  });

  it("a download failure refuses cleanly", async () => {
    const get = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await run(["--id", "hero", "--out", outDir()], deps(get));
    expect(result.code).toBe(1);
    expect(result.message).toContain("could not be downloaded");
  });
});

/** pool-synthetic.ndjson with its header label swapped (the label is data of the header). */
function syntheticWithLabel(label = "synthetic pool, full stream"): string {
  const lines = SYNTHETIC.split("\n");
  const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  header.label = label;
  lines[0] = JSON.stringify(header);
  return lines.join("\n");
}
