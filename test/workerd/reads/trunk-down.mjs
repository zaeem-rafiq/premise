// Slice 7 item 5's "Trunk unreachable" stand-in: bound in place of the real Trunk by the
// landing harness's `breakTrunk()`, it answers 503 to every fetch (and swallows alarms).
// Public reads through the app server and the Floor must not notice it — FS2, AS16.

import { DurableObject } from "cloudflare:workers";

export class TrunkDown extends DurableObject {
  fetch() {
    return new Response(JSON.stringify({ error: { code: "trunk_down" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  alarm() {}
}
