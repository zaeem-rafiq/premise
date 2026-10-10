import { describe, expect, it } from "vitest";
import { runProbe, type ProbeNamespace, type ProbeRepo } from "./probe.ts";

type Calls = string[];

/** A fake namespace: `fork` puts the new name in `forkTarget` (the namespace the platform picks). */
function fakeNamespace(label: string, calls: Calls, opts: { forkTarget?: () => Set<string> } = {}) {
  const names = new Set<string>();
  const ns: ProbeNamespace & { names: Set<string> } = {
    names,
    async create(name) {
      calls.push(`${label}.create ${name}`);
      names.add(name);
      return { name };
    },
    async get(name) {
      if (!names.has(name)) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      const repo: ProbeRepo = {
        async fork(target) {
          calls.push(`${label}.fork ${name} -> ${target}`);
          (opts.forkTarget?.() ?? names).add(target);
          return { name: target };
        },
        async createToken(scope, ttl) {
          calls.push(`${label}.createToken ${name} ${scope} ${ttl}`);
          return { plaintext: "x" };
        },
      };
      return repo;
    },
    async delete(name) {
      calls.push(`${label}.delete ${name}`);
      return names.delete(name);
    },
  };
  return ns;
}

const deps = { stamp: "s1", now: () => 0, sleep: async () => {}, pollMs: 1, maxPolls: 3 };

describe("fork probe (04-build-plan 2.5 item 7, SE22, S3b)", () => {
  it("reports 'pools' when the fork lands beside its source, and deletes all three repositories (SE22)", async () => {
    const calls: Calls = [];
    const pools = fakeNamespace("pools", calls);
    const attempts = fakeNamespace("attempts", calls);
    const r = await runProbe({ ...deps, pools, attempts });
    expect(r.fork.place).toBe("pools");
    expect(r.create.ok).toBe(true);
    expect(calls).toContain("attempts.createToken probe-a-s1 write 600");
    expect(r.cleanup).toEqual({ "pools/probe-src-s1": true, "pools/probe-fork-s1": true, "attempts/probe-a-s1": true });
    expect(pools.names.size + attempts.names.size).toBe(0);
  });

  it("reports 'attempts' when the platform places the fork in the attempt namespace (option B possible)", async () => {
    const calls: Calls = [];
    const attempts = fakeNamespace("attempts", calls);
    const pools = fakeNamespace("pools", calls, { forkTarget: () => attempts.names });
    const r = await runProbe({ ...deps, pools, attempts });
    expect(r.fork.place).toBe("attempts");
    expect(attempts.names.size).toBe(0);
  });

  it("reports 'neither' after the polls when the fork never appears, and still runs option A", async () => {
    const calls: Calls = [];
    const pools = fakeNamespace("pools", calls, { forkTarget: () => new Set() });
    const attempts = fakeNamespace("attempts", calls);
    const r = await runProbe({ ...deps, pools, attempts });
    expect(r.fork).toMatchObject({ place: "neither", polls: 3, error: null });
    expect(r.create.ok).toBe(true);
  });
});
