// The throwaway Worker that `green-isolate.ts` deploys for 04-build-plan 2.15 item 4. It holds only
// the Worker Loader binding and runs the green line's own isolate verifier on the files the script
// posts, `runs` times in sequence (one verification in flight, S4b), and answers each run's verdict
// and duration. It answers only a POST that carries the run's random key. The script deletes the
// Worker when the run ends.

import { runInIsolate, type IsolateLoader } from "../../../src/worker/adapters/verifier/isolate.ts";

type ProbeEnv = { LOADER: IsolateLoader; PROBE_KEY: string };
type ProbeRequest = { files: Record<string, string>; runs: number; cpuMs: number };

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (
      request.method !== "POST" ||
      !env.PROBE_KEY ||
      request.headers.get("authorization") !== `Bearer ${env.PROBE_KEY}`
    ) {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as ProbeRequest;
    const files = new Map(Object.entries(body.files));
    const runs: Array<{ ok: boolean; ms: number; checks: Array<{ name: string; ok: boolean; code?: string }> }> = [];
    for (let i = 0; i < Math.min(body.runs, 50); i += 1) {
      const started = Date.now();
      const result = await runInIsolate({ seq: 0, commit: "probe", files, loader: env.LOADER, cpuMs: body.cpuMs });
      runs.push({ ok: result.ok, ms: Date.now() - started, checks: result.checks.filter((c) => !c.ok) });
    }
    return Response.json({ runs });
  },
};
