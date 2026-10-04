// Acceptance item 4 (04-build-plan 2.1): `redact()` has one test per pattern family of SE5a —
// Artifacts tokens, the OWNER_KEY value, Authorization header values, and credentials inside a URL.

import { describe, expect, it } from "vitest";
import { redact, redactMatch, REDACTED } from "./redact.ts";

describe("redact() (SE5a)", () => {
  it("removes an Artifacts token (`art_v\\d+_[0-9a-f]+`)", () => {
    const secret = "art_v1_0123456789abcdef0123456789abcdef";
    expect(redact(`push failed for ${secret} after 2 tries`)).toBe(`push failed for ${REDACTED} after 2 tries`);
    expect(redactMatch(secret)).toBe("artifacts_token");
  });

  it("removes the OWNER_KEY value wherever it stands", () => {
    const ownerKey = "dGVzdC1vd25lci1rZXktbm90LWEtcmVhbC1zZWNyZXQ";
    expect(redact(`the key ${ownerKey} was sent`, [ownerKey])).toBe(`the key ${REDACTED} was sent`);
    expect(redact(`prefix${ownerKey}suffix`, [ownerKey])).toBe(`prefix${REDACTED}suffix`);
    expect(redactMatch(`key=${ownerKey}`, [ownerKey])).toBe("secret");
  });

  it("removes an Authorization header value, keeping the header name", () => {
    expect(redact("Authorization: Bearer abc123xyz")).toBe(`Authorization: ${REDACTED}`);
    expect(redact("authorization:basic q==")).toBe(`authorization:${REDACTED}`);
    expect(redactMatch("Authorization: Bearer abc")).toBe("authorization");
  });

  it("removes credentials inside a URL, keeping scheme and host", () => {
    expect(redact("https://user:pass@example.com/repo.git")).toBe(`https://${REDACTED}@example.com/repo.git`);
    expect(redactMatch("https://token@example.com/x")).toBe("url_credentials");
  });

  it("leaves ordinary text and paths alone", () => {
    expect(redact("world/energy.js: no match for ENERGY_MAX")).toBe("world/energy.js: no match for ENERGY_MAX");
    expect(redactMatch("a plain error message")).toBeNull();
  });

  it("removes every occurrence, not only the first", () => {
    const token = "art_v2_abcdef0123456789";
    expect(redact(`${token} and ${token}`)).toBe(`${REDACTED} and ${REDACTED}`);
  });
});
