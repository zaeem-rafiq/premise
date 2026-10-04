/**
 * Fail-closed request authentication. Pure module: no Cloudflare imports.
 *
 * Every route needs the header "x-spike-key" to equal the SPIKE_KEY secret.
 * When the secret is missing or too short, every request is refused.
 */

export const KEY_HEADER = "x-spike-key";
/** Shorter secrets are treated as "not configured". `openssl rand -hex 32` gives 64 characters. */
export const MIN_KEY_LENGTH = 16;

export type AuthDecision = { allowed: true } | { allowed: false; status: 401 | 503; error: string };

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compare two strings without leaking where they differ: hash both, then compare every byte. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.byteLength; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export async function checkSpikeKey(provided: string | null, secret: unknown): Promise<AuthDecision> {
  if (typeof secret !== "string" || secret.length < MIN_KEY_LENGTH) {
    return {
      allowed: false,
      status: 503,
      error: `SPIKE_KEY secret is not set (or is shorter than ${MIN_KEY_LENGTH} characters); every request is refused`,
    };
  }
  if (provided === null || provided.length === 0 || !(await constantTimeEqual(provided, secret))) {
    return { allowed: false, status: 401, error: `missing or wrong ${KEY_HEADER} header` };
  }
  return { allowed: true };
}
