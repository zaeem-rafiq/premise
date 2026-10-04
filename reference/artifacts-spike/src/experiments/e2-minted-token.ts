/**
 * e2-minted-token: do tokens from createToken() on an existing repo work for git requests
 * made inside a Durable Object?
 *
 * With {"outside_control": true} it also mints one 60-second token, probes it from inside
 * the Durable Object, and returns it so that outside-probe.mjs can send the same requests
 * from outside Workers. With {"outside_control_recheck": true} it probes that same token
 * from inside once more. The order inside, outside, inside separates "refused only inside
 * Workers" from "refused everywhere" AND from "a fresh token needs time to become valid".
 */
import {
  authHeader,
  cloneRepo,
  commitFiles,
  pushDecision,
  pushRef,
  rawDiscover,
  rawServicePost,
  type AuthStyle,
  type GitService,
  type LocalRepo,
  type PushOutcome,
  type RecordingHttpClient,
} from "../gitops";
import {
  describeToken,
  intParam,
  randomSuffix,
  sleep,
  type Recorder,
} from "../recorder";
import {
  pushSummary,
  remoteRefValue,
  requireE1,
  withRepo,
  type Deps,
  type Experiment,
  type OutsideControlState,
  type RepoState,
} from "./common";

interface Probe {
  token: string;
  style: AuthStyle | "none";
  service: string;
  status: number;
}

const STYLES = ["bearer", "basic"] as const;

/** HTTP statuses that mean "this credential is not accepted". */
function isAuthRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

/** Shortest lifetime the service allows for a token (documented minimum). */
const OUTSIDE_CONTROL_TTL_SECONDS = 60;
/**
 * A recheck that ends this close to the token's expiry (or after it) is not used: a refusal
 * could then be the expiry itself. The margin covers a small difference between clocks.
 */
const EXPIRY_MARGIN_MS = 2_000;
/** The User-Agent the git command-line client sends, for the matched inside/outside requests. */
export const GIT_CLI_USER_AGENT = "git/2.50.1";
const USER_AGENTS = ["none set", GIT_CLI_USER_AGENT] as const;

/** A pkt-line that carries text. */
function pkt(text: string): string {
  return (text.length + 4).toString(16).padStart(4, "0") + text;
}

/**
 * Body of the POST probe. e2 has seen minted tokens that pass GET info/refs and are refused
 * on POST, so the control repeats a POST as well.
 *  - read token: a real fetch request for the branch tip ("want <tip>", "done"). The answer
 *    is a small pack. Without a known tip the body is a lone flush-pkt (no wants).
 *  - write token: a lone flush-pkt, which is a push with no commands. It cannot change the repo.
 */
function postProbeBody(service: GitService, tip: string | null): string {
  if (service === "git-upload-pack" && tip !== null) return `${pkt(`want ${tip}\n`)}0000${pkt("done\n")}`;
  return "0000";
}

export interface ControlProbe {
  /** "GET info/refs" or "POST <service>". */
  request: string;
  auth: AuthStyle;
  /** "none set": the harness sets no User-Agent (fetch on workerd then sends none at all). */
  user_agent: (typeof USER_AGENTS)[number];
  status: number;
  /** Age of the token when the answer arrived. */
  ms_after_mint: number;
}

const uaTag = (userAgent: string): string => (userAgent === "none set" ? "no-ua" : "git-ua");

/** One round of control requests from inside the Durable Object: GET and POST, both auth styles, with and without a git User-Agent. */
async function controlProbes(rec: Recorder, label: string, control: OutsideControlState): Promise<ControlProbe[]> {
  const probes: ControlProbe[] = [];
  for (const style of STYLES) {
    for (const userAgent of USER_AGENTS) {
      const extra: Record<string, string> = userAgent === "none set" ? {} : { "User-Agent": userAgent };
      const step = `${label}:${style}:${uaTag(userAgent)}`;
      const authorization = authHeader(control.token, style);
      const get = await rawDiscover(rec, step, control.remote, control.service, authorization, extra);
      probes.push({ request: "GET info/refs", auth: style, user_agent: userAgent, status: get.status, ms_after_mint: Date.now() - control.mintedAtMs });
      const post = await rawServicePost(rec, step, control.remote, control.service, authorization, control.postBody, extra);
      probes.push({ request: `POST ${control.service}`, auth: style, user_agent: userAgent, status: post.status, ms_after_mint: Date.now() - control.mintedAtMs });
    }
  }
  return probes;
}

