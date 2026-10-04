// The lanes of docs/spec/04-build-plan.md 3.1 (BP2) and the lane check of plan 1.5.
// Expected owners come from the table in the plan, never from scripts/ops/lanes.json (BP1).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderLaneTable, withLaneTable } from "../../scripts/build/lane-table.ts";
import {
  globToRegExp,
  laneNames,
  listedBy,
  loadLanes,
  outsideLane,
  ownerOf,
  parseLanes,
} from "../../scripts/ops/lanes.ts";
import { createScratchRepo } from "../support/git.ts";
import type { ScratchRepo } from "../support/git.ts";
import { REPO_ROOT } from "../support/source.ts";

const lanes = loadLanes();

/** Plan 3.1, one or more paths per clause of the table: path, then the lane that owns it. */
const OWNERS: ReadonlyArray<readonly [path: string, lane: string]> = [
  // lead
  ["package.json", "lead"],
  ["wrangler.jsonc", "lead"],
  ["README.md", "lead"],
  ["AGENTS.md", "lead"],
  ["docs/spec/01-core.md", "lead"],
  ["docs/measurements/cases.md", "lead"],
  ["public/replay/index.json", "lead"],
  ["src/protocol/events.ts", "lead"],
  ["src/config/features.ts", "lead"],
  ["src/copy/index.ts", "lead"],
  ["src/core/trunk/engine.ts", "lead"],
  ["src/worker/trunk/effects.ts", "lead"],
  ["src/worker/index.ts", "lead"],
  ["src/worker/env.ts", "lead"],
  ["src/worker/adapters/index.ts", "lead"],
  ["src/worker/adapters/not-built.ts", "lead"],
  ["src/floor/app/registry.ts", "lead"],
  ["scripts/build/floor-json.ts", "lead"],
  ["scripts/ops/lanes.json", "lead"],
  ["scripts/submission/check.ts", "lead"],
  ["test/arch/imports.test.ts", "lead"],
  ["test/support/source.ts", "lead"],
  ["test/cases/load.ts", "lead"],
  ["test/cases/required.json", "lead"],
  ["test/cases/list.test.ts", "lead"],
  ["test/workerd/cases-smoke.test.ts", "lead"],
  ["test/e2e/lead/rehearsal.spec.ts", "lead"],
  // leaf
  ["src/core/sync/h.ts", "leaf"],
  ["src/core/keys/key.ts", "leaf"],
  ["src/core/entities/parse.ts", "leaf"],
  ["src/core/refs/resolve.ts", "leaf"],
  ["src/core/replay/replay.ts", "leaf"],
  ["src/core/policy/tier.ts", "leaf"],
  ["src/core/diff/entity.ts", "leaf"],
  ["src/core/classify/table.test.ts", "leaf"],
  ["src/core/plain/merge.ts", "leaf"],
  ["src/core/undo/plan.ts", "leaf"],
  ["test/tidepool/scenarios/hero.test.ts", "leaf"],
  // git
  ["src/core/git/pack.ts", "git"],
  ["src/core/outbox/decide.ts", "git"],
  ["src/core/rebuild/plan.ts", "git"],
  ["src/core/trunk/outbox-apply.ts", "git"],
  ["src/core/trunk/restart.ts", "git"],
  ["src/core/trunk/register.test.ts", "git"],
  ["src/core/trunk/wiring/git.ts", "git"],
  ["src/worker/adapters/pusher/raw.ts", "git"],
  ["src/worker/adapters/token-source/minted.ts", "git"],
  ["src/worker/adapters/notes-reader/by-hash.ts", "git"],
  ["src/worker/adapters/verifier/isolate.ts", "git"],
  ["src/worker/adapters/verifier/static.test.ts", "git"],
  ["src/worker/trunk/push-runner.ts", "git"],
  ["src/worker/trunk/reconcile.ts", "git"],
  ["src/worker/trunk/rebuild-job.ts", "git"],
  ["src/worker/trunk/plain-runner.ts", "git"],
  ["src/worker/trunk/preview-runner.ts", "git"],
  ["src/worker/trunk/wiring/git.ts", "git"],
  ["src/worker/workflows/green-line.ts", "git"],
  ["test/git/pack.test.ts", "git"],
  ["test/integration/landing/pushes.test.ts", "git"],
  ["test/integration/green/green.test.ts", "git"],
  // engine
  ["src/core/trunk/tick.ts", "engine"],
  ["src/core/trunk/schema.ts", "engine"],
  ["src/core/trunk/wiring/engine.ts", "engine"],
  ["test/cases/driver.ts", "engine"],
  ["test/cases/run.test.ts", "engine"],
  // trunk
  ["src/worker/trunk/trunk-do.ts", "trunk"],
  ["src/worker/trunk/timers.ts", "trunk"],
  ["src/worker/trunk/wiring/trunk.ts", "trunk"],
  ["src/worker/routes/pools.ts", "trunk"],
  ["src/worker/routes/wiring.ts", "trunk"],
  ["src/worker/security/owner-key.ts", "trunk"],
  ["test/workerd/trunk/tool-call.test.ts", "trunk"],
  ["test/workerd/landing/outbox.test.ts", "trunk"],
  ["test/integration/tracer.test.ts", "trunk"],
  ["test/integration/kill/kill.test.ts", "trunk"],
  // agent
  ["src/core/agent/inbox.ts", "agent"],
  ["src/core/gate/bucket.ts", "agent"],
  ["src/worker/agent/agent-do.ts", "agent"],
  ["src/worker/gate/gate-do.ts", "agent"],
  ["src/worker/adapters/model/workers-ai.ts", "agent"],
  ["src/worker/adapters/attempt-repo/fork.ts", "agent"],
  ["src/worker/adapters/triage/clef.ts", "agent"],
  ["src/worker/adapters/risk/clef.ts", "agent"],
  ["src/worker/workflows/attempt-repo.ts", "agent"],
  ["test/workerd/agent/journal.test.ts", "agent"],
  ["test/workerd/gate/cap.test.ts", "agent"],
  ["test/workerd/triage/triage.test.ts", "agent"],
  ["scripts/calibrate/clef.ts", "agent"],
  // measure (Day 1 and Day 2; at IP1 the lead moves both globs to the agent lane)
  ["scripts/measure/models.ts", "measure"],
  ["scripts/measure/early/run.ts", "measure"],
  ["scripts/measure/early/score.test.ts", "measure"],
  ["src/core/agent/loop/next-action.ts", "measure"],
  ["src/core/agent/loop/next-action.test.ts", "measure"],
  // stream
  ["src/protocol/reducer/index.ts", "stream"],
  ["src/worker/floor/floor-do.ts", "stream"],
  ["src/worker/floor/wiring.ts", "stream"],
  ["test/workerd/floor/socket.test.ts", "stream"],
  ["test/fixtures/streams/tracer.ndjson", "stream"],
  ["scripts/fixtures/write.ts", "stream"],
  ["scripts/recordings/export.ts", "stream"],
  // floor-shell
  ["src/floor/main.tsx", "floor-shell"],
  ["src/floor/app/app.tsx", "floor-shell"],
  ["src/floor/app/wiring/shell.ts", "floor-shell"],
  ["src/floor/stream/socket.ts", "floor-shell"],
  ["src/floor/replay/player.ts", "floor-shell"],
  ["src/floor/state/store.ts", "floor-shell"],
  ["src/floor/styles/base.css", "floor-shell"],
  ["src/floor/keys/keys.ts", "floor-shell"],
  ["src/floor/components/strip/strip.tsx", "floor-shell"],
  ["src/floor/components/banners/banners.tsx", "floor-shell"],
  ["src/floor/components/owner-key/owner-key.tsx", "floor-shell"],
  ["src/floor/components/kill-switch/kill-switch.tsx", "floor-shell"],
  ["src/floor/components/toast/toast.tsx", "floor-shell"],
  ["src/floor/components/about/about.tsx", "floor-shell"],
  ["src/floor/components/swarm/swarm.tsx", "floor-shell"],
  ["src/floor/components/green/green.tsx", "floor-shell"],
  ["test/e2e/shell/replay.spec.ts", "floor-shell"],
  // floor-rail
  ["src/floor/app/wiring/rail.ts", "floor-rail"],
  ["src/floor/components/intent-box/intent-box.tsx", "floor-rail"],
  ["src/floor/components/attempt-card/attempt-card.tsx", "floor-rail"],
  ["src/floor/components/lights/lights.tsx", "floor-rail"],
  ["src/floor/components/heads-up/heads-up.tsx", "floor-rail"],
  ["src/floor/components/tray/tray.tsx", "floor-rail"],
  ["src/floor/components/card-sheet/card-sheet.tsx", "floor-rail"],
  ["src/floor/components/held-sheet/held-sheet.tsx", "floor-rail"],
  ["src/floor/components/race-sheet/race-sheet.tsx", "floor-rail"],
  ["src/floor/components/risk/risk.tsx", "floor-rail"],
  ["test/e2e/rail/card.spec.ts", "floor-rail"],
  // floor-pool
  ["src/floor/app/wiring/pool-area.ts", "floor-pool"],
  ["src/floor/components/pool-frame/pool-frame.tsx", "floor-pool"],
  ["src/floor/components/plain-frame/plain-frame.tsx", "floor-pool"],
  ["src/floor/components/compare/compare.tsx", "floor-pool"],
  ["src/floor/components/tiles/tiles.tsx", "floor-pool"],
  ["src/floor/components/why/why.tsx", "floor-pool"],
  ["src/floor/components/git-drawer/git-drawer.tsx", "floor-pool"],
  ["src/floor/components/who-relies/who-relies.tsx", "floor-pool"],
  ["src/floor/components/undo-sheet/undo-sheet.tsx", "floor-pool"],
  ["test/e2e/pool-area/frame.spec.ts", "floor-pool"],
  // copy
  ["src/copy/cards.ts", "copy"],
  ["src/copy/limits.ts", "copy"],
  // pool
  ["seeds/tidepool/world/energy.js", "pool"],
  ["scripts/seeds/build.ts", "pool"],
  ["src/host/main.ts", "pool"],
  ["src/worker/app-server/wiring.ts", "pool"],
  ["src/worker/adapters/pool-source/by-commit.ts", "pool"],
  ["src/worker/adapters/verifier/harness/entry.ts", "pool"],
  ["test/tidepool/seed.test.ts", "pool"],
  // swarm
  ["src/swarm/prng.ts", "swarm"],
  ["src/swarm/patterns/add-plain.ts", "swarm"],
  ["src/worker/routes/swarm.ts", "swarm"],
  ["src/worker/workflows/swarm.ts", "swarm"],
  ["scripts/soak/run.ts", "swarm"],
  ["scripts/rehearse/hero.ts", "swarm"],
  ["test/integration/collide/collide.test.ts", "swarm"],
  ["test/integration/hero/hero.test.ts", "swarm"],
];

