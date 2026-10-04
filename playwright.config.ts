// Browser checks (docs/spec/04-build-plan.md 1.4 and 1.5).
//
//   npm run test:e2e                         the `fixture` project: Chromium against the built Floor and
//                                            fixture streams, with no Worker running
//   npm run test:e2e -- --project=deployed   the `deployed` project: against the address in PREMISE_URL
//
// The `deployed` project exists only when the command line asks for it, so a plain run never reaches a
// deployment.

import { defineConfig, devices } from "@playwright/test";

// One fixed port by default. `PREMISE_E2E_PORT` moves it, so that two checkouts on one machine can
// run their fixture projects at the same time without one reusing the other's server.
const FIXTURE_PORT = Number(process.env.PREMISE_E2E_PORT ?? 4173);
const PROJECTS_VARIABLE = "PREMISE_E2E_PROJECTS";

/** The project names that follow `--project` on a command line. */
function projectsOnCommandLine(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument.startsWith("--project=")) {
      names.push(argument.slice("--project=".length));
    } else if (argument === "--project") {
      while (index + 1 < argv.length && !(argv[index + 1] ?? "").startsWith("-")) {
        index += 1;
        names.push(argv[index] ?? "");
      }
    }
  }
  return names;
}

// Only the main process sees the command line. Its workers load this file again and inherit the environment.
const fromCommandLine = projectsOnCommandLine(process.argv);
if (fromCommandLine.length > 0) {
  process.env[PROJECTS_VARIABLE] = fromCommandLine.join(",");
}
const requested = (process.env[PROJECTS_VARIABLE] ?? "").split(",").filter((name) => name !== "");
const runsFixture = requested.length === 0 || requested.includes("fixture");
const runsDeployed = requested.includes("deployed");

if (runsDeployed && process.env.PREMISE_URL === undefined) {
  throw new Error("The `deployed` project needs the address of a deployment in PREMISE_URL.");
}

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  projects: [
    {
      name: "fixture",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${FIXTURE_PORT}` },
    },
    ...(runsDeployed
      ? [{ name: "deployed", use: { ...devices["Desktop Chrome"], baseURL: process.env.PREMISE_URL } }]
      : []),
  ],
  // The built Floor (`npm run build:floor` first), served as static files.
  webServer: runsFixture
    ? {
        command: `npx vite preview --port ${FIXTURE_PORT} --strictPort`,
        url: `http://localhost:${FIXTURE_PORT}`,
        reuseExistingServer: true,
      }
    : undefined,
});
