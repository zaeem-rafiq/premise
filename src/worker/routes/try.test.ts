// 09-try TY3: a try pool's name — `try-` and TRY_ID_LENGTH (10) characters of `a-z0-9`, drawn
// from the random source, matching PL1's pattern.

import { describe, expect, it } from "vitest";
import { POOL_NAME } from "./pools.ts";
import { tryPoolName } from "./try.ts";

describe("TY3: the try pool's name", () => {
  it("TY3: `try-` and ten characters of a-z0-9, a PL1 pool name", () => {
    for (let i = 0; i < 200; i += 1) {
      const name = tryPoolName();
      expect(name).toMatch(/^try-[a-z0-9]{10}$/);
      expect(POOL_NAME.test(name)).toBe(true);
    }
  });

  it("TY3: each byte below 252 picks one of the 36 characters; bytes 252-255 are drawn again", () => {
    const draws = [
      Uint8Array.from([252, 253, 254, 255, 0, 25, 26, 35, 36, 251]),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    ];
    const name = tryPoolName((bytes) => {
      bytes.set(draws.shift()!);
      return bytes;
    });
    // 0 -> a, 25 -> z, 26 -> 0, 35 -> 9, 36 -> a, 251 -> 251 % 36 = 35 -> 9, then 1..4 -> b..e.
    expect(name).toBe("try-az09a9bcde");
  });
});
