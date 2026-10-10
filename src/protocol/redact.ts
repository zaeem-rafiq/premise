// `redact()`: the one function that removes secrets from any text that could reach a log, a report, a
// recording or a chat message (SE5a). The exporter tests every line of a Replay file against these
// patterns before it exports (RP1).

/** The token patterns of SE5a, one per family. `ownerKey` is matched literally. */
const ARTIFACTS_TOKEN = /art_v\d+_[0-9a-f]+/g;
/** An MCP token (07-mcp MC6, MC8): `pmcp1_<base64url body>.<64 hex signature>`. */
const MCP_TOKEN = /pmcp1_[A-Za-z0-9_-]+\.[0-9a-f]{64}/g;
const AUTHORIZATION_VALUE = /(Authorization)(\s*:\s*)[^\r\n]*/gi;
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@"']+(?::[^\s/@"']*)?@/g;

export const REDACTED = "[redacted]";

/**
 * Replaces every match of the token patterns by `[redacted]`: Artifacts tokens (`art_v\d+_[0-9a-f]+`),
 * MCP tokens (07-mcp MC8), every `secrets` entry verbatim (the OWNER_KEY value is passed this way), any Authorization header
 * value, and credentials inside a URL.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(ARTIFACTS_TOKEN, REDACTED);
  out = out.replace(MCP_TOKEN, REDACTED);
  out = out.replace(AUTHORIZATION_VALUE, `$1$2${REDACTED}`);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const secret of secrets) {
    if (secret !== "") out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** The check the Replay exporter runs on every line (RP1): the family the line matches, or null. */
export function redactMatch(text: string, secrets: readonly string[] = []): string | null {
  if (new RegExp(ARTIFACTS_TOKEN.source).test(text)) return "artifacts_token";
  if (new RegExp(MCP_TOKEN.source).test(text)) return "mcp_token";
  if (new RegExp(AUTHORIZATION_VALUE.source, "i").test(text)) return "authorization";
  if (new RegExp(URL_CREDENTIALS.source).test(text)) return "url_credentials";
  for (const secret of secrets) {
    if (secret !== "" && text.includes(secret)) return "secret";
  }
  return null;
}
