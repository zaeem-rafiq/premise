// Unit checks of the session cookie (SE2), the SE3 origin rule and the sliding windows (SE2a, SE21)
// — the workerd tests then prove the same rules end to end over HTTP.

import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import { bearerAuths, timingSafeEqual } from "./owner.ts";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  credentialKind,
  mintSessionCookie,
  originOkFor,
  sessionCookieAuths,
} from "./session.ts";
import { SlidingWindow } from "./rate-limit.ts";
import { SESSION_TTL_S, UNLOCK_FAILS_PER_MIN } from "../../protocol/constants.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const env = { OWNER_KEY: KEY } as Env;
const noKey = {} as Env;

function cookieRequest(value: string, origin?: string): Request {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${value}` });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request("https://premise.test/api/session", { headers });
}

function cookieOf(setCookie: string): string {
  return setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
}

describe("SE2: the premise_owner session cookie", () => {
  it("mints an HttpOnly, Secure, SameSite=Strict cookie with the SESSION_TTL_S lifetime", () => {
    const setCookie = mintSessionCookie(env, 1_000_000);
    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_S}`]) {
      expect(setCookie).toContain(flag);
    }
  });

  it("verifies a cookie it minted, and rejects a tampered, expired, foreign or malformed one", () => {
    const now = 1_000_000_000;
    const value = cookieOf(mintSessionCookie(env, now));
    expect(sessionCookieAuths(cookieRequest(value), env, now + 1_000)).toBe(true);

    const [version, expiry, signature] = value.split(".");
    expect(sessionCookieAuths(cookieRequest(`${version}.${expiry}.${signature?.slice(1)}0`), env, now)).toBe(false);
    expect(sessionCookieAuths(cookieRequest(`${version}.${expiry}`), env, now)).toBe(false);
    expect(sessionCookieAuths(cookieRequest("v9.1.abc"), env, now)).toBe(false);
    expect(sessionCookieAuths(cookieRequest("not-a-cookie"), env, now)).toBe(false);
    expect(sessionCookieAuths(cookieRequest(value), env, now + SESSION_TTL_S * 1000 + 1)).toBe(false);
    // A cookie minted under a different OWNER_KEY does not verify (SE2: HMAC-signed).
    expect(sessionCookieAuths(cookieRequest(value), { OWNER_KEY: "other" } as Env, now)).toBe(false);
    // And no cookie verifies in a deployment with no key at all (SE1).
    expect(sessionCookieAuths(cookieRequest(value), noKey, now)).toBe(false);
  });

  it("credentialKind reports bearer, then cookie, then none", () => {
    const cookie = cookieOf(mintSessionCookie(env));
    expect(
      credentialKind(new Request("https://premise.test/", { headers: { authorization: `Bearer ${KEY}` } }), env),
    ).toBe("bearer");
    expect(credentialKind(cookieRequest(cookie), env)).toBe("cookie");
    expect(credentialKind(new Request("https://premise.test/"), env)).toBe("none");
    // Bearer wins when both are sent — SE3's origin rule then does not apply.
    const both = cookieRequest(cookie);
    both.headers.set("authorization", `Bearer ${KEY}`);
    expect(credentialKind(both, env)).toBe("bearer");
  });

  it("SE3: a cookie credential needs an Origin equal to the request origin; a Bearer needs none", () => {
    expect(originOkFor(cookieRequest("x", "https://premise.test"), "cookie")).toBe(true);
    expect(originOkFor(cookieRequest("x"), "cookie")).toBe(false);
    expect(originOkFor(cookieRequest("x", "https://attacker.example"), "cookie")).toBe(false);
    expect(originOkFor(cookieRequest("x", "premise.test"), "cookie")).toBe(false);
    expect(originOkFor(new Request("https://premise.test/"), "bearer")).toBe(true);
    expect(originOkFor(new Request("https://premise.test/"), "none")).toBe(true);
  });

  it("timingSafeEqual compares only equal-length keys", () => {
    expect(timingSafeEqual(KEY, KEY)).toBe(true);
    expect(timingSafeEqual(KEY, `${KEY}x`)).toBe(false);
    expect(timingSafeEqual(KEY, `${KEY.slice(0, -1)}x`)).toBe(false);
    expect(bearerAuths(new Request("https://x", { headers: { authorization: `Bearer ${KEY}` } }), env)).toBe(true);
    expect(bearerAuths(new Request("https://x", { headers: { authorization: `bearer ${KEY}` } }), env)).toBe(false);
  });
});

describe("SE2a/SE21: the sliding minute window", () => {
  it("limits at the spec's count inside the minute and frees the key as the window slides", () => {
    const window = new SlidingWindow();
    const t0 = 10_000_000;
    for (let i = 0; i < UNLOCK_FAILS_PER_MIN; i += 1) window.record("a", t0 + i);
    expect(window.limited("a", UNLOCK_FAILS_PER_MIN, t0 + UNLOCK_FAILS_PER_MIN)).toBe(true);
    // A different address is not limited by the first one's failures.
    expect(window.limited("b", UNLOCK_FAILS_PER_MIN, t0 + UNLOCK_FAILS_PER_MIN)).toBe(false);
    // At the minute's edge the failures still count; past it the whole burst has slid out.
    expect(window.limited("a", UNLOCK_FAILS_PER_MIN, t0 + 59_999)).toBe(true);
    expect(window.limited("a", UNLOCK_FAILS_PER_MIN, t0 + 61_000)).toBe(false);
    expect(window.count("a", t0 + 61_000)).toBe(0);
  });

  it("a success never resets the count (SE2a): the window holds failures only", () => {
    const window = new SlidingWindow();
    const t0 = 20_000_000;
    for (let i = 0; i < UNLOCK_FAILS_PER_MIN; i += 1) window.record("a", t0);
    expect(window.limited("a", UNLOCK_FAILS_PER_MIN, t0)).toBe(true);
    // Nothing in the model removes failures — the next record inside the minute is the eleventh.
    window.record("a", t0 + 1);
    expect(window.count("a", t0 + 1)).toBe(UNLOCK_FAILS_PER_MIN + 1);
  });
});
