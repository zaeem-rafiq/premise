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

/** Heads-up history stays intact when an attempt changes an unrelated field. */
export function persistHeadsUps(sql: Sql, a: Attempt): void {
  const stored = new Map(
    sql
      .exec("SELECT * FROM heads_ups WHERE attempt_id = ?", a.id)
      .toArray()
      .map((row) => [Number(row.hn), row]),
  );
  for (const h of a.heads) {
    const row = stored.get(h.hn);
    const values = [
      h.result,
      h.wake ? 1 : 0,
      JSON.stringify(h.body),
      h.created_at,
      h.received_at,
      h.delivered_at,
      h.resolved_at,
      h.statement,
      h.op_mark,
    ];
    if (row === undefined) {
      sql.exec(
        `INSERT INTO heads_ups (attempt_id, hn, result, wake, body, created_at, received_at, delivered_at, resolved_at, statement, op_mark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        h.hn,
        ...values,
      );
    } else if (
      [
        "result",
        "wake",
        "body",
        "created_at",
        "received_at",
        "delivered_at",
        "resolved_at",
        "statement",
        "op_mark",
      ].some((column, i) => row[column] !== values[i])
    ) {
      sql.exec(
        `UPDATE heads_ups SET result = ?, wake = ?, body = ?, created_at = ?, received_at = ?, delivered_at = ?, resolved_at = ?, statement = ?, op_mark = ?
         WHERE attempt_id = ? AND hn = ?`,
        ...values,
        a.id,
        h.hn,
      );
    }
    stored.delete(h.hn);
  }
  for (const hn of stored.keys()) {
    sql.exec("DELETE FROM heads_ups WHERE attempt_id = ? AND hn = ?", a.id, hn);
  }
}
