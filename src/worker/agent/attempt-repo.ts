// AG5: a separate, durable background drain. Model/tool/landing callers only set timer
// rows; no provisioning call or checkpoint push is awaited by the agent's turn loop.
import type { Sql } from "../../protocol/ports.ts";
import { FORK_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import { metaGet, metaSet, timerDelete, timerList, timerPut, transcriptRows } from "../../core/agent/store.ts";
import { blobBytes, concatBytes, text, utf8 } from "../../core/sync/bytes.ts";
import type { Env } from "../env.ts";
import {
  artifactsAttemptCheckpointWriter,
  attemptRepoName,
  redactCheckpointValue,
  type AttemptCheckpoint,
} from "../adapters/attempt-repo/index.ts";
import { appendEvent } from "./events.ts";
import { gateDurableObjectTransport } from "./gate-client.ts";
import type { TrunkTransport } from "./trunk-client.ts";

const PREFIX = "repo_";
// SQ2: byte chunks leave room for the other columns below the 1 MiB row limit.
const CHECKPOINT_PART_BYTES = 512 * 1024;
export const isAttemptRepoTimer = (kind: string): boolean => kind.startsWith(PREFIX);

export class AttemptRepositoryArchive {
  readonly #sql: Sql;
  readonly #env: Env;
  readonly #ctx: DurableObjectState;
  readonly #trunk: TrunkTransport;
  readonly #arm: () => Promise<void>;
  readonly #events: () => Promise<void>;
  readonly #busy = new Set<string>();

  constructor(options: {
    sql: Sql;
    env: Env;
    ctx: DurableObjectState;
    trunk: TrunkTransport;
    arm: () => Promise<void>;
    events: () => Promise<void>;
  }) {
    this.#sql = options.sql;
    this.#env = options.env;
    this.#ctx = options.ctx;
    this.#trunk = options.trunk;
    this.#arm = options.arm;
    this.#events = options.events;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS attempt_checkpoint_jobs (
      slot TEXT NOT NULL, n INTEGER NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (slot, part)
    ) WITHOUT ROWID`);
  }

  #get(key: string): string | null {
    return metaGet(this.#sql, key);
  }
  #set(key: string, value: string | number): void {
    metaSet(this.#sql, key, value);
  }
  #id(): string {
    return this.#get("attempt_id")!;
  }
  #timer(kind: string, at = Date.now()): void {
    timerPut(this.#sql, PREFIX + kind, "main", at);
  }
  #deleteTimer(kind: string): void {
    timerDelete(this.#sql, PREFIX + kind, "main");
  }

  start(): void {
    if (this.#get("repo_started") !== null) return;
    this.#sql.transaction(() => {
      this.#set("repo_started", "1");
      this.#timer("enqueue");
    });
  }

  requestCheckpoint(terminal = false, inTransaction = false): void {
    if (this.#get("repo_started") === null || this.#get("repo_failed") === "1") return;
    const terminalKey = `${this.#get("revision")}:${this.#get("state")}:${this.#get("step")}`;
    if (terminal && this.#get("repo_terminal") === terminalKey) return;
    const write = () => {
      if (terminal) this.#set("repo_terminal", terminalKey);
      this.#set("checkpoint_requested", Number(this.#get("checkpoint_requested") ?? 0) + 1);
      this.#timer("capture");
    };
    if (inTransaction) write();
    else this.#sql.transaction(write);
  }

  /** Trunk rebuild registration can recreate its row without the earlier repo receipt. */
  registered(): void {
    if (this.#get("attempt_repo") !== null) this.#requestNotification();
  }

  #requestNotification(): void {
    this.#set("repo_notify_requested", Number(this.#get("repo_notify_requested") ?? 0) + 1);
    this.#sql.exec("DELETE FROM meta WHERE k = 'repo_notified'");
    this.#timer("notify");
  }

  receive(body: unknown): Response {
    const r = body as { attempt_id?: unknown; repo?: unknown; error?: unknown; ms?: unknown } | null;
    if (
      r === null ||
      typeof r !== "object" ||
      r.attempt_id !== this.#id() ||
      this.#get("repo_started") === null ||
      (r.repo !== null && r.repo !== attemptRepoName(this.#id())) ||
      typeof r.ms !== "number" ||
      !Number.isFinite(r.ms) ||
      r.ms < 0 ||
      (r.repo === null ? r.error !== "provision_failed" : r.error !== null)
    ) {
      return Response.json({ ok: false, error: "invalid_args" }, { status: 400 });
    }
    this.#sql.transaction(() => {
      if (this.#get("repo_result") !== null) return;
      this.#set("repo_result", "1");
      if (r.repo === null) {
        this.#set("repo_failed", "1");
        for (const timer of timerList(this.#sql)) {
          if (isAttemptRepoTimer(timer.kind)) timerDelete(this.#sql, timer.kind, timer.key);
        }
      } else {
        this.#set("attempt_repo", r.repo as string);
        this.#requestNotification();
        if (this.#sql.exec("SELECT 1 FROM attempt_checkpoint_jobs").toArray().length > 0) this.#timer("push");
      }
      appendEvent(this.#sql, {
        ts: Date.now(),
        pool: this.#get("pool_id")!,
        src: "agent",
        type: "attempt.repo",
        attempt_id: this.#id(),
        ok: r.repo !== null,
        ms: r.ms as number,
        error: r.repo === null ? "provision_failed" : null,
      });
    });
    this.#ctx.waitUntil(this.#events().finally(() => this.#arm()));
    this.kick(Date.now());
    return Response.json({ ok: true });
  }

  kick(now: number): void {
    for (const t of timerList(this.#sql)) {
      if (!isAttemptRepoTimer(t.kind) || t.due_at > now) continue;
      if (this.#busy.has(t.kind)) {
        timerPut(this.#sql, t.kind, t.key, Date.now() + FORK_BACKOFF_BASE_MS);
        continue;
      }
      const kind = t.kind.slice(PREFIX.length);
      this.#busy.add(t.kind);
      // Preserve a recovery wakeup before I/O. A running operation is never started twice.
      this.#timer(kind, Date.now() + FORK_BACKOFF_BASE_MS);
      this.#ctx.waitUntil(
        this.#work(kind)
          .catch(() => {
            this.#set("checkpoint_error", "archive_transport");
            this.#timer(kind, Date.now() + FORK_BACKOFF_BASE_MS);
          })
          .finally(async () => {
            this.#busy.delete(t.kind);
            this.kick(Date.now());
            await this.#arm();
          }),
      );
    }
  }

  async #work(kind: string): Promise<void> {
    if (this.#get("repo_failed") === "1") {
      this.#deleteTimer(kind);
      return;
    }
    if (kind === "enqueue") {
      const response = await gateDurableObjectTransport(this.#env.GATE).post("/internal/attempt-repo", {
        pool: this.#get("pool_id"),
        attempt_id: this.#id(),
      });
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error("archive_enqueue");
      this.#set("repo_queued", "1");
      this.#deleteTimer(kind);
    } else if (kind === "notify") {
      const requested = this.#get("repo_notify_requested");
      const response = await this.#trunk.post("/internal/attempt-repo", {
        attempt_id: this.#id(),
        repo: this.#get("attempt_repo"),
      });
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error("archive_notify");
      this.#sql.transaction(() => {
        if (this.#get("repo_notify_requested") === requested) {
          this.#set("repo_notified", "1");
          this.#deleteTimer(kind);
        } else {
          // A rebuild/registration while this reply waited requires another receipt.
          this.#timer(kind);
        }
      });
    } else if (kind === "capture") await this.#capture();
    else if (kind === "push") await this.#push();
    else this.#deleteTimer(kind);
  }

  async #capture(): Promise<void> {
    const n = Number(this.#get("checkpoint_requested") ?? 0);
    const response = await this.#trunk.post("/internal/attempt-checkpoint", { attempt_id: this.#id() });
    if (!response.ok) throw new Error("archive_snapshot");
    const snapshot = (await response.json()) as Pick<AttemptCheckpoint, "ops" | "premises" | "files">;
    if (
      !Array.isArray(snapshot.ops) ||
      !Array.isArray(snapshot.premises) ||
      snapshot.files === null ||
      typeof snapshot.files !== "object" ||
      Array.isArray(snapshot.files) ||
      Object.values(snapshot.files).some((value) => typeof value !== "string")
    )
      throw new Error("archive_snapshot");
    const secrets = this.#env.OWNER_KEY === undefined ? [] : [this.#env.OWNER_KEY];
    const checkpoint: AttemptCheckpoint = redactCheckpointValue(
      {
        ...snapshot,
        repo: attemptRepoName(this.#id()),
        attempt_id: this.#id(),
        n,
        step: Number(this.#get("step") ?? 0),
        at: Date.now(),
        transcript: transcriptRows(this.#sql),
      },
      secrets,
    );
    const bytes = utf8(JSON.stringify(checkpoint));
    this.#sql.transaction(() => {
      this.#sql.exec("DELETE FROM attempt_checkpoint_jobs WHERE slot = 'pending'");
      for (let part = 0, offset = 0; offset < bytes.byteLength; part += 1, offset += CHECKPOINT_PART_BYTES) {
        this.#sql.exec(
          "INSERT INTO attempt_checkpoint_jobs (slot, n, part, bytes) VALUES ('pending', ?, ?, ?)",
          n,
          part,
          bytes.slice(offset, offset + CHECKPOINT_PART_BYTES),
        );
      }
      this.#set("checkpoint_captured", n);
      if (Number(this.#get("checkpoint_requested")) === n) this.#deleteTimer("capture");
      else this.#timer("capture");
      if (this.#get("attempt_repo") !== null) this.#timer("push");
    });
  }

  async #push(): Promise<void> {
    if (this.#get("attempt_repo") === null) {
      this.#deleteTimer("push");
      return;
    }
    const row = this.#sql.transaction(() => {
      let job = this.#sql.exec("SELECT n FROM attempt_checkpoint_jobs WHERE slot = 'pushing' LIMIT 1").toArray()[0];
      if (job === undefined) {
        this.#sql.exec("UPDATE attempt_checkpoint_jobs SET slot = 'pushing' WHERE slot = 'pending'");
        job = this.#sql.exec("SELECT n FROM attempt_checkpoint_jobs WHERE slot = 'pushing' LIMIT 1").toArray()[0];
      }
      return job;
    });
    if (row === undefined) {
      this.#deleteTimer("push");
      return;
    }
    const writer = artifactsAttemptCheckpointWriter(this.#env.ATTEMPTS, {
      secrets: this.#env.OWNER_KEY === undefined ? [] : [this.#env.OWNER_KEY],
    });
    const parts = this.#sql
      .exec("SELECT n, part, bytes FROM attempt_checkpoint_jobs WHERE slot = 'pushing' ORDER BY part")
      .toArray()
      .map((part, index) => {
        const bytes = blobBytes(part.bytes);
        if (part.part !== index || part.n !== row.n || bytes.byteLength === 0)
          throw new Error("archive_snapshot_parts");
        return bytes;
      });
    const checkpoint = JSON.parse(text(concatBytes(parts))) as AttemptCheckpoint;
    const result = await writer.push(checkpoint);
    this.#sql.transaction(() => {
      if (result.ok) {
        this.#sql.exec("DELETE FROM attempt_checkpoint_jobs WHERE slot = 'pushing'");
        this.#set("checkpoint_pushed", Number(row.n));
        this.#set("checkpoint_commit", result.commit_oid);
        this.#set("checkpoint_tries", 0);
        this.#sql.exec("DELETE FROM meta WHERE k = 'checkpoint_error'");
        if (this.#sql.exec("SELECT 1 FROM attempt_checkpoint_jobs WHERE slot = 'pending'").toArray().length > 0)
          this.#timer("push");
        else this.#deleteTimer("push");
      } else {
        const tries = Number(this.#get("checkpoint_tries") ?? 0) + 1;
        this.#set("checkpoint_tries", tries);
        this.#set("checkpoint_error", result.error);
        this.#timer(
          "push",
          Date.now() + Math.min(PUSH_BACKOFF_MAX_MS, FORK_BACKOFF_BASE_MS * 2 ** Math.min(tries - 1, 10)),
        );
      }
    });
  }
}
