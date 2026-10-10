// Local ATTEMPTS and POOLS namespaces. All repository data is stored by real git
// in the harness. Returned create/fork tokens are deliberately unusable; only
// tokens minted by createToken can pass the harness's smart-HTTP auth check.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

async function call(env, namespace, repo, method, args = {}) {
  const response = await fetch(`${env.ARTIFACTS_UPSTREAM}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ namespace, repo, method, args }),
  });
  if (!response.ok)
    throw new Error(`${response.status === 404 ? "NOT_FOUND" : "UPSTREAM_UNAVAILABLE"}: fake Artifacts`);
  return response;
}

class Repo extends RpcTarget {
  constructor(env, namespace, name) {
    super();
    this.env = env;
    this.namespace = namespace;
    this.name = name;
  }
  async info() {
    return (await call(this.env, this.namespace, this.name, "info")).json();
  }
  async createToken(scope, ttl) {
    return (await call(this.env, this.namespace, this.name, "createToken", { scope, ttl })).json();
  }
  async fork(name, options) {
    return (await call(this.env, this.namespace, name, "fork", { source: this.name, options })).json();
  }
  async readFile({ ref, path }) {
    try {
      return await (await call(this.env, this.namespace, this.name, "readFile", { ref, path })).blob();
    } catch {
      return null;
    }
  }
  async readBlob(hash) {
    try {
      return await (await call(this.env, this.namespace, this.name, "readBlob", { hash })).blob();
    } catch {
      return null;
    }
  }
  async readCommit(hash) {
    try {
      return await (await call(this.env, this.namespace, this.name, "readCommit", { hash })).json();
    } catch {
      return null;
    }
  }
  async readTree(hash) {
    try {
      return await (await call(this.env, this.namespace, this.name, "readTree", { hash })).json();
    } catch {
      return null;
    }
  }
  async log() {
    return [];
  }
}

export default class FakeAttemptArtifacts extends WorkerEntrypoint {
  async create(name, options) {
    return (await call(this.env, this.env.NAMESPACE, name, "create", { options })).json();
  }
  async get(name) {
    return new Repo(this.env, this.env.NAMESPACE, name);
  }
}

// Test-only outbound service: HTTPS is the repository contract presented to
// the production adapter. Local smart HTTP still runs against stock git.
export class GitProxy extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== "attempt-artifacts.test") return new Response("no upstream", { status: 403 });
    return fetch(`${this.env.ARTIFACTS_UPSTREAM}/git${url.pathname}${url.search}`, request);
  }
}
