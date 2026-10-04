// `npm run pool:create` (PL1, gap 5): creates a pool through `POST /api/pools` on the Worker that
// `PREMISE_URL` names — a deployment or a local workerd — authenticated by `PREMISE_OWNER_KEY`.
//
//   npm run pool:create -- <pool> <seed> [--summary-only] [--request-id <id>]
//
// The address and the key are never printed: only the HTTP status and the body's own fields are.

const USAGE =
  "usage: npm run pool:create -- <pool> <seed> [--summary-only] [--request-id <id>]\n" +
  "       needs PREMISE_URL (the Worker's origin) and PREMISE_OWNER_KEY set in the environment";

const args = process.argv.slice(2);
const positional: string[] = [];
let summaryOnly = false;
let requestId: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--summary-only") summaryOnly = true;
  else if (arg === "--request-id") {
    requestId = args[i + 1];
    i += 1;
  } else if (arg !== undefined && !arg.startsWith("--")) positional.push(arg);
  else {
    console.error(USAGE);
    process.exit(1);
  }
}

const [pool, seed] = positional;
const url = process.env.PREMISE_URL?.replace(/\/+$/, "");
const key = process.env.PREMISE_OWNER_KEY;
if (pool === undefined || seed === undefined) {
  console.error(USAGE);
  process.exit(1);
}
if (url === undefined || key === undefined) {
  const missing = [url === undefined ? "PREMISE_URL" : "", key === undefined ? "PREMISE_OWNER_KEY" : ""]
    .filter(Boolean)
    .join(" and ");
  console.error(`pool:create: ${missing} is not set. ${USAGE}`);
  process.exit(1);
}

const body = {
  pool,
  seed,
  summary_only: summaryOnly,
  request_id: requestId ?? `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
};

const response = await fetch(`${url}/api/pools`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
const text = await response.text();
console.log(`POST /api/pools ${pool}: ${response.status} ${text}`);
if (!response.ok) process.exitCode = 1;
