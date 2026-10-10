// Internal-only archive reads/receipt. Neither endpoint is a model tool or public route.
import type { Pool } from "../../core/trunk/sets.ts";
import { view } from "../../core/trunk/sets.ts";
import type { Sql } from "../../protocol/ports.ts";
import { attemptRepoName } from "../adapters/attempt-repo/index.ts";

export function recordAttemptRepository(sql: Sql, body: unknown): Response {
  const r = body as { attempt_id?: unknown; repo?: unknown } | null;
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.attempt_id !== "string" ||
    r.repo !== attemptRepoName(r.attempt_id)
  ) {
    return Response.json({ ok: false, error: "invalid_args" }, { status: 400 });
  }
  const row = sql.exec("SELECT agent_kind, attempt_repo FROM attempts WHERE attempt_id = ?", r.attempt_id).toArray()[0];
  if (row === undefined || row.agent_kind !== "real") {
    return Response.json({ ok: false, error: "attempt_unknown" }, { status: 404 });
  }
  if (row.attempt_repo !== null && row.attempt_repo !== r.repo) {
    return Response.json({ ok: false, error: "attempt_conflict" }, { status: 409 });
  }
  // The accepted note is already frozen by tick. A late receipt never rewrites that note.
  sql.exec("UPDATE attempts SET attempt_repo = ? WHERE attempt_id = ?", r.repo as string, r.attempt_id);
  return Response.json({ ok: true });
}

export function attemptCheckpointView(pool: Pool, attemptId: string): object | null {
  const attempt = pool.attempts.get(attemptId);
  if (attempt === undefined || attempt.agent_kind !== "real") return null;
  // Accepted/landed operations already belong to the pool tree. Replaying them again would
  // duplicate replacements or lose deleted-file evidence. Read that exact landing instead.
  const files =
    attempt.landed_seq === null || (attempt.state !== "accepted" && attempt.state !== "landed")
      ? view(attempt, pool.files, pool.languages)
      : pool.fileMapAt(attempt.landed_seq);
  const touched = [...new Set(attempt.ops.map((op) => op.path))].sort();
  return {
    ops: [...attempt.ops].sort((a, b) => a.op_seq - b.op_seq),
    premises: [...attempt.premises.values()].sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
    files: Object.fromEntries(touched.filter((path) => files.has(path)).map((path) => [path, files.get(path)!])),
  };
}
