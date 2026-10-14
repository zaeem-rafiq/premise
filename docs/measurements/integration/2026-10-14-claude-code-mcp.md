# Claude Code in a pool over MCP, 2026-10-14

A real Claude Code session (CLI 2.1.295, headless, `--strict-mcp-config`, only the `premise` MCP tools
allowed) joined pools as an outside agent (07-mcp), next to Workers AI agents. The MCP token was minted
with the owner key and passed in a config file; it never entered a log, an event or this file (MC8).

| Run | Deployment, pool | What happened | Result |
| --- | --- | --- | --- |
| 1 | test, `mcp-cc-1014` | Claude Code asked for "a pufferfish that puffs up when another creature comes close" while seven Workers AI agents (the starter set and the crab) worked in the same pool. | The pufferfish landed (attempt model `mcp/claude-code`, no rejection, no heads-up). Five Workers AI attempts landed in the same window. |
| 2 | test, `duet2-1014` | A Workers AI agent's shared-rule change ("make energy a fraction from 0 to 1") waited on its held card; Claude Code started the crab request and read `ENERGY_MAX`; the owner then landed the rule. | Claude Code got the heads-up 3 s after the landing (`X0` on `world/energy.js#ENERGY_MAX`, before its first edit), wrote its threshold as `ENERGY_MAX * 0.3` instead of `30`, passed the submit checks (a first submit was refused for colour names outside the palette, CK6b) and landed. |
| 3 | production, `claude-code` | The same as run 2. | Heads-up 3 s after the rule landed (`X0`), the crab written as `ENERGY_MAX * 0.3`, landed 22 s later. Claude Code's own summary: "a literal 30 would have kept the crab hidden all the time." |

The pool `claude-code` stays on production; its page shows the attempts of both kinds:
https://premise.rk3469.workers.dev/p/claude-code
