// The plain-merge replay of 01-core.md 11.7 over the seed tidepool (02-tidepool.md 7.8, 8.5,
// 9.4). Expected values come from the specification and from real git, never from the
// implementation's own output (BP1).

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABSENT } from "../../protocol/premise.ts";
import type { Operation } from "../../protocol/operations.ts";
import { REPO_ROOT } from "../../../test/support/source.ts";
import { createScratchRepo } from "../../../test/support/git.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { makeTreeFromFiles } from "../git/tree-files.ts";
import { plainTreeId, replayPlainMerge, type PlainLanding } from "./plain.ts";

// ---------------------------------------------------------------------------
// The seed files, read from seeds/tidepool/ (02-tidepool.md 2.1).

function seedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, "seeds/tidepool", relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(REPO_ROOT, "seeds/tidepool", path), "utf8"));
    }
  };
  visit("");
  return files;
}

// ---------------------------------------------------------------------------
// The canned files of 02-tidepool.md 7.3 and 8.2, verbatim from the specification.

const CRAB_30 = `import { ENERGY_MAX } from "../world/energy.js";
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

/** P5b's "crab that walks sideways and waves one big claw" (02-tidepool.md 9.3): a different
 *  crab file for the same path. The specification gives no canned text for it; the value only
 *  has to differ from C's crab for the OP5 conflict to show. */
const CRAB_BIG_CLAW = `import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "red";

export function spawn() {
  return { y: FLOOR_Y - 10, vx: 1 };
}

export function update(crab) {
  step(crab);
  bounce(crab);
}

export function draw(crab, pen) {
  pen.fill(SHELL);
  pen.circle(22, -8, 10);
  pen.ellipse(0, 0, 18, 11);
}
`;

const SHRIMP_5 = `import { ENERGY_MAX, drain } from "../world/energy.js";
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

const JELLYFISH_FILE = `import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BELL = "purple";

export function spawn() {
  return { vy: -0.4 };
}

export function update(jellyfish) {
  if (jellyfish.y < SURFACE_Y + 40) jellyfish.vy = 0.4;
  if (jellyfish.y > FLOOR_Y - 60) jellyfish.vy = -0.4;
  jellyfish.y += jellyfish.vy;
}

export function draw(jellyfish, pen) {
  pen.alpha(0.8);
  pen.fill(BELL);
  pen.ellipse(0, 0, 16, 10);
  pen.line(-8, 6, -8, 22);
  pen.line(0, 6, 0, 26);
  pen.line(8, 6, 8, 22);
}
`;

const SEAHORSE_FILE = `import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BODY = "pink";

export function spawn() {
  return { bob: 0 };
}

export function update(seahorse, world) {
  seahorse.bob = Math.sin(world.tick / 30 + seahorse.id);
  seahorse.y += seahorse.bob * 0.5;
  if (seahorse.y < SURFACE_Y + 30) seahorse.y = SURFACE_Y + 30;
  if (seahorse.y > FLOOR_Y - 30) seahorse.y = FLOOR_Y - 30;
}

export function draw(seahorse, pen) {
  pen.fill(BODY);
  pen.ellipse(0, 0, 8, 16);
  pen.circle(4, -18, 8);
  pen.line(10, -18, 18, -16);
  pen.arc(-2, 18, 8, 0, Math.PI);
}
`;

// S's replace of 7.3, verbatim.
const S_REPLACE: Operation = {
  op_seq: 1,
  op: "replace",
  path: "world/energy.js",
  old: "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
  new: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
  targets: ["world/energy.js#ENERGY_MAX"],
};

// ---------------------------------------------------------------------------
// Landing builders. `opsFirst`/`submitted` follow PM1 and PM2: an attempt that never had a
// confirm/repair heads-up replays its landed operations (opsFirst false); an ops_first
// snapshot carries the submitted flag it was written with.