/** The npm scripts of plan 1.5, and the two checks that BP5 and BP7 name. */
const PLAN_COMMANDS = [
  "types",
  "typecheck",
  "test",
  "test:cases",
  "test:workerd",
  "test:e2e",
  "test:integration",
  "build",
  "build:seeds",
  "build:host",
  "build:floor",
  "build:worker",
  "check",
  "check:licenses",
  "check:secrets",
  "check:lane",
  "dev:floor",
  "dev",
  "deploy:test",
  "deploy",
  "pool:create",
  "measure:models",
  "soak",
  "calibrate:clef",
  "rehearse:hero",
  "record:export",
  "check:submission",
  "cleanup:test",
  "spend",
];

/** The fourteen lanes of plan 3.1. */
const PLAN_LANES = [
  "lead",
  "leaf",
  "git",
  "engine",
  "trunk",
  "agent",
  "measure",
  "stream",
  "floor-shell",
  "floor-rail",
  "floor-pool",
  "copy",
  "pool",
  "swarm",
];

describe("lanes.json", () => {
  it("names the fourteen lanes of plan 3.1", () => {
    expect(laneNames(lanes)).toEqual(PLAN_LANES);
  });

  it("compares lane branches with main", () => {
    expect(lanes.base).toBe("main");
  });

  it.each(OWNERS)("%s belongs to %s", (path, lane) => {
    expect(listedBy(lanes, path)).toEqual(lane === "lead" ? [] : [lane]);
    expect(ownerOf(lanes, path)).toBe(lane);
  });

  it("every path the plan names for the lead is listed by no other lane", () => {
    const leadNamed = OWNERS.filter(([, lane]) => lane === "lead").map(([path]) => path);
    for (const path of leadNamed) {
      expect(
        lanes.leadNamed.some((glob) => globToRegExp(glob).test(path)),
        path,
      ).toBe(true);
    }
  });

  it("no file of the repository is listed by two lanes", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path !== "");
    expect(files.length).toBeGreaterThan(0);
    const twice = files.filter((path) => listedBy(lanes, path).length > 1);
    expect(twice).toEqual([]);
  });
});

