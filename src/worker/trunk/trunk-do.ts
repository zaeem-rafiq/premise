import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";

/** Stub (Slice 0). One Trunk per pool. The trunk lane builds this class from Slice 1, track 1D. */
export class Trunk extends DurableObject<Env> {
  override fetch(): Response {
    return notBuilt();
  }
}
