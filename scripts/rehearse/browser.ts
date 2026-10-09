// The conductor's browser effects use Compare's two live, isolated pool frames (02-tidepool
// 4.8/7.11), not the Floor's controls. The small parent page stays on the deployment's
// origin for SE14's frame-ancestors policy. It never receives the owner key.
import { parsePoolMessage } from "../../src/floor/components/pool-frame/frame-plan.ts";
import type { PoolToFloor } from "../../src/protocol/channel.ts";

export type HeroFrame = "main" | "plain";
type Stats = Extract<PoolToFloor, { type: "stats" }>;
type Versions = Record<HeroFrame, string>;
const FRAMES: HeroFrame[] = ["main", "plain"];

/** A transport's receive callback must identify the sending iframe by event.source. */
export type HeroFrameTransport = {
  mount(urls: Versions, receive: (frame: HeroFrame, payload: unknown) => void): Promise<void>;
  post(frame: HeroFrame, message: { type: "probe"; selftest: true }): Promise<void>;
  close(): Promise<void>;
};

export type HeroFrames = {
  compare(): Promise<Record<string, unknown>[]>;
  probe(versions: Versions): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};

/** Isolated injectable browser transport. Only the live adapter launches Chromium. */
export async function openHeroFrames(
  origin: string,
  pool: string,
  options: { createTransport?: () => Promise<HeroFrameTransport>; timeoutMs?: number } = {},
): Promise<HeroFrames> {
  let address: URL;
  try {
    address = new URL(origin);
  } catch {
    throw new Error("hero_browser_invalid_address");
  }
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username !== "" ||
    address.password !== "" ||
    address.search !== "" ||
    address.hash !== "" ||
    address.pathname !== "/" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(pool)
  ) {
    throw new Error("hero_browser_invalid_address");
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("hero_browser_invalid_timeout");
  let transport: HeroFrameTransport;
  try {
    transport = await (options.createTransport ?? (() => chromiumTransport(address.origin)))();
  } catch {
    throw new Error("hero_browser_launch_failed");
  }
  const latest = new Map<HeroFrame, Stats>();
  let closed = false;
  type Waiter = {
    versions: Versions | null;
    seen: Map<HeroFrame, Stats>;
    sent: Map<HeroFrame, string>;
    resolve(events: Record<string, unknown>[]): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  let waiting: Waiter | null = null;
  const fail = (code: string) => {
    if (waiting === null) return;
    const active = waiting;
    waiting = null;
    clearTimeout(active.timer);
    active.reject(new Error(code));
  };
  const finish = () => {
    if (waiting === null || waiting.seen.size !== 2) return;
    const active = waiting;
    waiting = null;
    clearTimeout(active.timer);
    active.resolve(FRAMES.map((frame) => ({ ...active.seen.get(frame)!, frame })));
  };
  const post = (frame: HeroFrame, version: string) => {
    const active = waiting;
    if (active === null) return;
    active.sent.set(frame, version);
    void transport.post(frame, { type: "probe", selftest: true }).catch(() => {
      if (waiting === active) fail("hero_browser_probe_failed");
    });
  };
  const receive = (frame: HeroFrame, payload: unknown) => {
    if (closed || !FRAMES.includes(frame)) return;
    const stats = parsePoolMessage(payload);
    if (
      stats === null ||
      stats.type !== "stats" ||
      stats.source !== frame ||
      // AS17: before the first plain.updated, plain serves the pool seed as c-<commit>.
      !(frame === "main" ? /^c-[0-9a-f]{40}$/ : /^[cp]-[0-9a-f]{40}$/).test(stats.version)
    )
      return;
    latest.set(frame, stats);
    const active = waiting;
    if (active === null) return;
    if (active.versions === null) {
      active.seen.set(frame, stats);
    } else if (stats.version === active.versions[frame]) {
      if (stats.selftest?.version === stats.version) {
        active.seen.set(frame, stats);
      } else if (active.sent.get(frame) !== stats.version) {
        // A shared-file change reloads the live iframe. Its first message has no self-test,
        // so ask again on this final version instead of waiting on the destroyed document.
        post(frame, stats.version);
      }
    }
    finish();
  };
  try {
    await transport.mount(
      {
        main: `${address.origin}/pool/${pool}/main/?seed=7`,
        plain: `${address.origin}/pool/${pool}/plain/?seed=7`,
      },
      receive,
    );
  } catch {
    await transport.close().catch(() => undefined);
    throw new Error("hero_browser_mount_failed");
  }
  const wait = (versions: Versions | null): Promise<Record<string, unknown>[]> => {
    if (closed) return Promise.reject(new Error("hero_browser_closed"));
    if (waiting !== null) return Promise.reject(new Error("hero_browser_busy"));
    return new Promise((resolve, reject) => {
      waiting = {
        versions,
        seen: versions === null ? new Map(latest) : new Map(),
        sent: new Map(),
        resolve,
        reject,
        timer: setTimeout(() => fail("hero_browser_stats_timeout"), timeoutMs),
      };
      if (versions !== null) {
        for (const frame of FRAMES) post(frame, latest.get(frame)?.version ?? "");
      }
      finish();
    });
  };
  return {
    compare: () => wait(null),
    probe: (versions) => {
      if (!/^c-[0-9a-f]{40}$/.test(versions.main) || !/^p-[0-9a-f]{40}$/.test(versions.plain)) {
        return Promise.reject(new Error("hero_browser_invalid_version"));
      }
      return wait(versions);
    },
    async close() {
      if (closed) return;
      closed = true;
      fail("hero_browser_closed");
      try {
        await transport.close();
      } catch {
        throw new Error("hero_browser_close_failed");
      }
    },
  };
}

async function chromiumTransport(origin: string): Promise<HeroFrameTransport> {
  const { chromium } = await import("@playwright/test");
  // Do not give Chromium the CLI's environment: that environment holds the owner key.
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  const browser = await chromium.launch({ headless: true, env });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    return {
      async mount(urls, receive) {
        await page.exposeBinding("__heroStats", ({ frame }, source: unknown, payload: unknown) => {
          // Bindings also exist inside child frames. Accept only the trusted parent listener.
          if (frame === page.mainFrame() && (source === "main" || source === "plain")) receive(source, payload);
        });
        const parent = `${origin}/__premise_hero_rehearsal__`;
        await page.route(parent, (route) =>
          route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Hero rehearsal</title>" }),
        );
        await page.goto(parent, { waitUntil: "domcontentloaded" });
        // This code executes in the browser, while this script belongs to the Node program.
        // A function given as a string is only evaluated, never called: send one expression that
        // calls it, with its arguments as JSON (the browser code stays out of the Node program).
        const mountFrames = `(urls) => {
          const frames = new Map();
          window.addEventListener("message", (event) => {
            for (const [name, iframe] of frames) {
              if (event.source === iframe.contentWindow) {
                void window.__heroStats(name, event.data);
                return;
              }
            }
          });
          for (const name of ["main", "plain"]) {
            const iframe = document.createElement("iframe");
            iframe.id = name;
            iframe.title = name;
            iframe.setAttribute("sandbox", "allow-scripts");
            iframe.style.cssText = "width:600px;height:600px;border:0";
            iframe.src = urls[name];
            frames.set(name, iframe);
            document.body.append(iframe);
          }
        }`;
        await page.evaluate(`(${mountFrames})(${JSON.stringify(urls)})`);
      },
      async post(frame, message) {
        const postToFrame = `({ frame, message }) => {
          const iframe = document.getElementById(frame);
          iframe.contentWindow.postMessage(message, "*");
        }`;
        await page.evaluate(`(${postToFrame})(${JSON.stringify({ frame, message })})`);
      },
      close: () => browser.close(),
    };
  } catch {
    await browser.close().catch(() => undefined);
    throw new Error("hero_browser_page_failed");
  }
}
