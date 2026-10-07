// Test-only instrumentation of the built local-workerd bundle. Nothing here is imported by
// production. Timings include the observer's counters and SQLite reads; no cost is subtracted.
export type TrunkLoadCall = {
  n: number;
  entry: string;
  method?: string;
  tool?: string;
  attempt?: string;
  call_ms: number;
  engine_ms: number;
  transaction_ms: number;
  transaction_max_ms: number;
  transactions: number;
  rows_changed: number;
  judgments_written: number;
  events_written: number;
  sql_write_statements: number;
  writes_by_table: Record<string, number>;
  tick_calls: number;
  batch_size: number;
  post_batch_classified: number;
  head_seq?: number;
  files?: number;
  attempts?: number;
  inflight?: number;
  validated?: number;
  failed: boolean;
  analyse_calls: number;
  analyse_ms: number;
  classify_calls: number;
  classify_ms: number;
};

export type TrunkLoadSnapshot = {
  rows: TrunkLoadCall[];
  total: number;
  states: Record<string, number>;
  pending_outbox: number;
  errors: number;
};

export function instrumentTrunkLoad(source: string): string {
  const one = (pattern: RegExp, label: string): string => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`trunk-load instrumentation expected one ${label}`);
    return matches[0]![1]!;
  };
  const session = one(/var (EngineSession) = class[ {]/g, "EngineSession");
  const facade = one(/var (Trunk\d*) = class _Trunk[ {]/g, "Trunk facade");
  const object = one(/var (Trunk\d*) = class extends DurableObject[ {]/g, "Trunk Durable Object");
  one(/function (tick)\(pool\)/g, "tick");
  one(/function (classify)\(pool, a, before, after,/g, "classify");
  one(/function (analyse)\(files,/g, "analyse");
  one(/function (sqlOf)\(ctx\)/g, "sqlOf");
  return (
    source +
    `
// This observer exists only in the local test's in-memory bundle.
(() => {
  const records = new WeakMap();
  const active = new WeakMap();
  const originalExec = ${session}.prototype.exec;
  const originalTransaction = ${session}.prototype.transaction;
  const originalRun = ${session}.prototype.run;
  const originalClassify = classify;
  const originalTick = tick;
  const originalAnalyse = analyse;
  let current = null;
  const changes = (sql) => Number(originalExec.call(sql, "SELECT total_changes() AS n").toArray()[0].n);
  const rowsFor = (sql) => {
    let rows = records.get(sql);
    if (!rows) { rows = []; records.set(sql, rows); }
    return rows;
  };
  function record(sql, entry, run) {
    if (active.has(sql)) return run();
    const row = {
      n: rowsFor(sql).length, entry, call_ms: 0, engine_ms: 0,
      transaction_ms: 0, transaction_max_ms: 0, transactions: 0,
      rows_changed: 0, judgments_written: 0, events_written: 0,
      sql_write_statements: 0, writes_by_table: {}, tick_calls: 0, batch_size: 0, post_batch_classified: 0, failed: false,
      analyse_calls: 0, analyse_ms: 0, classify_calls: 0, classify_ms: 0
    };
    const state = { row, depth: 0, classified: new Set(), ticks: [] };
    const before = changes(sql);
    active.set(sql, state);
    const previous = current;
    current = state;
    const start = performance.now();
    try { return run(); }
    catch (error) { row.failed = true; throw error; }
    finally {
      row.call_ms = performance.now() - start;
      if (!row.method && entry !== "shell_transaction") row.engine_ms = row.call_ms;
      row.rows_changed = changes(sql) - before;
      row.post_batch_classified = state.classified.size;
      active.delete(sql);
      current = previous;
      rowsFor(sql).push(row);
    }
  }
  ${session}.prototype.exec = function(query, ...bindings) {
    const state = active.get(this);
    if (!state) return originalExec.call(this, query, ...bindings);
    const write = /^\\s*(?:INSERT(?: OR \\w+)? INTO|UPDATE|DELETE FROM)\\s+(\\w+)/i.exec(query);
    if (write) state.row.sql_write_statements++;
    const watched = write !== null;
    const before = watched ? changes(this) : 0;
    try { return originalExec.call(this, query, ...bindings); }
    finally {
      if (watched) {
        const delta = changes(this) - before;
        state.row.writes_by_table[write[1]] = (state.row.writes_by_table[write[1]] || 0) + delta;
        if (write[1] === "judgments") state.row.judgments_written += delta;
        if (write[1] === "events_out") state.row.events_written += delta;
      }
    }
  };
  ${session}.prototype.transaction = function(run) {
    const state = active.get(this);
    // Shell-only transactions are measured too: alarm bookkeeping is synchronous storage.
    if (!state) return record(this, "shell_transaction", () => this.transaction(run));
    const outer = state.depth++ === 0;
    const start = performance.now();
    try { return originalTransaction.call(this, run); }
    finally {
      const ms = performance.now() - start;
      state.depth--;
      if (outer) {
        state.row.transaction_ms += ms;
        state.row.transaction_max_ms = Math.max(state.row.transaction_max_ms, ms);
        state.row.transactions++;
      }
    }
  };
  ${session}.prototype.run = function(name, options, run) {
    return record(this, name, () => originalRun.call(this, name, options, run));
  };
  analyse = function(...args) {
    if (!current) return originalAnalyse(...args);
    const state = current;
    const start = performance.now();
    state.row.analyse_calls++;
    try { return originalAnalyse(...args); }
    finally { state.row.analyse_ms += performance.now() - start; }
  };
  tick = function(pool) {
    const state = active.get(pool.sql);
    if (!state) return originalTick(pool);
    // A right_of_way alarm invokes the core tick inside expireRightOfWay's transaction.
    // Observe the core function rather than only the facade method named tick.
    const startLandings = pool.out.landings.length;
    state.ticks.push(startLandings);
    state.row.tick_calls++;
    try { return originalTick(pool); }
    finally {
      state.row.batch_size += Math.max(0, pool.out.landings.length - startLandings);
      state.ticks.pop();
    }
  };
  classify = function(...args) {
    const [pool, attempt, , after] = args;
    const state = active.get(pool.sql);
    // Step 5 runs after setHead. Candidate dry runs and hypothetical card/ROW checks do not
    // classify against the installed post-batch head and therefore do not enter this count.
    if (state && state.ticks.length > 0 && pool.out.landings.length > state.ticks.at(-1) && after === pool.files)
      state.classified.add(attempt.id);
    if (!state) return originalClassify(...args);
    const start = performance.now();
    state.row.classify_calls++;
    try { return originalClassify(...args); }
    finally { state.row.classify_ms += performance.now() - start; }
  };
  const inspectPool = (row, pool) => {
    row.head_seq = pool.headSeq();
    row.files = pool.files.size;
    row.attempts = pool.attempts.size;
    row.inflight = 0;
    row.validated = 0;
    for (const attempt of pool.attempts.values()) {
      if (attempt.state !== "landed" && attempt.state !== "stopped") row.inflight++;
      if (attempt.state === "validated") row.validated++;
    }
  };
  for (const name of Object.getOwnPropertyNames(${facade}.prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(${facade}.prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value;
    ${facade}.prototype[name] = function(...args) {
      const sql = this.pool.sql;
      const invoke = () => {
        const state = active.get(sql);
        const row = state.row;
        row.method = name;
        if (name === "tool") { row.tool = args[0].tool; row.attempt = args[0].attempt_id; }
        else if (typeof args[0] === "string" && name === "openAttempt") row.attempt = args[0];
        else if (args[0] && typeof args[0] === "object" && args[0].attempt_id) row.attempt = args[0].attempt_id;
        inspectPool(row, this.pool);
        const start = performance.now();
        try { return original.apply(this, args); }
        finally {
          row.engine_ms += performance.now() - start;
        }
      };
      return active.has(sql) ? invoke() : record(sql, name, invoke);
    };
  }
  for (const name of ["create", "createImported", "open"]) {
    const original = ${facade}[name];
    ${facade}[name] = function(sql, ...args) {
      return record(sql, name === "create" ? "pool_create" : name, () => original.call(this, sql, ...args));
    };
  }
  const originalFetch = ${object}.prototype.fetch;
  ${object}.prototype.fetch = async function(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/__test/trunk-load") return originalFetch.call(this, request);
    const sql = sqlOf(this.ctx);
    const all = rowsFor(sql);
    const after = Math.max(0, Number(url.searchParams.get("after") || 0));
    const exists = (table) => originalExec.call(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length > 0;
    const states = exists("attempts")
      ? Object.fromEntries(originalExec.call(sql, "SELECT state, count(*) AS n FROM attempts GROUP BY state").toArray().map(row => [row.state, Number(row.n)])) : {};
    const pending_outbox = exists("outbox") ? Number(originalExec.call(sql, "SELECT count(*) AS n FROM outbox WHERE state IN ('pending', 'notes_pending')").toArray()[0].n) : 0;
    return Response.json({ rows: all.slice(after), total: all.length, states, pending_outbox, errors: all.filter(row => row.failed).length });
  };
})();
`
  );
}

const round = (n: number) => Math.round(n * 1_000) / 1_000;
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0);
  return { p50: at(0.5), p99: at(0.99), max: at(1) };
}

export function summarizeTrunkLoad(rows: TrunkLoadCall[]) {
  const group = (row: TrunkLoadCall) => (row.tool === undefined ? row.entry : `${row.entry}:${row.tool}`);
  const entries = [...new Set(rows.map(group))].sort();
  return {
    calls: rows.length,
    failed: rows.filter((row) => row.failed).length,
    per_entry: entries.map((entry) => {
      const selected = rows.filter((row) => group(row) === entry);
      return {
        entry,
        calls: selected.length,
        call_ms: distribution(selected.map((row) => row.call_ms)),
        engine_ms: distribution(selected.map((row) => row.engine_ms)),
        transaction_ms: distribution(selected.map((row) => row.transaction_ms)),
        transaction_max_ms: distribution(selected.map((row) => row.transaction_max_ms)),
        rows_changed: distribution(selected.map((row) => row.rows_changed)),
        judgments_written: distribution(selected.map((row) => row.judgments_written)),
        events_written: distribution(selected.map((row) => row.events_written)),
        analyse_calls: distribution(selected.map((row) => row.analyse_calls)),
        analyse_ms: distribution(selected.map((row) => row.analyse_ms)),
        classify_calls: distribution(selected.map((row) => row.classify_calls)),
        classify_ms: distribution(selected.map((row) => row.classify_ms)),
        tick_calls: distribution(selected.map((row) => row.tick_calls)),
        batch_size: distribution(selected.map((row) => row.batch_size)),
        post_batch_classified: distribution(selected.map((row) => row.post_batch_classified)),
        writes_by_table: Object.fromEntries(
          [...new Set(selected.flatMap((row) => Object.keys(row.writes_by_table)))]
            .sort()
            .map((table) => [table, distribution(selected.map((row) => row.writes_by_table[table] ?? 0))]),
        ),
      };
    }),
    ten_largest: [...rows].sort((a, b) => b.call_ms - a.call_ms).slice(0, 10),
  };
}
