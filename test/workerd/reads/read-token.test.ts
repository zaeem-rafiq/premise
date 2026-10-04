// test/workerd/reads/read-token.test.ts — Slice 7 acceptance item 3 (04-build-plan 2.8), SE5c end
// to end in local workerd: the owner-only route mints a read token, stock git clones with it, and
// the stand-in server refuses a push with it — scope `read` cannot write, the real service's rule.
// BP7: the minted token is never printed — git errors are scrubbed and every assertion on the
// token itself is boolean, so a failure diff can never carry it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitAsync } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { OWNER_KEY, bearer, createPool, landOne } from "./helpers.ts";

const POOL = "reads-token";
// The fake binding's token convention (`tok-<repo>-<scope>`) — what the server's scope check
// knows ahead of the mint. The route's returned token is compared, never logged.
const WRITE_TOKEN = `tok-${POOL}-write`;
const READ_TOKEN = `tok-${POOL}-read`;

/** `gitAsync` with the token values scrubbed out of any error it throws (BP7). */
function gitQuiet(cwd: string, args: string[]): Promise<string> {
  return gitAsync(cwd, args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(READ_TOKEN, "<token>").replaceAll(WRITE_TOKEN, "<token>"));
  });
}

describe("Slice 7 item 3: the read token (SE5c, 13.6)", () => {
  let worker: LandingWorker;
  let landedCommit: string;
  let token: string;

  beforeAll(async () => {
    // No gate token: `enforceTokenScopes` is the auth the stand-in applies to every request —
    // the landing below is itself the positive control that a write token may push through it.
    worker = await startLandingWorker({ ownerKey: OWNER_KEY, repos: [POOL] });
    worker.enforceTokenScopes({ read: READ_TOKEN, write: WRITE_TOKEN });
    await createPool(worker, POOL);
    landedCommit = (await landOne(worker, POOL, "r-token-land")).commit;
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("without the owner key the route answers 401 (13.6 owner role)", async () => {
    const response = await worker.fetch(`/api/pools/${POOL}/read-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("the minted token clones with stock git, cannot push, while the write token still can", async () => {
    const minted = await worker.fetch(`/api/pools/${POOL}/read-token`, bearer({}) satisfies RequestInit);
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { token: string };
    token = body.token;
    // Structural checks only — the token's value is never put in an expectation's diff output.
    expect(typeof token === "string" && token.length > 0).toBe(true);
    expect(token === READ_TOKEN).toBe(true);
    expect(token === WRITE_TOKEN).toBe(false);

    const work = mkdtempSync(join(tmpdir(), "premise-reads-clone-"));
    const remote = worker.remoteFor(POOL);
    const auth = { name: "http.extraheader", value: `Authorization: Bearer ${token}` };

    // The clone: stock git, read token, every HTTP hop authenticated (`--template=` keeps this
    // sandbox's unreadable git template directory out of the fresh .git).
    await gitQuiet(work, ["-c", `${auth.name}=${auth.value}`, "clone", "--template=", remote, "clone"]);
    const clone = join(work, "clone");
    await gitQuiet(clone, ["config", auth.name, auth.value]); // persisted for fetch/push below
    expect(await gitQuiet(clone, ["rev-parse", "HEAD"])).toBe(landedCommit);
    // The read token reads the notes ref too (the platform's `git fetch refs/notes/premise` shape).
    await gitQuiet(clone, ["fetch", "origin", "refs/notes/premise:refs/notes/premise"]);
    const noted = await gitQuiet(clone, ["notes", "--ref=premise", "show", "HEAD"]);
    expect(JSON.parse(noted)).toMatchObject({ seq: 1 });

    // The push attempt with the read token is refused by the server before git runs a pack.
    await gitQuiet(clone, ["commit", "--allow-empty", "-m", "a read token cannot write"]);
    const newCommit = await gitQuiet(clone, ["rev-parse", "HEAD"]);
    await expect(gitQuiet(clone, ["push", "origin", "HEAD:main"])).rejects.toThrow();
    // The remote's main is unmoved, and the refused request is on the server's log.
    expect(worker.refs(POOL).main).toBe(landedCommit);
    const sawDeniedPush = worker
      .gitRequests()
      .some((r) => r.path.includes("git-receive-pack") && r.authorization === `Bearer ${token}`);
    expect(sawDeniedPush).toBe(true);

    // Positive control: the same commit pushed with the write token succeeds, so the refusal
    // above was the scope rule and not a dead server.
    await gitQuiet(clone, ["config", auth.name, `Authorization: Bearer ${WRITE_TOKEN}`]);
    await gitQuiet(clone, ["push", "origin", "HEAD:main"]);
    expect(worker.refs(POOL).main).toBe(newCommit);
  }, 60_000);
});
