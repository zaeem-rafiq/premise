import type { FloorRead } from "../../protocol/internal.ts";

/** Missing registration is a public 404, distinct from an unavailable Floor. */
export class PoolNotRegistered extends Error {}

export type RegisteredFloorRead = FloorRead & {
  repositories: { main: string; plain: string | null };
};

/** The POOLS binding selects the namespace. Only a registered remote's repository
 * component is passed to it, never a path or namespace supplied by a visitor. */
function repositoryName(remote: unknown): string | null {
  if (typeof remote !== "string" || /[\s\\]/.test(remote)) return null;
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return null;
  const name =
    url.pathname
      .split("/")
      .at(-1)
      ?.replace(/\.git$/, "") ?? "";
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) && name !== ".." ? name : null;
}

/** SE22 from the Floor's projection, which carries the newest `pool.state`'s remotes and app. */
export function registeredFromProjection(read: FloorRead): RegisteredFloorRead {
  const main = repositoryName(read.pool.remote);
  if (main === null) throw new PoolNotRegistered();
  return {
    ...read,
    pool: { ...read.pool, app: read.pool.app === null ? null : "tidepool" },
    repositories: { main, plain: repositoryName(read.pool.plain_remote) },
  };
}

/** SE22: pool.state is the registration emitted by Trunk and retained by Floor.
 * Use the latest event, including an absent plain remote; never infer a name. */
export function registeredFloorRead(pool: string, read: FloorRead, replay: string): RegisteredFloorRead {
  let registration: Record<string, unknown> | null = null;
  for (const line of replay.split("\n")) {
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event !== "object" || event === null) continue;
      const ev = event as Record<string, unknown>;
      if (ev.type === "pool.state" && ev.src === "trunk" && ev.pool === pool) registration = ev;
    } catch {
      /* Replay header and incomplete lines do not register a pool. */
    }
  }
  const main = repositoryName(registration?.remote);
  if (main === null) throw new PoolNotRegistered();
  return {
    ...read,
    pool: {
      ...read.pool,
      app:
        registration?.app === null
          ? null
          : registration?.app === "tidepool"
            ? "tidepool"
            : (read.pool.app ?? "tidepool"),
    },
    repositories: { main, plain: repositoryName(registration?.plain_remote) },
  };
}
