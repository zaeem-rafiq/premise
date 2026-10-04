// Removes the build output (`dist/`), so that a build never ships a file of an earlier build.

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
