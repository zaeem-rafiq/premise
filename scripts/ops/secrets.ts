// BP7: secrets never enter the repository. This file finds text that looks like one.
//
// The pattern families are those of `redact()` (01-core SE5a): Artifacts tokens, the value of an
// Authorization header, credentials inside a URL, and the OWNER_KEY value. BP7 adds Cloudflare API tokens.
//
// Slice 0b: when `src/protocol/redact.ts` exists, take the token patterns from it, so that there is one list.

export type SecretKind =
  "artifacts_token" | "authorization_value" | "url_credentials" | "cloudflare_api_token" | "environment_value";

/** One match. `match` is the secret text itself: compare it, never print it. */
export type Secret = { kind: SecretKind; match: string; index: number };

// Characters that cannot be part of a real credential in source text: quotes, spaces, and the `$`, `{`, `<`
// of a placeholder such as `${token}` or `<key>`.
const PATTERNS: ReadonlyArray<{ kind: SecretKind; pattern: RegExp; group: number }> = [
  // SE5a names the hex form. The platform record's harness also saw a token with a wider alphabet, so the
  // scan matches both.
  { kind: "artifacts_token", pattern: /art_v\d+_[A-Za-z0-9+/=_-]+/g, group: 0 },
  {
    kind: "authorization_value",
    pattern: /\bauthorization["']?\s*[:=]\s*["'`]?\s*(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 1,
  },
  { kind: "url_credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>${}]+:([^\s/@"'`<>${}]+)@/gi, group: 1 },
  {
    kind: "cloudflare_api_token",
    pattern: /\b(?:CLOUDFLARE|CF)_API_(?:TOKEN|KEY)["']?\s*[:=]\s*["'`]?([A-Za-z0-9_-]{20,})/g,
    group: 1,
  },
];

/** A secret from the environment shorter than this is not searched for: it would match by accident. */
export const MIN_ENVIRONMENT_VALUE_LENGTH = 8;

/**
 * Every match in `text`. `environmentValues` are the values of secrets known to this shell (the owner
 * key, a Cloudflare token): each is searched for as it is.
 */
export function findSecrets(text: string, environmentValues: readonly string[] = []): Secret[] {
  const found: Secret[] = [];
  for (const { kind, pattern, group } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[group];
      if (value !== undefined) found.push({ kind, match: value, index: match.index + match[0].lastIndexOf(value) });
    }
  }
  for (const value of environmentValues) {
    if (value.length < MIN_ENVIRONMENT_VALUE_LENGTH) continue;
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
      found.push({ kind: "environment_value", match: value, index: at });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** A value that is known to be made up, and where it may appear. */
export type AllowEntry = { path: string; match: string; why: string };

/** Reads and checks the allow list. Throws on anything that is not the expected shape. */
export function parseAllowList(json: string): AllowEntry[] {
  const data = JSON.parse(json) as { allow?: unknown };
  if (!Array.isArray(data.allow)) {
    throw new Error("secrets-allow.json: `allow` must be an array.");
  }
  return data.allow.map((entry: Partial<AllowEntry>) => {
    if (typeof entry.path !== "string" || typeof entry.match !== "string" || typeof entry.why !== "string") {
      throw new Error("secrets-allow.json: every entry needs `path`, `match` and `why`.");
    }
    return { path: entry.path, match: entry.match, why: entry.why };
  });
}

/** True when the allow list names exactly this value for exactly this file. A secret from the environment is never allowed. */
export function isAllowed(allow: readonly AllowEntry[], path: string, secret: Secret): boolean {
  if (secret.kind === "environment_value") return false;
  return allow.some((entry) => entry.path === path && entry.match === secret.match);
}