const change = (
  seq: number,
  ops: readonly Operation[],
  opts: { opsFirst?: boolean; submitted?: boolean } = {},
): PlainLanding => ({
  seq,
  kind: "change",
  ops,
  opsFirst: opts.opsFirst ?? false,
  submitted: opts.submitted ?? true,
});

const undo = (seq: number, undoes: readonly number[], kind: "undo" | "revert" = "undo"): PlainLanding => ({
  seq,
  kind,
  ops: [],
  opsFirst: false,
  submitted: true,
  undoes,
});

const writeFile = (opSeq: number, path: string, content: string, baseOid: string = ABSENT): Operation => ({
  op_seq: opSeq,
  op: "write",
  path,
  content,
  base_oid: baseOid,
});

const replace = (opSeq: number, path: string, oldText: string, newText: string, targets: string[]): Operation => ({
  op_seq: opSeq,
  op: "replace",
  path,
  old: oldText,
  new: newText,
  targets,
});

// ---------------------------------------------------------------------------

describe("plain-merge replay (11.7)", () => {
  it("hero, landing order 1 (7.5, 7.8): ENERGY_MAX = 1, crab.energy < 30, drain(shrimp, 5)", () => {
    // 7.8 order 1: S replays its landed replace; C and H replay their ops_first (the writes
    // of 7.3, before the repairs); J replays its landed write. C and H had not passed a
    // submit when S landed, so their landings are interrupted (PM4, 7.5 step 4).
    const landings: PlainLanding[] = [
      change(1, [S_REPLACE]),
      change(2, [writeFile(1, "creatures/crab.js", CRAB_30)], { opsFirst: true, submitted: false }),
      change(3, [writeFile(1, "creatures/shrimp.js", SHRIMP_5)], { opsFirst: true, submitted: false }),
      change(4, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
    ];
    const result = replayPlainMerge(seedFiles(), landings);

    expect(result.files.get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
    expect(result.files.get("world/energy.js")).toContain("Energy is a fraction");
    expect(result.files.get("creatures/crab.js")).toContain("crab.energy < 30");
    expect(result.files.get("creatures/crab.js")).not.toContain("crab.energy < 0.3");
    expect(result.files.get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(result.files.get("creatures/shrimp.js")).not.toContain("drain(shrimp, 0.05)");
    expect(result.files.get("creatures/jellyfish.js")).toContain('const BELL = "purple"');

    // 7.8: `plain.updated.skipped` is empty; the text-conflict count is 0.
    expect(result.skipped).toEqual([]);
    expect(result.interrupted).toEqual([2, 3]);
    expect(result.throughSeq).toBe(4);
    expect(result.steps.map((s) => s.outcome)).toEqual(["applied", "applied", "applied", "applied"]);
    // The seed's 21 files plus the three new creatures; nothing else moved.
    expect(result.files.size).toBe(seedFiles().size + 3);
  });

  it("hero, landing order 2 (7.6, 7.8): the same tree as order 1", () => {
    // 7.8 order 2: C and H replay their landed writes; S replays its ops_first — the one
    // replace without the creature repairs — with submitted = 1 (S had passed a submit).
    const order1 = replayPlainMerge(seedFiles(), [
      change(1, [S_REPLACE]),
      change(2, [writeFile(1, "creatures/crab.js", CRAB_30)], { opsFirst: true, submitted: false }),
      change(3, [writeFile(1, "creatures/shrimp.js", SHRIMP_5)], { opsFirst: true, submitted: false }),
      change(4, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
    ]);
    const order2 = replayPlainMerge(seedFiles(), [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
      change(2, [writeFile(1, "creatures/shrimp.js", SHRIMP_5)]),
      change(3, [S_REPLACE], { opsFirst: true, submitted: true }),
      change(4, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
    ]);
    expect(order2.skipped).toEqual([]);
    expect(order2.interrupted).toEqual([]); // 7.8: none, S had passed a submit.
    expect(Object.fromEntries(order2.files)).toEqual(Object.fromEntries(order1.files));
    expect(plainTreeId(order2.files)).toBe(plainTreeId(order1.files));
  });

  it("pair P4 (9.3, 9.4): the second change of DAY_TICKS is a text conflict (PM3)", () => {
    // R02 lands `3600 -> 7200`; the later change replays its ops_first `3600 -> 10800`,
    // recorded before its first repair heads-up. In the pool the line no longer matches (OP1),
    // so the change is skipped and counted.
    const landings: PlainLanding[] = [
      change(1, [replace(1, "world/time.js", "DAY_TICKS = 3600", "DAY_TICKS = 7200", ["world/time.js#DAY_TICKS"])]),
      change(2, [replace(1, "world/time.js", "DAY_TICKS = 3600", "DAY_TICKS = 10800", ["world/time.js#DAY_TICKS"])], {
        opsFirst: true,
        submitted: true,
      }),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.files.get("world/time.js")).toContain("export const DAY_TICKS = 7200;");
    expect(result.skipped).toEqual([2]);
    expect(result.steps[1]?.outcome).toBe("conflict");
    expect(result.steps[1]?.failure).toEqual({ path: "world/time.js", op_seq: 1, rule: "OP1" });
    expect(result.interrupted).toEqual([]);
    expect(result.throughSeq).toBe(2);
  });

  it("pair P5 (9.3, 9.4): the later write whose base moved is a text conflict (PM3)", () => {
    // P1a's crab lands; the second crab's ops_first is a `write` of the same path recorded
    // against base `absent`. The path was created by the first change, so its base moved
    // (OP5): skipped and counted. The plain-merge pool keeps the first crab.
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
      change(2, [writeFile(1, "creatures/crab.js", CRAB_BIG_CLAW)], { opsFirst: true, submitted: true }),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.skipped).toEqual([2]);
    expect(result.steps[1]?.failure?.rule).toBe("OP5");
    expect(result.files.get("creatures/crab.js")).toBe(CRAB_30);
  });

  it("PM4: an ops_first landing with submitted = 0 is marked interrupted (TP23)", () => {
    const result = replayPlainMerge(seedFiles(), [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)], { opsFirst: true, submitted: false }),
    ]);
    expect(result.interrupted).toEqual([1]);
    expect(result.skipped).toEqual([]);
    expect(result.steps[0]?.interrupted).toBe(true);
    expect(result.steps[0]?.outcome).toBe("applied");
  });

  it("8.5: B's seahorse, then A's ops_first repaints — every seed creature gold, seahorse pink", () => {
    // The nine repaints of 8.2, each a `replace` of a colour constant (TP18's targets are
    // the constant's entity; OP3 is off so the recorded key is not consulted).
    const repaints: Operation[] = [
      replace(1, "creatures/anemone.js", 'const ARMS = "pink";', 'const ARMS = "gold";', ["creatures/anemone.js#ARMS"]),
      replace(2, "creatures/anemone.js", 'const BASE = "purple";', 'const BASE = "#b8860b";', [
        "creatures/anemone.js#BASE",
      ]),
      replace(3, "creatures/fish.js", 'const BODY = "orange";', 'const BODY = "gold";', ["creatures/fish.js#BODY"]),
      replace(4, "creatures/fish.js", 'const FIN = "yellow";', 'const FIN = "#b8860b";', ["creatures/fish.js#FIN"]),
      replace(5, "creatures/minnow.js", 'const BODY = "silver";', 'const BODY = "gold";', ["creatures/minnow.js#BODY"]),
      replace(6, "creatures/snail.js", 'const SHELL = "brown";', 'const SHELL = "gold";', ["creatures/snail.js#SHELL"]),
      replace(7, "creatures/snail.js", 'const BODY = "sand";', 'const BODY = "#b8860b";', ["creatures/snail.js#BODY"]),
      replace(8, "creatures/turtle.js", 'const SHELL = "green";', 'const SHELL = "gold";', [
        "creatures/turtle.js#SHELL",
      ]),
      replace(9, "creatures/turtle.js", 'const SKIN = "teal";', 'const SKIN = "#b8860b";', [
        "creatures/turtle.js#SKIN",
      ]),
    ];
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "creatures/seahorse.js", SEAHORSE_FILE)]),
      // A had not submitted when its L1 heads-up arrived (8.3), so submitted = 0 (PM4).
      change(2, repaints, { opsFirst: true, submitted: false }),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.skipped).toEqual([]);
    expect(result.interrupted).toEqual([2]);
    for (const name of ["anemone", "fish", "minnow", "snail", "turtle"]) {
      expect(result.files.get(`creatures/${name}.js`)).toContain('"gold"');
    }
    // The second constant of each file but minnow's is repainted "#b8860b" (8.2's table).
    for (const name of ["anemone", "fish", "snail", "turtle"]) {
      expect(result.files.get(`creatures/${name}.js`)).toContain('"#b8860b"');
    }
    expect(result.files.get("creatures/minnow.js")).not.toContain('"#b8860b"'); // only one constant
    expect(result.files.get("creatures/seahorse.js")).toContain('const BODY = "pink";');
  });

  it("PM5: an undo takes back the change it names and keeps later unrelated landings", () => {
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
      change(2, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
      undo(3, [1]),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.files.get("creatures/crab.js")).toBeUndefined();
    expect(result.files.get("creatures/jellyfish.js")).toBe(JELLYFISH_FILE);
    expect(result.steps[2]?.outcome).toBe("reverted");
    expect(result.steps[2]?.reverted).toEqual([1]);
    expect(result.steps[2]?.changed).toEqual(new Map([["creatures/crab.js", null]]));
    expect(result.throughSeq).toBe(3);
  });

  it("PM5: reverting a skipped change takes back nothing of it (it changed nothing)", () => {
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
      change(2, [writeFile(1, "creatures/crab.js", CRAB_BIG_CLAW)], { opsFirst: true, submitted: true }),
      undo(3, [1, 2]),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.skipped).toEqual([2]);
    expect(result.steps[2]?.reverted).toEqual([1, 2]);
    expect(result.files.get("creatures/crab.js")).toBeUndefined();
    expect(result.files.size).toBe(seedFiles().size);
  });

  it("PM5/UN3: a later landing whose operations cannot stand joins the revert", () => {
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "a.txt", "alpha\nbeta\n")]),
      change(2, [replace(1, "a.txt", "beta", "B2", ["a.txt"])]),
      undo(3, [1]),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    // Restoring a.txt to before seq 1 removes it; seq 2's replace then fails OP4 and joins
    // the revert (UN3), so a.txt stays absent.
    expect(result.steps[2]?.reverted).toEqual([1, 2]);
    expect(result.files.get("a.txt")).toBeUndefined();
  });

  it("PM5/UN3: a later landing whose operations still apply is replayed on the restored base", () => {
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "a.txt", "old\n")]),
      change(2, [writeFile(1, "a.txt", "new\n", blobId(utf8("old\n")))]),
      undo(3, [1]),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    // seq 2's write re-applies over the absent base (UN3: OP5 not applied): a.txt is `new`.
    expect(result.steps[2]?.reverted).toEqual([1]);
    expect(result.files.get("a.txt")).toBe("new\n");
  });

  it("PM5: a revert landing (kind `revert`) takes back its range the same way", () => {
    const landings: PlainLanding[] = [
      change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
      change(2, [writeFile(1, "creatures/shrimp.js", SHRIMP_5)]),
      undo(3, [1, 2], "revert"),
    ];
    const result = replayPlainMerge(seedFiles(), landings);
    expect(result.steps[2]?.reverted).toEqual([1, 2]);
    expect(result.files.get("creatures/crab.js")).toBeUndefined();
    expect(result.files.get("creatures/shrimp.js")).toBeUndefined();
    expect(result.files.size).toBe(seedFiles().size);
  });
});

