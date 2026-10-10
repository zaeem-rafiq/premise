// One object-local engine working set. SQLite remains authoritative (RB1-RB5, SY2).
// All shell writers share this Sql adapter; unknown writes and rollback discard the working
// set. A SQLite witness also detects writes which bypass the adapter, including test hooks.
import type { Sql } from "../../protocol/ports.ts";
import { Trunk, releaseWorkingState, type PoolOptions } from "../../core/trunk/registry.ts";

// These entries keep every changed engine row in their Pool. Import/rebuild and less frequent
// owner/jobs use the original full-open path, before and after their direct table writes.
const RETAINED = new Set([
  "open_attempt",
  "tool",
  "sync",
  "stop",
  "tick",
  "push_ok",
  "push_result",
  "right_of_way",
  // These entries mutate Pool metadata and persist through wrapCall, just like tools.
  "plain",
  "plain_done",
  "green",
  "green_done",
  "resume_failed",
]);
type Witness = { writes: number; data: number; schema: string; occupied: string };
// These tables hydrate Pool or its lazy historical snapshots. One existence lookup per table
// also detects DROP + identical CREATE, which does not advance total_changes. No row counts.
const CACHED_TABLES = [
  "meta",
  "files",
  "trees",
  "intents",
  "attempts",
  "premises",
  "ops",
  "ops_first",
  "heads_ups",
  "judgments",
  "landings",
  "landing_files",
  "landing_writes",
  "landing_premises",
  "landing_ops",
  "blobs",
  "outbox",
  "outbox_chunks",
  "cards",
  "undo_requests",
] as const;
const OCCUPIED = "SELECT " + CACHED_TABLES.map((table) => `EXISTS(SELECT 1 FROM ${table}) AS ${table}`).join(", ");

export type SessionMetrics = {
  calls: Record<string, { reused: number; reopened: number }>;
  invalidations: Record<string, number>;
};

