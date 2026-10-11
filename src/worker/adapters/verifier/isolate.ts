// The isolate runtime of the green line (01-core 11.5 GR5, GR6; S4 option B, S4a to S4c): the
// commit's `.js` files and the generated entry module (`harness/selftest.ts`) run as the modules of
// one fresh Dynamic Worker, loaded through the Worker Loader binding with an empty environment, no
// outbound network and a CPU limit. A run with no verdict within `SELFTEST_TIMEOUT_MS` fails closed
// (ST4). The verifier never sees a token or a binding of its own Worker (GR6).

import { GREEN_CPU_MS, SELFTEST_TIMEOUT_MS } from "../../../protocol/constants.ts";
import type { VerifyResult } from "../../../protocol/green.ts";
import type { Verifier } from "../../../protocol/ports.ts";
import {
  againstGreen,
  ENTRY_MODULE,
  failClosed,
  isolateModules,
  mapAnswer,
  SELFTEST_PATH,
  type Run,
} from "./harness/selftest.ts";

/** The compatibility date of the loaded isolate: the Worker's own (wrangler.jsonc). */
const COMPATIBILITY_DATE = "2026-10-01";

/** The code of the one Dynamic Worker, as the Worker Loader binding takes it (S4a, GR6). */
export type IsolateCode = {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, { js: string }>;
  env: Record<string, never>;
  globalOutbound: null;
  limits: { cpuMs: number };
};

/** The part of the Worker Loader binding (`LOADER`) the verifier uses. */
export type IsolateLoader = {
  load(code: IsolateCode): { getEntrypoint(): { fetch(url: string): Promise<Response> } };
};

export type IsolateInput = {
  seq: number;
  commit: string;
  /** The commit's files (path -> content), as Trunk recorded them for its landing (GR5a, S7). */
  files: ReadonlyMap<string, string>;
  /** The green commit's files (GR3d): a failed head is judged against them. Absent, it is not. */
  greenFiles?: ReadonlyMap<string, string>;
  /** The Worker Loader binding (`LOADER`). */
  loader: IsolateLoader;
  cpuMs?: number;
  timeoutMs?: number;
};

/** GR6 and S4a: the code of the one Dynamic Worker. Exported for the test that proves its isolation. */
export function isolateCode(files: ReadonlyMap<string, string>, cpuMs: number = GREEN_CPU_MS): IsolateCode {
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    mainModule: ENTRY_MODULE,
    modules: isolateModules(files),
    env: {},
    globalOutbound: null,
    limits: { cpuMs },
  };
}

function reason(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
}

/** One run of the self-test in a fresh isolate, mapped to the checks of GR8. */
export async function runInIsolate(input: IsolateInput): Promise<Run> {
  if (!input.files.has(SELFTEST_PATH)) return failClosed("harness_error", `${SELFTEST_PATH} is missing`);
  const timeoutMs = input.timeoutMs ?? SELFTEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    const run = (async () => {
      const worker = input.loader.load(isolateCode(input.files, input.cpuMs));
      const response = await worker.getEntrypoint().fetch("http://selftest.invalid/");
      return response.text();
    })();
    const answer = await Promise.race([run, late]);
    if (answer === "late") {
      run.catch(() => undefined); // the isolate is dropped with this request
      return { ...failClosed("no_verdict", `no verdict within ${timeoutMs} ms`), unanswered: true };
    }
    return mapAnswer(answer);
  } catch (cause) {
    const text = reason(cause);
    // The CPU limit ends the isolate with an error that names it: no verdict within the limit.
    const run = /CPU time limit|exceeded CPU/i.test(text)
      ? failClosed("no_verdict", text)
      : failClosed("harness_error", text);
    return { ...run, unanswered: true };
  } finally {
    clearTimeout(timer);
  }
}

/** The `Verifier` of the isolate runtime over one start answer's files. `now` gives `duration_ms`. */
export function isolateVerifier(input: IsolateInput, now: () => number = Date.now): Verifier {
  return {
    async verify(request) {
      if (request.seq !== input.seq || request.commit !== input.commit) {
        throw new Error("the isolate verifier holds the files of another commit");
      }
      const started = now();
      const head = await runInIsolate(input);
      let result: Pick<VerifyResult, "ok" | "checks" | "log"> = head;
      // GR3d: a failure is the landings' only when the green commit does not have it too.
      if (!head.ok && input.greenFiles !== undefined) {
        result = againstGreen(head, await runInIsolate({ ...input, files: input.greenFiles }));
      }
      const { ok, checks, log } = result;
      return {
        seq: input.seq,
        commit: input.commit,
        runtime: "isolate",
        duration_ms: now() - started,
        ok,
        checks,
        log,
      };
    },
  };
}
