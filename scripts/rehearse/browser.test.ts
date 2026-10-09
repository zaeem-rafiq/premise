import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openHeroFrames } from "./browser.ts";
import type { HeroFrame, HeroFrameTransport } from "./browser.ts";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@playwright/test", () => ({ chromium: { launch } }));
const MAIN = `c-${"a".repeat(40)}`;
const PLAIN = `p-${"b".repeat(40)}`;
const VERSIONS = { main: MAIN, plain: PLAIN };
const SECRET = "private-owner-key-for-browser-test";

// Channel fixture values follow 02-tidepool 4.5, not the adapter's output.
function stats(frame: HeroFrame, version: string, selftest = false) {
  return {
    type: "stats",
    source: frame,
    version,
    seq: 4,
    tick: 1,
    paused: false,
    kinds: {},
    shown: 3,
    total: 3,
    swap: null,
    selftest: selftest
      ? { version, ok: frame === "main", failed: frame === "main" ? [] : [{ name: "not_exhausted", kind: "shrimp" }] }
      : null,
  };
}

function fakeTransport() {
  let receive: Parameters<HeroFrameTransport["mount"]>[1] = () => undefined;
  const transport: HeroFrameTransport = {
    mount: vi.fn(async (_urls, callback) => {
      receive = callback;
    }),
    post: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { transport, emit: (frame: HeroFrame, payload: unknown) => receive(frame, payload) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  launch.mockReset();
});

describe("hero Compare frame adapter", () => {
  it("opens both live sources with the same seed, accepting AS17 plain seed fallback before its first update", async () => {
    const fake = fakeTransport();
    const frames = await openHeroFrames("https://premise.example", "hero-1", {
      createTransport: async () => fake.transport,
    });
    expect(fake.transport.mount).toHaveBeenCalledWith(
      {
        main: "https://premise.example/pool/hero-1/main/?seed=7",
        plain: "https://premise.example/pool/hero-1/plain/?seed=7",
      },
      expect.any(Function),
    );
    const pending = frames.compare();
    fake.emit("main", stats("main", MAIN));
    fake.emit("plain", stats("plain", MAIN));
    expect(await pending).toEqual([
      { ...stats("main", MAIN), frame: "main" },
      { ...stats("plain", MAIN), frame: "plain" },
    ]);
    await frames.close();
  });

  it("waits for current self-tests and repeats the probe after a live frame reload", async () => {
    const fake = fakeTransport();
    const frames = await openHeroFrames("https://premise.example", "hero-2", {
      createTransport: async () => fake.transport,
    });
    const old = `c-${"0".repeat(40)}`;
    fake.emit("main", stats("main", old));
    fake.emit("plain", stats("plain", old));
    const result = frames.probe(VERSIONS);
    expect(fake.transport.post).toHaveBeenCalledTimes(2);
    fake.emit("main", stats("main", old, true));
    fake.emit("main", stats("main", MAIN));
    expect(fake.transport.post).toHaveBeenCalledTimes(3);
    fake.emit("main", stats("main", MAIN));
    expect(fake.transport.post).toHaveBeenCalledTimes(3);
    fake.emit("plain", stats("plain", PLAIN));
    expect(fake.transport.post).toHaveBeenCalledTimes(4);
    fake.emit("plain", stats("plain", PLAIN, true));
    fake.emit("main", stats("main", MAIN, true));
    const events = await result;
    expect(events.map((event) => event.selftest)).toEqual([
      { version: MAIN, ok: true, failed: [] },
      { version: PLAIN, ok: false, failed: [{ name: "not_exhausted", kind: "shrimp" }] },
    ]);
    await frames.close();
  });

  it("refuses malformed, wrong-source and stale self-test messages until the bounded wait fails", async () => {
    vi.useFakeTimers();
    const fake = fakeTransport();
    const frames = await openHeroFrames("https://premise.example", "hero-3", {
      createTransport: async () => fake.transport,
      timeoutMs: 100,
    });
    const pending = frames.probe(VERSIONS);
    const rejection = expect(pending).rejects.toThrow("hero_browser_stats_timeout");
    fake.emit("main", { type: "stats", source: "main", version: MAIN });
    fake.emit("main", stats("plain", PLAIN, true));
    fake.emit("main", {
      ...stats("main", MAIN, true),
      selftest: { version: `c-${"0".repeat(40)}`, ok: true, failed: [] },
    });
    fake.emit("plain", stats("plain", PLAIN, true));
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    await frames.close();
  });

  it("sanitizes transport errors and disposes a failed mount", async () => {
    const fake = fakeTransport();
    vi.mocked(fake.transport.mount).mockRejectedValue(new Error(SECRET));
    await expect(
      openHeroFrames("https://premise.example", "hero-4", { createTransport: async () => fake.transport }),
    ).rejects.toThrow(/^hero_browser_mount_failed$/);
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
    await expect(
      openHeroFrames("https://premise.example", "hero-4", {
        createTransport: async () => {
          throw new Error(SECRET);
        },
      }),
    ).rejects.toThrow(/^hero_browser_launch_failed$/);
  });

  it("closes pending waits and does not close the transport twice", async () => {
    const fake = fakeTransport();
    const frames = await openHeroFrames("https://premise.example", "hero-5", {
      createTransport: async () => fake.transport,
    });
    const rejected = expect(frames.compare()).rejects.toThrow("hero_browser_closed");
    await frames.close();
    await rejected;
    await frames.close();
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects secret-bearing addresses and malformed version targets with fixed errors", async () => {
    await expect(openHeroFrames(`https://user:${SECRET}@premise.example`, "hero-6")).rejects.toThrow(
      /^hero_browser_invalid_address$/,
    );
    const fake = fakeTransport();
    const frames = await openHeroFrames("https://premise.example", "hero-6", {
      createTransport: async () => fake.transport,
    });
    await expect(frames.probe({ main: SECRET, plain: PLAIN })).rejects.toThrow(/^hero_browser_invalid_version$/);
    await expect(frames.probe({ main: MAIN, plain: MAIN })).rejects.toThrow(/^hero_browser_invalid_version$/);
    expect(fake.transport.post).not.toHaveBeenCalled();
    await frames.close();
  });

  it("uses a same-origin parent, opaque sandbox frames and source-checked messages without passing credentials to Chromium", async () => {
    vi.stubEnv("PREMISE_OWNER_KEY", SECRET);
    const parentFrame = {};
    const posts: unknown[] = [];
    const iframes: Array<{
      id: string;
      src: string;
      title: string;
      style: Record<string, string>;
      contentWindow: { postMessage(message: unknown, origin: string): void };
      setAttribute: ReturnType<typeof vi.fn>;
    }> = [];
    let binding: (source: { frame: unknown }, name: unknown, payload: unknown) => void = () => undefined;
    let messageListener: (event: { source: unknown; data: unknown }) => void = () => undefined;
    const window = {
      addEventListener: (_name: string, listener: typeof messageListener) => {
        messageListener = listener;
      },
      __heroStats: (name: unknown, payload: unknown) => binding({ frame: parentFrame }, name, payload),
    };
    const document = {
      createElement: () => ({
        id: "",
        src: "",
        title: "",
        style: {},
        contentWindow: {
          postMessage: (message: unknown, origin: string) => {
            posts.push({ message, origin });
          },
        },
        setAttribute: vi.fn(),
      }),
      body: {
        append: (frame: (typeof iframes)[number]) => {
          iframes.push(frame);
        },
      },
      getElementById: (id: string) => iframes.find((frame) => frame.id === id),
    };
    const page = {
      exposeBinding: vi.fn(async (_name: string, callback: typeof binding) => {
        binding = callback;
      }),
      mainFrame: () => parentFrame,
      route: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      // As Playwright does: a string is evaluated as one expression, and a function it yields is never
      // called (the fake once called it, so the live helper mounted no frames while this test passed).
      evaluate: vi.fn(async (code: string) => runInNewContext(code, { window, document })),
    };
    const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
    launch.mockResolvedValue(browser);
    const frames = await openHeroFrames("https://premise.example", "hero-7");
    expect(JSON.stringify(launch.mock.calls)).not.toContain(SECRET);
    expect(page.goto).toHaveBeenCalledWith("https://premise.example/__premise_hero_rehearsal__", {
      waitUntil: "domcontentloaded",
    });
    expect(iframes).toHaveLength(2);
    for (const frame of iframes) expect(frame.setAttribute).toHaveBeenCalledWith("sandbox", "allow-scripts");
    let settled = false;
    const pending = frames.compare().then((result) => {
      settled = true;
      return result;
    });
    binding({ frame: {} }, "main", stats("main", MAIN));
    messageListener({ source: {}, data: stats("plain", PLAIN) });
    await Promise.resolve();
    expect(settled).toBe(false);
    for (const frame of iframes)
      messageListener({
        source: frame.contentWindow,
        data: stats(frame.id as HeroFrame, frame.id === "main" ? MAIN : PLAIN),
      });
    expect((await pending).map((event) => event.frame)).toEqual(["main", "plain"]);
    const selftests = frames.probe(VERSIONS);
    for (const frame of iframes)
      messageListener({
        source: frame.contentWindow,
        data: stats(frame.id as HeroFrame, frame.id === "main" ? MAIN : PLAIN, true),
      });
    await selftests;
    expect(posts).toEqual([
      { message: { type: "probe", selftest: true }, origin: "*" },
      { message: { type: "probe", selftest: true }, origin: "*" },
    ]);
    await frames.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
