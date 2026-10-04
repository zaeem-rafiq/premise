// The committed host bundle is the app server's answer to `/pool/~host.<build>.js` (4.2, 4.5). This
// test proves `host-bundle.ts` is the text `vite build` of `src/host/` emits — same bytes, same
// content-derived build id — so the bundle served can never drift from the source it names.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildHostBundle, HOST_BUILD_BYTES } from "./bundle.ts";
import { HOST_BUILD, HOST_SOURCE } from "../../../src/worker/app-server/host-bundle.ts";

const ROOT = join(fileURLToPath(import.meta.url), "../../../..");

describe("the committed host bundle (4.2)", () => {
  it("equals a fresh vite build of src/host/, byte for byte, with the same build id", async () => {
    const built = await buildHostBundle(ROOT);
    expect(HOST_SOURCE).toBe(built.source);
    expect(HOST_BUILD).toBe(built.build);
    expect(HOST_BUILD).toBe(createHash("sha256").update(HOST_SOURCE).digest("hex").slice(0, HOST_BUILD_BYTES));
    expect(HOST_SOURCE).toContain("startHost"); // sanity: the bundle carries the entry point
  });
});
