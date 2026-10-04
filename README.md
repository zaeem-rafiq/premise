# Premise

Git records only what an agent wrote. Premise also records what it read.

A change lands the instant everything it relied on is still true, and returns
to its still-running agent with the exact diff the instant it is not.

Premise is built on Cloudflare Workers, Durable Objects and Artifacts.

> Status: early build. This repository holds the specification and the toolchain.
> The product is not built yet: the Worker answers one probe, and the page is a placeholder.
> Instructions for running a deployment will be added as the system comes together.

## Run the checks

You need Node.js 22 (22.18 or later), npm 10 and git 2.40 or later. You do not need a Cloudflare account.

```sh
npm ci
npm run check
```

`npm run check` runs the format check, the typecheck, the offline tests, the build, the licence check and the
secret scan. It deploys nothing.

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm test`          | Runs the offline tests.                                              |
| `npm run typecheck` | Compiles the six TypeScript programs without output.                 |
| `npm run build`     | Builds the page and the Worker bundle into `dist/`. Deploys nothing. |
| `npm run dev:floor` | Serves the placeholder page at `http://localhost:5173`.              |

## Where things are

- [`docs/spec/`](docs/spec/): the specification. `01-core.md` holds the rules and the protocol.
- [`docs/measurements/`](docs/measurements/): what was measured on the real Cloudflare service.
- [`AGENTS.md`](AGENTS.md): the rules for coding agents that work in this repository.
- [`reference/`](reference/): working material from before the build. It is not product code.

## License

[MIT](LICENSE)
