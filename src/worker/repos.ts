// src/worker/repos.ts — the one place the Artifacts repository names are made (PL1, gap 6).
// A pool owns two repos: its own (`<pool>`) and the plain-merge's (`<pool>-plain`). Trunk's
// pusher, the app server's pool source and the create route all name them through here.

/** The Artifacts repository that holds a pool's `main` — or its plain-merge mirror (`"plain"`). */
export function poolRepoName(pool: string, kind: "main" | "plain" = "main"): string {
  return kind === "plain" ? `${pool}-plain` : pool;
}
