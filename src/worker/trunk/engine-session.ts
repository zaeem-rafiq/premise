// One object-local engine working set. SQLite remains authoritative (RB1-RB5, SY2).
// All shell writers share this Sql adapter; unknown writes and rollback discard the working
// set. A SQLite witness also detects writes which bypass the adapter, including test hooks.
import type { Sql } from "../../protocol/ports.ts";
import { Trunk, releaseWorkingState, type PoolOptions } from "../../core/trunk/registry.ts";

// These entries keep every changed engine row in their Pool. Import/rebuild and less frequent
// owner/jobs use the original full-open path, before and after their direct table writes.
const RETAINED = new Set(["open_attempt", "tool", "sync", "stop", "tick", "push_ok", "push_result", "right_of_way"]);
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

  invalidate(): void {
    this.#trunk = null;
    this.#witness = null;
    this.#changedMeta.clear();
    this.#configuration = null;
  }

  exec(query: string, ...bindings: Parameters<Sql["exec"]> extends [string, ...infer B] ? B : never) {
    if (this.#active || this.#trunk === null || /^\s*SELECT\b/i.test(query))
      return this.#store.exec(query, ...bindings);
    if (!this.#current(this.#version())) this.invalidate();
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
        } else if (!uncached) {
          this.invalidate();
        }
        if (this.#trunk !== null) this.#witness = this.#version();
      }
      return result;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  transaction<T>(run: () => T): T {
    try {
      return this.#store.transaction(run);
    } catch (error) {
      // Memory can already have changed even when SQLite rolled every row back.
      this.invalidate();
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
    if (
      !retain ||
      opts.now === undefined ||
      configuration !== this.#configuration ||
      opts.syncTriage !== this.#triage ||
      opts.ids !== this.#ids ||
      !this.#current(this.#version())
    )
      this.invalidate();
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
        this.invalidate();
      }
      return result;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.#active = false;
    }
  }
}
