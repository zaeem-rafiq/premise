import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";

/** Stub (Slice 0). One Floor per pool: the event stream. The stream lane builds this class from Slice 1, track 1E. */
export class Floor extends DurableObject<Env> {
  override fetch(): Response {
    return notBuilt();
  }
}
