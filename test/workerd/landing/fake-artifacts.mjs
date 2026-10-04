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
    return { remote: `${this.env.GIT_ORIGIN}/${this.name}` };
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
    return { remote: `${this.env.GIT_ORIGIN}/${name}`, token: { plaintext: "created-token" } };
  }
  // `get` returns a handle unconditionally for the same reason (NOT_FOUND cannot cross either):
  // a read against a missing repository answers null through the sidecar's 404, which the app
  // maps to 404 all the same.
  async get(name) {
    return new Repo(name, this.env);
  }
}
