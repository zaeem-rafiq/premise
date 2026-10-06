// Differential writes for the mutable child rows of an attempt (01-core 3.2).
// Read inside the caller's transaction: rollback and direct rebuild writes need no cache repair.
import type { Sql } from "../../protocol/ports.ts";
import type { Attempt } from "./sets.ts";

export function persistPremises(sql: Sql, a: Attempt): void {
  const stored = new Map(
    sql
      .exec("SELECT * FROM premises WHERE attempt_id = ?", a.id)
      .toArray()
      .map((row) => [`${row.kind}|${row.key}`, row]),
  );
  for (const p of a.premises.values()) {
    const key = `${p.kind}|${p.key}`;
    const row = stored.get(key);
    const values = [
      p.hash,
      p.seq,
      p.members === null ? null : JSON.stringify(p.members),
      p.shown === null ? null : JSON.stringify(p.shown),
      p.read ? 1 : 0,
      p.edit ? 1 : 0,
      p.derived ? 1 : 0,
      p.status,
    ];
    if (row === undefined) {
      sql.exec(
        `INSERT INTO premises (attempt_id, kind, key, hash, seq, members, shown, read, edit, derived, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        p.kind,
        p.key,
        ...values,
      );
    } else if (
      ["hash", "seq", "members", "shown", "read", "edit", "derived", "status"].some(
        (column, i) => row[column] !== values[i],
      )
    ) {
      sql.exec(
        `UPDATE premises SET hash = ?, seq = ?, members = ?, shown = ?, read = ?, edit = ?, derived = ?, status = ?
        WHERE attempt_id = ? AND kind = ? AND key = ?`,
        ...values,
        a.id,
        p.kind,
        p.key,
      );
    }
    stored.delete(key);
  }
  for (const row of stored.values()) {
    sql.exec(
      "DELETE FROM premises WHERE attempt_id = ? AND kind = ? AND key = ?",
      a.id,
      String(row.kind),
      String(row.key),
    );
  }
}

export function persistOps(sql: Sql, a: Attempt): void {
  const stored = new Map(
    sql
      .exec("SELECT * FROM ops WHERE attempt_id = ?", a.id)
      .toArray()
      .map((row) => [Number(row.op_seq), row]),
  );
  for (const op of a.ops) {
    const row = stored.get(op.op_seq);
    const values = [
      op.op,
      op.path,
      op.op === "write" ? op.content : null,
      op.op === "replace" ? op.old : null,
      op.op === "replace" ? op.new : null,
      op.op === "write" ? op.base_oid : null,
      op.op === "replace" ? JSON.stringify(op.targets) : null,
      op.dropped ? 1 : 0,
    ];
    if (row === undefined) {
      sql.exec(
        `INSERT INTO ops (attempt_id, op_seq, op, path, content, old, new, base_oid, targets, dropped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        op.op_seq,
        ...values,
      );
    } else if (
      ["op", "path", "content", "old", "new", "base_oid", "targets", "dropped"].some(
        (column, i) => row[column] !== values[i],
      )
    ) {
      sql.exec(
        `UPDATE ops SET op = ?, path = ?, content = ?, old = ?, new = ?, base_oid = ?, targets = ?, dropped = ?
        WHERE attempt_id = ? AND op_seq = ?`,
        ...values,
        a.id,
        op.op_seq,
      );
    }
    stored.delete(op.op_seq);
  }
  for (const seq of stored.keys()) {
    sql.exec("DELETE FROM ops WHERE attempt_id = ? AND op_seq = ?", a.id, seq);
  }
}
