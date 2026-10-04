// The client routes of 03-floor 4.5 (FE7): `/` shows the default pool of `/floor.json`,
// `/p/{pool}` shows that pool as the main pool, `/replay/{id}` loads that recording and
// plays it (RY18). The page is a single-page app: these are client routes of one page.

export type Route =
  | { kind: "floor"; pool: string | null } // null: the default pool of /floor.json
  | { kind: "replay"; id: string };

export function parseRoute(pathname: string): Route {
  const replay = /^\/replay\/([^/]+)\/?$/.exec(pathname);
  if (replay !== null) return { kind: "replay", id: decodeURIComponent(replay[1]!) };
  const pool = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (pool !== null) return { kind: "floor", pool: decodeURIComponent(pool[1]!) };
  return { kind: "floor", pool: null };
}

/** The client route for the main pool: `/` for the default pool (FE7). */
export function poolRoute(pool: string, defaultPool: string): string {
  return pool === defaultPool ? "/" : `/p/${encodeURIComponent(pool)}`;
}