describe("lane globs", () => {
  it("** crosses directories and * does not", () => {
    expect(globToRegExp("src/core/sync/**").test("src/core/sync/a/b.ts")).toBe(true);
    expect(globToRegExp("src/protocol/*.ts").test("src/protocol/events.ts")).toBe(true);
    expect(globToRegExp("src/protocol/*.ts").test("src/protocol/reducer/index.ts")).toBe(false);
    expect(globToRegExp("*").test("package.json")).toBe(true);
    expect(globToRegExp("*").test("src/worker/index.ts")).toBe(false);
  });

  it("a file glob covers the file and its test, and no other file", () => {
    const glob = globToRegExp("src/core/trunk/restart.*");
    expect(glob.test("src/core/trunk/restart.ts")).toBe(true);
    expect(glob.test("src/core/trunk/restart.test.ts")).toBe(true);
    expect(glob.test("src/core/trunk/restarted.ts")).toBe(false);
    expect(glob.test("src/core/trunk/restart/x.ts")).toBe(false);
  });

  it("a dot in a glob is a dot", () => {
    expect(globToRegExp("src/copy/index.ts").test("src/copy/indexXts")).toBe(false);
  });
});

describe("parseLanes", () => {
  const lane = { lane: "leaf", paths: ["src/core/sync/**"], except: [] };
  const file = (change: object): string =>
    JSON.stringify({ base: "main", lead: { named: ["*"] }, lanes: [lane], ...change });

  it("reads a lanes file", () => {
    expect(parseLanes(file({}))).toEqual({ base: "main", leadNamed: ["*"], lanes: [lane] });
  });

  it("refuses a lane that is listed twice, a lane named lead, a lane with no path and a path that is no glob", () => {
    expect(() => parseLanes(file({ lanes: [lane, lane] }))).toThrow(/listed twice/);
    expect(() => parseLanes(file({ lanes: [{ ...lane, lane: "lead" }] }))).toThrow(/not a lane name/);
    expect(() => parseLanes(file({ lanes: [{ ...lane, paths: [] }] }))).toThrow(/lists no path/);
    expect(() => parseLanes(file({ lanes: [{ ...lane, paths: ["/etc/passwd"] }] }))).toThrow(
      /not a repository path glob/,
    );
    expect(() => parseLanes(file({ lanes: [{ ...lane, paths: ["src/(a|b)/**"] }] }))).toThrow(
      /not a repository path glob/,
    );
  });
});

