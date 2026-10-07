// Unit checks of the receive-pack pusher's operator log (SE5b, hardening): the remote's own
// refusal text reaches `console.warn` only through `redact()`, so a git server that echoes a
// token-shaped string — or anything else — cannot write it into the log.

import { afterEach, describe, expect, it, vi } from "vitest";
import { concatBytes } from "../../../core/sync/bytes.ts";
import { FLUSH_PKT, pktLine } from "../../../core/git/pkt-line.ts";
import { receivePackPusher, refusalLog } from "./pusher.ts";

// A made-up Artifacts-token-shaped string, built in parts so the tree carries no token literal
// (`npm run check:secrets` scans for the `art_v\d+_[0-9a-f]+` pattern itself).
const TOKEN = ["art", "v1", "0123456789abcdef"].join("_");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("L2/SE5b: the refusal log is redacted", () => {
  it("refusalLog redacts the remote's unpack error and per-ref refusal text", () => {
    const log = refusalLog({
      unpackOk: false,
      unpackError: `index-pack died: ${TOKEN}`,
      results: [
        { ref: "refs/heads/main", ok: false, error: `denied: ${TOKEN}` },
        { ref: "refs/notes/premise", ok: true },
      ],
    });
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    expect(log).toEqual({
      unpack: "index-pack died: [redacted]",
      refs: ["ng refs/heads/main denied: [redacted]", "ok refs/notes/premise"],
    });
  });

  it("a refused push logs no token the remote echoed", async () => {
    // One POST to git-receive-pack (atomic: false skips the advertisement read), answered by a
    // report whose refusal text holds the token-shaped string.
    const report = concatBytes([pktLine("unpack ok\n"), pktLine(`ng refs/heads/main refused: ${TOKEN}\n`), FLUSH_PKT]);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(report, { status: 200, headers: { "content-type": "application/x-git-receive-pack-result" } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await receivePackPusher().push({
      remote: "https://artifacts.example/repo",
      token: "madeup_token",
      updates: [{ ref: "refs/heads/main", old: "0".repeat(40), new: "f".repeat(40) }],
      pack: new Uint8Array([1, 2, 3]),
      atomic: false,
      signal: AbortSignal.timeout(5_000),
    });

    expect(result).toEqual({ ok: false, kind: "rejected", refs: { "refs/heads/main": "ng" } });
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("[redacted]");
    expect(logged).toContain("refs/heads/main");
  });
});
