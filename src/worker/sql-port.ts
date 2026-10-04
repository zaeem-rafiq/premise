// The `Sql` port (`src/protocol/ports.ts`) over a Durable Object's SQLite. Trunk and every Agent
// read their tables through it, and so does the engine, which the tests run over `node:sqlite`.

import type { Sql } from "../protocol/ports.ts";

/**
 * A row as the `Sql` port promises it: a BLOB column is a `Uint8Array`. A Durable Object's SQLite
 * returns a BLOB as an `ArrayBuffer`, while `node:sqlite`, which the engine's tests run over,
 * returns a `Uint8Array`. The rows are converted here, once, so that no reader has to know which
 * database it runs over. (A reader that tested `instanceof Uint8Array` took a stored pack for
 * empty on the real service, and every push carried no objects.)
 */
function portRow(row: Record<string, unknown>): Record<string, unknown> {
  let out = row;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof ArrayBuffer) {
      if (out === row) out = { ...row };
      out[key] = new Uint8Array(value);
    }
  }
  return out;
}

/** The `Sql` port over a Durable Object's storage: `transaction` is `transactionSync` (SY2). */
export function sqlOver(storage: DurableObjectStorage): Sql {
  return {
    exec: (query, ...bindings) => {
      const cursor = storage.sql.exec(query, ...bindings);
      return { toArray: () => cursor.toArray().map(portRow) };
    },
    transaction: (run) => storage.transactionSync(run),
  };
}
