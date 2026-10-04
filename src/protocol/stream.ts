// The WebSocket protocol between the Floor Durable Object and the page, and the source-id space of EV2a.
// Source: 01-core 12.2 (EV2a, the socket protocol).

import type { PoolEvent } from "./events.ts";

/** The source id an attempt's Agent emits under (EV2a): `agent:<attempt_id>`. */
export function agentSourceId(attemptId: string): string {
  return `agent:${attemptId}`;
}

/** The source ids at the Floor (`sources.source`, EV2a). `agent` sources carry their attempt id;
 * the Floor's own events need no row. */
export type StreamSource = "trunk" | `agent:${string}` | "gate" | "swarm";

/** The de-duplication key a source sends with its events (EV2): `(source, epoch, source_n)`. */
export type SourceSeq = { source: StreamSource; epoch: number; source_n: number };

/** The one message the client sends: `{ "hello": 1, "after": <n> }`. Any second message closes the socket. */
export type StreamHello = { hello: 1; after: number };

/** What the Floor answers: a snapshot when `after` is older than its oldest retained snapshot or 0,
 * then `events` frames in `n` order. */
export type StreamFrame = { snapshot: { n: number; state: unknown } } | { events: PoolEvent[] };
