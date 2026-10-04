// Acceptance item 7 (04-build-plan 2.1): every seam and every wiring module of plan 3.2 exists,
// and every port of plan 1.7 resolves to `adapters/not-built.ts`, whose methods fail closed with
// the code `not_built`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeFilesUnder, REPO_ROOT, readText } from "../support/source.ts";
import { engineTable } from "../../src/core/trunk/engine.ts";
import { registry } from "../../src/floor/app/registry.ts";
import * as adapters from "../../src/worker/adapters/index.ts";
import { NOT_BUILT } from "../../src/worker/not-built.ts";

/** The seams of 3.2 and the wiring modules each calls, in seam-table order. */
const SEAMS: ReadonlyArray<{ seam: string; wiring: readonly string[] }> = [
  {
    seam: "src/core/trunk/engine.ts",
    wiring: ["src/core/trunk/wiring/engine.ts", "src/core/trunk/wiring/git.ts"],
  },
  {
    seam: "src/worker/trunk/effects.ts",
    wiring: ["src/worker/trunk/wiring/trunk.ts", "src/worker/trunk/wiring/git.ts"],
  },
  {
    seam: "src/worker/index.ts",
    wiring: [
      "src/worker/routes/wiring.ts",
      "src/worker/routes/swarm.ts",
      "src/worker/floor/wiring.ts",
      "src/worker/app-server/wiring.ts",
    ],
  },
  {
    seam: "src/floor/app/registry.ts",
    wiring: ["src/floor/app/wiring/shell.ts", "src/floor/app/wiring/rail.ts", "src/floor/app/wiring/pool-area.ts"],
  },
];

/** The seven class files `wrangler.jsonc` names (Slice 0 stubs). */
const STUB_CLASSES = [
  "src/worker/trunk/trunk-do.ts",
  "src/worker/agent/agent-do.ts",
  "src/worker/floor/floor-do.ts",
  "src/worker/gate/gate-do.ts",
  "src/worker/workflows/swarm.ts",
  "src/worker/workflows/green-line.ts",
  "src/worker/workflows/attempt-repo.ts",
] as const;

describe("the seams and wiring modules of 04-build-plan 3.2", () => {
  it.each(SEAMS)("$seam exists and so does each of its wiring modules", ({ seam, wiring }) => {
    expect(existsSync(join(REPO_ROOT, seam)), `${seam} is missing`).toBe(true);
    for (const module of wiring) {
      expect(existsSync(join(REPO_ROOT, module)), `${module} is missing`).toBe(true);
    }
  });

  it("every wiring module exports a `wire` function and no side effect", () => {
    const wiring = SEAMS.flatMap(({ wiring }) => wiring);
    for (const module of wiring) {
      const text = readText(REPO_ROOT, module);
      expect(text, `${module} must export function wire`).toMatch(/export function wire\(/);
    }
    const files = new Set(codeFilesUnder(REPO_ROOT, "src"));
    for (const module of wiring) {
      expect(files.has(module), `${module} is not a source file`).toBe(true);
    }
  });

  it("each seam imports its wiring modules and calls their wire functions", () => {
    const engine = readText(REPO_ROOT, "src/core/trunk/engine.ts");
    expect(engine).toContain('from "./wiring/engine.ts"');
    expect(engine).toContain('from "./wiring/git.ts"');
    const effects = readText(REPO_ROOT, "src/worker/trunk/effects.ts");
    expect(effects).toContain('from "./wiring/trunk.ts"');
    expect(effects).toContain('from "./wiring/git.ts"');
    expect(effects).toMatch(/wireTrunk\(table\)/);
    expect(effects).toMatch(/wireGit\(table\)/);
    const index = readText(REPO_ROOT, "src/worker/index.ts");
    for (const module of ["./routes/wiring.ts", "./routes/swarm.ts", "./floor/wiring.ts", "./app-server/wiring.ts"]) {
      expect(index, `src/worker/index.ts does not wire ${module}`).toContain(`from "${module}"`);
    }
    const registrySource = readText(REPO_ROOT, "src/floor/app/registry.ts");
    for (const module of ["./wiring/shell.ts", "./wiring/rail.ts", "./wiring/pool-area.ts"]) {
      expect(registrySource, `src/floor/app/registry.ts does not wire ${module}`).toContain(`from "${module}"`);
    }
  });

  it("the seam builders run; the engine table is empty until its lane wires it", () => {
    // The pure seams are called here; the worker seams are checked from their text above: the
    // Worker's types are not part of this test's program (plan 1.3, mechanism 1).
    expect(engineTable().entries.size).toBe(0);
    expect(engineTable().effects.size).toBe(0);
    // The Floor's registry is filled since track 1F: floor-shell registers its views, sheets and keys.
    expect(registry().entries.size).toBeGreaterThan(0);
  });

  it.each(STUB_CLASSES)("%s exists and answers not_built", (file) => {
    const text = readText(REPO_ROOT, file);
    expect(existsSync(join(REPO_ROOT, file)), `${file} is missing`).toBe(true);
    expect(text, `${file} must answer through notBuilt()/notBuiltError()`).toMatch(/notBuilt(?:Error)?\(\)/);
  });
});

describe("the ports of plan 1.7 resolve to adapters/not-built.ts (item 7)", () => {
  const methods: Array<[string, () => unknown]> = [
    [
      "pusher.push",
      () =>
        adapters.pusher.push({
          remote: "",
          token: "",
          updates: [],
          pack: new Uint8Array(),
          atomic: false,
          signal: new AbortController().signal,
        }),
    ],
    [
      "pusher.readRefs",
      () => adapters.pusher.readRefs({ remote: "", token: "", refs: [], signal: new AbortController().signal }),
    ],
    ["notesReader.readNote", () => adapters.notesReader.readNote("0".repeat(40))],
    ["tokenSource.writeTarget", () => adapters.tokenSource.writeTarget("tidepool")],
    ["attemptRepoProvisioner.provision", () => adapters.attemptRepoProvisioner.provision("a_x")],
    ["verifier.verify", () => adapters.verifier.verify({ pool_id: "tidepool", seq: 1, commit: "0".repeat(40) })],
    ["poolSource.resolve", () => adapters.poolSource.resolve("tidepool", "main")],
    ["poolSource.read", () => adapters.poolSource.read("tidepool", "c-" + "0".repeat(40), "x.js")],
    ["poolSource.list", () => adapters.poolSource.list("tidepool", "c-" + "0".repeat(40), "/")],
    [
      "triage.judge",
      () => adapters.triage.judge({ attempt_id: "a_x", intent: "", patch: [], premises: {}, truth: null }),
    ],
    ["riskJudge.judge", () => adapters.riskJudge.judge({ intent: "", summary: "", held_paths: [], files: [] })],
    ["driver.next", () => adapters.driver.next({ last: null, state: null })],
  ];

  it.each(methods)("%s fails closed with the code not_built", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: NOT_BUILT });
  });

  it("notesReader.listNotes fails closed with the code not_built", async () => {
    const iterator = adapters.notesReader.listNotes()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: NOT_BUILT });
  });
});
