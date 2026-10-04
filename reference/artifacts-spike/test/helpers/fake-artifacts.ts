/**
 * Fake Artifacts binding for local tests.
 *
 * Repos are real bare git repos on disk, served by the local git HTTP server,
 * so every git request in the experiments is handled by real git. The fake
 * copies the documented surface of the binding (create/get/list/delete, and
 * info/createToken/fork/log/readCommit/readTree/readBlob/readFile on the
 * handle) and the documented token rules. It says nothing about how the real
 * service behaves.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, gitBytes, initBareRepo, removeDir, type AuthRequest, type AuthResult } from "./git-http-server";

export class FakeArtifactsError extends Error {
  override readonly name = "ArtifactsError";
  constructor(
    readonly code: string,
    readonly numericCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface RepoRecord {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  source: string | null;
  readOnly: boolean;
  /** This many more get() calls throw `pendingCode` before the repo counts as ready. */
  pendingGets: number;
  pendingCode: "CREATE_IN_PROGRESS" | "FORK_IN_PROGRESS";
}

interface TokenRecord {
  id: string;
  repo: string;
  scope: "read" | "write";
  secret: string;
  plaintext: string;
  expiresAt: number;
}

export interface FakeOptions {
  /** The first N get() calls after create() throw CREATE_IN_PROGRESS. Counted, not timed, so tests are deterministic. */
  createPendingGets?: number;
  /** The first N get() calls after fork() throw FORK_IN_PROGRESS. */
  forkPendingGets?: number;
  /** Simulate workers-sdk issue 15429: tokens from createToken() get HTTP 403 on git requests. */
  mintedTokensForbidden?: boolean;
}

export class FakeArtifacts {
  readonly repos = new Map<string, RepoRecord>();
  readonly tokens = new Map<string, TokenRecord>();
  /** Every token ever issued, for redaction checks. */
  readonly issued: string[] = [];
  readonly minted = new Set<string>();
  handlesOpened = 0;
  handlesDisposed = 0;

  constructor(
    private readonly root: string,
    private readonly remoteFor: (repo: string) => string,
    readonly options: FakeOptions = {},
  ) {}

  repoPath(name: string): string {
    return join(this.root, `${name}.git`);
  }

  mint(repo: string, scope: "read" | "write", ttl: number): TokenRecord {
    const secret = `art_v1_${randomBytes(20).toString("hex")}`;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const token: TokenRecord = { id: randomUUID(), repo, scope, secret, plaintext: `${secret}?expires=${expiresAt}`, expiresAt };
    this.tokens.set(secret, token);
    this.issued.push(token.plaintext);
    return token;
  }

  /** Auth hook for the local git server, following the documented token rules. */
  authorize = (req: AuthRequest): AuthResult => {
    const header = req.authorization;
    if (!header) return { status: 401, body: "authentication required" };
    let secret: string | null = null;
    if (header.startsWith("Bearer ")) {
      // Bearer takes the full token string, expiry suffix included.
      const full = header.slice("Bearer ".length);
      const match = [...this.tokens.values()].find((t) => t.plaintext === full);
      secret = match?.secret ?? null;
    } else if (header.startsWith("Basic ")) {
      // Basic takes the secret (no "?expires=" suffix) as the password; the username is ignored.
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      secret = decoded.slice(decoded.indexOf(":") + 1);
    }
    const token = secret === null ? undefined : this.tokens.get(secret);
    if (!token) return { status: 401, body: "invalid token" };
    if (token.repo !== req.repo) return { status: 403, body: "token does not belong to this repository" };
    if (token.expiresAt * 1000 < Date.now()) return { status: 401, body: "token expired" };
    if (this.options.mintedTokensForbidden && this.minted.has(token.secret)) return { status: 403, body: "forbidden (simulated issue 15429)" };
    if (req.service === "git-receive-pack" && token.scope !== "write") return { status: 403, body: "read tokens cannot push" };
    return { status: 200 };
  };

