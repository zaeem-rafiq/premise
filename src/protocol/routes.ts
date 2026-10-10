// Method, path and role of every route of 01-core 13.6 (the Worker and its Durable Objects) and of
// 02-tidepool 4.2 (the app server). Request/response types the routes carry.

import type { UndoPlanResponse, UndoResponse } from "./undo.ts";
import type { SwarmRequest } from "./swarm.ts";
import type { CardOption } from "./cards.ts";
import type { Note } from "./note.ts";

/** Who may call a route (01-core 13.6): anyone; the owner (mutating routes, SE1/SE3); or the key
 * holder (`POST /api/session`, which is the unlock itself). */
export type RouteRole = "anyone" | "owner" | "key";

/** What answers the route (the "Answered by" column of 13.6 and of 02-tidepool 4.2). */
export type RouteAnsweredBy = "assets" | "worker" | "floor" | "trunk" | "agent" | "gate" | "swarm" | "app-server";

/** One row of a route table. `paths` holds the path template(s) of the row; `{name}` is a segment
 * parameter. */
export type Route = {
  method: "GET" | "POST" | "DELETE" | "WS";
  paths: readonly string[];
  role: RouteRole;
  answeredBy: RouteAnsweredBy;
};

/**
 * The twenty-one rows of 01-core 13.6, in table order. A path template segment `{pool}`, `{card_id}`,
 * `{attempt_id}`, `{seq}` or `{id}` is one path segment.
 */
export const ROUTES: readonly Route[] = [
  { method: "GET", paths: ["/"], role: "anyone", answeredBy: "assets" },
  { method: "GET", paths: ["/p/{pool}"], role: "anyone", answeredBy: "assets" },
  { method: "GET", paths: ["/floor.json"], role: "anyone", answeredBy: "assets" },
  { method: "WS", paths: ["/api/pools/{pool}/stream"], role: "anyone", answeredBy: "floor" },
  { method: "GET", paths: ["/api/session"], role: "anyone", answeredBy: "worker" },
  { method: "POST", paths: ["/api/session"], role: "key", answeredBy: "worker" },
  { method: "DELETE", paths: ["/api/session"], role: "owner", answeredBy: "worker" },
  { method: "POST", paths: ["/api/pools/{pool}/intents"], role: "owner", answeredBy: "trunk" },
  {
    method: "POST",
    paths: ["/api/pools/{pool}/cards/{card_id}"],
    role: "owner",
    answeredBy: "trunk",
  },
  { method: "GET", paths: ["/api/pools/{pool}/undo-plan"], role: "owner", answeredBy: "trunk" },
  { method: "POST", paths: ["/api/pools/{pool}/undo"], role: "owner", answeredBy: "trunk" },
  {
    method: "POST",
    paths: ["/api/pools/{pool}/attempts/{attempt_id}/stop"],
    role: "owner",
    answeredBy: "agent",
  },
  { method: "POST", paths: ["/api/swarm"], role: "owner", answeredBy: "swarm" },
  { method: "POST", paths: ["/api/kill"], role: "owner", answeredBy: "gate" },
  { method: "POST", paths: ["/api/pools/{pool}/rebuild"], role: "owner", answeredBy: "trunk" },
  { method: "POST", paths: ["/api/pools"], role: "owner", answeredBy: "worker" },
  { method: "POST", paths: ["/api/pools/{pool}/read-token"], role: "owner", answeredBy: "worker" },
  {
    method: "GET",
    paths: ["/api/pools/{pool}/landings/{seq}/note"],
    role: "anyone",
    answeredBy: "floor",
  },
  {
    method: "GET",
    paths: ["/replay/index.json", "/replay/{id}.ndjson"],
    role: "anyone",
    answeredBy: "assets",
  },
  {
    method: "GET",
    paths: ["/api/pools/{pool}/replay.ndjson"],
    role: "owner",
    answeredBy: "floor",
  },
  { method: "GET", paths: ["/pool/{rest}"], role: "anyone", answeredBy: "app-server" },
];

/** The six rows of 02-tidepool 4.2 (the app server's routes). `<pool>`, `<source>`, `<version>`,
 * `<build>` and `<path>` stand for path segments (`{rest}` carries `<path>`, which spans segments);
 * `~head.js`, `~boot.js`, `~registry.js` and `~host.<build>.js` are the generated `~` modules of SE15. */
