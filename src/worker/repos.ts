// src/worker/repos.ts — the one place the Artifacts repository names are made (PL1, gap 6).
// A pool owns two repos: its own (`<pool>`) and the plain-merge's (`<pool>-plain`). Trunk's
// pusher, the app server's pool source and the create route all name them through here.

/** The Artifacts repository that holds a pool's `main` — or its plain-merge mirror (`"plain"`). */
export function poolRepoName(pool: string, kind: "main" | "plain" = "main"): string {
  return kind === "plain" ? `${pool}-plain` : pool;
}

// IR1: the public hosts a pool's `source` may name, and the shapes of the address's parts.
const SOURCE_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com", "codeberg.org"]);
const SOURCE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SOURCE_BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * The checked repository source of IR1: `{ url, branch? }` where `url` is
 * `https://<host>/<owner>/<name>` — the same ending `.git` also allowed — on one of the
 * supported hosts, with no user name, password, port, query or fragment, and `<owner>` and
 * `<name>` matching `^[A-Za-z0-9._-]+$`; `branch`, when given, matches `^[A-Za-z0-9._/-]+$`
 * and holds no `..`. Returns the descriptor as given, or null for any other form.
 *
 * The authority is checked on the raw address, not `URL.host`: `new URL` folds `:443` away,
 * and IR1 refuses every port — including the default one.
 */
export function parseRepoSource(source: unknown): { url: string; branch?: string } | null {
  if (typeof source !== "object" || source === null) return null;
  const request = source as { url?: unknown; branch?: unknown };
  if (typeof request.url !== "string" || request.url.length === 0) return null;
  if (
    request.branch !== undefined &&
    (typeof request.branch !== "string" || !SOURCE_BRANCH.test(request.branch) || request.branch.includes(".."))
  ) {
    return null;
  }
  const authority = request.url.slice("https://".length).split(/[/?#]/, 1)[0];
  if (
    request.url.slice(0, 8) !== "https://" ||
    authority === undefined ||
    authority.includes("@") ||
    authority.includes(":")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    !SOURCE_HOSTS.has(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const segments = /^\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
  if (segments === null) return null;
  const owner = segments[1]!;
  const rawName = segments[2]!;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;
  if (!SOURCE_SEGMENT.test(owner) || !SOURCE_SEGMENT.test(name)) return null;
  return request.branch === undefined ? { url: request.url } : { url: request.url, branch: request.branch };
}