  async create(name: string, opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }) {
    if (this.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS", 10201, `repository ${name} already exists`);
    const defaultBranch = opts?.setDefaultBranch ?? "main";
    initBareRepo(this.root, name, defaultBranch);
    const record: RepoRecord = {
      id: randomUUID(),
      name,
      description: opts?.description ?? null,
      defaultBranch,
      createdAt: new Date().toISOString(),
      source: null,
      readOnly: opts?.readOnly ?? false,
      pendingGets: this.options.createPendingGets ?? 0,
      pendingCode: "CREATE_IN_PROGRESS",
    };
    this.repos.set(name, record);
    const token = this.mint(name, "write", 86400);
    return { id: record.id, name, description: record.description, defaultBranch, remote: this.remoteFor(name), token: token.plaintext };
  }

  async get(name: string): Promise<FakeRepo> {
    const record = this.repos.get(name);
    if (!record) throw new FakeArtifactsError("NOT_FOUND", 10200, `repository ${name} not found`);
    if (record.pendingGets > 0) {
      record.pendingGets--;
      throw new FakeArtifactsError(record.pendingCode, record.pendingCode === "FORK_IN_PROGRESS" ? 10303 : 0, `repository ${name} is not ready yet`);
    }
    this.handlesOpened++;
    return new FakeRepo(this, record);
  }

  async list(opts?: { limit?: number; cursor?: string }) {
    const names = [...this.repos.keys()].sort();
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 50;
    const page = names.slice(start, start + limit);
    const next = start + limit < names.length ? String(start + limit) : undefined;
    return { repos: page.map((n) => this.infoFor(this.repos.get(n)!, false)), total: names.length, cursor: next };
  }

  async delete(name: string): Promise<boolean> {
    if (!this.repos.has(name)) return false;
    this.repos.delete(name);
    removeDir(this.repoPath(name));
    for (const [secret, token] of this.tokens) if (token.repo === name) this.tokens.delete(secret);
    return true;
  }

  async import(): Promise<never> {
    throw new FakeArtifactsError("INTERNAL_ERROR", 10400, "import is not implemented in the fake");
  }

  infoFor(record: RepoRecord, withRemote: boolean) {
    const path = this.repoPath(record.name);
    let lastPushAt: string | null = null;
    if (existsSync(path)) {
      const refs = git(path, ["for-each-ref", "--count=1"]).trim();
      if (refs.length > 0) lastPushAt = new Date().toISOString();
    }
    const info = {
      id: record.id,
      name: record.name,
      description: record.description,
      defaultBranch: record.defaultBranch,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      lastPushAt,
      source: record.source,
      readOnly: record.readOnly,
    };
    return withRemote ? { ...info, remote: this.remoteFor(record.name) } : info;
  }

  forkRecord(source: RepoRecord, name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }) {
    if (this.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS", 10201, `repository ${name} already exists`);
    const target = this.repoPath(name);
    const args = ["clone", "--bare", "--quiet"];
    if (opts?.defaultBranchOnly !== false) args.push("--single-branch", "--branch", source.defaultBranch);
    git(this.root, [...args, this.repoPath(source.name), target]);
    git(target, ["config", "http.receivepack", "true"]);
    const record: RepoRecord = {
      id: randomUUID(),
      name,
      description: opts?.description ?? null,
      defaultBranch: source.defaultBranch,
      createdAt: new Date().toISOString(),
      source: `artifacts:spike/${source.name}`,
      readOnly: opts?.readOnly ?? false,
      pendingGets: this.options.forkPendingGets ?? 0,
      pendingCode: "FORK_IN_PROGRESS",
    };
    this.repos.set(name, record);
    const token = this.mint(name, "write", 86400);
    return { id: record.id, name, description: record.description, defaultBranch: record.defaultBranch, remote: this.remoteFor(name), token: token.plaintext };
  }
}