function statusLine(probes: ControlProbe[]): string {
  const requests = [...new Set(probes.map((p) => p.request))];
  return requests.map((request) => `${request}: ${probes.filter((p) => p.request === request).map((p) => `${p.auth}/${uaTag(p.user_agent)}=${p.status}`).join(" ")}`).join("; ");
}

/**
 * Opt-in control from outside Workers, first half. Mints one short-lived token on the
 * existing repo and sends GET info/refs and one POST with it from inside the Durable Object
 * (both auth styles, with and without a git User-Agent). It then hands the token to the
 * caller under `disclosed`, so the same requests can be repeated from the operator's
 * machine, and keeps it in memory for the second half (outsideControlRecheck).
 */
async function outsideControl(deps: Deps, rec: Recorder, state: RepoState, scope: "read" | "write"): Promise<void> {
  const service: GitService = scope === "write" ? "git-receive-pack" : "git-upload-pack";
  // The tip for the fetch request is read with the create() token, which is known to work.
  const tip = service === "git-upload-pack" ? await remoteRefValue(rec, "outside-control-tip", state.remote, state.token, `refs/heads/${state.branch}`) : null;
  const token = await withRepo(deps.artifacts, state.name, (repo) => repo.createToken(scope, OUTSIDE_CONTROL_TTL_SECONDS));
  const mintedAtMs = Date.now();
  // Registered as a secret: the only copy in the result is the one under `disclosed`.
  rec.addSecret(token.plaintext);
  const control: OutsideControlState = { token: token.plaintext, remote: state.remote, service, scope, mintedAtMs, expiresAt: token.expiresAt, postBody: postProbeBody(service, tip) };
  const post = { path: `/${service}`, content_type: `application/x-${service}-request`, accept: `application/x-${service}-result`, body: control.postBody };
  const inside = await controlProbes(rec, "outside-control-inside", control);
  deps.warm.e2OutsideControl = control;
  rec.data.outside_control = {
    scope,
    service,
    ttl_seconds: OUTSIDE_CONTROL_TTL_SECONDS,
    minted_at: new Date(mintedAtMs).toISOString(),
    expires_at: token.expiresAt,
    git_user_agent: GIT_CLI_USER_AGENT,
    post_request: { path: post.path, body: tip !== null ? `want ${tip}, done (a fetch of the branch tip)` : "a lone flush-pkt (no wants, no commands)" },
    inside_durable_object: inside,
  };
  rec.verdict.outside_control_inside_statuses = statusLine(inside);
  rec.note(
    `outside control: minted one ${scope} token with a ${OUTSIDE_CONTROL_TTL_SECONDS} s lifetime (${describeToken(token.plaintext)}). ` +
      `From inside the Durable Object, ${inside[0]?.ms_after_mint ?? 0} to ${inside[inside.length - 1]?.ms_after_mint ?? 0} ms after minting: ${statusLine(inside)}. ` +
      "The token is returned under `disclosed` for the same requests from outside Workers. outside-probe.mjs sends them, removes the token from the saved file, " +
      'and then calls e2 with {"outside_control_recheck": true} so the same token is probed from inside once more. Only that second inside probe can tell an origin-dependent refusal from a token that needed time to become valid.',
  );
  rec.disclose({
    purpose: "repeat GET <remote>/info/refs?service=<service> and POST <remote><post.path> from outside Workers with this token before it expires",
    remote: state.remote,
    service,
    scope,
    token: token.plaintext,
    minted_at: new Date(mintedAtMs).toISOString(),
    expires_at: token.expiresAt,
    git_user_agent: GIT_CLI_USER_AGENT,
    post,
  });
}

/**
 * Opt-in control from outside Workers, second half ({"outside_control_recheck": true}).
 * Repeats the inside requests with the token that outsideControl() minted, AFTER the
 * operator's machine has sent its requests. The token is used once and then dropped.
 */
async function outsideControlRecheck(deps: Deps, rec: Recorder): Promise<boolean> {
  const control = deps.warm.e2OutsideControl;
  deps.warm.e2OutsideControl = undefined;
  if (!control) {
    const reason = 'no outside-control token is held in memory: call e2 with {"outside_control": true} first (the token is dropped after one recheck, and when the Durable Object restarts)';
    rec.note(reason);
    rec.verdict.outside_control_recheck = `not run: ${reason}`;
    return false;
  }
  rec.addSecret(control.token);
  const inside = await controlProbes(rec, "outside-control-inside-again", control);
  const expired = Date.now() > Date.parse(control.expiresAt) - EXPIRY_MARGIN_MS;
  const answered = inside.every((p) => p.status !== 0);
  rec.data.outside_control_recheck = {
    scope: control.scope,
    service: control.service,
    minted_at: new Date(control.mintedAtMs).toISOString(),
    expires_at: control.expiresAt,
    token_expired_before_end: expired,
    inside_durable_object: inside,
  };
  rec.verdict.outside_control_recheck = expired ? `not usable: the recheck finished less than ${EXPIRY_MARGIN_MS} ms before the token expired, or after it` : answered ? "done" : "not usable: a request got no HTTP answer";
  rec.verdict.outside_control_recheck_statuses = statusLine(inside);
  rec.note(`outside control, second inside probe (${inside[0]?.ms_after_mint ?? 0} to ${inside[inside.length - 1]?.ms_after_mint ?? 0} ms after minting): ${statusLine(inside)}${expired ? `. The last request finished less than ${EXPIRY_MARGIN_MS} ms before the token expired, or after it, so these statuses are not used` : ""}`);
  return !expired && answered;
}

