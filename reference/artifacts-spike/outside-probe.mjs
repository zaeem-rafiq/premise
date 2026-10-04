#!/usr/bin/env node
/**
 * Control from OUTSIDE Workers for e2-minted-token.
 *
 *   SPIKE_KEY=<secret> node outside-probe.mjs <saved e2 result file> <Worker base URL>
 *   node outside-probe.mjs <saved e2 result file>          (outside requests only)
 *
 * The question: is a token from createToken() refused only when the request comes from
 * inside Workers (workers-sdk issue 15429), or refused everywhere, or just not valid yet?
 *
 * One 60-second token is probed three times, in this order:
 *   1. inside the Durable Object, right after minting (e2 with {"outside_control": true});
 *   2. from this machine, with curl (this script);
 *   3. inside the Durable Object again (this script calls e2 with
 *      {"outside_control_recheck": true}; it needs the Worker base URL and SPIKE_KEY).
 * Step 3 is what makes the comparison fair. Step 2 is always later than step 1, so a token
 * that needs a moment to become valid is also "refused inside, accepted outside". Only a
 * request that is still refused inside AFTER it was accepted outside shows that the origin
 * matters. Without step 3 that case is reported as "inconclusive".
 *
 * Each round sends GET <remote>/info/refs?service=<service> and one POST <remote>/<service>,
 * with Bearer and with Basic auth, with and without a git User-Agent.
 *
 * Handling of the token and the key:
 *   - the token is removed from the saved file before any request is sent;
 *   - token and key reach curl on stdin (a curl config), never as command-line arguments;
 *   - neither is ever printed.
 * run-spikes.sh calls this script when E2_OUTSIDE_CONTROL is set.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REMOVED = "<removed by outside-probe.mjs after use>";

function fail(message) {
  process.stderr.write(`outside-probe: ${message}\n`);
  process.exit(1);
}

const file = process.argv[2];
const workerBase = process.argv[3] ? process.argv[3].replace(/\/+$/, "") : null;
if (!file) fail("usage: node outside-probe.mjs <saved e2 result file> [<Worker base URL>]");

let result;
try {
  result = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  fail(`cannot read ${file} as JSON (${e.message})`);
}
const disclosed = result.disclosed;
if (!disclosed || typeof disclosed.token !== "string" || disclosed.token === REMOVED) {
  fail('the result holds no token under "disclosed"; call e2 with {"outside_control": true}');
}
const { token, remote, service } = disclosed;
const gitUserAgent = typeof disclosed.git_user_agent === "string" ? disclosed.git_user_agent : "git/2.50.1";

// Remove the token from the file first, so it cannot stay on disk if a later step fails.
// The account label in the remote URL is masked too, as it is everywhere else in a result.
disclosed.token = REMOVED;
if (typeof remote === "string") disclosed.remote = remote.replace(/[A-Za-z0-9-]+(\.artifacts\.cloudflare\.net)\b/, "<account>$1");
writeFileSync(file, JSON.stringify(result, null, 2));

if (typeof remote !== "string" || !/^https?:\/\//.test(remote) || (service !== "git-upload-pack" && service !== "git-receive-pack")) {
  fail("the disclosed remote or service is not usable; the token was removed from the file and no request was sent");
}
// The POST request e2 sent from inside. A result without one (an older Worker) is probed with GET only.
const post = disclosed.post;
const hasPost = post !== undefined && post !== null;
if (hasPost && (post.path !== `/${service}` || typeof post.body !== "string" || post.body.length > 4096 || typeof post.content_type !== "string" || typeof post.accept !== "string")) {
  fail("the disclosed POST request is not usable; the token was removed from the file and no request was sent");
}

/** Escape a value for a double-quoted curl config parameter. */
function quote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

function authorization(style) {
  if (style === "bearer") return `Authorization: Bearer ${token}`;
  // Basic: any username; the password is the token without its "?expires=" suffix.
  const secret = token.split("?expires=")[0];
  return `Authorization: Basic ${Buffer.from(`x:${secret}`).toString("base64")}`;
}

const GET_REQUEST = "GET info/refs";
const POST_REQUEST = `POST ${service}`;

