/**
 * The Worker's bindings.
 *
 * `Cloudflare.Env` is generated from wrangler.jsonc by `npm run types` (worker-configuration.d.ts).
 * The members below are not in wrangler.jsonc, so wrangler cannot generate them.
 */
export type Env = Cloudflare.Env & {
  /** Secret (SE1). Absent in a deployment that has no key: every mutating route then answers 503. */
  readonly OWNER_KEY?: string;
  /** Optional second hostname for the app server (SE14b). */
  readonly APP_HOST?: string;
};
