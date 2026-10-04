// The host bundle as a data value: builds `src/host/` with the same vite config the release build
// uses, into a scratch dir, and returns the emitted file name and text. `host-bundle.test.ts` checks
// that the committed `src/worker/app-server/host-bundle.ts` still matches this build, so the bundle
// the app server serves is always the bundle `npm run build:host` emits.

import { build as viteBuild } from "vite";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const HOST_BUILD_BYTES = 16; // hex chars of the bundle's sha-256 that name `<build>`

export async function buildHostBundle(root: string): Promise<{ file: string; source: string; build: string }> {
  const outDir = join(root, ".tmp-test", "host-bundle");
  await viteBuild({
    configFile: join(root, "vite.host.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
  const names = (await fs.readdir(outDir)).filter((name) => /^~host\.[^/]+\.js$/.test(name));
  if (names.length !== 1) throw new Error(`expected one ~host bundle, found ${names.length}`);
  const source = await fs.readFile(join(outDir, names[0]!), "utf8");
  const build = createHash("sha256").update(source).digest("hex").slice(0, HOST_BUILD_BYTES);
  return { file: names[0]!, source, build };
}
