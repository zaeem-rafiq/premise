// AG5: called only by the Agent's background checkpoint drain. This reuses the pool
// receive-pack implementation; no second git transport or token cache is introduced.

import { makeCommit, ZERO_OID } from "../../../core/git/objects.ts";
import { buildPack } from "../../../core/git/pack.ts";
import { makeTreeFromFiles } from "../../../core/git/tree-files.ts";
import { utf8 } from "../../../core/sync/bytes.ts";
import { sha1Hex } from "../../../core/sync/sha1.ts";
import { PUSH_TIMEOUT_MS } from "../../../protocol/constants.ts";
import type { Pusher } from "../../../protocol/ports.ts";
import { redact } from "../../../protocol/redact.ts";
import { receivePackPusher } from "../pusher/pusher.ts";
import { attemptRepoName, disposeAttemptRepository, safeAttemptRemote, type AttemptNamespace } from "./provisioner.ts";

export const ATTEMPT_REF = "refs/heads/attempt";
/** Explicit write scope plus a one-hour lifetime, matching the existing push token source. */
export const ATTEMPT_REPO_WRITE_TTL_SECONDS = 3_600;

export type AttemptCheckpoint = {
  repo: string;
  attempt_id: string;
  /** Monotonic checkpoint number and the transcript step captured by this snapshot. */
  n: number;
  step: number;
  /** Milliseconds since epoch, persisted with the snapshot and stable through retries. */
  at: number;
  transcript: readonly unknown[];
  ops: readonly unknown[];
  premises: readonly unknown[];
  /** The attempt view of every touched file, by its original repository path. */
  files: Readonly<Record<string, string>>;
};

export type AttemptCheckpointResult = { ok: true; commit_oid: string } | { ok: false; error: string };
export type AttemptCheckpointWriter = { push(input: AttemptCheckpoint): Promise<AttemptCheckpointResult> };

/** Redact before serializing: an Authorization value must not consume JSON's escaped delimiters. */
function redacted(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redacted(entry, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redact(key, secrets);
      if (Object.hasOwn(out, safeKey)) throw new Error("checkpoint_key_collision");
      out[safeKey] = redacted(entry, secrets);
    }
    return out;
  }
  return value;
}

/** Redact JSON-shaped records before durable storage as well as before the git push (AG7). */
export function redactCheckpointValue<T>(value: T, secrets: readonly string[] = []): T {
  return redacted(value, secrets) as T;
}

function checkpointFiles(input: AttemptCheckpoint, secrets: readonly string[]): Record<string, string> {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const json = (value: unknown): string => JSON.stringify(redacted(value, secrets));
  files["transcript.jsonl"] = input.transcript.map((entry) => `${json(entry)}\n`).join("");
  files["ops.json"] = `${json(input.ops)}\n`;
  files["premises.json"] = `${json(input.premises)}\n`;
  for (const [path, content] of Object.entries(input.files)) {
    const safePath = redact(path, secrets);
    if (
      /[\u0000-\u001f\u007f\\]/.test(safePath) ||
      safePath.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
    ) {
      throw new Error("checkpoint_invalid_path");
    }
    const key = `files/${safePath}`;
    if (Object.hasOwn(files, key)) throw new Error("checkpoint_path_collision");
    files[key] = redact(content, secrets);
  }
  return files;
}

export function artifactsAttemptCheckpointWriter(
  attempts: AttemptNamespace,
  options: { pusher?: Pusher; secrets?: readonly string[] } = {},
): AttemptCheckpointWriter {
  const pusher = options.pusher ?? receivePackPusher();
  const secrets = options.secrets ?? [];
  return {
    async push(input) {
      if (input.repo !== attemptRepoName(input.attempt_id)) return { ok: false, error: "attempt_repo_invalid_target" };
      if (
        !Number.isSafeInteger(input.n) ||
        input.n < 1 ||
        !Number.isSafeInteger(input.step) ||
        input.step < 0 ||
        !Number.isSafeInteger(input.at) ||
        input.at < 0
      ) {
        return { ok: false, error: "attempt_checkpoint_invalid" };
      }
      try {
        const tree = makeTreeFromFiles(checkpointFiles(input, secrets));
        const marker = sha1Hex(utf8(JSON.stringify([input.attempt_id, input.n, input.step, input.at, tree.root.oid])));
        const message = `Premise attempt checkpoint ${input.n}\n\nCheckpoint-Id: ${marker}\n`;
        const handle = await attempts.get(input.repo);
        try {
          const info = await handle.info();
          if (info.name !== input.repo || !safeAttemptRemote(info.remote)) {
            return { ok: false, error: "attempt_repo_invalid_target" };
          }
          // S3b: mint on this attempt repository, never use create()/fork()'s token.
          const token = await handle.createToken("write", ATTEMPT_REPO_WRITE_TTL_SECONDS);
          const target = { remote: info.remote, token: token.plaintext };
          const readHead = async (): Promise<string | null> =>
            (await pusher.readRefs({ ...target, refs: [ATTEMPT_REF], signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) }))[
              ATTEMPT_REF
            ] ?? null;
          const parent = await readHead();
          if (parent !== null) {
            const previous = await handle.readCommit(parent);
            // Binding object reads can lag a ref update. Retry instead of guessing that
            // a previously pushed checkpoint did not complete (AG5 recovery).
            if (previous === null) return { ok: false, error: "attempt_checkpoint_not_ready" };
            if (previous.treeHash === tree.root.oid && previous.message.replace(/\n$/, "") === message.trimEnd()) {
              return { ok: true, commit_oid: parent };
            }
          }
          const commit = makeCommit({
            tree: tree.root.oid,
            parents: parent === null ? [] : [parent],
            author: { name: "Premise Agent", email: "checkpoint@agents.premise.invalid", timestamp: input.at / 1_000 },
            message,
          });
          const result = await pusher.push({
            ...target,
            updates: [{ ref: ATTEMPT_REF, old: parent ?? ZERO_OID, new: commit.oid }],
            pack: buildPack([...tree.objects, commit]),
            atomic: false,
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          });
          // As on the pool push path, a lost reply is recovered by confirmed ref values.
          if (result.ok || (await readHead()) === commit.oid) return { ok: true, commit_oid: commit.oid };
          return { ok: false, error: "attempt_checkpoint_push_failed" };
        } finally {
          disposeAttemptRepository(handle);
        }
      } catch {
        return { ok: false, error: "attempt_checkpoint_failed" };
      }
    },
  };
}
