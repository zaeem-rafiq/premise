# Extension: outside agents over MCP

Branch `feat/mcp`. Browser port `4405`. Read `README.md` in this folder first.

## What it is

An outside agent (Claude Code, Codex, any MCP client) joins a pool as one more attempt. It gets the same
tools as Premise's own agents, every read becomes a premise, and its change lands, goes around or waits
on a card exactly like any other. The owner sees it on the Floor as an attempt card named after the
client. Nothing of this exists today, and no specification covers it.

## Write the specification first

Create `docs/spec/07-mcp.md` with rule ids `MC1`, `MC2`, …, and settle at least these points, preferring
the simplest form that is safe:

- **Transport.** MCP's Streamable HTTP transport (JSON-RPC 2.0 over `POST`) at `/mcp/<pool>`, with
  `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. Build it by hand on
  the Worker; propose a dependency only if the protocol truly needs one.
- **Who may connect.** The owner mints a token for one pool: a new owner route such as
  `POST /api/pools/{pool}/mcp-tokens`, answered once with the token, which expires (hours, not days)
  and is signed like the owner session (`src/worker/security/session.ts`). The client sends it as
  `Authorization: Bearer`. Add its pattern to `redact()` (SE5a), so no token reaches a log, an event or
  a recording. The kill switch refuses every MCP call.
- **One session, one attempt.** A first tool (for example `premise_start` with the request in plain
  words) opens the intent and the attempt. Choose how the attempt is labelled: the simplest is agent
  `real` with the model field set to the client's name from `initialize`, so the Floor needs no new
  kind; justify the choice. The attempt takes one of the `MAX_REAL_AGENTS` slots and makes no Workers AI
  call, so the model gate's spend is untouched.
- **Tools.** One MCP tool per tool of `docs/spec/05-agent.md`, with the same names, argument schemas and
  results (`src/protocol/agent-prompt.ts` holds the definitions), forwarded to Trunk exactly as the Agent
  Durable Object forwards them. Heads-ups reach the client the way they reach Premise's agents (find how
  in `05-agent.md` and the Agent DO) plus a tool that lists the pending ones.
- **Silence.** An outside attempt that sends nothing for `AGENT_WATCHDOG_MS` stops, so its slot frees.

`features.mcp` (new, false) gates the route: off, `/mcp/...` answers 404.

## Acceptance

workerd tests: no token, a wrong pool and an expired token each answer 401; `initialize` and
`tools/list` match the specification; a scripted MCP client opens an attempt, reads by entity (a premise
is recorded), writes, submits and lands on a test pool; a landing that breaks its premise gives it a
heads-up; the kill switch refuses; a silent client is stopped; no token appears in any event or log line.
A browser test: the attempt card shows the client's name.

## Paths

`docs/spec/07-mcp.md` (new), `src/worker/routes/mcp*` and `src/worker/mcp/**` (new), the route table in
`src/worker/routes/wiring.ts`, `src/worker/security/**`, the redaction in `src/protocol/` (lead path,
allowed here), `test/workerd/mcp/**` (new), the attempt card's label in `src/floor/components/attempt-card/**`,
About in `src/floor/components/about/**`, `README.md`'s "Run it" section if you add a short "connect an
outside agent" note (keep `docs/submission/run.txt` equal to it, SC3), and the shared files of
`README.md`'s list.

## The lead's live checks

Mint a token on `test`, connect Claude Code with
`claude mcp add --transport http premise-test https://premise-test.rk3469.workers.dev/mcp/<pool> --header "Authorization: Bearer <token>"`,
ask it for a small creature, and watch the attempt card, its lights and its landing.
