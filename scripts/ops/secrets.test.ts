// BP7 and the pattern families of 01-core SE5a.
//
// Every made-up secret below is put together at run time, so this file holds no text that
// `npm run check:secrets` would find.

import { describe, expect, it } from "vitest";
import { findSecrets, isAllowed, parseAllowList } from "./secrets.ts";

const HEX_40 = "0123456789abcdef0123456789abcdef01234567";
const artifactsToken = ["art", "v1", HEX_40].join("_");
const widerToken = ["art", "v2", "AbCd-EfGh_0123456789"].join("_");
const bearerValue = ["abc123", "def456", "ghi789"].join("");
const password = ["hunter2", "secret"].join("");

function kinds(text: string, environmentValues: string[] = []): string[] {
  return findSecrets(text, environmentValues).map((secret) => secret.kind);
}

describe("findSecrets: the pattern families of SE5a", () => {
  it("finds an Artifacts token", () => {
    const found = findSecrets(`remote said: token ${artifactsToken}?expires=1 leaked`);
    expect(found).toEqual([{ kind: "artifacts_token", match: artifactsToken, index: 19 }]);
  });

  it("finds an Artifacts token whose secret is not hex", () => {
    expect(findSecrets(`token ${widerToken} end`)).toEqual([{ kind: "artifacts_token", match: widerToken, index: 6 }]);
  });

  it("finds the value of an Authorization header, Bearer and Basic", () => {
    const basicValue = Buffer.from(`x:${password}`).toString("base64");
    expect(findSecrets(`Authorization: Bearer ${bearerValue}`).map((secret) => secret.match)).toEqual([bearerValue]);
    expect(findSecrets(`authorization: basic ${basicValue}`).map((secret) => secret.match)).toEqual([basicValue]);
    expect(kinds(`{ "Authorization": "Bearer ${bearerValue}" }`)).toEqual(["authorization_value"]);
    expect(kinds(`headers.Authorization = "Bearer ${bearerValue}";`)).toEqual(["authorization_value"]);
  });

  it("finds credentials inside a URL", () => {
    const found = findSecrets(`git clone https://user:${password}@host.example/repo.git`);
    expect(found.map((secret) => [secret.kind, secret.match])).toEqual([["url_credentials", password]]);
  });

  it("finds the owner key, or any other secret of the shell, as it is", () => {
    const ownerKey = ["k3y", "Zm9v", "YmFy", "cXV4"].join("-");
    expect(kinds(`log line: unlocked with ${ownerKey}`, [ownerKey])).toEqual(["environment_value"]);
    expect(kinds(`twice ${ownerKey} and ${ownerKey}`, [ownerKey])).toEqual(["environment_value", "environment_value"]);
  });

  it("finds a Cloudflare API token that is assigned to its variable (BP7)", () => {
    const apiToken = ["Zx9", "Qw8Er7Ty6", "Ui5Op4As3Df2"].join("_");
    expect(kinds(`CLOUDFLARE_API_TOKEN=${apiToken}`)).toEqual(["cloudflare_api_token"]);
    expect(kinds(`export CF_API_TOKEN="${apiToken}"`)).toEqual(["cloudflare_api_token"]);
  });
});

describe("findSecrets: what is not a finding", () => {
  it("a placeholder in the place of a secret", () => {
    expect(kinds("Mutating routes require `Authorization: Bearer <key>` or the session cookie.")).toEqual([]);
    expect(kinds("headers: { Authorization: `Bearer ${token}` }")).toEqual([]);
    expect(kinds("const remote = `https://x:${token}@${host}/git/${repo}.git`;")).toEqual([]);
    expect(kinds("CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}")).toEqual([]);
  });

  it("the pattern of SE5a written as a pattern", () => {
    expect(kinds("Artifacts tokens `art_v\\d+_[0-9a-f]+` are replaced by `[redacted]`.")).toEqual([]);
  });

  it("a URL without credentials, and a git object id", () => {
    expect(kinds("https://developers.cloudflare.com/workers/ at port http://localhost:8787/api")).toEqual([]);
    expect(kinds(`the example commit has id 6bd48525d87d048e928a6dce65cd7e033fcbd839`)).toEqual([]);
  });

  it("a secret of the shell that is too short to search for", () => {
    expect(kinds("the word test appears in this test", ["test"])).toEqual([]);
  });
});

describe("the allow list", () => {
  const allow = parseAllowList(
    JSON.stringify({ allow: [{ path: "reference/x.test.ts", match: artifactsToken, why: "made up" }] }),
  );
  const [secret] = findSecrets(artifactsToken);

  it("allows one exact value in one exact file", () => {
    expect(secret).toBeDefined();
    expect(isAllowed(allow, "reference/x.test.ts", secret!)).toBe(true);
  });

  it("does not allow the same value in another file, or another value in the same file", () => {
    expect(isAllowed(allow, "src/worker/index.ts", secret!)).toBe(false);
    const [other] = findSecrets(widerToken);
    expect(isAllowed(allow, "reference/x.test.ts", other!)).toBe(false);
  });

  it("never allows a secret of the shell", () => {
    const [fromShell] = findSecrets(`key ${artifactsToken}`, [artifactsToken]).filter(
      (found) => found.kind === "environment_value",
    );
    expect(isAllowed(allow, "reference/x.test.ts", fromShell!)).toBe(false);
  });

  it("refuses an allow list of another shape", () => {
    expect(() => parseAllowList(`{ "allow": [{ "path": "a" }] }`)).toThrow(/every entry needs/);
    expect(() => parseAllowList(`{}`)).toThrow(/must be an array/);
  });
});