const LOG_FORMAT = "%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%at%x1f%ct%x1f%B%x1e";

function parseLog(output: string) {
  return output
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [hash, treeHash, parents, an, ae, cn, ce, at, ct, message] = entry.split("\x1f");
      return {
        hash: hash!,
        treeHash: treeHash!,
        message: (message ?? "").replace(/\n$/, ""),
        author: { name: an!, email: ae! },
        committer: { name: cn!, email: ce! },
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        authoredAt: Number(at),
        committedAt: Number(ct),
      };
    });
}

export class FakeRepo {
  constructor(
    private readonly owner: FakeArtifacts,
    private readonly record: RepoRecord,
  ) {}

  private get path(): string {
    return this.owner.repoPath(this.record.name);
  }

  [Symbol.dispose](): void {
    this.owner.handlesDisposed++;
  }

  async info() {
    return this.owner.infoFor(this.record, true);
  }

  async createToken(scope: "read" | "write" = "write", ttl = 86400) {
    if (ttl < 60 || ttl > 31_536_000) throw new FakeArtifactsError("INVALID_TTL", 10103, "ttl out of range");
    const token = this.owner.mint(this.record.name, scope, ttl);
    this.owner.minted.add(token.secret);
    return { id: token.id, plaintext: token.plaintext, scope, expiresAt: new Date(token.expiresAt * 1000).toISOString() };
  }

  async listTokens() {
    const tokens = [...this.owner.tokens.values()].filter((t) => t.repo === this.record.name);
    return {
      tokens: tokens.map((t) => ({ id: t.id, scope: t.scope, state: "active" as const, createdAt: new Date().toISOString(), expiresAt: new Date(t.expiresAt * 1000).toISOString() })),
      total: tokens.length,
    };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    for (const [secret, token] of this.owner.tokens) {
      if (token.id === tokenOrId || token.plaintext === tokenOrId) {
        this.owner.tokens.delete(secret);
        return true;
      }
    }
    return false;
  }

  async fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }) {
    return this.owner.forkRecord(this.record, name, opts);
  }

  async log(opts?: { ref?: string; limit?: number; offset?: number }) {
    try {
      const out = git(this.path, ["log", "--first-parent", `--max-count=${opts?.limit ?? 50}`, `--skip=${opts?.offset ?? 0}`, `--format=${LOG_FORMAT}`, opts?.ref ?? "HEAD", "--"]);
      return parseLog(out);
    } catch {
      return [];
    }
  }

  async readCommit(hash: string) {
    try {
      if (git(this.path, ["cat-file", "-t", hash]).trim() !== "commit") return null;
      return parseLog(git(this.path, ["log", "--max-count=1", `--format=${LOG_FORMAT}`, hash, "--"]))[0] ?? null;
    } catch {
      return null;
    }
  }

  async readTree(hash: string) {
    try {
      if (git(this.path, ["cat-file", "-t", hash]).trim() !== "tree") return null;
      return git(this.path, ["ls-tree", hash])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t");
          const [mode, kind, oid] = meta!.split(" ");
          const type = kind === "tree" ? "tree" : kind === "commit" ? "gitlink" : mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob";
          return { name: name!, mode: mode!.replace(/^0/, ""), hash: oid!, type };
        });
    } catch {
      return null;
    }
  }

  async readBlob(hash: string): Promise<Blob | null> {
    try {
      if (git(this.path, ["cat-file", "-t", hash]).trim() !== "blob") return null;
      return new Blob([gitBytes(this.path, ["cat-file", "blob", hash])]);
    } catch {
      return null;
    }
  }

  async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
    try {
      const spec = `${args.ref}:${args.path}`;
      if (git(this.path, ["cat-file", "-t", spec]).trim() !== "blob") return null;
      return new Blob([gitBytes(this.path, ["cat-file", "blob", spec])], { type: "text/plain;charset=utf-8" });
    } catch {
      return null;
    }
  }
}
