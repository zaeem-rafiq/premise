// The stub Agent of the resume acceptance (docs/spec/04-build-plan.md 2.3 item 9): "a stub
// Agent bound in place of the real one". The pool's `AGENT` binding resolves to this Durable
// Object, so every `/resume` the Trunk side sends lands here — recorded, then answered by the
// mode the test leaves in the object's storage (`/internal/mode`):
//
//   "ack"     -> `{ ok: true, resume_n }` — the answer RS2 gives.
//   otherwise -> a 500 — the request arrived and no `ok` did, so RS1's repush cadence and
//                RS4's deadline play out without any wait for real time.
//
// `/open`, `/release` and `/push` answer `ok` so the launch path stays usable when a test
// goes through it; the attempt's own calls are the test's to make on Trunk directly.

import { DurableObject } from "cloudflare:workers";

export class StubAgent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.json().catch(() => ({}));
    }
    if (url.pathname === "/internal/state") {
      return Response.json({
        resumes: (await this.ctx.storage.get("resumes")) ?? [],
        mode: (await this.ctx.storage.get("mode")) ?? "silent",
      });
    }
    if (url.pathname === "/internal/mode") {
      await this.ctx.storage.put("mode", typeof body.mode === "string" ? body.mode : "ack");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/resume") {
      const resumes = (await this.ctx.storage.get("resumes")) ?? [];
      resumes.push({
        attempt_id: body.attempt_id,
        revision: body.revision,
        cause: body.cause,
        resume_n: body.resume_n,
      });
      await this.ctx.storage.put("resumes", resumes);
      if ((await this.ctx.storage.get("mode")) === "ack") {
        return Response.json({ ok: true, resume_n: body.resume_n });
      }
      return Response.json({ error: { code: "silent" } }, { status: 500 });
    }
    if (url.pathname === "/open" || url.pathname === "/release" || url.pathname === "/push") {
      return Response.json({ ok: true });
    }
    return Response.json({ error: { code: "not_built" } }, { status: 404 });
  }
}

export default {
  fetch: () => new Response("stub-agent hosts Durable Objects only", { status: 404 }),
};
