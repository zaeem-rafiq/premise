// One vitest configuration, one project per kind of test (docs/spec/04-build-plan.md 1.4).
// `npm test` runs unit, arch, cases, git, tidepool and languages: all offline. The other two have their own commands.

import { defineConfig } from "vitest/config";

/**
 * Never tests: working material from before the build (BP6), seed files, build output, and the files
 * under `test/arch/fixtures/` that break a rule on purpose.
 */
const NEVER = ["**/node_modules/**", "reference/**", "seeds/**", "dist/**", "test/arch/fixtures/**"];

function project(name: string, include: string[], timeoutMs = 10_000) {
  return {
    test: {
      name,
      include,
      exclude: NEVER,
      environment: "node",
      testTimeout: timeoutMs,
      hookTimeout: timeoutMs,
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      // Next to the source.
      project("unit", ["src/**/*.test.ts", "scripts/**/*.test.ts"]),
      // The boundaries of plan 1.3 and the lanes of plan 3.1.
      project("arch", ["test/arch/**/*.test.ts"], 60_000),
      // docs/spec/premise-cases.json through the engine, on node:sqlite.
      project("cases", ["test/cases/**/*.test.ts"]),
      // Against the git binary and a local `git http-backend` server.
      project("git", ["test/git/**/*.test.ts"], 60_000),
      // The seed pool.
      project("tidepool", ["test/tidepool/**/*.test.ts"]),
      // Python and Go through the real tree-sitter parsers, loaded in Node (06-repos.md LG4).
      project("languages", ["test/languages/**/*.test.ts"]),
      // Local workerd through the Miniflare API, over the built bundle: `npm run test:workerd`.
      project("workerd", ["test/workerd/**/*.test.ts"], 60_000),
      // Against the deployed `test` environment: `npm run test:integration`.
      project("integration", ["test/integration/**/*.test.ts"], 300_000),
    ],
  },
});