export const APP_ROUTES: readonly Route[] = [
  { method: "GET", paths: ["/pool/{pool}/{source}/"], role: "anyone", answeredBy: "app-server" },
  {
    method: "GET",
    paths: ["/pool/{pool}/{source}/~head.js"],
    role: "anyone",
    answeredBy: "app-server",
  },
  {
    method: "GET",
    paths: ["/pool/{pool}/{source}/~boot.js"],
    role: "anyone",
    answeredBy: "app-server",
  },
  {
    method: "GET",
    paths: ["/pool/{pool}/v/{version}/{path}"],
    role: "anyone",
    answeredBy: "app-server",
  },
  {
    method: "GET",
    paths: ["/pool/{pool}/v/{version}/~registry.js"],
    role: "anyone",
    answeredBy: "app-server",
  },
  {
    method: "GET",
    paths: ["/pool/~host.{build}.js"],
    role: "anyone",
    answeredBy: "app-server",
  },
];

/** The rows `07-mcp.md` section 6 adds to 13.6 (outside agents over MCP): the token route and the
 * MCP endpoint. Kept apart from `ROUTES`, which is the table of 13.6 as it stands. */
export const MCP_ROUTES: readonly Route[] = [
  { method: "POST", paths: ["/api/pools/{pool}/mcp-tokens"], role: "owner", answeredBy: "worker" },
  { method: "POST", paths: ["/mcp/{pool}"], role: "anyone", answeredBy: "worker" },
  { method: "GET", paths: ["/mcp/{pool}"], role: "anyone", answeredBy: "worker" },
  { method: "DELETE", paths: ["/mcp/{pool}"], role: "anyone", answeredBy: "worker" },
];

// ---- Request and response bodies the routes carry ----

/** `POST /api/session` (SE2): the unlock. */
export type SessionRequest = { key: string };

/** `GET /api/session` answers. */
export type SessionResponse = { owner: boolean };

/** `POST /api/pools/{pool}/intents`: one intent. `request_id` makes a repeated send a no-op. */
export type CreateIntentRequest = { text: string; race: boolean; prewritten: boolean; request_id: string };
export type CreateIntentResponse = { intent_id: string };

/** `POST /api/pools/{pool}/cards/{card_id}`: the owner's tap. `option` is a `CardOption` the card offers
 * (CD4); `attempt_id` is required for `choose`; `submit_ids` binds the tap to the submits the owner saw. */
export type CardActionRequest = {
  option: CardOption;
  submit_ids: Record<string, string>;
  attempt_id?: string;
  reason?: string;
  request_id: string;
};

/** `POST /api/pools/{pool}/attempts/{attempt_id}/stop` (stop reason `cancelled`). */
export type StopAttemptRequest = { request_id: string };

/** `GET /api/pools/{pool}/undo-plan?seq=` (UN4) and `POST /api/pools/{pool}/undo` (UN5). */
export type { UndoPlanResponse, UndoResponse };
export type UndoRequest = { seq: number; expect_reverted: number[]; request_id: string };

/** `POST /api/swarm` (SWR1). */
export type { SwarmRequest };

/** `POST /api/kill` (SE10): the kill switch. `landings` asks that in-flight landings finish first. */
export type KillRequest = { killed: boolean; landings?: boolean };

/** `POST /api/pools/{pool}/rebuild` (RB1). */
export type RebuildRequest = { request_id: string };

/**
 * `POST /api/pools` (PL1, IR1): exactly one of `seed` (a seed tree built into the deployment)
 * or `source` (a public git repository). `source.url` is `https://<host>/<owner>/<name>` —
 * optionally `.git`-suffixed — with `<host>` one of `github.com`, `gitlab.com`, `codeberg.org`;
 * `branch` names the imported branch (the remote's default when absent). Returns no token.
 */
export type CreatePoolRequest = {
  pool: string;
  seed?: string;
  source?: { url: string; branch?: string };
  summary_only?: boolean;
  request_id: string;
};

/** `POST /api/pools/{pool}/read-token` (SE5c): a read token for the pool repository, minted with
 * explicit scope `read` and a lifetime of `READ_TOKEN_TTL_S`, returned to the owner only. */
export type ReadTokenResponse = { token: string };

/** `GET /api/pools/{pool}/landings/{seq}/note` answers the note itself (from `landing.landed.note_json`). */
export type { Note };

/**
 * The error code a route answers with when the build's `features` (FJ1) switches the feature off —
 * for example `undo: false` refuses `POST /api/pools/{pool}/undo`. Not a tool `ErrorCode` (4.1):
 * a response error code from the fixed list of SE5b.
 */
export const FEATURE_OFF = "feature_off";
