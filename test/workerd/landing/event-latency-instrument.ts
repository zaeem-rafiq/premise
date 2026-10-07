// Local-workerd observer only. Appended to an in-memory bundle by event-latency.test.ts.
// No production import, endpoint, timer or event payload changes.
export function instrumentEventLatency(source: string, pushDelayMs: number): string {
  const one = (pattern: RegExp, name: string): string => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`event latency observer expected one ${name}`);
    return matches[0]![1]!;
  };
  const session = one(/var (EngineSession) = class[ {]/g, "EngineSession");
  const object = one(/var (Trunk\d*) = class extends DurableObject[ {]/g, "Trunk object");
  one(/function (sqlOf)\(ctx\)/g, "sqlOf");
  return (
    source +
    `
(() => {
  const records = new WeakMap();
  const names = new WeakMap();
  const pushes = [];
  const originalRun = ${session}.prototype.run;
  const originalTransaction = ${session}.prototype.transaction;
  const originalFetch = ${object}.prototype.fetch;
  const networkFetch = globalThis.fetch;
  function rowsFor(sql) {
    let rows = records.get(sql);
    if (!rows) { rows = []; records.set(sql, rows); }
    return rows;
  }
  ${session}.prototype.run = function(name, ...args) {
    names.set(this, name);
    try { return originalRun.call(this, name, ...args); }
    finally { names.delete(this); }
  };
  ${session}.prototype.transaction = function(run) {
    const result = originalTransaction.call(this, run);
    // transactionSync has returned. Never time from the engine's earlier source ts.
    const committed_at = Date.now();
    const epoch = Number(this.exec("SELECT v FROM meta WHERE k = 'epoch'").toArray()[0]?.v ?? 1);
    const rows = rowsFor(this);
    const last = rows.filter(row => row.epoch === epoch).at(-1)?.source_n ?? 0;
    for (const row of this.exec("SELECT n, body FROM events_out WHERE n > ? ORDER BY n", last).toArray()) {
      rows.push({ epoch, source_n: Number(row.n), committed_at, entry: names.get(this) ?? "shell", event: JSON.parse(String(row.body)) });
    }
    return result;
  };
  globalThis.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    const method = init?.method ?? input.method ?? "GET";
    if (method !== "POST" || !url.endsWith("/git-receive-pack")) return networkFetch(input, init);
    const push = { started_at: Date.now(), answered_at: null };
    pushes.push(push);
    const response = await networkFetch(input, init);
    // Fake Artifacts has applied the pack, but its receive-pack reply is slow.
    await new Promise(resolve => setTimeout(resolve, ${pushDelayMs}));
    push.answered_at = Date.now();
    return response;
  };
  ${object}.prototype.fetch = async function(request) {
    if (new URL(request.url).pathname === "/__test/event-latency") {
      const sql = sqlOf(this.ctx);
      return Response.json({ rows: rowsFor(sql), pushes,
        states: sql.exec("SELECT state, COUNT(*) AS n FROM attempts GROUP BY state").toArray(),
        pending: sql.exec("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending', 'notes_pending')").toArray()[0].n,
      });
    }
    return originalFetch.call(this, request);
  };
})();
`
  );
}
