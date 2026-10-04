// test/workerd/agent/real/fake-ai.mjs — the `AI` binding as a deployment binds it:
// a service binding whose `run(model, request)` answers like Workers AI. The
// script itself lives in the test's FakeModel (a loopback HTTP service this
// module forwards to), so a test keeps its per-request control in-process.
// Non-2xx answers are rethrown with the Workers AI error surface `callModel`
// classifies: `status`, `code` and `retryAfterMs`.

import { WorkerEntrypoint } from "cloudflare:workers";

export class AiBinding extends WorkerEntrypoint {
  async run(model, request) {
    const res = await fetch(`${this.env.MODEL_UPSTREAM}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, request }),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = null;
      let retry = null;
      try {
        const j = JSON.parse(text);
        code = typeof j.code === "number" ? j.code : null;
        retry = typeof j.retry_after_ms === "number" ? j.retry_after_ms : null;
      } catch {
        // a plain body is fine
      }
      const header = res.headers.get("retry-after");
      if (retry === null && header !== null) {
        const secs = Number(header);
        if (Number.isFinite(secs)) retry = Math.ceil(secs * 1000);
      }
      const err = new Error(`model http ${res.status}${code === null ? "" : ` code ${code}`}`);
      err.status = res.status;
      err.code = code;
      err.retryAfterMs = retry;
      throw err;
    }
    return JSON.parse(text);
  }
}

export default {
  fetch() {
    return new Response("fake-ai", { status: 404 });
  },
};
