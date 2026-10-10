// The throwaway Worker that `fork-probe.ts` deploys to answer the fork question live. It holds the
// `test` namespaces' bindings and answers only a POST that carries the run's random key; nothing
// else. `fork-probe.ts` deletes the Worker when the run ends.

import { runProbe, type ProbeNamespace } from "./probe.ts";

type ProbeEnv = { POOLS: ProbeNamespace; ATTEMPTS: ProbeNamespace; PROBE_KEY: string };

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (
      request.method !== "POST" ||
      !env.PROBE_KEY ||
      request.headers.get("authorization") !== `Bearer ${env.PROBE_KEY}`
    ) {
      return new Response("not found", { status: 404 });
    }
    const stamp = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const result = await runProbe({
      pools: env.POOLS,
      attempts: env.ATTEMPTS,
      stamp,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    return Response.json({ stamp, ...result });
  },
};
