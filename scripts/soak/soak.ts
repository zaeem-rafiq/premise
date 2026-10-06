// `npm run soak` — the Swarm soak of VE6 (docs/spec/04-build-plan.md 5.2). For each collision-dial
// value: one `summary_only` pool seeded from `tidepool-swarm`, the `SwarmConfig` of VE6 against it,
// then the eleven checks — one `SoakResult` file per dial under `--out`.
//
// Usage:
//   npm run soak -- --agents 1024 --dial 0,0.1,0.25,0.5,1 --seed 7 \
//     [--launch-per-second 50] [--namespace premise-test-pools] [--out docs/measurements/soak]
//
// `PREMISE_URL` is the service origin, `PREMISE_OWNER_KEY` the owner key (BP7: it is never
// printed, never written). The Artifacts read token comes from
// `npx wrangler artifacts repos issue-token <repo> --namespace <ns> --scope read --ttl 900 --json`
// and reaches the clone only through git's own process environment (`http.extraHeader`).
// The file name is `<UTC date>-<build>-d<dial>.json` with `build` the short commit id.
// Exits 0 only when every check of every dial passed; prints one line per check.

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PoolEvent } from "../../src/protocol/events.ts";
import type { SwarmConfig } from "../../src/protocol/swarm.ts";
import type { FloorJson } from "../../src/protocol/floor-json.ts";
import { redact } from "../../src/protocol/redact.ts";
import { runDial } from "./run.ts";
import type { SoakDeps, SoakResponse, SoakResult, SoakStream } from "./run.ts";

const execFileAsync = promisify(execFile);

type Args = {
  agents: number | null;
  dial: number[];
  seed: number | null;
  launchPerSecond: number | null;
  namespace: string;
  out: string;
};

const USAGE =
  "usage: npm run soak -- --agents <n> --dial <d,d,…> --seed <n> " +
  "[--launch-per-second <n>] [--namespace <ns>] [--out <dir>]";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agents: null,
    dial: [],
    seed: null,
    launchPerSecond: null,
    namespace: "premise-test-pools",
    out: "docs/measurements/soak",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--agents":
        args.agents = Number(argv[++i]);
        break;
      case "--dial":
        args.dial = (argv[++i] ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map(Number);
        break;
      case "--seed":
        args.seed = Number(argv[++i]);
        break;
      case "--launch-per-second":
        args.launchPerSecond = Number(argv[++i]);
        break;
      case "--namespace":
        args.namespace = argv[++i] ?? "";
        break;
      case "--out":
        args.out = argv[++i] ?? "";
        break;
      default:
        throw new Error(`${USAGE}\nunknown argument: ${String(a)}`);
    }
  }
  if (args.agents === null || !Number.isInteger(args.agents) || args.agents < 0) {
    throw new Error(`${USAGE}\n--agents must be a non-negative integer`);
  }
  if (args.dial.length === 0) throw new Error(`${USAGE}\n--dial needs at least one value`);
  for (const d of args.dial) {
    if (!Number.isFinite(d) || d < 0 || d > 1) throw new Error(`--dial values are numbers in [0, 1]: ${d}`);
  }
  if (args.out === "") throw new Error("--out needs a directory");
  if (args.namespace === "") throw new Error("--namespace needs a name");
  return args;
}

// ---- The real dependencies of run.ts ----

/** Everything the owner key or a read token could leak into passes through `redact` first. */
const secrets: string[] = [];
const clean = (text: string): string => redact(text, secrets);