// ---------------------------------------------------------------------------
// PM7: when every change replays exactly as it landed, the pool's tree id is the id real
// git computes for the same files — the comparison `plain.updated.tree` ==
// `landing.landed.tree` is a comparison of two ids built the same way (9.5).

const GIT_BIN_DIR = join(REPO_ROOT, ".tmp-test", "git-bin");

/**
 * `git init` copies template files out of the toolchain's template directory; in a sandbox
 * that denies reads outside the workspace that copy fails and `git init` cannot run. The
 * same workaround test/git/helpers.ts installs: a `git` wrapper first in PATH that calls
 * `git init --template=` and passes every other command through unchanged.
 */
function ensureGitWrapper(): void {
  if ((process.env.PATH ?? "").split(":").includes(GIT_BIN_DIR)) return;
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(GIT_BIN_DIR, { recursive: true });
  const staged = join(GIT_BIN_DIR, `git.${process.pid}`);
  writeFileSync(
    staged,
    `#!/bin/sh\nif [ "$1" = "init" ]; then\n  shift\n  exec "${real}" init --template= "$@"\nfi\nexec "${real}" "$@"\n`,
  );
  chmodSync(staged, 0o755);
  renameSync(staged, join(GIT_BIN_DIR, "git"));
  process.env.PATH = `${GIT_BIN_DIR}:${process.env.PATH ?? ""}`;
}

