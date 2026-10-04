// The request paths of 03-floor 4.5 the shell makes. The pool name goes through
// encodeURIComponent: the route is `/api/pools/{pool}/stream` with a single path segment.

export function streamPath(pool: string): string {
  return `/api/pools/${encodeURIComponent(pool)}/stream`;
}

export function sessionPath(): string {
  return "/api/session";
}

export function killPath(): string {
  return "/api/kill";
}