export const e2: Experiment = async (deps, body, rec) => {
  // The recheck is a request of its own: it needs only the token held in memory.
  if (body.outside_control_recheck === true) return outsideControlRecheck(deps, rec);
  const state = await requireE1(deps);
  rec.addSecret(state.token);
  const tokenWaitMs = intParam(body.token_wait_ms, 30_000, 0, 120_000);
  const outsideScope: "read" | "write" | null = body.outside_control === true || body.outside_control === "read" ? "read" : body.outside_control === "write" ? "write" : null;

  // 1. Mint tokens on the existing repo.
  const minted = await withRepo(deps.artifacts, state.name, async (repo) => {
    const write = await rec.time("createToken_write_ms", () => repo.createToken("write", 3600));
    rec.addSecret(write.plaintext);
    const read = await rec.time("createToken_read_ms", () => repo.createToken("read", 3600));
    rec.addSecret(read.plaintext);
    const listed = await repo.listTokens();
    return {
      write: { plaintext: write.plaintext, id: write.id, scope: write.scope, expiresAt: write.expiresAt },
      read: { plaintext: read.plaintext, id: read.id, scope: read.scope, expiresAt: read.expiresAt },
      listed: { total: listed.total, states: listed.tokens.map((t) => `${t.scope}/${t.state}`) },
    };
  });
  const mintedAt = Date.now();
  rec.note(`createToken("write", 3600): scope=${minted.write.scope} expiresAt=${minted.write.expiresAt} format: ${describeToken(minted.write.plaintext)}`);
  rec.note(`createToken("read", 3600): scope=${minted.read.scope} expiresAt=${minted.read.expiresAt} format: ${describeToken(minted.read.plaintext)}`);
  rec.note(`listTokens(): total=${minted.listed.total} [${minted.listed.states.join(", ")}]`);

  // 2. Probe matrix: one plain GET info/refs per token, auth style and service.
  const tokens: Record<string, string> = { create: state.token, minted_write: minted.write.plaintext, minted_read: minted.read.plaintext };
  const services = ["git-upload-pack", "git-receive-pack"] as const;
  const runMatrix = async (label: string): Promise<Probe[]> => {
    const probes: Probe[] = [];
    for (const service of services) {
      const none = await rawDiscover(rec, `${label}:none`, state.remote, service, null);
      probes.push({ token: "none", style: "none", service, status: none.status });
    }
    for (const [tokenName, token] of Object.entries(tokens)) {
      for (const style of STYLES) {
        for (const service of services) {
          const outcome = await rawDiscover(rec, `${label}:${tokenName}:${style}`, state.remote, service, authHeader(token, style));
          probes.push({ token: tokenName, style, service, status: outcome.status });
        }
      }
    }
    return probes;
  };
  const matrix = await runMatrix("probe");
  rec.data.probe_matrix = matrix;
  rec.note(`probe matrix started ${Date.now() - mintedAt} ms or less after minting; rows are in data.probe_matrix`);
  const statusOf = (rows: Probe[], token: string, style: string, service: string) =>
    rows.find((p) => p.token === token && p.style === style && p.service === service)?.status ?? -1;

  // 3. If a minted token was refused, see whether it starts working (token propagation).
  //    Every auth style that was refused is polled, until each one is accepted or time runs out.
  const refusedStyles = STYLES.filter((s) => statusOf(matrix, "minted_write", s, "git-receive-pack") !== 200);
  let matrixAfterWait: Probe[] | null = null;
  if (refusedStyles.length > 0 && tokenWaitMs > 0) {
    const quiet = rec.quiet();
    const started = Date.now();
    let polls = 0;
    const lastStatus = new Map<AuthStyle, number>();
    const acceptedAfterMs = new Map<AuthStyle, number>();
    while (acceptedAfterMs.size < refusedStyles.length && Date.now() - started < tokenWaitMs) {
      polls++;
      for (const style of refusedStyles) {
        if (acceptedAfterMs.has(style)) continue;
        const outcome = await rawDiscover(quiet, "poll", state.remote, "git-receive-pack", authHeader(minted.write.plaintext, style));
        // The polls are listed as aggregated rows: one row per auth style and status.
        rec.httpCount(`poll-minted-write:${style} GET /info/refs?service=git-receive-pack`, outcome.status, outcome.ms);
        lastStatus.set(style, outcome.status);
        if (outcome.status === 200) acceptedAfterMs.set(style, Date.now() - started);
      }
      if (acceptedAfterMs.size < refusedStyles.length) await sleep(500);
    }
    const waited = Date.now() - started;
    rec.timing("minted_write_token_wait_ms", waited);
    for (const style of refusedStyles) {
      const acceptedMs = acceptedAfterMs.get(style);
      rec.note(
        acceptedMs !== undefined
          ? `minted write token (${style} auth) was refused at first but returned 200 after ${acceptedMs} ms: token propagation delay`
          : `minted write token (${style} auth) still returned ${lastStatus.get(style) ?? "no answer"} after ${waited} ms (${polls} polls)`,
      );
    }
    matrixAfterWait = await runMatrix("probe-after-wait");
    rec.data.probe_matrix_after_wait = matrixAfterWait;
  }
  const finalMatrix = matrixAfterWait ?? matrix;

  // Every request sent with the minted write token after the wait, so the verdict can
  // look at the POSTs too and not only at the GET info/refs probes.
  const mintedWriteCalls: RecordingHttpClient["calls"] = [];

  // 4. Get a local clone at the current head. Prefer the minted write token; fall back to the create() token.
  let clone = await cloneRepo(rec, "clone-minted-write-bearer", { url: state.remote, token: minted.write.plaintext, style: "bearer" }, state.branch);
  mintedWriteCalls.push(...clone.calls);
  rec.note(`clone with minted write token (bearer): ${clone.ok ? `ok in ${clone.ms} ms, head ${clone.head}` : `FAILED (HTTP ${clone.statuses.join(", ")}): ${clone.errorText}`}`);
  const mintedCloneOk = clone.ok;
  if (!clone.ok) {
    clone = await cloneRepo(rec, "clone-create-token-basic", { url: state.remote, token: state.token, style: "basic" }, state.branch);
    rec.note(`control clone with create() token (basic): ${clone.ok ? `ok in ${clone.ms} ms, head ${clone.head}` : `FAILED (HTTP ${clone.statuses.join(", ")}): ${clone.errorText}`}`);
  }

  // 5. Push with the minted write token, once per auth style.
  const pushes: Record<AuthStyle, PushOutcome | null> = { bearer: null, basic: null };
  let controlPush: PushOutcome | null = null;
  let head = state.head;
  if (clone.ok && clone.repo) {
    let lastOid = head;
    for (const style of STYLES) {
      const oid = await commitFiles(clone.repo, { "e2.txt": `pushed with a minted write token, ${style} auth, ${randomSuffix()}\n` }, `spike e2: minted token push (${style})`);
      lastOid = oid;
      const push = await pushRef(rec, `push-minted-write-${style}`, clone.repo, { url: state.remote, token: minted.write.plaintext, style }, { ref: state.branch });
      pushes[style] = push;
      mintedWriteCalls.push(...push.calls);
      rec.timing(`push_minted_write_${style}_ms`, push.ms);
      rec.note(`push with minted write token (${style} auth), commit ${oid}: ${pushSummary(push)}`);
      if (push.ok) head = oid;
    }
    // Control: when no minted-token push landed, push the same commits with the create() token.
    // If that works, the refusal is specific to minted tokens (the symptom of issue 15429).
    if (pushes.bearer?.ok !== true && pushes.basic?.ok !== true) {
      for (const style of ["basic", "bearer"] as const) {
        controlPush = await pushRef(rec, `push-create-token-control-${style}`, clone.repo, { url: state.remote, token: state.token, style }, { ref: state.branch });
        rec.note(`control push of the same commits with the create() token (${style} auth): ${pushSummary(controlPush)}`);
        if (controlPush.ok) {
          head = lastOid;
          break;
        }
      }
    }
  } else {
    rec.note("no local clone could be made, so the minted-token push was not attempted");
  }
  if (head !== state.head) await deps.store.put("e1", { ...state, head } satisfies RepoState);

  // 6. Read token: fetch with both styles, then confirm it cannot push.
  const readClones: Record<AuthStyle, boolean> = { bearer: false, basic: false };
  let readClone: LocalRepo | undefined;
  for (const style of STYLES) {
    const outcome = await cloneRepo(rec, `clone-minted-read-${style}`, { url: state.remote, token: minted.read.plaintext, style }, state.branch);
    readClones[style] = outcome.ok && outcome.head === head;
    rec.timing(`clone_minted_read_${style}_ms`, outcome.ms);
    rec.note(
      `fetch (clone) with minted read token (${style} auth): ${outcome.ok ? `ok in ${outcome.ms} ms, head ${outcome.head}${outcome.head === head ? " (matches the pushed head)" : ` (expected ${head})`}` : `FAILED (HTTP ${outcome.statuses.join(", ")}): ${outcome.errorText}`}`,
    );
    if (outcome.ok && outcome.repo) readClone = outcome.repo;
  }
  // True only when the server refused the push (401, 403 or report-status "ng"). A push that
  // failed for another reason (no answer, 5xx) is "inconclusive", not a refusal.
  let readPushRejected: boolean | string | null = null;
  if (readClone) {
    await commitFiles(readClone, { "should-not-land.txt": "pushed with a read token\n" }, "spike e2: this push must be refused");
    const push = await pushRef(rec, "push-minted-read-bearer", readClone, { url: state.remote, token: minted.read.plaintext, style: "bearer" }, { ref: state.branch });
    if (push.ok) readPushRejected = false;
    else if (push.statuses.some(isAuthRefusal) || pushDecision(push, `refs/heads/${state.branch}`) === false) readPushRejected = true;
    else readPushRejected = `inconclusive (the push failed without a refusal by the server: ${push.errorText ?? `HTTP ${push.statuses.join(", ")}`})`;
    rec.note(`push with minted READ token (should be refused): ${pushSummary(push)}`);
  }

  // 7. Verdict. A refusal counts wherever it happened: on a GET info/refs probe, or on the
  //    POST of a clone or push made with the minted write token.
  const refusals: { request: string; status: number }[] = [];
  for (const p of finalMatrix) {
    if (p.token === "minted_write" && isAuthRefusal(p.status)) refusals.push({ request: `probe GET /info/refs?service=${p.service} (${p.style} auth)`, status: p.status });
  }
  for (const call of mintedWriteCalls) {
    if (isAuthRefusal(call.status)) refusals.push({ request: call.step, status: call.status });
  }
  rec.data.minted_write_token_refusals = refusals;
  const refusedOn = [...new Set(refusals.map((r) => (/ POST \/git-receive-pack/.test(r.request) ? "POST git-receive-pack" : / POST \/git-upload-pack/.test(r.request) ? "POST git-upload-pack" : "GET info/refs")))];
  const createProbeOk = STYLES.some((s) => statusOf(finalMatrix, "create", s, "git-receive-pack") === 200);
  const controlOk = createProbeOk && (controlPush === null || controlPush.ok);
  const mintedProbeOk = STYLES.some((s) => statusOf(finalMatrix, "minted_write", s, "git-receive-pack") === 200);
  const writeOk = pushes.bearer?.ok === true || pushes.basic?.ok === true;
  const readOk = readClones.bearer || readClones.basic;
  if (refusals.length > 0) rec.note(`requests with the minted write token that were refused (401 or 403): ${refusals.map((r) => `${r.request} -> ${r.status}`).join("; ")}`);
  Object.assign(rec.verdict, {
    minted_write_push_bearer: pushes.bearer ? pushes.bearer.ok : "not attempted",
    minted_write_push_basic: pushes.basic ? pushes.basic.ok : "not attempted",
    minted_write_clone_bearer: mintedCloneOk,
    minted_read_fetch_bearer: readClones.bearer,
    minted_read_fetch_basic: readClones.basic,
    read_token_push_refused: readPushRejected,
    create_token_still_accepted: controlOk,
    create_token_control_push: controlPush ? controlPush.ok : writeOk ? "not needed" : "not attempted",
    // No minted-token push landed, the minted write token was refused (401 or 403) on at
    // least one request, and the create() token still works.
    bug_15429_reproduced: !writeOk && refusals.length > 0 && controlOk,
    minted_write_token_got_403: refusals.some((r) => r.status === 403),
    minted_write_token_refused_on: refusedOn,
    needed_token_propagation_wait: matrixAfterWait !== null && mintedProbeOk,
  });

  // 8. Optional control from outside Workers. Last step, so the 60 s token is still valid
  //    when the response reaches the caller.
  if (outsideScope) await outsideControl(deps, rec, state, outsideScope);

  return writeOk && readOk;
};