describe("plainTreeId (PM7, 9.5)", () => {
  it("equals the tree id of the same files built for main, and `git write-tree` in a real repo", () => {
    // Every change replayed exactly as it landed (the repaired files of 7.5/7.6): the
    // plain-merge files are the files of `main` after the same landings.
    const repairedCrab = CRAB_30.replace("crab.energy < 30", "crab.energy < 0.3");
    const repairedShrimp = SHRIMP_5.replace("drain(shrimp, 5)", "drain(shrimp, 0.05)");
    const result = replayPlainMerge(seedFiles(), [
      change(1, [S_REPLACE]),
      change(2, [writeFile(1, "creatures/crab.js", repairedCrab)]),
      change(3, [writeFile(1, "creatures/shrimp.js", repairedShrimp)]),
      change(4, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.files.get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
    expect(result.files.get("creatures/crab.js")).toContain("crab.energy < 0.3");
    expect(result.files.get("creatures/shrimp.js")).toContain("drain(shrimp, 0.05)");

    // The id src/core/git computes for the tree of `main` over the same file map.
    const filesForTree: Record<string, string> = {};
    for (const [path, content] of result.files) filesForTree[path] = content;
    const mainTreeId = makeTreeFromFiles(filesForTree).root.oid;
    expect(plainTreeId(result.files)).toBe(mainTreeId);

    // The same files committed by real git give the same tree id.
    ensureGitWrapper();
    const repo = createScratchRepo("premise-plain-");
    try {
      for (const [path, content] of result.files) {
        const full = join(repo.directory, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      repo.git("add", "-A");
      const realTree = repo.git("write-tree");
      expect(plainTreeId(result.files)).toBe(realTree);
    } finally {
      repo.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// PM3a (added 2026-10-10): with `features.text_merge` on, each change merges three ways. The
// expected trees come from `git merge-file -p` on the three versions PM3a names for each path
// (base from the pool's history at the fork point, ours from the plain-merge pool, theirs the
// landing's operations over base), then `git write-tree` of the merged files (BP1).

/** `history(seq)` over the real pool's file maps after each landing (index 0: the seed). */
const historyOf =
  (maps: readonly ReadonlyMap<string, string>[]) =>
  (seq: number): ReadonlyMap<string, string> =>
    maps[Math.min(seq, maps.length - 1)]!;

const withFiles = (from: ReadonlyMap<string, string>, set: Record<string, string>): Map<string, string> => {
  const out = new Map(from);
  for (const [path, content] of Object.entries(set)) out.set(path, content);
  return out;
};

/** Real git on three versions of one file: the merged text, or null for a text conflict. */
function gitMergeFile(base: string | null, ours: string | null, theirs: string | null): string | null {
  const repo = createScratchRepo("premise-pm3a-");
  try {
    writeFileSync(join(repo.directory, "base"), base ?? "");
    writeFileSync(join(repo.directory, "ours"), ours ?? "");
    writeFileSync(join(repo.directory, "theirs"), theirs ?? "");
    try {
      return execFileSync("git", ["merge-file", "-p", "ours", "base", "theirs"], {
        cwd: repo.directory,
        env: repo.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && status > 0) return null;
      throw error;
    }
  } finally {
    repo.remove();
  }
}

/** `git write-tree` of a file map in a scratch repository. */
function gitTree(files: ReadonlyMap<string, string>): string {
  ensureGitWrapper();
  const repo = createScratchRepo("premise-pm3a-tree-");
  try {
    for (const [path, content] of files) {
      const full = join(repo.directory, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    repo.git("add", "-A");
    return repo.git("write-tree");
  } finally {
    repo.remove();
  }
}

const SEED_ENERGY = seedFiles().get("world/energy.js")!;
const ENERGY_TOP = SEED_ENERGY.replace(
  "// What one tick of ordinary living costs.",
  "// The cost of one tick of living.",
);
const ENERGY_BOTTOM = SEED_ENERGY.replace("const REST_TICKS = 300;", "const REST_TICKS = 600;");

describe("PM3a: the plain-merge replay with three-way text merge", () => {
  it("PM3a: hero landing order 1 gives the tree git merge-file gives for the same three versions", () => {
    const seed = seedFiles();
    const sApplied = seed.get("world/energy.js")!.replace(S_REPLACE.old, S_REPLACE.new);
    const crabFinal = CRAB_30.replace("crab.energy < 30", "crab.energy < 0.3");
    const shrimpFinal = SHRIMP_5.replace("drain(shrimp, 5)", "drain(shrimp, 0.05)");
    // The real pool's `main` after each landing of order 1 (7.5): S, then C, H and J as they landed.
    const h1 = withFiles(seed, { "world/energy.js": sApplied });
    const h2 = withFiles(h1, { "creatures/crab.js": crabFinal });
    const h3 = withFiles(h2, { "creatures/shrimp.js": shrimpFinal });
    const h4 = withFiles(h3, { "creatures/jellyfish.js": JELLYFISH_FILE });
    // C and H opened on the seed (opened_seq 0) and replay their ops_first; S and J their landed ops.
    const forked = (l: PlainLanding, forkSeq: number): PlainLanding => ({ ...l, forkSeq });
    const result = replayPlainMerge(
      seed,
      [
        change(1, [S_REPLACE]),
        forked(change(2, [writeFile(1, "creatures/crab.js", CRAB_30)], { opsFirst: true, submitted: false }), 0),
        forked(change(3, [writeFile(1, "creatures/shrimp.js", SHRIMP_5)], { opsFirst: true, submitted: false }), 0),
        change(4, [writeFile(1, "creatures/jellyfish.js", JELLYFISH_FILE)]),
      ],
      { textMerge: { history: historyOf([seed, h1, h2, h3, h4]) } },
    );

    // Each path's three versions, as PM3a names them, merged by real git.
    const expected = new Map(seed);
    expected.set(
      "world/energy.js",
      gitMergeFile(seed.get("world/energy.js")!, seed.get("world/energy.js")!, sApplied)!,
    );
    expected.set("creatures/crab.js", gitMergeFile(null, null, CRAB_30)!);
    expected.set("creatures/shrimp.js", gitMergeFile(null, null, SHRIMP_5)!);
    expected.set("creatures/jellyfish.js", gitMergeFile(null, null, JELLYFISH_FILE)!);
    expect(result.skipped).toEqual([]); // 7.8: the text-conflict count is 0
    expect(result.interrupted).toEqual([2, 3]);
    expect(plainTreeId(result.files)).toBe(gitTree(expected));
    // 7.8's tree: ENERGY_MAX = 1, crab.energy < 30, drain(shrimp, 5).
    expect(result.files.get("creatures/crab.js")).toContain("crab.energy < 30");
    expect(result.files.get("creatures/shrimp.js")).toContain("drain(shrimp, 5)");
    expect(result.files.get("world/energy.js")).toContain("export const ENERGY_MAX = 1;");
  });

  it("PM3a: pair P5 is still a text conflict: both sides add creatures/crab.js with different contents", () => {
    const seed = seedFiles();
    const h1 = withFiles(seed, { "creatures/crab.js": CRAB_30 });
    const h2 = withFiles(h1, { "creatures/crab.js": CRAB_BIG_CLAW });
    const result = replayPlainMerge(
      seed,
      [
        change(1, [writeFile(1, "creatures/crab.js", CRAB_30)]),
        { ...change(2, [writeFile(1, "creatures/crab.js", CRAB_BIG_CLAW)], { opsFirst: true }), forkSeq: 0 },
      ],
      { textMerge: { history: historyOf([seed, h1, h2]) } },
    );
    // Real git: base absent (empty), ours the first crab, theirs the second: a conflict.
    expect(gitMergeFile(null, CRAB_30, CRAB_BIG_CLAW)).toBeNull();
    expect(result.skipped).toEqual([2]);
    expect(result.steps[1]?.conflict).toEqual({ path: "creatures/crab.js", kind: "add_add" });
    expect(result.files.get("creatures/crab.js")).toBe(CRAB_30); // the plain-merge pool keeps the first crab
    expect(plainTreeId(result.files)).toBe(gitTree(h1));
  });

  it("PM3a: pair P4 is still a text conflict: both sides change the DAY_TICKS line", () => {
    const seed = seedFiles();
    const time = seed.get("world/time.js")!;
    const r02 = replace(1, "world/time.js", "DAY_TICKS = 3600", "DAY_TICKS = 7200", ["world/time.js#DAY_TICKS"]);
    const p4b = replace(1, "world/time.js", "DAY_TICKS = 3600", "DAY_TICKS = 10800", ["world/time.js#DAY_TICKS"]);
    const h1 = withFiles(seed, { "world/time.js": time.replace("DAY_TICKS = 3600", "DAY_TICKS = 7200") });
    const result = replayPlainMerge(seed, [change(1, [r02]), { ...change(2, [p4b], { opsFirst: true }), forkSeq: 0 }], {
      textMerge: { history: historyOf([seed, h1, h1]) },
    });
    expect(
      gitMergeFile(time, h1.get("world/time.js")!, time.replace("DAY_TICKS = 3600", "DAY_TICKS = 10800")),
    ).toBeNull();
    expect(result.skipped).toEqual([2]);
    expect(result.steps[1]?.conflict).toEqual({ path: "world/time.js", kind: "lines" });
    expect(result.files.get("world/time.js")).toContain("export const DAY_TICKS = 7200;");
  });

  it("PM3a: two whole-file writes of one module from the same base, in different regions, both land", () => {
    // PM3 skips the second write (OP5: its base moved). A three-way merge takes both edits.
    const seed = seedFiles();
    const seedOid = blobId(utf8(SEED_ENERGY));
    const h1 = withFiles(seed, { "world/energy.js": ENERGY_TOP });
    const landings = [
      change(1, [writeFile(1, "world/energy.js", ENERGY_TOP, seedOid)]),
      { ...change(2, [writeFile(1, "world/energy.js", ENERGY_BOTTOM, seedOid)], { opsFirst: true }), forkSeq: 0 },
    ];
    expect(replayPlainMerge(seed, landings).skipped).toEqual([2]); // PM3, switch off
    const result = replayPlainMerge(seed, landings, { textMerge: { history: historyOf([seed, h1, h1]) } });
    const merged = gitMergeFile(SEED_ENERGY, ENERGY_TOP, ENERGY_BOTTOM);
    expect(merged).not.toBeNull();
    expect(result.skipped).toEqual([]);
    expect(result.files.get("world/energy.js")).toBe(merged);
    expect(result.files.get("world/energy.js")).toContain("// The cost of one tick of living.");
    expect(result.files.get("world/energy.js")).toContain("export const REST_TICKS = 600;");
  });

  it("PM3a: the fork point is the first version from opened_seq on where the operations apply", () => {
    // The attempt opened on the seed, but its replace edits a line that landing 1 wrote: the
    // seed does not hold `old` (OP1), so base is `main` after landing 1, where it applies.
    const seed = seedFiles();
    const h1 = withFiles(seed, { "world/energy.js": ENERGY_BOTTOM });
    const op = replace(1, "world/energy.js", "REST_TICKS = 600", "REST_TICKS = 900", ["world/energy.js#REST_TICKS"]);
    const result = replayPlainMerge(
      seed,
      [
        change(1, [writeFile(1, "world/energy.js", ENERGY_BOTTOM, blobId(utf8(SEED_ENERGY)))]),
        { ...change(2, [op], { opsFirst: true }), forkSeq: 0 },
      ],
      { textMerge: { history: historyOf([seed, h1, h1]) } },
    );
    expect(result.skipped).toEqual([]);
    expect(result.files.get("world/energy.js")).toContain("export const REST_TICKS = 900;");
  });

  it("PM3a: operations that apply to no version from the fork point on are a text conflict (no_base)", () => {
    const seed = seedFiles();
    const op = replace(1, "world/energy.js", "NOT IN ANY VERSION", "x", ["world/energy.js#ENERGY_MAX"]);
    const result = replayPlainMerge(seed, [{ ...change(1, [op], { opsFirst: true }), forkSeq: 0 }], {
      textMerge: { history: historyOf([seed, seed]) },
    });
    expect(result.skipped).toEqual([1]);
    expect(result.steps[0]?.conflict).toEqual({ path: "world/energy.js", kind: "no_base" });
  });

  it("PM3a with PM5: undoing the first of two merged changes keeps the second, merged again", () => {
    const seed = seedFiles();
    const seedOid = blobId(utf8(SEED_ENERGY));
    const h1 = withFiles(seed, { "world/energy.js": ENERGY_TOP });
    const merged = gitMergeFile(SEED_ENERGY, ENERGY_TOP, ENERGY_BOTTOM)!;
    const h2 = withFiles(seed, { "world/energy.js": merged });
    const result = replayPlainMerge(
      seed,
      [
        change(1, [writeFile(1, "world/energy.js", ENERGY_TOP, seedOid)]),
        { ...change(2, [writeFile(1, "world/energy.js", ENERGY_BOTTOM, seedOid)], { opsFirst: true }), forkSeq: 0 },
        undo(3, [1]),
      ],
      { textMerge: { history: historyOf([seed, h1, h2, h2]) } },
    );
    // Back to the seed's content for the path, then landing 2's base and theirs merged into it:
    // git merge-file of (base seed, ours seed, theirs ENERGY_BOTTOM).
    expect(result.steps[2]?.reverted).toEqual([1]);
    expect(result.files.get("world/energy.js")).toBe(gitMergeFile(SEED_ENERGY, SEED_ENERGY, ENERGY_BOTTOM));
    expect(result.files.get("world/energy.js")).toBe(ENERGY_BOTTOM);
  });
});
