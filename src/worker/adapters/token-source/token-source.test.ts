// SE5c's unit half for the write path: `writeTarget` must pass the scope explicitly — a call
// with no scope argument, or `undefined`, is a defect even though it happens to mean "write" on
// the real service. The recording handle counts arguments, so an implicit default fails here.
// The read side's twin lives beside `pools.ts`; the end-to-end proof is in test/workerd/reads/.

import { describe, expect, it } from "vitest";
import { artifactsTokenSource, WRITE_TOKEN_TTL_SECONDS, type ArtifactsLike } from "./token-source.ts";

/** A `createToken` that records its argument list verbatim — scope included only if passed. */
function recordingBinding() {
  const mints: Array<{ args: unknown[] }> = [];
  const binding: ArtifactsLike = {
    get: (name) =>
      Promise.resolve({
        info: () => Promise.resolve({ remote: `https://artifacts.test/${name}` }),
        createToken: (...args: unknown[]) => {
          mints.push({ args });
          return Promise.resolve({ plaintext: "tok-unit-test", expiresAt: "2026-10-06T00:00:00.000Z" });
        },
      }),
  };
  return { binding, mints };
}

describe("artifactsTokenSource (SE5c: the write scope is always explicit)", () => {
  it("writeTarget calls createToken with exactly ('write', ttl) — never a scope-less call", async () => {
    const { binding, mints } = recordingBinding();
    const source = artifactsTokenSource(binding);
    const target = await source.writeTarget("pool-x");
    expect(target.repo).toBe("pool-x");
    expect(mints).toHaveLength(1);
    expect(mints[0]?.args).toEqual(["write", WRITE_TOKEN_TTL_SECONDS]);
    // argc is the explicit-scope proof: createToken() or createToken(undefined, ...) fail this.
    expect(mints[0]?.args).toHaveLength(2);
    expect(mints[0]?.args[0]).toBe("write");
  });

  it("keeps the explicit scope when the ttl option overrides the default", async () => {
    const { binding, mints } = recordingBinding();
    const source = artifactsTokenSource(binding, { tokenTtlSeconds: 60 });
    await source.writeTarget("pool-y");
    expect(mints[0]?.args).toEqual(["write", 60]);
  });
});