/** Only exact, single-key shell metadata statements may update a retained map in place. */
function metaKey(query: string, bindings: unknown[]): string | null {
  const insert = /^INSERT OR REPLACE INTO meta \(k, v\) VALUES \((\?|('[^']*')), \?\)$/i.exec(query.trim());
  if (insert !== null) return insert[1] === "?" ? String(bindings[0]) : insert[1]!.slice(1, -1);
  if (/^DELETE FROM meta WHERE k = \?$/i.test(query.trim())) return String(bindings[0]);
  return null;
}

export class EngineSession implements Sql {
  readonly #store: Sql;
  #trunk: Trunk | null = null;
  #witness: Witness | null = null;
  #active = false;
  #configuration: string | null = null;
  #triage: PoolOptions["syncTriage"];
  #ids: PoolOptions["ids"];
  #changedMeta = new Set<string>();
  #calls: SessionMetrics["calls"] = {};
  #invalidations: SessionMetrics["invalidations"] = {};

  /** Object-lifetime counters only. Statements omit bindings, comments and literal values. */
  metrics(): SessionMetrics {
    return {
      calls: Object.fromEntries(Object.entries(this.#calls).map(([name, counts]) => [name, { ...counts }])),
      invalidations: { ...this.#invalidations },
    };
  }

  constructor(store: Sql) {
    this.#store = store;
  }

  #version(): Witness {
    const schema = this.#store
      .exec("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name")
      .toArray();
    const tables = new Set(schema.filter((row) => row.type === "table").map((row) => row.name));
    return {
      writes: Number(this.#store.exec("SELECT total_changes() AS n").toArray()[0]!.n),
      data: Number(this.#store.exec("PRAGMA data_version").toArray()[0]!.data_version),
      // workerd forbids PRAGMA schema_version. Schema text is bounded by the fixed table
      // layout, not by pool history; data_version also detects another connection's commits.
      schema: JSON.stringify(schema),
      occupied: CACHED_TABLES.every((table) => tables.has(table))
        ? JSON.stringify(this.#store.exec(OCCUPIED).toArray())
        : "missing_table",
    };
  }

  #current(version: Witness): boolean {
    return (
      this.#witness?.writes === version.writes &&
      this.#witness.data === version.data &&
      this.#witness.schema === version.schema &&
      this.#witness.occupied === version.occupied
    );
  }

  #difference(version: Witness): string {
    return (["writes", "data", "schema", "occupied"] as const)
      .filter((key) => this.#witness?.[key] !== version[key])
      .join(",");
  }

  invalidate(reason = "explicit"): void {
    if (this.#trunk !== null) this.#invalidations[reason] = (this.#invalidations[reason] ?? 0) + 1;
    this.#trunk = null;
    this.#witness = null;
    this.#changedMeta.clear();
    this.#configuration = null;
  }

  /** workerd writes _cf_METADATA synchronously when these native alarm APIs are invoked.
   * Capture only that non-yielding operation, never writes arriving while its promise waits.
   * All application SQL still goes through exec; bypass writes before/after remain visible. */
  async alarmWrite(write: () => Promise<void>): Promise<void> {
    if (this.#trunk !== null) {
      const version = this.#version();
      if (!this.#current(version)) this.invalidate(`sqlite witness before alarm write: ${this.#difference(version)}`);
    }
    try {
      const pending = write();
      if (this.#trunk !== null) this.#witness = this.#version();
      await pending;
    } catch (error) {
      this.invalidate("alarm write failed");
      throw error;
    }
  }

  /** Exact statements owned by push.ts. Refresh from SQLite so predicates and no-op writes
   * retain their SQL meaning. Persistence later must not undo a receipt or retry count. */
  #mirrorShellWrite(query: string, bindings: unknown[]): boolean {
    const pool = this.#trunk!.pool;
    const statement = query.trim();
    let batch: unknown;
    if (statement === "UPDATE outbox SET tries = ?, next_try = ?, last_error = ? WHERE batch_id = ?")
      batch = bindings[3];
    else if (statement === "UPDATE outbox SET rejects = rejects + 1 WHERE batch_id = ?") batch = bindings[0];
    if (batch !== undefined) {
      if (pool.outbox?.batch_id === Number(batch)) {
        const row = this.#store
          .exec("SELECT tries, next_try, last_error, rejects FROM outbox WHERE batch_id = ?", Number(batch))
          .toArray()[0];
        if (row !== undefined) {
          pool.outbox.tries = Number(row.tries);
          pool.outbox.next_try = row.next_try === null ? null : Number(row.next_try);
          pool.outbox.last_error = row.last_error === null ? null : String(row.last_error);
          pool.outbox.rejects = Number(row.rejects);
        }
      }
      return true;
    }
    if (statement === "UPDATE heads_ups SET received_at = ? WHERE attempt_id = ? AND hn = ? AND received_at IS NULL") {
      const head = pool.attempts.get(String(bindings[1]))?.heads.find((h) => h.hn === Number(bindings[2]));
      if (head !== undefined) {
        const row = this.#store
          .exec(
            "SELECT received_at FROM heads_ups WHERE attempt_id = ? AND hn = ?",
            String(bindings[1]),
            Number(bindings[2]),
          )
          .toArray()[0];
        if (row !== undefined) head.received_at = row.received_at === null ? null : Number(row.received_at);
      }
      return true;
    }
    return false;
  }

  exec(query: string, ...bindings: Parameters<Sql["exec"]> extends [string, ...infer B] ? B : never) {
    if (this.#active || this.#trunk === null || /^\s*SELECT\b/i.test(query))
      return this.#store.exec(query, ...bindings);
    const version = this.#version();
    if (!this.#current(version)) this.invalidate(`sqlite witness before shell write: ${this.#difference(version)}`);
    try {
      const result = this.#store.exec(query, ...bindings);
      if (this.#trunk !== null) {
        const key = metaKey(query, bindings);
        // No Pool collection mirrors events_out or timers. Counter changes are handled below.
        const uncached =
          !query.includes(";") &&
          /^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM) (?:events_out|timers)\b/i.test(query);
        // These keys also hydrate fields outside Pool.meta, so their external writers reopen.
        if (
          key !== null &&
          !/^(?:steps:|checks:|approved:|app$|features_held$|head_|schema_version$|hash_version$)/.test(key)
        ) {
          this.#changedMeta.add(key);
        } else if (!uncached && !this.#mirrorShellWrite(query, bindings)) {
          // SQL literals can contain owner content. Keep only the statement's shape.
          this.invalidate(
            `shell: ${query
              .replace(/'([^']|'')*'|"([^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, "?")
              .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, "?")
              .replace(/\s+/g, " ")
              .trim()}`,
          );
        }
        if (this.#trunk !== null) this.#witness = this.#version();
      }
      return result;
    } catch (error) {
      this.invalidate("shell statement failed");
      throw error;
    }
  }

  transaction<T>(run: () => T): T {
    try {
      return this.#store.transaction(run);
    } catch (error) {
      // Memory can already have changed even when SQLite rolled every row back.
      this.invalidate("transaction rolled back");
      throw error;
    }
  }

  /** The callback is synchronous; the shell starts remote effects only after this returns. */
  run<T>(name: string, opts: PoolOptions, call: (trunk: Trunk) => T): T {
    if (this.#active) throw new Error("nested engine session");
    let retain = RETAINED.has(name);
    const configuration = JSON.stringify({
      pool: opts.pool_id,
      constants: opts.constants,
      switches: opts.switches,
      features: opts.features,
      killed: opts.killed,
    });
    const version = this.#version();
    const reason = !retain
      ? `entry not retained: ${name}`
      : opts.now === undefined
        ? "clock omitted"
        : configuration !== this.#configuration || opts.syncTriage !== this.#triage || opts.ids !== this.#ids
          ? "configuration changed"
          : !this.#current(version)
            ? `sqlite witness before engine call: ${this.#difference(version)}`
            : null;
    if (reason !== null) this.invalidate(reason);
    const counts = (this.#calls[name] ??= { reused: 0, reopened: 0 });
    counts[this.#trunk === null ? "reopened" : "reused"] += 1;
    this.#active = true;
    try {
      // An unexpected trigger can write engine tables from an otherwise harmless timer
      // statement. Use the full-open path until the store has the trigger-free schema again.
      if (
        this.#trunk === null &&
        this.#store.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' LIMIT 1").toArray().length > 0
      )
        retain = false;
      const trunk = this.#trunk ?? Trunk.open(this, opts);
      // The supplied options are per-call inputs, particularly the alarm's driven clock.
      if (opts.now !== undefined) trunk.pool.now = opts.now;
      if (opts.ids !== undefined) trunk.pool.ids = opts.ids;
      if (opts.constants !== undefined) Object.assign(trunk.pool.K, opts.constants);
      trunk.pool.killed = opts.killed === true;
      trunk.pool.clefOn = (opts.switches?.CLEF_TRIAGE ?? "on") === "on";
      trunk.pool.syncTriage = opts.syncTriage ?? null;
      trunk.pool.featuresHeld = opts.features?.held ?? trunk.pool.meta.get("features_held") === "1";
      trunk.pool.featuresGreen = opts.features?.green ?? "none";
      for (const key of this.#changedMeta) {
        const value = this.#store.exec("SELECT v FROM meta WHERE k = ?", key).toArray()[0]?.v;
        if (value === undefined) {
          trunk.pool.meta.delete(key);
          trunk.pool.savedMeta.delete(key);
        } else {
          trunk.pool.meta.set(key, String(value));
          trunk.pool.savedMeta.set(key, String(value));
        }
      }
      trunk.pool.eventCounter = Number(trunk.pool.meta.get("next_event_n") ?? "1");
      this.#changedMeta.clear();
      const result = call(trunk);
      if (result !== null && typeof result === "object" && "then" in result)
        throw new Error("engine entry must be synchronous");
      // Reopening reconstructs pending triage without its call-local frozen maps. Keep
      // that established restart behavior until those rows have been resolved.
      if (retain && trunk.pool.pendingTriage.length === 0) {
        releaseWorkingState(trunk.pool);
        this.#trunk = trunk;
        this.#configuration = configuration;
        this.#triage = opts.syncTriage;
        this.#ids = opts.ids;
        this.#witness = this.#version();
      } else {
        this.invalidate(trunk.pool.pendingTriage.length > 0 ? "pending triage" : `entry not retained: ${name}`);
      }
      return result;
    } catch (error) {
      this.invalidate("engine call failed");
      throw error;
    } finally {
      this.#active = false;
    }
  }
}
