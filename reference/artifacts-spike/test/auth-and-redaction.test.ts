/**
 * Fail-closed auth and token redaction: the two things that keep a public
 * workers.dev URL and its JSON output safe.
 */
import { describe, expect, it } from "vitest";
import { MIN_KEY_LENGTH, checkSpikeKey } from "../src/auth";
import { authHeader } from "../src/gitops";
import { MemoryFS } from "../src/memory-fs";
import { Recorder, describeToken, errText, isInProgress, redactText, summarize, tokenSecret } from "../src/recorder";

const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=1760000000";

describe("checkSpikeKey", () => {
  it("allows only the exact key", async () => {
    expect(await checkSpikeKey(SECRET, SECRET)).toEqual({ allowed: true });
  });

  it("answers 401 for a missing, empty or wrong header", async () => {
    for (const provided of [null, "", "wrong", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      const decision = await checkSpikeKey(provided, SECRET);
      expect(decision, String(provided)).toMatchObject({ allowed: false, status: 401 });
    }
  });

  it("fails closed with 503 when the secret is unset, not a string, or too short - even if the header matches", async () => {
    for (const secret of [undefined, null, "", 12345, {}, "short", "x".repeat(MIN_KEY_LENGTH - 1)]) {
      const provided = typeof secret === "string" ? secret : "anything";
      const decision = await checkSpikeKey(provided, secret);
      expect(decision, String(secret)).toMatchObject({ allowed: false, status: 503 });
    }
    // An empty header must not match an empty secret.
    expect(await checkSpikeKey("", "")).toMatchObject({ allowed: false, status: 503 });
    expect(await checkSpikeKey(null, undefined)).toMatchObject({ allowed: false, status: 503 });
  });
});

describe("auth header for Artifacts tokens (documented rules)", () => {
  it("bearer sends the full token, expiry suffix included", () => {
    expect(authHeader(TOKEN, "bearer")).toBe(`Bearer ${TOKEN}`);
  });

  it("basic sends the token without the ?expires suffix as the password", () => {
    const header = authHeader(TOKEN, "basic");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe("x:art_v1_0123456789abcdef0123456789abcdef01234567");
    expect(tokenSecret(TOKEN)).toBe("art_v1_0123456789abcdef0123456789abcdef01234567");
    expect(tokenSecret("opaque-token-without-suffix")).toBe("opaque-token-without-suffix");
  });
});

describe("redaction", () => {
  it("removes every form of a registered token from the finished result", () => {
    const rec = new Recorder("t");
    rec.addSecret(TOKEN);
    rec.note(`full ${TOKEN}`);
    rec.note(`secret ${tokenSecret(TOKEN)}`);
    rec.note(`header ${authHeader(TOKEN, "basic")} and ${authHeader(TOKEN, "bearer")}`);
    rec.note(`url https://x:${tokenSecret(TOKEN)}@abc.artifacts.cloudflare.net/git/spike/r.git`);
    rec.data.nested = { deep: [TOKEN] };
    const result = rec.finish(false, `error mentioning ${TOKEN}`);
    const text = JSON.stringify(result);
    expect(text).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(text).not.toContain(Buffer.from(`x:${tokenSecret(TOKEN)}`).toString("base64"));
    expect(text).toContain("<redacted-token>");
    expect(result.error).toBe("error mentioning <redacted-token>");
  });

  it("redacts unregistered tokens, opaque registered tokens and authorization values by pattern", () => {
    expect(redactText("got art_v2_ZZZZ9999aaaa0000?expires=5 back")).toBe("got art_v2_<redacted> back");
    expect(redactText("Authorization: Bearer abc123def456ghi789")).toBe("Authorization: Bearer <redacted>");
    expect(redactText("Authorization: Basic eDphcnRfdjFfMDEyMzQ1Njc4OQ==")).toBe("Authorization: Basic <redacted>");
    expect(redactText("clone https://user:hunter2secret@host.example/repo.git")).toBe("clone https://<redacted>@host.example/repo.git");
    expect(redactText("token is opaque-secret-value-1", ["opaque-secret-value-1"])).toBe("token is <redacted-token>");
  });

  it("redacts an unregistered token whose secret is not hex (base64url, dashes, underscores)", () => {
    // An art_v2 token has been seen in the wild; its alphabet is not documented.
    expect(redactText("art_v2_AbCdEfGh-IjKl_MnOpQrStUv0123456789?expires=1791072745")).toBe("art_v2_<redacted>");
    expect(redactText("token art_v2_abc-def_0123456789abcdef0123456789 end")).toBe("token art_v2_<redacted> end");
    expect(redactText("b64 art_v3_QUJD+REVG/R0hJ== end")).toBe("b64 art_v3_<redacted> end");
    // Inside serialised JSON the match stops at the closing quote.
    expect(JSON.parse(redactText(JSON.stringify({ a: "art_v2_abc-def_0123456789", b: "kept" })))).toEqual({ a: "art_v2_<redacted>", b: "kept" });
  });

  it("masks the account label of an Artifacts remote, and nothing else in the URL", () => {
    expect(redactText("remote=https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/spike/spike-e1-abc.git")).toBe(
      "remote=https://<account>.artifacts.cloudflare.net/git/spike/spike-e1-abc.git",
    );
    const rec = new Recorder("t");
    rec.data.repo = { remote: "https://acct-label.artifacts.cloudflare.net/git/spike/r.git" };
    expect((rec.finish(true).data!.repo as { remote: string }).remote).toBe("https://<account>.artifacts.cloudflare.net/git/spike/r.git");
  });

  it("disclose() is the only way a token leaves a result, and only under `disclosed`", () => {
    const rec = new Recorder("t");
    rec.addSecret(TOKEN);
    rec.note(`minted ${TOKEN}`);
    rec.data.copy = TOKEN;
    rec.disclose({ token: TOKEN, remote: "https://acct-label.artifacts.cloudflare.net/git/spike/r.git" });
    const result = rec.finish(true);
    expect(result.disclosed).toEqual({ token: TOKEN, remote: "https://acct-label.artifacts.cloudflare.net/git/spike/r.git" });
    const { disclosed: _disclosed, ...rest } = result;
    expect(JSON.stringify(rest)).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(new Recorder("t").finish(true)).not.toHaveProperty("disclosed");
  });

  it("leaves ordinary text alone", () => {
    const plain = "push with basic auth to http://127.0.0.1:8080/git/spike/x.git returned HTTP 403; Basic realm; bearer style";
    expect(redactText(plain)).toBe(plain);
  });

  it("describes a token without revealing it", () => {
    expect(describeToken(TOKEN)).toBe("prefix art_v1_, secret length 40 (hex), expires=1760000000");
    expect(describeToken("weird")).toBe("unrecognised format, length 5");
    expect(describeToken(undefined)).toBe("not a string (undefined)");
  });
});

describe("recorder helpers", () => {
  it("summarize uses nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(summarize(values)).toEqual({ n: 100, min: 1, p50: 50, p95: 95, max: 100, mean: 50.5 });
    expect(summarize([7])).toEqual({ n: 1, min: 7, p50: 7, p95: 7, max: 7, mean: 7 });
    expect(summarize([])).toBeNull();
  });

  it("recognises the in-progress error codes by code, number or message", () => {
    for (const code of ["CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]) {
      expect(isInProgress(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    expect(isInProgress(Object.assign(new Error("x"), { numericCode: 10303 }))).toBe(true);
    // RPC can drop custom properties, leaving only the message.
    expect(isInProgress(new Error("FORK_IN_PROGRESS: The repository is still being forked"))).toBe(true);
    expect(isInProgress(Object.assign(new Error("nope"), { code: "NOT_FOUND" }))).toBe(false);
    expect(errText(Object.assign(new Error("busy"), { name: "ArtifactsError", code: "FORK_IN_PROGRESS", numericCode: 10303 }))).toBe(
      "ArtifactsError[code=FORK_IN_PROGRESS numericCode=10303]: busy",
    );
  });

  it("time() records the duration even when the step throws", async () => {
    const rec = new Recorder("t");
    await expect(rec.time("boom_ms", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(typeof rec.timings.boom_ms).toBe("number");
    rec.timing("x", 1);
    rec.timing("x", 2);
    rec.timing("x", 3);
    expect(rec.timings.x).toEqual([1, 2, 3]);
  });
});

describe("MemoryFS error codes (isomorphic-git branches on err.code)", () => {
  it("uses Node-style codes", async () => {
    const fs = new MemoryFS();
    await expect(fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.writeFile("/no/parent.txt", "x")).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("/dir");
    await expect(fs.mkdir("/dir")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.mkdir("/a/b/c")).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("/a/b/c", { recursive: true });
    await fs.writeFile("/a/b/c/file.txt", "hello");
    await expect(fs.readdir("/a/b/c/file.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(fs.rmdir("/a")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await expect(fs.unlink("/a")).rejects.toMatchObject({ code: "EISDIR" });
    expect(await fs.readFile("/a/b/c/file.txt", "utf8")).toBe("hello");
    expect(await fs.readdir("/a/b")).toEqual(["c"]);
    expect((await fs.stat("/a/b/c/file.txt")).size).toBe(5);
    await fs.rm("/a", { recursive: true });
    await expect(fs.stat("/a")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.fileCount()).toBe(0);
  });

  it("does not share bytes with the caller's buffer", async () => {
    const fs = new MemoryFS();
    const data = new Uint8Array([1, 2, 3]);
    await fs.writeFile("/f", data);
    data[0] = 9;
    expect(Array.from((await fs.readFile("/f")) as Uint8Array)).toEqual([1, 2, 3]);
  });
});
