// The fork probe of 04-build-plan 2.5 item 7 (track 4D's first task): can `fork()` place the fork in
// the `ATTEMPTS` namespace (SE22)? The Workers binding's `fork(name, opts)` names no target namespace,
// so the probe forks a repository of `POOLS` and then asks both namespaces for the fork by name. It
// also times option A (S3 fallback: `ATTEMPTS.create()` and `createToken("write")`), and deletes every
// repository it made. Typed against the few binding methods it calls, so it runs against fakes
// offline and inside the probe Worker (`worker.ts`) live.

export type ProbeRepo = {
  fork(name: string, opts?: { description?: string; defaultBranchOnly?: boolean }): Promise<unknown>;
  createToken(scope?: "write" | "read", ttl?: number): Promise<unknown>;
};

export type ProbeNamespace = {
  create(name: string, opts?: { description?: string }): Promise<unknown>;
  get(name: string): Promise<ProbeRepo>;
  delete(name: string): Promise<boolean>;
};

/** Where the fork was found: only in `ATTEMPTS` means option B can satisfy SE22. */
export type ForkPlace = "attempts" | "pools" | "both" | "neither";

export type ProbeResult = {
  fork: { place: ForkPlace; ms: number; error: string | null; polls: number };
  create: { ok: boolean; ready_ms: number; token_ms: number; error: string | null };
  cleanup: Record<string, boolean | string>;
};

export type ProbeDeps = {
  pools: ProbeNamespace;
  attempts: ProbeNamespace;
  stamp: string; // makes the repository names unique per run
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
};

function message(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.message : String(err);
}

/** True when `get(name)` answers a handle; false when it throws (NOT_FOUND, *_IN_PROGRESS). */
async function has(ns: ProbeNamespace, name: string): Promise<boolean> {
  try {
    await ns.get(name);
    return true;
  } catch {
    return false;
  }
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const { pools, attempts, stamp, now, sleep } = deps;
  const pollMs = deps.pollMs ?? 500;
  const maxPolls = deps.maxPolls ?? 60;
  const src = `probe-src-${stamp}`;
  const forkName = `probe-fork-${stamp}`;
  const aName = `probe-a-${stamp}`;
  const made: Array<[ProbeNamespace, string, string]> = [];

  const result: ProbeResult = {
    fork: { place: "neither", ms: 0, error: null, polls: 0 },
    create: { ok: false, ready_ms: 0, token_ms: 0, error: null },
    cleanup: {},
  };

  // Option B: fork a POOLS repository, then look for the fork in both namespaces.
  const t0 = now();
  try {
    await pools.create(src, { description: "premise fork probe source" });
    made.push([pools, src, `pools/${src}`]);
    const repo = await pools.get(src);
    await repo.fork(forkName, { description: "premise fork probe" });
    let place: ForkPlace = "neither";
    for (let i = 0; i < maxPolls; i++) {
      result.fork.polls = i + 1;
      const inAttempts = await has(attempts, forkName);
      const inPools = await has(pools, forkName);
      place = inAttempts && inPools ? "both" : inAttempts ? "attempts" : inPools ? "pools" : "neither";
      if (place !== "neither") break;
      await sleep(pollMs);
    }
    result.fork.place = place;
    if (place === "pools" || place === "both") made.push([pools, forkName, `pools/${forkName}`]);
    if (place === "attempts" || place === "both") made.push([attempts, forkName, `attempts/${forkName}`]);
  } catch (err) {
    result.fork.error = message(err);
  }
  result.fork.ms = now() - t0;

  // Option A: create in ATTEMPTS and mint a write token with an explicit scope (S3b).
  const t1 = now();
  try {
    await attempts.create(aName, { description: "premise fork probe, option A" });
    made.push([attempts, aName, `attempts/${aName}`]);
    let repo: ProbeRepo | null = null;
    for (let i = 0; i < maxPolls && repo === null; i++) {
      try {
        repo = await attempts.get(aName);
      } catch {
        await sleep(pollMs);
      }
    }
    if (repo === null) throw new Error("not ready");
    result.create.ready_ms = now() - t1;
    const t2 = now();
    await repo.createToken("write", 600);
    result.create.token_ms = now() - t2;
    result.create.ok = true;
  } catch (err) {
    result.create.error = message(err);
  }

  for (const [ns, name, label] of made) {
    try {
      result.cleanup[label] = await ns.delete(name);
    } catch (err) {
      result.cleanup[label] = message(err);
    }
  }
  return result;
}
