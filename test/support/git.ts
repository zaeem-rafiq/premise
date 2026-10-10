// Scratch git repositories for tests (docs/spec/04-build-plan.md 1.4, "Real git").
//
// Git reads where its repository is from the environment before it looks at the working directory. A hook
// runs with GIT_DIR and GIT_INDEX_FILE set. A test that hands its own environment to git would then, when
// `npm test` runs from a hook, commit to the repository of the hook: the lane's own work tree.
// So every test that runs git gets its repository and its environment from here.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** No configuration of the user or of the machine: no hook, signing key or template interferes. */
const NO_CONFIGURATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const IDENTITY = {
  GIT_AUTHOR_NAME: "scratch test",
  GIT_AUTHOR_EMAIL: "scratch-test@example.invalid",
  GIT_COMMITTER_NAME: "scratch test",
  GIT_COMMITTER_EMAIL: "scratch-test@example.invalid",
};

/**
 * The environment for git in a scratch repository: `from` without any variable that git reads (`GIT_*`:
 * the repository, the work tree, the index, injected configuration), then a fixed identity and no
 * configuration. Git then finds its repository from the working directory alone.
 */
export function scratchGitEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.entries(from).filter(([name]) => !name.toUpperCase().startsWith("GIT_"));
  return { ...(Object.fromEntries(kept) as NodeJS.ProcessEnv), ...NO_CONFIGURATION, ...IDENTITY };
}

export type ScratchRepo = {
  /** The top level of the repository: a new directory under the temp directory. */
  readonly directory: string;
  /** The environment for every command that runs in the repository. */
  readonly env: NodeJS.ProcessEnv;
  /** Runs git in the repository and returns what it printed, without the last line break. */
  git(...args: string[]): string;
  /** Deletes the directory. */
  remove(): void;
};

/**
 * Creates an empty repository on the branch `main` in a new directory under the temp directory.
 * `from` is the environment the caller runs in. Throws, before anything is committed, unless git names the
 * new directory as the top level of the repository it works on.
 */
export function createScratchRepo(prefix: string, from: NodeJS.ProcessEnv = process.env): ScratchRepo {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = scratchGitEnv(from);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(
      /\r?\n$/,
      "",
    );
  const remove = (): void => rmSync(directory, { recursive: true, force: true });

  try {
    git("init", "--quiet", "--initial-branch=main");
    const topLevel = git("rev-parse", "--show-toplevel");
    const gitDirectory = git("rev-parse", "--absolute-git-dir");
    if (topLevel !== directory || gitDirectory !== join(directory, ".git")) {
      throw new Error(
        `git works on ${topLevel} (${gitDirectory}), not on the scratch repository ${directory}. Nothing was committed.`,
      );
    }
  } catch (error) {
    remove();
    throw error;
  }
  return { directory, env, git, remove };
}
