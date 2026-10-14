// 09-try TY6 and TY6a: the three limits in their table's order, and what the gate keeps of a
// client address. The numbers are Appendix A's: 600 s per address, 20 per hour, 300 in total.

import { describe, expect, it } from "vitest";
import { decideTry, pruneTries, tryLimitCopyId, type TryRow } from "./try-ledger.ts";

const MIN = 60_000;
const T0 = 1_760_000_000_000;

describe("TY6: the limits of a try", () => {
  it("TY6: a first try from an address is allowed", () => {
    expect(decideTry([], 0, "h1", T0)).toEqual({ ok: true });
  });

  it("TY6: one try per client address per 600 s", () => {
    const rows: TryRow[] = [{ t: T0, h: "h1" }];
    expect(decideTry(rows, 1, "h1", T0 + 9 * MIN)).toEqual({ ok: false, limit: "address" });
    expect(decideTry(rows, 1, "h1", T0 + 10 * MIN - 1)).toEqual({ ok: false, limit: "address" });
    expect(decideTry(rows, 1, "h1", T0 + 10 * MIN)).toEqual({ ok: true });
    // Another address is not limited by it.
    expect(decideTry(rows, 1, "h2", T0 + MIN)).toEqual({ ok: true });
  });

  it("TY6: at most 20 tries within an hour across every address", () => {
    const rows: TryRow[] = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * MIN, h: `a${i}` }));
    expect(decideTry(rows, 20, "new", T0 + 20 * MIN)).toEqual({ ok: false, limit: "hour" });
    expect(decideTry(rows.slice(1), 19, "new", T0 + 20 * MIN)).toEqual({ ok: true });
    // An hour after the first try, it no longer counts.
    expect(decideTry(rows, 20, "new", T0 + 60 * MIN)).toEqual({ ok: true });
  });

  it("TY6: at most 300 tries in total", () => {
    expect(decideTry([], 299, "h", T0)).toEqual({ ok: true });
    expect(decideTry([], 300, "h", T0)).toEqual({ ok: false, limit: "total" });
  });

  it("TY6: the first limit of the table's order answers", () => {
    const rows: TryRow[] = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * 1000, h: i === 0 ? "me" : `a${i}` }));
    expect(decideTry(rows, 300, "me", T0 + MIN)).toEqual({ ok: false, limit: "address" });
    expect(decideTry(rows, 300, "you", T0 + MIN)).toEqual({ ok: false, limit: "hour" });
  });

  it("TY6: each refusal names its own sentence", () => {
    expect(tryLimitCopyId("address")).toBe("try.limited.address");
    expect(tryLimitCopyId("hour")).toBe("try.limited.hour");
    expect(tryLimitCopyId("total")).toBe("try.limited.total");
  });
});

describe("TY6a: what is kept of a client address", () => {
  it("TY6a: a hash is erased once its try is older than 600 s; the time stays for the hourly count", () => {
    const rows: TryRow[] = [
      { t: T0, h: "old" },
      { t: T0 + 5 * MIN, h: "young" },
    ];
    expect(pruneTries(rows, T0 + 10 * MIN)).toEqual([
      { t: T0, h: null },
      { t: T0 + 5 * MIN, h: "young" },
    ]);
  });

  it("TY6a: a row leaves after an hour", () => {
    expect(pruneTries([{ t: T0, h: null }], T0 + 60 * MIN)).toEqual([]);
    expect(pruneTries([{ t: T0, h: null }], T0 + 60 * MIN - 1)).toEqual([{ t: T0, h: null }]);
  });

  it("TY6a: an erased hash no longer limits its address", () => {
    const kept = pruneTries([{ t: T0, h: "me" }], T0 + 10 * MIN);
    expect(decideTry(kept, 1, "me", T0 + 10 * MIN)).toEqual({ ok: true });
  });
});
