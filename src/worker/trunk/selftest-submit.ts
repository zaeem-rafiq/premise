// The Worker half of a submit's pre-landing self-test (01-core 4.9 CK6c). Before the `tool` entry
// serves a `submit`, Trunk runs the pool's self-test on the tree the submit would land, in the
// isolate the green line uses (S4a), and hands the verdict to the engine as `Pool.selftest`.
// A failure counts only when head's own tree does not have it (GR3d): head's run is computed once
// per head commit. A run that gives no answer — the time-out, an error — gives no verdict, and the
// submit proceeds (fail open): the verifier being unavailable never blocks a landing.

import type { SelftestCandidate, SelftestVerdict } from "../../core/trunk/selftest.ts";
import { freshFailures, type Run } from "../adapters/verifier/harness/selftest.ts";
import { runInIsolate, type IsolateLoader } from "../adapters/verifier/isolate.ts";

/** One self-test run over a tree. */
export type SelftestRun = (files: ReadonlyMap<string, string>) => Promise<Run>;

/** The run of the isolate runtime over the Worker Loader binding (`LOADER`). */
export function isolateSelftestRun(loader: IsolateLoader): SelftestRun {
  return (files) => runInIsolate({ seq: 0, commit: "", files, loader });
}

/** CK6c for one Trunk object: head's run cached per head commit, and one run per candidate tree
 * while it is in flight (an Agent's retry of the same submit joins the run it already started). */
export class SubmitSelftest {
  readonly #run: SelftestRun;
  #head: { commit: string; run: Promise<Run> } | null = null;
  readonly #candidates = new Map<string, Promise<SelftestVerdict>>();

  constructor(run: SelftestRun) {
    this.#run = run;
  }

  verdict(candidate: SelftestCandidate): Promise<SelftestVerdict> {
    const running = this.#candidates.get(candidate.key);
    if (running !== undefined) return running;
    const verdict = this.#compute(candidate).finally(() => this.#candidates.delete(candidate.key));
    this.#candidates.set(candidate.key, verdict);
    return verdict;
  }

  async #compute(candidate: SelftestCandidate): Promise<SelftestVerdict> {
    try {
      const [run, head] = await Promise.all([this.#run(candidate.files), this.#headRun(candidate)]);
      return { key: candidate.key, failed: freshFailures(run, head, candidate.files.keys()) };
    } catch {
      return { key: candidate.key, failed: null };
    }
  }

  /** Head's run for this head commit: computed once and kept, unless it gave no answer. */
  #headRun(candidate: SelftestCandidate): Promise<Run> {
    if (this.#head !== null && this.#head.commit === candidate.head) return this.#head.run;
    const run = this.#run(candidate.headFiles).then(
      (result) => {
        if (result.unanswered === true) this.#forget(run);
        return result;
      },
      (cause: unknown) => {
        this.#forget(run);
        throw cause;
      },
    );
    this.#head = { commit: candidate.head, run };
    return run;
  }

  #forget(run: Promise<Run>): void {
    if (this.#head !== null && this.#head.run === run) this.#head = null;
  }
}
