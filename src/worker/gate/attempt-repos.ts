// S3a: the existing singleton gate owns every provisioning call in this deployment.
// A slot lasts until the actual binding call settles. No lease or timeout can release a
// slot while an older call is still running. Durable rows survive eviction; an interrupted
// call consumes a try and is recovered by the next alarm using the deterministic repo name.
import type { Sql } from "../../protocol/ports.ts";
import { FORK_BACKOFF_BASE_MS, FORK_RETRIES, MAX_FORKS_IN_FLIGHT } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { artifactsAttemptRepoProvisioner } from "../adapters/index.ts";

type Job = {
  attempt_id: string;
  pool: string;
  status: "pending" | "result" | "delivered";
  tries: number;
  started_at: number;
  last_completed_at: number | null;
  due_at: number;
  repo: string | null;
  error: string | null;
  ms: number | null;
};

export class AttemptRepoQueue {
  readonly #sql: Sql;
  readonly #env: Env;
  readonly #ctx: DurableObjectState;
  readonly #arm: () => Promise<void>;
  readonly #active = new Set<string>();
  readonly #delivering = new Set<string>();

  constructor(sql: Sql, env: Env, ctx: DurableObjectState, arm: () => Promise<void>) {
    this.#sql = sql;
    this.#env = env;
    this.#ctx = ctx;
    this.#arm = arm;
    sql.exec(`CREATE TABLE IF NOT EXISTS attempt_repositories (
      attempt_id TEXT PRIMARY KEY, pool TEXT NOT NULL, status TEXT NOT NULL,
      tries INTEGER NOT NULL, started_at INTEGER NOT NULL, last_completed_at INTEGER,
      due_at INTEGER NOT NULL, repo TEXT, error TEXT, ms INTEGER
    )`);
  }

  rows(): Job[] {
    return this.#sql.exec("SELECT * FROM attempt_repositories ORDER BY started_at, attempt_id").toArray() as Job[];
  }

  enqueue(body: unknown, now: number): Response {
    const r = body as { pool?: unknown; attempt_id?: unknown } | null;
    if (
      r === null ||
      typeof r !== "object" ||
      typeof r.pool !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(r.pool) ||
      typeof r.attempt_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(r.attempt_id)
    )
      return Response.json({ ok: false, error: "invalid_args" }, { status: 400 });
    const old = this.#sql.exec("SELECT pool FROM attempt_repositories WHERE attempt_id = ?", r.attempt_id).toArray()[0];
    if (old !== undefined && old.pool !== r.pool) {
      return Response.json({ ok: false, error: "attempt_conflict" }, { status: 409 });
    }
    this.#sql.exec(
      "INSERT OR IGNORE INTO attempt_repositories (attempt_id, pool, status, tries, started_at, due_at) VALUES (?, ?, 'pending', 0, ?, ?)",
      r.attempt_id,
      r.pool,
      now,
      now,
    );
    this.kick(now);
    return Response.json({ ok: true });
  }

  next(now: number): number | null {
    const jobs = this.rows().filter((r) => r.status !== "delivered");
    if (jobs.length === 0) return null;
    // Keep a recovery alarm even while requests are in flight; a reset loses the in-memory
    // sets, but never the queued job. Busy requests keep their slots when that alarm fires.
    return Math.min(
      ...jobs.map((r) =>
        this.#active.has(r.attempt_id) ||
        this.#delivering.has(r.attempt_id) ||
        (r.status === "pending" && this.#active.size >= MAX_FORKS_IN_FLIGHT)
          ? now + FORK_BACKOFF_BASE_MS
          : r.due_at,
      ),
    );
  }

  kick(now: number): void {
    for (const row of this.rows()) {
      if (row.status === "result" && row.due_at <= now && !this.#delivering.has(row.attempt_id)) {
        this.#delivering.add(row.attempt_id);
        this.#ctx.waitUntil(
          this.#deliver(row).finally(async () => {
            this.#delivering.delete(row.attempt_id);
            await this.#arm();
          }),
        );
      }
      if (row.status !== "pending" || row.due_at > now || this.#active.has(row.attempt_id)) continue;
      if (this.#active.size >= MAX_FORKS_IN_FLIGHT) continue;
      if (row.tries > FORK_RETRIES) {
        this.#finish(row, null, "provision_failed", Date.now());
        continue;
      }
      this.#active.add(row.attempt_id);
      row.tries += 1;
      this.#sql.exec(
        "UPDATE attempt_repositories SET tries = ?, due_at = ? WHERE attempt_id = ?",
        row.tries,
        now + FORK_BACKOFF_BASE_MS * 2 ** (row.tries - 1),
        row.attempt_id,
      );
      this.#ctx.waitUntil(
        this.#provision(row).finally(async () => {
          this.#active.delete(row.attempt_id);
          this.kick(Date.now());
          await this.#arm();
        }),
      );
    }
  }

  #finish(row: Job, repo: string | null, error: string | null, now: number): void {
    this.#sql.exec(
      "UPDATE attempt_repositories SET status = 'result', repo = ?, error = ?, ms = ?, last_completed_at = ?, due_at = ? WHERE attempt_id = ?",
      repo,
      error,
      Math.max(0, now - row.started_at),
      now,
      now,
      row.attempt_id,
    );
  }

  async #provision(row: Job): Promise<void> {
    try {
      const result = await artifactsAttemptRepoProvisioner(this.#env.ATTEMPTS).provision(row.attempt_id);
      if ("repo" in result) {
        this.#finish(row, result.repo, null, Date.now());
        return;
      }
    } catch {
      // Only a fixed code is persisted; binding exceptions can contain credentials (SE5b).
    }
    const now = Date.now();
    if (row.tries > FORK_RETRIES) this.#finish(row, null, "provision_failed", now);
    else
      this.#sql.exec(
        "UPDATE attempt_repositories SET last_completed_at = ?, due_at = ?, error = 'provision_failed' WHERE attempt_id = ?",
        now,
        now + FORK_BACKOFF_BASE_MS * 2 ** (row.tries - 1),
        row.attempt_id,
      );
  }

  async #deliver(row: Job): Promise<void> {
    try {
      const agent = this.#env.AGENT.get(this.#env.AGENT.idFromName(row.attempt_id));
      const response = await agent.fetch("https://agent/internal/attempt-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt_id: row.attempt_id, repo: row.repo, error: row.error, ms: row.ms }),
      });
      const body = (await response.json()) as { ok?: boolean };
      if (response.ok && body.ok === true) {
        this.#sql.exec("UPDATE attempt_repositories SET status = 'delivered' WHERE attempt_id = ?", row.attempt_id);
        return;
      }
    } catch {
      // Delivery retries do not provision another repository and do not consume a fork try.
    }
    this.#sql.exec(
      "UPDATE attempt_repositories SET due_at = ? WHERE attempt_id = ?",
      Date.now() + FORK_BACKOFF_BASE_MS,
      row.attempt_id,
    );
  }
}
