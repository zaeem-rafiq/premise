// IR2a: an imported pool's repository gets `refs/heads/main` at the imported branch's head, with
// one ref command and an empty pack, and only when `main` is not already there.

import { describe, expect, it } from "vitest";
import type { Pusher, PushResult, TokenSource } from "../../protocol/ports.ts";
import { ZERO_OID } from "../../core/git/objects.ts";
import { ensureMainRef } from "./main-ref.ts";

const HEAD = "43a86ade8b795c6ef9b4ec53372a607cd1ed426f";
const OTHER = "1dd4f59b814647502596eb3bf4ac9e3a0b868712";

function fakes(
  refs: Record<string, string | null>,
  answer: PushResult = { ok: true, refs: { "refs/heads/main": "ok" } },
) {
  const pushes: Array<{ updates: Array<{ ref: string; old: string; new: string }>; atomic: boolean }> = [];
  const tokenSource: TokenSource = {
    writeTarget: async (pool_id) => ({
      remote: `https://artifacts.test/${pool_id}.git`,
      repo: pool_id,
      token: "t",
      expires_at: null,
    }),
  };
  const pusher: Pusher = {
    push: async (input) => {
      pushes.push({ updates: input.updates, atomic: input.atomic });
      return answer;
    },
    readRefs: async (input) => Object.fromEntries(input.refs.map((r) => [r, refs[r] ?? null])),
  };
  const headOf = async () => refs.HEAD ?? null;
  return { deps: { tokenSource, pusher, headOf }, pushes };
}

describe("ensureMainRef (06-repos IR2a)", () => {
  it("IR2a: creates main at the head of a master branch from the zero id", async () => {
    const { deps, pushes } = fakes({ "refs/heads/master": HEAD });
    await ensureMainRef(deps, "py-pool", "master");
    expect(pushes).toEqual([{ updates: [{ ref: "refs/heads/main", old: ZERO_OID, new: HEAD }], atomic: true }]);
  });

  it("IR2a: pushes nothing when main already points at the imported head (a retried create)", async () => {
    const { deps, pushes } = fakes({ "refs/heads/master": HEAD, "refs/heads/main": HEAD });
    await ensureMainRef(deps, "py-pool", "master");
    expect(pushes).toEqual([]);
  });

  it("IR2a: moves a main that differs to the imported head, compare-and-swap on its old value", async () => {
    const { deps, pushes } = fakes({ "refs/heads/trunk": HEAD, "refs/heads/main": OTHER });
    await ensureMainRef(deps, "p", "trunk");
    expect(pushes[0]?.updates).toEqual([{ ref: "refs/heads/main", old: OTHER, new: HEAD }]);
  });

  it("IR2a: does nothing for a pool imported from main", async () => {
    const { deps, pushes } = fakes({ "refs/heads/main": HEAD, HEAD });
    await ensureMainRef(deps, "p", "main");
    expect(pushes).toEqual([]);
  });

  it("IR2a: takes the head from HEAD when the reported branch main does not exist (a master-only repository)", async () => {
    const { deps, pushes } = fakes({ "refs/heads/master": HEAD, HEAD });
    await ensureMainRef(deps, "py-pool", "main");
    expect(pushes[0]?.updates).toEqual([{ ref: "refs/heads/main", old: ZERO_OID, new: HEAD }]);
  });

  it("IR2a: fails when the push is refused or the branch is missing", async () => {
    const refused = fakes(
      { "refs/heads/master": HEAD },
      { ok: false, kind: "rejected", refs: { "refs/heads/main": "ng" } },
    );
    await expect(ensureMainRef(refused.deps, "p", "master")).rejects.toThrow("main was not created");
    const missing = fakes({});
    await expect(ensureMainRef(missing.deps, "p", "master")).rejects.toThrow("not in the repository");
  });
});