/** One request with curl. Returns the HTTP status, or 0 when curl got no HTTP answer. */
function send(request, style, userAgent) {
  const lines = [
    `header = ${quote(authorization(style))}`,
    // "User-Agent:" with no value tells curl to send no User-Agent header at all.
    `header = ${quote(userAgent === "none set" ? "User-Agent:" : `User-Agent: ${userAgent}`)}`,
  ];
  if (request === GET_REQUEST) {
    lines.push(`url = ${quote(`${remote}/info/refs?service=${service}`)}`);
  } else {
    lines.push(`url = ${quote(`${remote}${post.path}`)}`, `header = ${quote(`Content-Type: ${post.content_type}`)}`, `header = ${quote(`Accept: ${post.accept}`)}`, `data-binary = ${quote(post.body)}`);
  }
  const run = spawnSync("curl", ["--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "20", "--config", "-"], { input: `${lines.join("\n")}\n`, encoding: "utf8" });
  if (run.error || run.status !== 0) return { status: 0, curl_exit: run.status ?? -1 };
  return { status: Number(run.stdout.trim()) || 0, curl_exit: 0 };
}

const control = result.data?.outside_control ?? {};
const insideBefore = Array.isArray(control.inside_durable_object) ? control.inside_durable_object : [];
// Results from before the POST probe existed carry no "request" field: those are GET probes.
const statusIn = (list, request, auth, userAgent) => list.find((p) => (p.request ?? GET_REQUEST) === request && p.auth === auth && p.user_agent === userAgent)?.status ?? null;

// ---- Step 2: the same requests from this machine. ----
// Each row is one request (same token, auth style, User-Agent and body) from every place.
// "none set": the harness set no User-Agent inside the Durable Object; the matching
// request from here sends no User-Agent header.
const startedAt = Date.now();
const expiresAt = Date.parse(disclosed.expires_at ?? "");
const mintedAt = Date.parse(disclosed.minted_at ?? control.minted_at ?? "");
const pairs = [];
for (const auth of ["bearer", "basic"]) {
  for (const userAgent of ["none set", gitUserAgent]) {
    for (const request of hasPost ? [GET_REQUEST, POST_REQUEST] : [GET_REQUEST]) {
      const outside = send(request, auth, userAgent);
      pairs.push({
        request,
        auth,
        user_agent: userAgent,
        inside_status_before: statusIn(insideBefore, request, auth, userAgent),
        outside_status: outside.status,
        inside_status_after: null,
        ...(outside.curl_exit === 0 ? {} : { curl_exit: outside.curl_exit }),
      });
    }
  }
}
const finishedAt = Date.now();

// ---- Step 3: ask the Worker to probe the same token from inside once more. ----
function recheckInside() {
  if (!workerBase) return { done: false, reason: "no Worker base URL was given to outside-probe.mjs" };
  if (!/^https?:\/\//.test(workerBase)) return { done: false, reason: "the Worker base URL does not start with http:// or https://" };
  const key = process.env.SPIKE_KEY;
  if (!key) return { done: false, reason: "SPIKE_KEY is not set in the environment" };
  const config = [`url = ${quote(`${workerBase}/run/e2-minted-token`)}`, `header = ${quote(`x-spike-key: ${key}`)}`, `header = ${quote("content-type: application/json")}`, `data = ${quote('{"outside_control_recheck": true}')}`].join("\n");
  const run = spawnSync("curl", ["--silent", "--max-time", "120", "--config", "-"], { input: `${config}\n`, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) return { done: false, reason: `the recheck request to the Worker failed (curl exit ${run.status ?? -1})` };
  let answer;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    return { done: false, reason: "the Worker's answer to the recheck request is not JSON" };
  }
  const recheck = answer?.data?.outside_control_recheck;
  if (!recheck || !Array.isArray(recheck.inside_durable_object)) {
    return { done: false, reason: `the Worker did not run the recheck: ${String(answer?.error ?? answer?.data?.verdict?.outside_control_recheck ?? "no recheck data in its answer").slice(0, 300)}` };
  }
  return { done: true, token_expired_before_end: recheck.token_expired_before_end === true, inside_durable_object: recheck.inside_durable_object };
}
const recheck = recheckInside();
// Statuses from a recheck that ran past the token's expiry say nothing about the token: they are not used.
const afterUsable = recheck.done && !recheck.token_expired_before_end;
if (afterUsable) for (const p of pairs) p.inside_status_after = statusIn(recheck.inside_durable_object, p.request, p.auth, p.user_agent);
const whyNoAfter = !recheck.done ? recheck.reason : recheck.token_expired_before_end ? "the token expired before the second probe inside the Durable Object had finished" : "the second inside probe holds no status for at least one of these requests";

// ---- Verdict. ----
const refused = (status) => status === 401 || status === 403;
const label = (p) => `${p.request} (${p.auth} auth, ${p.user_agent === "none set" ? "no User-Agent" : "git User-Agent"})`;
const requestsSent = hasPost ? `${GET_REQUEST} and ${POST_REQUEST}` : `${GET_REQUEST} only (the result held no POST request to repeat)`;
// Refused inside first, accepted from this machine afterwards: either the origin matters, or the token needed time.
const suspects = pairs.filter((p) => refused(p.inside_status_before) && p.outside_status === 200);
let refusedOnlyInside;
let conclusion;
if (pairs.some((p) => p.outside_status === 0)) {
  refusedOnlyInside = "inconclusive";
  conclusion = "inconclusive: at least one request from this machine got no HTTP answer";
} else if (Number.isFinite(expiresAt) && finishedAt > expiresAt) {
  refusedOnlyInside = "inconclusive";
  conclusion = "inconclusive: the token expired before the requests from this machine had finished";
} else if (pairs.some((p) => p.inside_status_before === null)) {
  refusedOnlyInside = "inconclusive";
  conclusion = "inconclusive: the result holds no status from inside the Durable Object for at least one request";
} else if (suspects.length > 0 && (!afterUsable || suspects.some((p) => p.inside_status_after === null))) {
  refusedOnlyInside = "inconclusive";
  conclusion =
    `inconclusive: ${suspects.length} request(s) were refused inside the Durable Object and accepted from this machine afterwards, but there is no usable second probe from inside ` +
    `(${whyNoAfter}). A token that needs time to become valid gives the same picture, so this does not show that the origin matters`;
} else if (suspects.some((p) => refused(p.inside_status_after))) {
  const still = suspects.filter((p) => refused(p.inside_status_after));
  refusedOnlyInside = true;
  conclusion = `the same token was refused inside the Durable Object before AND after it was accepted from this machine: the refusal depends on where the request comes from; the age of the token alone does not explain it. Requests: ${still.map(label).join("; ")}`;
} else if (suspects.length > 0 && suspects.every((p) => p.inside_status_after === 200)) {
  refusedOnlyInside = false;
  conclusion = `the token was refused inside the Durable Object at first, then accepted from this machine, then accepted inside as well: a new token needs time to become valid. The origin of the request makes no difference. Requests: ${suspects.map(label).join("; ")}`;
} else if (suspects.length > 0) {
  refusedOnlyInside = "inconclusive";
  conclusion = "inconclusive: requests that were refused inside and accepted from this machine got neither 200 nor a refusal on the second inside probe; read the pairs";
} else if (pairs.every((p) => p.inside_status_before === 200 && p.outside_status === 200 && (p.inside_status_after === null || p.inside_status_after === 200))) {
  refusedOnlyInside = false;
  conclusion = `the token was accepted inside the Durable Object and from this machine (${requestsSent})`;
} else if (pairs.every((p) => p.inside_status_before === p.outside_status && (p.inside_status_after === null || p.inside_status_after === p.outside_status))) {
  refusedOnlyInside = false;
  conclusion = `every request got the same status inside the Durable Object and from this machine: the origin of the request makes no difference (${requestsSent})`;
} else {
  refusedOnlyInside = "inconclusive";
  conclusion = "mixed statuses; read the pairs";
}

const sinceMint = (time) => (Number.isFinite(mintedAt) ? time - mintedAt : null);
result.outside_probe = {
  added_by: "outside-probe.mjs on the operator's machine (curl); not part of the Worker's answer",
  requests: hasPost ? [`GET <remote>/info/refs?service=${service}`, `POST <remote>${post.path}`] : [`GET <remote>/info/refs?service=${service}`],
  order: "inside_status_before (in the e2 run), then outside_status (this machine), then inside_status_after (a second probe inside the Durable Object)",
  started_at: new Date(startedAt).toISOString(),
  ms: finishedAt - startedAt,
  // Token age at the outside requests, by this machine's clock (the Worker's clock set minted_at).
  outside_ms_after_mint: { first: sinceMint(startedAt), last: sinceMint(finishedAt) },
  token_expires_at: disclosed.expires_at ?? null,
  inside_recheck: recheck.done ? { done: true, token_expired_before_end: recheck.token_expired_before_end, inside_durable_object: recheck.inside_durable_object } : recheck,
  pairs,
  minted_token_refused_only_inside_workers: refusedOnlyInside,
  conclusion,
};
writeFileSync(file, JSON.stringify(result, null, 2));

const show = (status) => (status === null ? "-" : String(status));
const brief = pairs.map((p) => `${p.request.split(" ")[0]} ${p.auth}/${p.user_agent === "none set" ? "no-ua" : "git-ua"} ${show(p.inside_status_before)}>${show(p.outside_status)}>${show(p.inside_status_after)}`).join("; ");
process.stdout.write(`  outside control: ${conclusion}\n  statuses as inside>outside>inside again: ${brief}\n`);
