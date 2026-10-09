import type { Page, WebSocketRoute } from "@playwright/test";
import {
  ev,
  FLOOR_JSON,
  poolState,
  intentCreated,
  attemptOpened,
  attemptState,
  serveSession,
  type Frame,
} from "../shell/stream.ts";
export { ev, poolState, intentCreated, attemptOpened, attemptState, type Frame };

// The pool host is stubbed like lead/look.spec.ts. Only rail behaviour is under test.
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><script>
const source = location.pathname.split('/')[3];
setInterval(() => parent.postMessage({type:'stats',source,version:'c-seed',seq:0,tick:1,
paused:false,kinds:{},shown:0,total:0,swap:null,selftest:null}, '*'), 200);
</script>`;

export async function serveReview(page: Page, frames: Frame[], settings: Frame = {}) {
  await serveSession(page, true);
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...FLOOR_JSON, ...settings }) }),
  );
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      if (JSON.parse(message.toString()).hello === 1) ws.send(JSON.stringify({ events: frames }));
    });
  });
  return (events: Frame[]) => {
    if (!socket) throw new Error("Stream has not connected");
    socket.send(JSON.stringify({ events }));
  };
}

export function attempts(count: number): Frame[] {
  const frames = [poolState(1)];
  for (let i = 1; i <= count; i++) {
    frames.push(
      intentCreated(i * 3 - 1, `i_${i}`, `a creature ${i}`),
      attemptOpened(i * 3, `a_${i}`, `i_${i}`),
      attemptState(i * 3 + 1, `a_${i}`, "opened", "working"),
    );
  }
  return frames;
}

export function headsup(n: number, attempt = "a_1", hn = 1): Frame {
  return ev(n, {
    type: "headsup.sent",
    attempt_id: attempt,
    hn,
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [1], changes: [] },
    go_around: 1,
    keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
    dropped_ops: [],
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: "E2",
        result: "repair",
        reason: "referenced_entity_changed",
        old_hash: "h0",
        new_hash: "h1",
        cause_seq: 1,
        uses: [],
        diff: {
          kind: "entity",
          before:
            "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
          after: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
        },
      },
    ],
  });
}