function makeDeps(origin: string, ownerKey: string, namespace: string): SoakDeps {
  const http: SoakDeps["http"] = async ({ method, path, body }): Promise<SoakResponse> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ownerKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const buffer = await response.arrayBuffer();
    return { status: response.status, body: new TextDecoder().decode(buffer), bytes: buffer.byteLength };
  };

  const openStream: SoakDeps["openStream"] = (pool): SoakStream => {
    const pending: PoolEvent[] = [];
    const socket = {
      pending,
      closed: false,
      close(): void {
        socket.closed = true;
        ws.close();
      },
    };
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/pools/${pool}/stream`);
    ws.onopen = () => ws.send(JSON.stringify({ hello: 1, after: 0 }));
    ws.onmessage = (message) => {
      try {
        const frame = JSON.parse(String(message.data)) as { events?: PoolEvent[] };
        for (const event of frame.events ?? []) pending.push(event);
      } catch {
        /* an unparseable frame carries no event */
      }
    };
    ws.onclose = () => {
      socket.closed = true;
    };
    ws.onerror = () => {
      socket.closed = true;
    };
    return socket;
  };

  const git: SoakDeps["git"] = async (args, opts) => {
    const env = { ...(opts?.env ?? {}) };
    try {
      const { stdout, stderr } = await execFileAsync("git", [...args], {
        cwd: opts?.cwd,
        env: { ...process.env, ...env },
        maxBuffer: 256 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (cause) {
      const error = cause as { code?: number; stdout?: string; stderr?: string };
      return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };

  const issueToken: SoakDeps["issueToken"] = async (repo) => {
    const { stdout } = await execFileAsync(
      "npx",
      [
        "wrangler",
        "artifacts",
        "repos",
        "issue-token",
        repo,
        "--namespace",
        namespace,
        "--scope",
        "read",
        "--ttl",
        "900",
        "--json",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    let token = "";
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      for (const field of ["token", "value", "secret", "plaintext", "key"]) {
        if (typeof parsed[field] === "string" && parsed[field] !== "") {
          token = parsed[field] as string;
          break;
        }
      }
    } catch {
      /* not JSON: the token pattern below is the fallback */
    }
    if (token === "") {
      const match = /art_v\d+_[0-9a-f]+/.exec(stdout);
      if (match !== null) token = match[0];
    }
    if (token === "") throw new Error("wrangler issue-token answered no token");
    secrets.push(token);
    return token;
  };

  return {
    http,
    openStream,
    git,
    issueToken,
    clock: { now: () => Date.now() },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

// ---- The command ----

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const origin = process.env.PREMISE_URL;
  const ownerKey = process.env.PREMISE_OWNER_KEY;
  if (origin === undefined || origin === "") throw new Error("PREMISE_URL is not set");
  if (ownerKey === undefined || ownerKey === "") throw new Error("PREMISE_OWNER_KEY is not set");
  secrets.push(ownerKey);

  const build = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const deps = makeDeps(origin.replace(/\/$/, ""), ownerKey, args.namespace);

  // `swarm_defaults` of /floor.json fills the SwarmConfig fields the flags do not name (VE6).
  const floorResponse = await deps.http({ method: "GET", path: "/floor.json" });
  if (floorResponse.status < 200 || floorResponse.status >= 300) {
    throw new Error(`GET /floor.json answered ${floorResponse.status}`);
  }
  const defaults = (JSON.parse(floorResponse.body) as FloorJson).swarm_defaults;

  const runTag = Date.now().toString(36);
  mkdirSync(args.out, { recursive: true });
  let allOk = true;
  const date = new Date().toISOString().slice(0, 10);

  for (const dial of args.dial) {
    const config: SwarmConfig = {
      seed: args.seed ?? defaults.seed,
      agents: args.agents as number,
      launch_per_second: args.launchPerSecond ?? defaults.launch_per_second,
      collision_dial: dial,
      think_ms: defaults.think_ms,
      rescale_every_s: defaults.rescale_every_s,
    };
    const pool = `soak-${runTag}-d${String(dial).replace(/\./g, "-")}`;
    const cloneDir = join(".tmp-test", `soak-clone-${pool}`);
    mkdirSync(cloneDir, { recursive: true });

    let result: SoakResult;
    try {
      result = await runDial(
        {
          pool,
          config,
          build,
          cloneDir,
          recordedAt: () => new Date().toISOString(),
        },
        deps,
      );
    } catch (cause) {
      allOk = false;
      process.stdout.write(
        `d${dial} ${pool}: run failed: ${clean(cause instanceof Error ? cause.message : String(cause))}\n`,
      );
      continue;
    }

    for (const check of result.checks) {
      if (!check.ok) allOk = false;
      process.stdout.write(`d${dial} ${check.name} ${check.ok ? "ok" : "FAIL"} ${check.detail ?? ""}\n`);
    }
    const file = join(args.out, `${date}-${build}-d${dial}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(`d${dial} wrote ${file}\n`);
  }
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((cause) => {
    process.stderr.write(`${clean(cause instanceof Error ? cause.message : String(cause))}\n`);
    process.exit(1);
  });
