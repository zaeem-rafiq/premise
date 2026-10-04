import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";

/** Stub (Slice 0). One model gate per deployment: spend cap and kill switch. The agent lane builds this class in Slice 4. */
export class ModelGate extends DurableObject<Env> {
  override fetch(): Response {
    return notBuilt();
  }
}
