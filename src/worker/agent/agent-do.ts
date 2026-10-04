import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";

/** Stub (Slice 0). One Agent per attempt. The agent lane builds this class from Slice 1, track 1H. */
export class Agent extends DurableObject<Env> {
  override fetch(): Response {
    return notBuilt();
  }
}
