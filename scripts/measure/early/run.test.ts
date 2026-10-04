// The runner of ME2: a dry run of the whole plan of 6.2 against the scripted fake model (no
// network), and the output file of 6.8 it writes. Also guide-first (B1), the hero round trip of
// ME5, and the --max-usd stop of ME4.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { runOnce } from "./run.ts";
import { cannedModel } from "./fake-model.ts";
import { newLedger, MODEL_PLAN } from "./ledger.ts";
import { ADDITIVE_INTENTS, HERO_INTENTS, runPlan } from "./intents.ts";
import { loadSeed } from "../models.ts";
import type { ModelMeasurement } from "./summarize.ts";

const seed = () => loadSeed();
const seedPaths = new Set(loadSeed().keys());
const clock = { now: () => Date.now(), sleep: async () => {} };
const entry = MODEL_PLAN["@cf/openai/gpt-oss-120b"]!;

const once = (intent: (typeof ADDITIVE_INTENTS)[number], maxUsd = 3) =>
  runOnce({
    attemptId: `m_${intent.id}_1`,
    intent,
    runIndex: 1,
    seed: seed(),
    seedPaths,
    modelId: "@cf/openai/gpt-oss-120b",
    modelOptions: entry.options,
    modelPrice: entry.price,
    ledger: newLedger({ maxUsd }),
    callModel: cannedModel(intent),
    clock,
  });

describe("one run against the scripted fake model (ME2)", () => {
  it("an additive run completes: guide first, write, submit, validated", async () => {
    const r = await once(ADDITIVE_INTENTS[0]!);
    expect(r.record.outcome).toBe("completed");
    expect(r.record.first_tool).toBe("read GUIDE.md"); // B1: the guide is read first
    expect(r.record.model_calls).toBeGreaterThan(0);
    expect(r.record.files["creatures/jellyfish.js"]).toContain("export function spawn");
  });

  it("a hero run goes through the heads-up and scores repaired (ME5, ME8)", async () => {
    const r = await once(HERO_INTENTS[0]!);
    expect(r.record.outcome).toBe("completed");
    expect(r.record.hero?.class).toBe("repaired");
    expect(r.record.hero?.before).toContain("crab.energy < 30");
    expect(r.pool.fileAt("creatures/crab.js")).toContain("crab.energy < 0.3");
  });

  it("tokens and cost come from real usage, not the reservation", async () => {
    const r = await once(ADDITIVE_INTENTS[0]!);
    expect(r.record.tokens_in).toBeGreaterThan(0);
    expect(r.record.cost_usd).toBeGreaterThan(0);
  });
});

describe("the whole plan of 6.2 as a dry run, writing the file of 6.8", () => {
  it("runPlan is 12 additive runs and 10 hero runs", () => {
    const plan = runPlan();
    expect(plan).toHaveLength(22);
    expect(plan.filter((p) => p.intent.set === "additive")).toHaveLength(12);
    expect(plan.filter((p) => p.intent.set === "hero")).toHaveLength(10);
  });

  it("models.ts --dry-run writes a ModelMeasurement JSON without touching the network", { timeout: 180_000 }, () => {
    const outDir = ".tmp-test/dry-run-out";
    mkdirSync(outDir, { recursive: true });
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/measure/models.ts",
        "--early",
        "--model",
        "@cf/openai/gpt-oss-120b",
        "--dry-run",
        "--out",
        outDir,
        "--build",
        "test",
        "--no-transcripts",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: `${process.cwd()}/.tmp-test` },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const file = readdirSync(outDir).find((f) => f.endsWith(".json") && f.includes("early"));
    expect(file).toBeDefined();
    const m = JSON.parse(readFileSync(`${outDir}/${file}`, "utf8")) as ModelMeasurement;
    // The 6.8 shape.
    expect(m.v).toBe(1);
    expect(m.mode).toBe("early");
    expect(m.agent_spec).toBe("05-agent/1");
    expect(m.prompt_hash).toBe("917e609ac30b64fb1cda644f68c06bda");
    expect(m.tools_hash).toBe("ba662e57680b04dd70f71cab3b04258e");
    expect(m.texts_hash).toBe("cc8cf3ff57cfa9b7988f4d2587c52fac");
    expect(m.intents).toHaveLength(14);
    expect(m.runs).toHaveLength(22);
    // The canned model completes everything and repairs every hero run.
    expect(m.intents.every((i) => i.landed === i.runs)).toBe(true);
    expect(m.hero.runs).toBe(10);
    expect(m.hero.repaired_correctly).toBe(10);
    expect(m.incomplete).toBe(false);
  });

  it("a tiny --max-usd stops the plan before it finishes (ME4)", async () => {
    const ledger = newLedger({ maxUsd: 0.000_000_001 });
    const r = await runOnce({
      attemptId: "m_A01_1",
      intent: ADDITIVE_INTENTS[0]!,
      runIndex: 1,
      seed: seed(),
      seedPaths,
      modelId: "@cf/openai/gpt-oss-120b",
      modelOptions: entry.options,
      modelPrice: entry.price,
      ledger,
      callModel: cannedModel(ADDITIVE_INTENTS[0]!),
      clock,
    });
    expect(r.incomplete).toBe(true);
    expect(ledger.spentUsd()).toBeLessThanOrEqual(0.000_000_001);
  });
});
