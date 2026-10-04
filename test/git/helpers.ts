// Helpers for the `git` project tests: scratch repositories from test/support/git.ts and a local
// smart-HTTP server that runs the real `git http-backend` CGI program on 127.0.0.1, so a hand-built
// receive-pack request is answered by real git (docs/spec/04-build-plan.md 1.4).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratchRepo, scratchGitEnv, type ScratchRepo } from "../support/git.ts";

export { createScratchRepo };
export type { ScratchRepo } from "../support/git.ts";

// `git init` copies template files out of the toolchain's template directory. Some environments
// (for example a sandbox that denies reads outside the workspace) refuse that copy and `git init`
// fails with "cannot copy ... Operation not permitted". A `git` wrapper first in PATH calls
// `git init --template=` — no template files — and passes every other command through unchanged.
// createScratchRepo resolves `git` through this PATH, so its repositories are created the same way.
const GIT_BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-test", "git-bin");

function ensureGitWrapper(): void {
  if ((process.env.PATH ?? "").split(":").includes(GIT_BIN_DIR)) return;
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(GIT_BIN_DIR, { recursive: true });
  const wrapper = join(GIT_BIN_DIR, "git");
  // Test files run in parallel processes and each installs the wrapper. It is written aside and
  // renamed into place, so no process ever executes a half-written file (`spawnSync git ENOEXEC`).
  const staged = `${wrapper}.${process.pid}`;
  writeFileSync(
    staged,
    `#!/bin/sh\nif [ "$1" = "init" ]; then\n  shift\n  exec "${real}" init --template= "$@"\nfi\nexec "${real}" "$@"\n`,
  );
  chmodSync(staged, 0o755);
  renameSync(staged, wrapper);
  process.env.PATH = `${GIT_BIN_DIR}:${process.env.PATH ?? ""}`;
}

ensureGitWrapper();

/** Runs `git` in `cwd` with the scratch environment (no user configuration, fixed identity). */
export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  return spawnGit(cwd, args, input)
    .stdout.toString("utf8")
    .replace(/\r?\n$/, "");
}

export function gitBytes(cwd: string, args: string[], input?: string | Uint8Array): Buffer {
  return spawnGit(cwd, args, input).stdout;
}

/** Runs `git` with extra environment variables (for example pinned author and committer dates). */
export function gitWithEnv(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string>,
  input?: string | Uint8Array,
): string {
  return spawnGit(cwd, args, input, extraEnv)
    .stdout.toString("utf8")
    .replace(/\r?\n$/, "");
}

/**
 * `git` like the sync helper, but asynchronous. A stock-git client call against the test's own
 * http server (`ls-remote http://127.0.0.1:...`) must not block the event loop: the server in this
 * same process has to answer while the command waits.
 */
export function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv() });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0)
        resolve(
          Buffer.concat(out)
            .toString("utf8")
            .replace(/\r?\n$/, ""),
        );
      else reject(new Error(`git ${args.join(" ")} exited ${status} in ${cwd}: ${err}`));
    });
    child.stdin.end();
  });
}

