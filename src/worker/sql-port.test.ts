import { describe, expect, it } from "vitest";
import { sqlOver } from "./sql-port.ts";

// The defect of the first live run: a Durable Object's SQLite returns a BLOB as an `ArrayBuffer`,
// and readers that tested `instanceof Uint8Array` took the stored pack for empty. `sqlOver` is the
// one place rows are converted, so no reader has to know which database it runs over.
describe("sqlOver", () => {
  it("returns a BLOB column as Uint8Array even when storage gives ArrayBuffer", () => {
    const blob = new Uint8Array([1, 2, 3, 4]).buffer;
    const storage = {
      sql: { exec: () => ({ toArray: () => [{ bytes: blob }] }) },
      transactionSync: (run: () => unknown) => run(),
    } as unknown as DurableObjectStorage;
    const row = sqlOver(storage).exec("SELECT bytes FROM outbox_chunks").toArray()[0];
    expect(row?.bytes).toBeInstanceOf(Uint8Array);
    expect([...(row?.bytes as Uint8Array)]).toEqual([1, 2, 3, 4]);
  });
});
