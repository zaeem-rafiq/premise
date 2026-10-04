import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Config for the optional workerd check only. See checks/workerd.check.test.ts.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root,
  test: {
    include: ["checks/**/*.check.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
