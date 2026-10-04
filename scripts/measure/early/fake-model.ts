// A scripted fake model for tests and `--dry-run`: no network, no credential. It answers in the
// Workers AI shape (`choices[0].message`) and plays a fixed, deterministic strategy: read the
// guide, write the intent's file, submit; after a heads-up, replace the energy number and submit
// with a statement. Its files are canned text; it exercises the whole loop, not a real model.

import type { CallModel } from "./run.ts";
import type { IntentSpec } from "./intents.ts";
import { GUIDE_PATH } from "../../../src/protocol/agent-prompt.ts";

const CANNED_CRAB = `import { ENERGY_MAX } from "../world/energy.js";
import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "orange";

export function spawn() {
  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };
}

export function update(crab) {
  crab.hiding = crab.energy < 30;
  if (crab.hiding) return;
  step(crab);
  bounce(crab);
}

export function draw(crab, pen) {
  pen.fill(SHELL);
  if (crab.hiding) {
    pen.ellipse(0, 2, 16, 9);
    return;
  }
  pen.line(-14, 6, -24, 14);
  pen.line(14, 6, 24, 14);
  pen.circle(-20, -10, 6);
  pen.circle(20, -10, 6);
  pen.ellipse(0, 0, 18, 11);
}
`;

const CANNED_SHRIMP = `import { ENERGY_MAX, drain } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, wander, glide } from "../world/movement.js";

const BODY = "pink";

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(shrimp) {
  if (shrimp.age % seconds(2) === 0) {
    wander(shrimp, 3);
    drain(shrimp, 5);
  }
  glide(shrimp, 0.95);
  step(shrimp);
  bounce(shrimp);
}

export function draw(shrimp, pen) {
  if (shrimp.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(0, 0, 14, 6);
  pen.poly([-12, 0, -22, -7, -22, 7]);
  pen.line(12, -2, 24, -10);
  pen.line(12, 0, 26, -4);
}
`;

/** A minimal valid creature for the additive intents (energy users for A08 and A09). */
function cannedAdditive(intent: IntentSpec): string {
  const kind = intent.writes.slice("creatures/".length, -".js".length);
  const energy = intent.readsEnergy ? `import { ENERGY_MAX } from "../world/energy.js";\n\n` : "";
  const spawn = intent.readsEnergy
    ? `export function spawn() {\n  return { energy: ENERGY_MAX };\n}`
    : `export function spawn() {\n  return {};\n}`;
  const countLine = intent.id === "A08" ? "export const count = 8;\n" : "";
  return `${energy}${countLine}const BODY = "gray";\n\n${spawn}\n\nexport function update(${kind}) {\n  ${kind}.x = (${kind}.x ?? 0) + 1;\n}\n\nexport function draw(${kind}, pen) {\n  pen.fill(BODY);\n  pen.circle(0, 0, 6);\n}\n`;
}

function creatureFor(intent: IntentSpec): string {
  if (intent.id === "P1a") return CANNED_CRAB;
  if (intent.id === "P1b") return CANNED_SHRIMP;
  return cannedAdditive(intent);
}

const REPAIR: Record<string, { old: string; new: string }> = {
  P1a: { old: "crab.energy < 30", new: "crab.energy < 0.3" },
  P1b: { old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" },
};

type Call = { name: string; args: Record<string, unknown> };

function answer(calls: Call[], content = "") {
  return {
    kind: "answer" as const,
    result: {
      choices: [
        {
          message: {
            content,
            tool_calls: calls.map((c, i) => ({
              id: `call_${i}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 400, completion_tokens: 80 },
    },
  };
}

/**
 * The canned strategy as a `CallModel`: each request's messages are inspected for a heads-up
 * (`"heads_ups"` in any message content); before it the model writes and submits, after it the
 * model repairs and submits with a statement. A fresh instance per run (ME2).
 */
export function cannedModel(intent: IntentSpec): CallModel {
  let stage: "guide" | "write" | "submit" | "repair" | "done" = "guide";
  return async (request: Record<string, unknown>) => {
    const messages = (request.messages ?? []) as Array<{ content?: unknown }>;
    const sawHeadsUp = messages.some((m) => {
      const c = m?.content;
      if (typeof c !== "string" || !c.includes("heads_ups")) return false;
      try {
        const parsed = JSON.parse(c) as { heads_ups?: unknown };
        return Array.isArray(parsed.heads_ups) && parsed.heads_ups.length > 0;
      } catch {
        return false;
      }
    });
    if (stage === "guide") {
      stage = "write";
      return answer([{ name: "read", args: { path: GUIDE_PATH } }]);
    }
    if (stage === "write") {
      stage = "submit";
      return answer([{ name: "write", args: { path: intent.writes, content: creatureFor(intent) } }]);
    }
    if (stage === "submit" && !sawHeadsUp) {
      stage = "repair";
      return answer([{ name: "submit", args: { summary: `Add ${intent.writes}` } }]);
    }
    if (stage === "repair" && sawHeadsUp) {
      const repair = REPAIR[intent.id];
      if (repair !== undefined) {
        stage = "done";
        return answer([{ name: "replace", args: { path: intent.writes, old: repair.old, new: repair.new } }]);
      }
      stage = "done";
      return answer([
        {
          name: "submit",
          args: {
            summary: `Repair ${intent.writes}`,
            statement: "Energy is now a fraction, so the number was rescaled.",
          },
        },
      ]);
    }
    if (stage === "done") {
      return answer([
        {
          name: "submit",
          args: {
            summary: `Repair ${intent.writes}`,
            statement: "Energy is now a fraction, so the number was rescaled.",
          },
        },
      ]);
    }
    stage = "done";
    return answer([
      {
        name: "submit",
        args: {
          summary: `Add ${intent.writes}`,
          statement: sawHeadsUp ? "Checked the heads-up; nothing needed changing." : undefined,
        },
      },
    ]);
  };
}
