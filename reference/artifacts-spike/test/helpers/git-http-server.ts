/**
 * Local git smart-HTTP server for tests: Node's http server running the real
 * `git http-backend` CGI program. Receive-pack is enabled, so pushes are
 * handled by real git.
 *
 * URL layout mirrors Artifacts: http://127.0.0.1:<port>/git/<namespace>/<repo>.git
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// `wrangler types` adds SPIKE_KEY to NodeJS.ProcessEnv as a required key, so a plain
// record type is used here and cast where Node's API asks for ProcessEnv.
type EnvVars = Record<string, string | undefined>;

/** Environment for every git process: ignore the user's and the system's git config. */
export const GIT_ENV: EnvVars = {
  PATH: process.env.PATH,
  HOME: join(PROJECT_ROOT, ".tmp-test"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

/** Run git and return stdout as text. Throws when git exits non-zero. */
export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
}

/** Run git with extra environment variables (for example pinned author and committer dates). */
export function gitWithEnv(cwd: string, args: string[], extraEnv: Record<string, string>, input?: string | Uint8Array): string {
  const env = { ...GIT_ENV, ...extraEnv } as NodeJS.ProcessEnv;
  return execFileSync("git", args, { cwd, env, input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
}

/** Run git and return stdout as bytes. */
export function gitBytes(cwd: string, args: string[], input?: string | Uint8Array): Buffer {
  return execFileSync("git", args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Temp directory inside the project (.tmp-test/), never in the system temp dir. */
export function makeTempDir(prefix: string): string {
  const base = join(PROJECT_ROOT, ".tmp-test");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Create an empty bare repo that accepts pushes over HTTP. */
export function initBareRepo(root: string, name: string, defaultBranch = "main"): string {
  const path = join(root, `${name}.git`);
  git(root, ["init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`, path]);
  git(path, ["config", "http.receivepack", "true"]);
  return path;
}

export interface AuthRequest {
  repo: string;
  /** "git-receive-pack" or "git-upload-pack". */
  service: string;
  authorization: string | undefined;
}

export type AuthResult = { status: 200 } | { status: 401 | 403; body: string };

export interface LoggedRequest {
  method: string;
  path: string;
  service: string;
  status: number;
  /** Value of the User-Agent request header, as the server received it. */
  userAgent: string | undefined;
  /** Date.now() when the request arrived. */
  receivedAt: number;
}

export interface GitServer {
  /** For example http://127.0.0.1:54321 */
  origin: string;
  root: string;
  requests: LoggedRequest[];
  remoteFor(repo: string): string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runBackend(env: EnvVars, body: Buffer): Promise<{ status: number; headers: [string, string][]; body: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env: env as NodeJS.ProcessEnv });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => {
      const raw = Buffer.concat(out);
      const split = raw.indexOf("\r\n\r\n");
      if (split === -1) {
        resolve({ status: 500, headers: [], body: Buffer.from(`git http-backend produced no CGI header. stderr: ${stderr}`), stderr });
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
      // git may close stdin early (for example on an auth failure); the exit handler reports the result.
    });
    child.stdin.end(body);
  });
}

export async function startGitServer(options: { root: string; namespace?: string; authorize?: (req: AuthRequest) => AuthResult }): Promise<GitServer> {
  const namespace = options.namespace ?? "spike";
  const prefix = `/git/${namespace}`;
  const requests: LoggedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const receivedAt = Date.now();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      const pathInfo = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : null;
      const repoMatch = pathInfo === null ? null : /^\/([^/]+)\.git\/(.*)$/.exec(pathInfo);
      const finish = (status: number, headers: [string, string][], payload: Buffer | string, service: string) => {
        requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, service, status, userAgent: req.headers["user-agent"], receivedAt });
        res.statusCode = status;
        for (const [name, value] of headers) res.setHeader(name, value);
        res.end(payload);
      };
      if (pathInfo === null || repoMatch === null) {
        finish(404, [["Content-Type", "text/plain"]], "not found", "");
        return;
      }
      const rest = repoMatch[2]!;
      const service = rest === "info/refs" ? (url.searchParams.get("service") ?? "") : rest;
      if (options.authorize) {
        const verdict = options.authorize({ repo: repoMatch[1]!, service, authorization: req.headers.authorization });
        if (verdict.status !== 200) {
          const headers: [string, string][] = [["Content-Type", "text/plain"]];
          if (verdict.status === 401) headers.push(["WWW-Authenticate", 'Basic realm="artifacts"']);
          finish(verdict.status, headers, verdict.body, service);
          return;
        }
      }
      const gitProtocol = req.headers["git-protocol"];
      const result = await runBackend(
        {
          ...GIT_ENV,
          GIT_PROJECT_ROOT: options.root,
          GIT_HTTP_EXPORT_ALL: "1",
          GATEWAY_INTERFACE: "CGI/1.1",
          SERVER_PROTOCOL: "HTTP/1.1",
          REQUEST_METHOD: req.method ?? "GET",
          PATH_INFO: pathInfo,
          QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_USER: "spike-test",
          REMOTE_ADDR: "127.0.0.1",
          ...(typeof gitProtocol === "string" ? { GIT_PROTOCOL: gitProtocol } : {}),
        },
        body,
      );
      finish(result.status, result.headers, result.body, service);
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    root: options.root,
    requests,
    remoteFor: (repo: string) => `${origin}${prefix}/${repo}.git`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
