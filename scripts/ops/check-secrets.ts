// npm run check:secrets
//
// BP7: scans the work tree and the full history for text that looks like a secret (scripts/ops/secrets.ts).
// Exit 0: nothing found. Exit 1: at least one finding. Exit 2: the check could not run.
//
// The work tree is every file that git tracks or would track (ignored files such as .dev.vars are left
// out: they are where a local secret belongs). The history is every line that any commit of any ref added,
// and every commit message. A finding names the place and the kind. It never prints the value.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findSecrets, isAllowed, parseAllowList } from "./secrets.ts";
import type { AllowEntry } from "./secrets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

/** Environment variables whose values are secrets (BP7). A value that is set is searched for as it is. */
const SECRET_VARIABLES = ["OWNER_KEY", "PREMISE_OWNER_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"];

/** A NUL byte in the first bytes marks a binary file. */
const BINARY_SNIFF_BYTES = 8000;

/** The allow list names the made-up values, so it holds them. It is the one file that is not scanned. */
const ALLOW_FILE = "scripts/ops/secrets-allow.json";

type Finding = { where: string; kind: string; length: number };

function environmentValues(): string[] {
  return SECRET_VARIABLES.map((name) => process.env[name]).filter((value): value is string => value !== undefined);
}

function scan(text: string, path: string, where: (line: number) => string, allow: readonly AllowEntry[]): Finding[] {
  const findings: Finding[] = [];
  if (path === ALLOW_FILE) return findings;
  for (const secret of findSecrets(text, environmentValues())) {
    if (isAllowed(allow, path, secret)) continue;
    const line = text.slice(0, secret.index).split("\n").length;
    findings.push({ where: where(line), kind: secret.kind, length: secret.match.length });
  }
  return findings;
}

function workTreeFindings(allow: readonly AllowEntry[]): { files: number; findings: Finding[] } {
  const listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = listing.split("\0").filter((path) => path !== "");
  const findings: Finding[] = [];
  let files = 0;
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(repoRoot, path));
    } catch (error) {
      // Listed by git and gone from the work tree: a deleted file that is not committed yet.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    files += 1;
    findings.push(...scan(bytes.toString("utf8"), path, (line) => `${path}:${line}`, allow));
  }
  return { files, findings };
}

/** Reads `git log -p` line by line: every added line and every commit message line of every ref. */
async function historyFindings(allow: readonly AllowEntry[]): Promise<{ commits: number; findings: Finding[] }> {
  const COMMIT = "premise-check-secrets-commit ";
  const git = spawn(
    "git",
    [
      "log",
      "--all",
      "-p",
      "-U0",
      "--diff-merges=separate",
      "--no-color",
      "--no-textconv",
      "--no-ext-diff",
      `--format=${COMMIT}%H%n%B`,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] },
  );
  const exit = new Promise<number>((resolve, reject) => {
    git.on("error", reject);
    git.on("close", (code) => resolve(code ?? 1));
  });

  const findings: Finding[] = [];
  let commits = 0;
  let commit = "";
  let path = "";
  let inDiff = false;
  for await (const line of createInterface({ input: git.stdout, crlfDelay: Infinity })) {
    if (line.startsWith(COMMIT)) {
      commit = line.slice(COMMIT.length, COMMIT.length + 12);
      commits += 1;
      inDiff = false;
      path = "";
    } else if (line.startsWith("diff --git ")) {
      inDiff = true;
    } else if (!inDiff) {
      findings.push(...scan(line, "", () => `commit ${commit}, message`, allow));
    } else if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : "";
    } else if (line.startsWith("+")) {
      const file = path;
      findings.push(...scan(line.slice(1), file, () => `commit ${commit}, ${file}`, allow));
    }
  }
  const code = await exit;
  if (code !== 0) {
    throw new Error(`git log ended with exit code ${code}.`);
  }
  return { commits, findings };
}

async function main(): Promise<number> {
  const allow = parseAllowList(readFileSync(join(repoRoot, ALLOW_FILE), "utf8"));
  const tree = workTreeFindings(allow);
  const history = await historyFindings(allow);
  const findings = [...tree.findings, ...history.findings];

  if (findings.length > 0) {
    console.error(`check:secrets: ${findings.length} finding(s). The values are not printed.`);
    for (const finding of findings) {
      console.error(`  ${finding.where}  ${finding.kind} (${finding.length} characters)`);
    }
    console.error("A value that is made up for a test goes into scripts/ops/secrets-allow.json, with its file.");
    console.error("A real secret must be revoked: removing it from the file does not remove it from the history.");
    return 1;
  }
  console.log(`check:secrets: ${tree.files} files and ${history.commits} commits scanned, nothing found.`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`check:secrets: could not run: ${(error as Error).message}`);
  process.exitCode = 2;
}
