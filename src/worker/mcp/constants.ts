// The constants of docs/spec/07-mcp.md Appendix A. `constants.test.ts` beside this file compares
// every name and value with that table.

/** Lifetime of an MCP token, in seconds (MC6). */
export const MCP_TOKEN_TTL_S = 14_400;

/** Silence after which a working outside attempt stops with `stalled` (MC21). */
export const MCP_SILENCE_MS = 120_000;

/** The longest wait of `premise_status` with `wait` true (MC19). */
export const MCP_WAIT_MS = 20_000;

/** How often that wait calls `sync` (MC19). */
export const MCP_POLL_MS = 2_000;

/** The longest one tool call waits inside its request for Trunk's answer (MC15). */
export const MCP_CALL_WAIT_MS = 60_000;

/** The longest client name (MC9). */
export const MCP_CLIENT_NAME_CHARS = 40;