function spawnGit(
  cwd: string,
  args: string[],
  input?: string | Uint8Array,
  extraEnv?: Record<string, string>,
): { stdout: Buffer } {
  const child = spawnSync("git", args, {
    cwd,
    env: { ...gitEnv(), ...extraEnv },
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${child.status} in ${cwd}: ${child.stderr.toString("utf8")} ${child.stdout.toString("utf8")}`,
    );
  }
  return { stdout: child.stdout };
}

/**
 * The environment for a git child: the scratch env, no interactive prompt, and no proxy. The
 * environment these tests run in is full of proxy variables (HTTP_PROXY and friends); the only
 * remote git talks to here is the test's own `git http-backend` on 127.0.0.1, and `no_proxy=*`
 * keeps even a broken or intercepted proxy variable out of the way.
 */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...scratchGitEnv(),
    GIT_TERMINAL_PROMPT: "0",
    no_proxy: "*",
    NO_PROXY: "*",
    ...extra,
  };
}

/**
 * A scratch repository that `git http-backend` may serve for receive-pack. The repository is not
 * bare, so the receive.denyCurrentBranch rule is relaxed: receive-pack updates the checked-out
 * branch's ref without touching the worktree, exactly what a test server needs.
 */
export function createServerRepo(prefix: string): ScratchRepo {
  const repo = createScratchRepo(prefix);
  repo.git("config", "http.receivepack", "true");
  repo.git("config", "receive.denyCurrentBranch", "ignore");
  return repo;
}

/** One ref command a git-receive-pack request body carries. */
export type RefCommand = { ref: string; old: string; new: string };

/** The commands of a git-receive-pack request: the pkt-lines before the flush and the pack. */
export function parseReceivePackCommands(body: Buffer): RefCommand[] {
  const commands: RefCommand[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const length = parseInt(body.toString("ascii", at, at + 4), 16);
    if (!Number.isFinite(length) || length === 0) break;
    const line = body.toString("latin1", at + 4, at + length);
    const [oldOid, newOid, rest] = line.split(" ", 3);
    if (oldOid === undefined || newOid === undefined || rest === undefined) break;
    commands.push({ ref: rest.split("\0")[0]!.trim(), old: oldOid, new: newOid });
    at += length;
  }
  return commands;
}

/** One request the test server saw, in the order it arrived. */
export type RecordedRequest = {
  method: string;
  /** Pathname and query, for example `/repo/info/refs?service=git-receive-pack`. */
  path: string;
  authorization: string | null;
  /** The ref commands of a `git-receive-pack` POST; absent on every other request. */
  commands?: RefCommand[];
};

/**
 * A gate in front of `git http-backend` standing in for Artifacts' token check: every
 * request whose Authorization header is not `Bearer <expectedToken>` is answered with
 * `status` (default 401) before git runs. `expectedToken` is read per request, so a test
 * may change which token the gate accepts mid-test. Null or undefined means no check.
 */
export type GitGate = {
  expectedToken?: string | null;
  status?: number;
};

/**
 * What the server does with one request, decided per request by `server.fault` — the
 * harness's configurable stand-in for Artifacts' unreliable edge (LP5):
 * - `forward` (the default): hand the request to real `git http-backend` and relay its answer.
 * - `answer`: never reach the backend — an HTTP status of the test's choosing (401, 429, 503),
 *   with optional headers (`Retry-After`).
 * - `apply_then_answer`: run the backend — real git applies every command — then rewrite refs
 *   through `setRefs` and answer `status`. `"revert"` puts the command's old value back (deleting
 *   the ref when it had none), `"other"` points the ref at a fresh orphan commit, a 40-hex value
 *   pins it. This is how a row of LP5 like "main applied, notes not" is produced honestly.
 * - `apply_then_drop`: run the backend — the refs land — then destroy the socket without
 *   answering, a response lost after server-side application.
 */
export type GitFault =
  | { action: "forward" }
  | { action: "answer"; status: number; headers?: Record<string, string> }
  | {
      action: "apply_then_answer";
      status: number;
      setRefs?: Record<string, "revert" | "other" | (string & {})>;
    }
  | { action: "apply_then_drop" };

export type GitFaultFor = (request: RecordedRequest & { body?: Buffer }) => GitFault;

export type GitHttpServer = {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  /** The remote URL a stock git client uses for `repo` (its directory's base name). */
  remoteFor(repo: ScratchRepo): string;
  /** Every request the server saw, in order. */
  readonly requests: RecordedRequest[];
  /** The fault hook; assigned by the test, consulted per request. Default `forward`. */
  fault: GitFaultFor;
  close(): Promise<void>;
};

/** A ref value, or null when the ref does not resolve. */
export function refValue(dir: string, ref: string): string | null {
  try {
    const value = git(dir, ["rev-parse", "--verify", "-q", ref]);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

const ZERO_OID_RE = /^0+$/;

/** One `setRefs` rewrite of `apply_then_answer` (see `GitFault`). */
function moveRef(dir: string, ref: string, how: string, commands: RefCommand[]): void {
  if (how === "revert") {
    const oldOid = commands.find((command) => command.ref === ref)?.old ?? "";
    if (oldOid === "" || ZERO_OID_RE.test(oldOid)) {
      if (refValue(dir, ref) !== null) git(dir, ["update-ref", "-d", ref]);
      return;
    }
    git(dir, ["update-ref", ref, oldOid]);
    return;
  }
  if (how === "other") {
    // An orphan commit on the empty tree: a value no push of this batch could have produced.
    const tree = git(dir, ["mktree"], "");
    const orphan = git(dir, ["commit-tree", tree, "-m", "moved by the fault proxy"]);
    git(dir, ["update-ref", ref, orphan]);
    return;
  }
  git(dir, ["update-ref", ref, how]);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runBackend(
  env: NodeJS.ProcessEnv,
  body: Buffer,
): Promise<{ status: number; headers: [string, string][]; body: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["http-backend"], { env: gitEnv(env) });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ status: 500, headers: [], body: Buffer.from(String(error)), stderr }));
    child.on("close", () => {
      const raw = Buffer.concat(out);
      const split = raw.indexOf("\r\n\r\n");
      if (split === -1) {
        resolve({
          status: 500,
          headers: [["Content-Type", "text/plain"]],
          body: Buffer.from(`git http-backend produced no CGI response; stderr: ${stderr}`),
          stderr,
        });
        return;
      }
      let status = 200;
      const headers: [string, string][] = [];
      for (const line of raw.subarray(0, split).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = parseInt(value, 10);
        else headers.push([name, value]);
      }
      resolve({ status, headers, body: raw.subarray(split + 4), stderr });
    });
    child.stdin.on("error", () => {
      // git may close stdin early; the close handler reports the result.
    });
    child.stdin.end(body);
  });
}

/**
 * Serves every directory under `projectRoot` (a directory's base name is its URL path) with real
 * `git http-backend`, with `GIT_HTTP_EXPORT_ALL` so no git-daemon-export-ok file is needed.
 */
export async function startGitServer(projectRoot: string, options?: { gate?: GitGate }): Promise<GitHttpServer> {
  const requests: RecordedRequest[] = [];
  // Held in a box so the test's later assignment to `server.fault` is what the handler reads.
  const hook: { fault: GitFaultFor } = { fault: () => ({ action: "forward" }) };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authorization = req.headers.authorization ?? null;
      const recorded: RecordedRequest & { body?: Buffer } = {
        method: req.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        authorization,
      };
      requests.push(recorded);
      const gate = options?.gate;
      if (
        gate?.expectedToken !== undefined &&
        gate.expectedToken !== null &&
        authorization !== `Bearer ${gate.expectedToken}`
      ) {
        res.statusCode = gate.status ?? 401;
        res.end();
        return;
      }
      const body = await readBody(req);
      if (recorded.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        recorded.body = body;
        recorded.commands = parseReceivePackCommands(body);
      }
      const fault = hook.fault(recorded);
      if (fault.action === "answer") {
        res.writeHead(fault.status, fault.headers ?? {});
        res.end();
        return;
      }
      const result = await runBackend(
        {
          ...scratchGitEnv(),
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          GATEWAY_INTERFACE: "CGI/1.1",
          REQUEST_METHOD: req.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_ADDR: "127.0.0.1",
        },
        body,
      );
      // The backend has run: whatever the refs hold now is real git's answer. The fault may
      // still drop the response or rewrite a ref before the report would have gone out.
      if (fault.action === "apply_then_drop") {
        req.socket.destroy();
        return;
      }
      if (fault.action === "apply_then_answer") {
        const repoDir = join(projectRoot, decodeURIComponent(url.pathname.split("/")[1] ?? ""));
        for (const [ref, how] of Object.entries(fault.setRefs ?? {})) {
          moveRef(repoDir, ref, how, recorded.commands ?? []);
        }
        res.statusCode = fault.status;
        res.end();
        return;
      }
      res.statusCode = result.status;
      for (const [name, value] of result.headers) res.setHeader(name, value);
      res.end(result.body);
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    remoteFor: (repo: ScratchRepo) => `http://127.0.0.1:${port}/${basename(repo.directory)}`,
    requests,
    get fault() {
      return hook.fault;
    },
    set fault(next: GitFaultFor) {
      hook.fault = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** The parent directory of `repo`: the GIT_PROJECT_ROOT under which the server finds it. */
export function repoRoot(repo: ScratchRepo): string {
  return dirname(repo.directory);
}

/** Posts a receive-pack request body to the local server and returns the HTTP status and body. */
export async function postReceivePack(remote: string, body: Uint8Array): Promise<{ status: number; body: Uint8Array }> {
  const response = await fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: { "Content-Type": "application/x-git-receive-pack-request" },
    body: Buffer.from(body),
  });
  return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
}

/** GETs an info/refs response for `service` ("git-receive-pack" or "git-upload-pack"). */
export async function getInfoRefs(remote: string, service: string): Promise<Uint8Array> {
  const response = await fetch(`${remote}/info/refs?service=${service}`);
  return new Uint8Array(await response.arrayBuffer());
}
