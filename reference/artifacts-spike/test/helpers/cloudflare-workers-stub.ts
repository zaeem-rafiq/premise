/**
 * Stand-in for the `cloudflare:workers` module so that the Worker entry point
 * (and the bundle wrangler builds) can be imported under Node in tests.
 * Only the base class the harness extends is provided.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
