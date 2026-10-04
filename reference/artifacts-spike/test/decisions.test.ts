/**
 * The rules that turn one push outcome into a verdict about the server (gitops.ts).
 * A failed request must never read as "the server refused".
 */
import { describe, expect, it } from "vitest";
import { confirmDecision, pushDecision, rawDecision, type PushOutcome, type RawPushOutcome } from "../src/gitops";

const REF = "refs/session/log";

function push(partial: Partial<PushOutcome> & { post?: number; get?: number }): PushOutcome {
  const calls: PushOutcome["calls"] = [];
  if (partial.get !== undefined) calls.push({ step: "GET", status: partial.get, method: "GET", requestBytes: 0, responseBytes: 0 });
  if (partial.post !== undefined) calls.push({ step: "POST", status: partial.post, method: "POST", requestBytes: 0, responseBytes: 0 });
  return { ok: false, ms: 1, posted: partial.post !== undefined, statuses: calls.map((c) => c.status), calls, serverMessages: [], ...partial };
}

function raw(status: number, refs?: { ref: string; ok: boolean; message?: string }[]): RawPushOutcome {
  return { status, ms: 1, requestBytes: 0, packBytes: 0, bodyPreview: "", report: refs ? { sideband: false, unpack: "ok", unpackOk: true, refs, progress: "", errors: "" } : undefined };
}

describe("pushDecision (isomorphic-git push)", () => {
  it("is true for an accepted push", () => {
    expect(pushDecision(push({ ok: true, get: 200, post: 200, refs: { [REF]: { ok: true } } }), REF)).toBe(true);
  });

  it("is false when the server answered 'ng' for the ref, or answered the POST with a 4xx", () => {
    expect(pushDecision(push({ get: 200, post: 200, refs: { [REF]: { ok: false, error: "hook declined" } } }), REF)).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(pushDecision(push({ get: 200, post: status }), REF), String(status)).toBe(false);
  });

  it("is 'inconclusive' when the POST got no decision: no answer, a server error, a rate limit, a timeout", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(pushDecision(push({ get: 200, post: status }), REF), String(status)).toMatch(/^inconclusive \(the receive-pack POST got (no HTTP answer|HTTP \d+), which is not a decision about the ref\)$/);
    }
  });

  it("is 'inconclusive' when no POST was sent, whatever the GET said", () => {
    for (const status of [0, 403, 503]) expect(pushDecision(push({ get: status, errorText: "HttpError" }), REF), String(status)).toMatch(/^inconclusive \(no receive-pack POST was sent: HttpError\)$/);
  });

  it("is 'inconclusive' for HTTP 200 without a line for the ref", () => {
    expect(pushDecision(push({ get: 200, post: 200, refs: {} }), REF)).toMatch(/^inconclusive \(HTTP 200, but no report-status line for refs\/session\/log/);
  });
});

describe("rawDecision (hand-built push)", () => {
  it("follows the report-status line of the ref on HTTP 200", () => {
    expect(rawDecision(raw(200, [{ ref: REF, ok: true }]), REF)).toBe(true);
    expect(rawDecision(raw(200, [{ ref: REF, ok: false, message: "failed to update ref" }]), REF)).toBe(false);
    expect(rawDecision(raw(200, [{ ref: "refs/heads/other", ok: true }]), REF)).toMatch(/^inconclusive \(no decision about refs\/session\/log/);
    expect(rawDecision(raw(200), REF)).toMatch(/^inconclusive/);
  });

  it("counts an HTTP 4xx as the server's refusal, and nothing else", () => {
    for (const status of [400, 403, 409]) expect(rawDecision(raw(status), REF), String(status)).toBe(false);
    for (const status of [0, 408, 429, 500, 503]) expect(rawDecision(raw(status), REF), String(status)).toMatch(/^inconclusive \(no decision about refs\/session\/log: no report-status \(HTTP \d+\)/);
  });
});

describe("confirmDecision (answer plus refs read back)", () => {
  it("accepts a change the refs show, whatever the answer was", () => {
    expect(confirmDecision(true, true)).toBe(true);
    expect(confirmDecision(false, true)).toBe(true);
    expect(confirmDecision("inconclusive (the receive-pack POST got HTTP 503, which is not a decision about the ref)", true)).toBe(true);
  });

  it("reports a refusal only when the refs confirm that nothing changed", () => {
    expect(confirmDecision(false, false)).toBe(false);
    expect(confirmDecision(false, null)).toBe("inconclusive (the server refused the request, but the refs could not be read back)");
  });

  it("never turns a missing decision or a disagreement into true or false", () => {
    expect(confirmDecision("inconclusive (x)", false)).toBe("inconclusive (x)");
    expect(confirmDecision("inconclusive (x)", null)).toBe("inconclusive (x)");
    expect(confirmDecision(true, false)).toBe("inconclusive (the server reported success, but the refs read back do not show the change)");
    expect(confirmDecision(true, null)).toBe("inconclusive (the server reported success, but the refs could not be read back)");
  });
});
