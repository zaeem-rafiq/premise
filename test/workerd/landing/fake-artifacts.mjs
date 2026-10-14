// The fake `env.POOLS` Artifacts binding of the Slice-1 landing acceptance (04-build-plan 2.2,
// item 3's local stand-in for Artifacts). It is a service-bound `WorkerEntrypoint`: Trunk's
// token source calls `get(name)` then `info()`/`createToken()`, the app server's pool source
// calls `readFile`/`readCommit`/`readTree`, and the pool-create route calls `create(name)`.
//
// The remote it reports is the test's real `git http-backend` server (GIT_ORIGIN); the reads are
// served by the test's read sidecar (READ_ORIGIN), which answers from the same repositories with
// stock `git show`/`git cat-file`/`git ls-tree`. A token is `tok-<repo>-<scope>` — visible to the
// test's auth gate, never a real secret.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class Repo extends RpcTarget {
  // `this.env` is not injected into an RpcTarget in local workerd: it is handed in, not awaited.
  constructor(name, env) {
    super();
    this.name = name;
    this.env = env;
  }
  async info() {
    // The real binding's `get` throws NOT_FOUND for a missing repository. An error's `code`
    // does not cross this service binding, so the stand-in's miss throws `NOT_FOUND:` as a
    // message prefix — the wipe probe (`#probeEmptyPool`) reads either shape.
    const exists = await fetch(`${this.env.READ_ORIGIN}/exists/${this.name}`);
    if (exists.status === 404) throw new Error(`NOT_FOUND: ${this.name}`);
    // `defaultBranch` is the clone's checked-out branch; a sidecar without /branch (the
    // real-agent lane's leaner one) answers 404 and the stand-in's repos are all `main`.
    const branch = await fetch(`${this.env.READ_ORIGIN}/branch/${this.name}`);
    const defaultBranch = branch.ok ? (await branch.json()).branch : "main";
    return { remote: `${this.env.GIT_ORIGIN}/${this.name}`, defaultBranch };
  }
  async createToken(scope) {
    return {
      plaintext: `tok-${this.name}-${scope}`,
      expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    };
  }
  async readFile({ ref, path }) {
    const response = await fetch(`${this.env.READ_ORIGIN}/file/${this.name}/${ref}/${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`readFile: ${response.status}`);
    return await response.blob();
  }
  async readCommit(hash) {
    const response = await fetch(`${this.env.READ_ORIGIN}/commit/${this.name}/${hash}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`readCommit: ${response.status}`);
    return await response.json();
  }
  async readBlob(hash) {
    const response = await fetch(`${this.env.READ_ORIGIN}/blob/${this.name}/${hash}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`readBlob: ${response.status}`);
    return await response.blob();
  }
  // The platform's `log`: first-parent, newest first, `offset`/`limit` paged.
  async log(opts = {}) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const response = await fetch(`${this.env.READ_ORIGIN}/log/${this.name}/${opts.ref ?? "HEAD"}?${params}`);
    if (!response.ok) return [];
    return await response.json();
  }
  async readTree(hash) {
    const response = await fetch(`${this.env.READ_ORIGIN}/tree/${this.name}/${hash}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`readTree: ${response.status}`);
    return await response.json();
  }
}

export default class FakeArtifacts extends WorkerEntrypoint {
  // `create` never throws: an error's `code` does not cross the service binding's RPC, so the
  // ALREADY_EXISTS branch of the route cannot be exercised from a fake. An existing repo is
  // idempotent here — the remote is the same either way.
  async create(name) {
    // Opt-in (AUTO_CREATE): a name no test can know ahead — a try pool's `try-<id>` — gets its
    // receive-pack-enabled repository on the git server when it is created.
    if (this.env.AUTO_CREATE === "1") {
      const made = await fetch(`${this.env.READ_ORIGIN}/create/${name}`, { method: "POST" });
      if (!made.ok) throw new Error(`create: ${made.status}`);
    }
    return { remote: `${this.env.GIT_ORIGIN}/${name}`, token: { plaintext: "created-token" } };
  }
  // `get` returns a handle unconditionally for the same reason (NOT_FOUND cannot cross either):
  // a read against a missing repository answers null through the sidecar's 404, which the app
  // maps to 404 all the same.
  async get(name) {
    return new Repo(name, this.env);
  }
  // The stand-in's `import` (IR2): the read sidecar clones the named local repository bare into
  // the target name — `source.url`'s last segment is the source's directory name, `depth` is
  // honoured by the `file://` transport. An IR2 fault armed on `/import-fault` throws first, as
  // `CODE: <name>` — an error's `code` does not cross the service binding, so the text carries
  // it and the route maps either shape.
  async import({ source, target }) {
    const fault = await fetch(`${this.env.READ_ORIGIN}/import-fault/x`);
    if (fault.status === 200) {
      const { code } = await fault.json();
      throw new Error(`${code}: ${source.url}`);
    }
    const name = new URL(source.url).pathname
      .replace(/\/$/, "")
      .split("/")
      .pop()
      .replace(/\.git$/, "");
    const params = new URLSearchParams({ from: name });
    if (source.branch !== undefined) params.set("branch", source.branch);
    const response = await fetch(`${this.env.READ_ORIGIN}/import/${target.name}?${params}`);
    if (response.status === 409) throw new Error(`ALREADY_EXISTS: ${target.name}`);
    if (response.status === 404) throw new Error(`NOT_FOUND: ${source.url}`);
    if (!response.ok) throw new Error(`UPSTREAM_UNAVAILABLE: ${response.status}`);
    // The real binding reports the branch it imported as `defaultBranch`; the sidecar names the
    // clone's checked-out branch — the request's `branch`, or the source's default when none rode.
    const { branch } = await response.json();
    return { remote: `${this.env.GIT_ORIGIN}/${target.name}`, defaultBranch: branch };
  }
}