describe("outsideLane (BP2)", () => {
  it("is empty when every changed path is inside the lane", () => {
    expect(outsideLane(lanes, "leaf", ["src/core/sync/h.ts", "src/core/keys/key.test.ts"])).toEqual([]);
    expect(outsideLane(lanes, "leaf", [])).toEqual([]);
  });

  it("lists a path of another lane with its owner", () => {
    expect(outsideLane(lanes, "leaf", ["src/core/sync/h.ts", "src/core/git/pack.ts"])).toEqual([
      { path: "src/core/git/pack.ts", owner: "git" },
    ]);
  });

  it("lists a seam and a root file as the lead's", () => {
    expect(outsideLane(lanes, "engine", ["src/core/trunk/engine.ts", "package.json"])).toEqual([
      { path: "src/core/trunk/engine.ts", owner: "lead" },
      { path: "package.json", owner: "lead" },
    ]);
  });

  it("refuses a lane that does not exist", () => {
    expect(() => outsideLane(lanes, "nobody", [])).toThrow(/not a lane/);
  });
});

describe("npm run check:lane, on a scratch repository", () => {
  const script = join(REPO_ROOT, "scripts/ops/check-lane.ts");

  const commit = (repo: ScratchRepo, path: string, message: string): void => {
    mkdirSync(dirname(join(repo.directory, path)), { recursive: true });
    writeFileSync(join(repo.directory, path), "export const one = 1;\n");
    repo.git("add", "--", path);
    repo.git("commit", "--quiet", "--message", message);
  };

  /** A scratch repository with `main` and three lane branches. `from` is the environment the test runs in. */
  const laneRepository = (from: NodeJS.ProcessEnv): ScratchRepo => {
    const repo = createScratchRepo("premise-lane-", from);
    try {
      commit(repo, "README.md", "chore: start");
      repo.git("checkout", "--quiet", "-b", "lane/leaf/inside");
      commit(repo, "src/core/sync/h.ts", "feat: inside the leaf lane");
      repo.git("checkout", "--quiet", "main");
      repo.git("checkout", "--quiet", "-b", "lane/leaf/outside");
      commit(repo, "src/core/sync/h.ts", "feat: inside the leaf lane");
      commit(repo, "src/core/git/pack.ts", "feat: outside the leaf lane");
      repo.git("checkout", "--quiet", "main");
      repo.git("checkout", "--quiet", "-b", "lane/leaf/moves");
      mkdirSync(join(repo.directory, "src/core/sync"), { recursive: true });
      repo.git("mv", "README.md", "src/core/sync/README.md");
      repo.git("commit", "--quiet", "--message", "chore: move a root file into the lane");
      repo.git("checkout", "--quiet", "main");
    } catch (error) {
      repo.remove();
      throw error;
    }
    return repo;
  };

  const LANE_BRANCHES = ["lane/leaf/inside", "lane/leaf/moves", "lane/leaf/outside", "main"];
  const branchesOf = (repo: ScratchRepo): string[] =>
    repo.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");

  let repo: ScratchRepo;
  const checkLane = (...args: string[]): { status: number | null; output: string } => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: repo.directory,
      env: repo.env,
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };

  beforeAll(() => {
    repo = laneRepository(process.env);
  });

  afterAll(() => {
    repo?.remove();
  });

  it("builds its branches in the scratch repository", () => {
    expect(branchesOf(repo)).toEqual(LANE_BRANCHES);
  });

  // Git starts a hook with GIT_INDEX_FILE set and, from a linked work tree (where every lane works), with
  // GIT_DIR as well. Both are absolute paths there, so they win over the working directory of every git
  // command that inherits them: the commits of this test would land in the lane's own repository.
  it.each([
    [
      "a linked work tree",
      (hook: string) => ({ GIT_DIR: join(hook, ".git"), GIT_INDEX_FILE: join(hook, ".git/index") }),
    ],
    ["the main work tree", (hook: string) => ({ GIT_INDEX_FILE: join(hook, ".git/index") })],
  ])("leaves the repository of a git hook alone when the tests run from a hook in %s", (_, variablesOf) => {
    const surrounding = createScratchRepo("premise-surrounding-");
    /** Every path of the hook's repository with its size, its `.git` directory included. */
    const everyFile = (): string[] =>
      readdirSync(surrounding.directory, { recursive: true, encoding: "utf8" })
        .sort()
        .map((path) => {
          const entry = statSync(join(surrounding.directory, path));
          return entry.isFile() ? `${path} (${entry.size} bytes)` : path;
        });
    const before = everyFile();
    let built: ScratchRepo | undefined;
    try {
      built = laneRepository({ ...process.env, ...variablesOf(surrounding.directory) });
      expect(branchesOf(built)).toEqual(LANE_BRANCHES);
      // No commit, no branch, no index and no file reached the hook's repository.
      expect(surrounding.git("for-each-ref")).toBe("");
      expect(everyFile()).toEqual(before);
    } finally {
      built?.remove();
      surrounding.remove();
    }
  });

  it("exits 0 for main against main (plan 2.1, acceptance item 7)", () => {
    const result = checkLane("leaf", "main");
    expect(result.output).toContain("changes 0 path(s) against main");
    expect(result.status).toBe(0);
  });

  it("exits 0 for a branch that stays inside the lane", () => {
    const result = checkLane("leaf", "lane/leaf/inside");
    expect(result.output).toContain("changes 1 path(s) against main");
    expect(result.status).toBe(0);
  });

  it("exits 1 for a branch that touches src/core/git/ (plan 2.1, acceptance item 7)", () => {
    const result = checkLane("leaf", "lane/leaf/outside");
    expect(result.output).toContain("src/core/git/pack.ts  (lane: git)");
    expect(result.output).not.toContain("src/core/sync/h.ts");
    expect(result.status).toBe(1);
  });

  it("exits 1 for a branch that moves a file of another lane into its own", () => {
    const result = checkLane("leaf", "lane/leaf/moves");
    expect(result.output).toContain("README.md  (lane: lead)");
    expect(result.status).toBe(1);
  });

  it("exits 2 when the check cannot run", () => {
    expect(checkLane("leaf").status).toBe(2);
    expect(checkLane("nobody", "main").status).toBe(2);
    expect(checkLane("leaf", "no-such-branch").status).toBe(2);
    expect(checkLane("leaf", "--output=x").status).toBe(2);
  });
});

describe("AGENTS.md", () => {
  const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

  it("holds the lane table that scripts/ops/lanes.json gives (run `npm run agents-md`)", () => {
    expect(withLaneTable(agents, renderLaneTable(lanes))).toBe(agents);
  });

  it("names every lane of plan 3.1", () => {
    for (const lane of PLAN_LANES) {
      expect(agents, lane).toContain(`| \`${lane}\` |`);
    }
  });

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("names every command of plan 1.5, and package.json has each of them", () => {
    expect(agents).toContain("`npm ci`");
    for (const name of PLAN_COMMANDS) {
      expect(Object.keys(manifest.scripts), name).toContain(name);
      const command = name === "test" ? "npm test" : `npm run ${name}`;
      expect(agents, command).toContain(`\`${command}`);
    }
  });

  it("names every command of package.json", () => {
    for (const name of Object.keys(manifest.scripts)) {
      const command = name === "test" ? "npm test" : `npm run ${name}`;
      expect(agents, command).toContain(`\`${command}`);
    }
  });
});
