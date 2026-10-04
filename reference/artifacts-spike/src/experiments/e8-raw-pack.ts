/**
 * e8-raw-pack: push with a hand-built pack and pkt-lines (no isomorphic-git), including two
 * refs in one request, atomicity, and a ref update that needs no new objects (empty pack).
 *
 * A true or false verdict needs the server's own answer (HTTP 200 with a report-status line
 * for each ref) and refs that agree with it. A request that failed is "inconclusive".
 */
import {
  authHeader,
  chooseCapabilities,
  confirmDecision,
  describeReport,
  rawDecision,
  rawDiscover,
  rawReceivePack,
  refResult,
  refusalReason,
  type AuthStyle,
  type Decision,
  type RawPushOutcome,
} from "../gitops";
import {
  ZERO_OID,
  type GitObject,
} from "../rawgit";
import {
  errText,
} from "../recorder";
import {
  createRepo,
  rawCommit,
  readRefsUntil,
  repoName,
  withRepo,
  type Experiment,
} from "./common";

export const e8: Experiment = async (deps, body, rec) => {
  const repo = await createRepo(rec, deps.artifacts, repoName("e8"));
  // Basic first (the style Cloudflare's isomorphic-git example uses), then bearer, unless the body picks one.
  const styles: AuthStyle[] = body.auth === "bearer" ? ["bearer"] : body.auth === "basic" ? ["basic"] : ["basic", "bearer"];
  const trailingNewline = body.lf === true;
  const tryUnadvertisedAtomic = body.try_unadvertised_atomic !== false;
  const branchRef = `refs/heads/${repo.branch}`;
  const notesRef = "refs/notes/premise";
  const fallbackRef = "refs/heads/e8-probe";

  // 1. Discover refs and capabilities.
  let style = styles[0]!;
  let authorization = authHeader(repo.token, style);
  let first = await rawDiscover(rec, `discover-${style}`, repo.remote, "git-receive-pack", authorization);
  for (const next of styles.slice(1)) {
    if (first.adv) break;
    style = next;
    authorization = authHeader(repo.token, style);
    first = await rawDiscover(rec, `discover-${style}`, repo.remote, "git-receive-pack", authorization);
  }
  if (!first.adv) {
    rec.note(`ref discovery failed: ${first.message}`);
    return false;
  }
  rec.note(`all git traffic in this experiment is hand-built (no isomorphic-git); auth style ${style}; commands ${trailingNewline ? "end with LF" : "have no trailing LF (git CLI style)"}`);
  rec.note(`new repo advertisement: emptyRepo=${first.adv.emptyRepo}, refs=${JSON.stringify(first.adv.refs)}, capabilities="${first.adv.capabilities.join(" ")}"`);
  // Capabilities are re-read on every discovery: a server may advertise none on an empty repo.
  let advertised = first.adv.capabilities;
  // Refs from the latest discovery. Null means the last discovery failed: nothing is known.
  let refs: Record<string, string> | null = first.adv.refs;
  const valueOf = (ref: string): string | null => refs?.[ref] ?? null;
  let counter = 0;
  const files = (): Record<string, string> => {
    counter++;
    return { "README.md": "# hand-built repository\n", "src/app.ts": `export const revision = ${counter};\n`, "docs/notes/readme.txt": "nested directory, to exercise sub-trees\n" };
  };
  type Command = { oldOid: string; newOid: string; ref: string };
  let refReadLagged = false;
  /**
   * Re-read the refs after a push. For every command the server reported "ok", the read must
   * show the new value; a read that does not is repeated a few times (see readRefsUntil).
   * On failure nothing is assumed: `refs` becomes null and the caller reports "inconclusive".
   */
  const refresh = async (step: string, pushed?: { outcome: RawPushOutcome; commands: Command[] }): Promise<boolean> => {
    const reportedOk = pushed ? pushed.commands.filter((c) => refResult(pushed.outcome, c.ref) === "ok") : [];
    const read = await readRefsUntil(rec, step, repo.remote, authorization, reportedOk.length === 0 ? undefined : (r) => reportedOk.every((c) => r[c.ref] === c.newOid));
    if (read.lagged) refReadLagged = true;
    if (!read.refs) {
      refs = null;
      rec.note(`${step}: the refs could not be read back (${read.message}); results that depend on them are reported as inconclusive`);
      return false;
    }
    refs = read.refs;
    if (read.capabilities.length > 0) advertised = read.capabilities;
    return true;
  };
  const send = (step: string, commands: Command[], objects: GitObject[], extraCapabilities: string[] = []) => {
    const capabilities = [...chooseCapabilities(advertised), ...extraCapabilities];
    return rawReceivePack(rec, step, { url: repo.remote, authorization, commands, capabilities, objects, trailingNewline }).then((outcome) => ({ outcome, capabilities, commands }));
  };
  const structured = (outcome: RawPushOutcome) => ({ http_status: outcome.status, post_ms: outcome.ms, request_bytes: outcome.requestBytes, pack_bytes: outcome.packBytes, report: outcome.report ?? null, raw_response_preview: outcome.bodyPreview });

  // 2. Single-ref update.
  const mainAtStart = valueOf(branchRef);
  const c1 = rawCommit(mainAtStart ? [mainAtStart] : [], files(), "spike e8: hand-built commit 1");
  const singlePush = await send("single-ref", [{ oldOid: mainAtStart ?? ZERO_OID, newOid: c1.commit.oid, ref: branchRef }], c1.objects);
  const { outcome: single, capabilities: sentCapabilities } = singlePush;
  rec.timing("single_ref_post_ms", single.ms);
  rec.note(`capabilities sent on pushes: "${sentCapabilities.join(" ")}"`);
  rec.note(`single-ref push (${single.packBytes}-byte pack, ${c1.objects.length} objects): ${describeReport(single)}`);
  rec.note(`raw response preview: ${single.bodyPreview}`);
  rec.data.single_ref = structured(single);
  const singleRead = await refresh("refs-after-single", singlePush);
  const singleOk = singleRead && refResult(single, branchRef) === "ok" && valueOf(branchRef) === c1.commit.oid;
  if (!singleOk) {
    rec.note(singleRead ? `single-ref push did not land (ref is ${valueOf(branchRef)}); stopping` : "single-ref push could not be confirmed because the refs could not be read back; stopping");
    Object.assign(rec.verdict, { single_ref_push: false });
    return false;
  }

  // 3. One request, two refs.
  const notesAtStart = valueOf(notesRef);
  const c2 = rawCommit([c1.commit.oid], files(), "spike e8: hand-built commit 2");
  // The notes on the notes ref. A notes commit is a full snapshot, so each later one carries these forward.
  let notesFiles: Record<string, string> = { [c2.commit.oid]: "premise: note attached by the two-ref push\n" };
  const n1 = rawCommit(notesAtStart ? [notesAtStart] : [], notesFiles, "spike e8: notes commit 1");
  const twoPush = await send(
    "two-refs",
    [
      { oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: branchRef },
      { oldOid: notesAtStart ?? ZERO_OID, newOid: n1.commit.oid, ref: notesRef },
    ],
    [...c2.objects, ...n1.objects],
  );
  const { outcome: two } = twoPush;
  rec.timing("two_ref_post_ms", two.ms);
  rec.data.two_refs = structured(two);
  rec.note(`two-ref push in ONE request (${branchRef} and ${notesRef}): ${describeReport(two)}`);
  const twoRead = await refresh("refs-after-two", twoPush);
  const twoMain = refResult(two, branchRef);
  const twoNotes = refResult(two, notesRef);
  const twoOk = twoRead && twoMain === "ok" && twoNotes === "ok" && valueOf(branchRef) === c2.commit.oid && valueOf(notesRef) === n1.commit.oid;
  if (twoRead) {
    rec.note(`after the two-ref push: ${branchRef}=${valueOf(branchRef)} (${valueOf(branchRef) === c2.commit.oid ? "updated" : "NOT updated"}), ${notesRef}=${valueOf(notesRef)} (${valueOf(notesRef) === n1.commit.oid ? "updated" : "NOT updated"})`);
  }

  // 4. Wrong old id and atomicity: one good command and one command with a wrong old id.
  //
  // Precondition: the second ref must exist at a value this experiment set. Otherwise the
  // "bad" command would be refused for a reason other than its old id (for example a
  // namespace the server does not accept). The notes ref is used when the two-ref push
  // created it; if not, a second branch is created and used instead.
  let probeRef: string | null = null;
  if (twoRead && valueOf(notesRef) === n1.commit.oid) {
    probeRef = notesRef;
  } else if (twoRead || (await refresh("refs-before-probe-branch"))) {
    rec.note(`${notesRef} is not at the commit the two-ref push sent (it is ${valueOf(notesRef) ?? "missing"}), so the wrong-old-id and atomicity probes use the branch ${fallbackRef} instead`);
    const s1 = rawCommit([c1.commit.oid], files(), "spike e8: first commit on the probe branch");
    const createPush = await send("probe-branch-create", [{ oldOid: valueOf(fallbackRef) ?? ZERO_OID, newOid: s1.commit.oid, ref: fallbackRef }], s1.objects);
    const { outcome: created } = createPush;
    const createdRead = await refresh("refs-after-probe-branch-create", createPush);
    rec.note(`create ${fallbackRef}: ${describeReport(created)}`);
    if (createdRead && valueOf(fallbackRef) === s1.commit.oid) probeRef = fallbackRef;
  }
  if (probeRef === null) rec.note("no second ref could be set up at a known value, so the wrong-old-id and atomicity probes were not run");

  // The wrong old id is commit 1: a real object, but not the current value of the probe ref.
  const wrongOld = c1.commit.oid;
  /** Files for a commit on the probe ref: the notes so far plus one more for the notes ref, ordinary files for a branch. */
  const probeFiles = (annotated: string, text: string): Record<string, string> => (probeRef === notesRef ? { ...notesFiles, [annotated]: text } : files());
  const mixed = async (ref: string, step: string, order: "good-first" | "bad-first", extraCapabilities: string[] = []) => {
    const mainBefore = valueOf(branchRef);
    const probeBefore = valueOf(ref);
    if (!mainBefore || !probeBefore) {
      rec.note(`${step}: not sent, because the current refs are not known`);
      return { order, capabilities_sent: null, http_status: null, report: "not sent: the current refs are not known", ref_statuses: null, good_command_status: "missing", bad_command_status: "missing", bad_command_refusal_reason: null, good_ref_updated: null, bad_ref_updated: null };
    }
    const good = rawCommit([mainBefore], files(), `spike e8: ${step} (good command)`);
    // A child of the ref's current value: a fast-forward, so the only fault is the old id.
    const badFiles = probeFiles(good.commit.oid, `premise: note from ${step}\n`);
    const bad = rawCommit([probeBefore], badFiles, `spike e8: ${step} (command with wrong old id)`);
    const goodCommand = { oldOid: mainBefore, newOid: good.commit.oid, ref: branchRef };
    const badCommand = { oldOid: wrongOld, newOid: bad.commit.oid, ref };
    const pushed = await send(step, order === "good-first" ? [goodCommand, badCommand] : [badCommand, goodCommand], [...good.objects, ...bad.objects], extraCapabilities);
    const { outcome, capabilities } = pushed;
    const read = await refresh(`refs-after-${step}`, pushed);
    const result = {
      order,
      capabilities_sent: capabilities as string[] | null,
      http_status: outcome.status as number | null,
      report: describeReport(outcome),
      ref_statuses: outcome.report?.refs ?? null,
      good_command_status: refResult(outcome, branchRef) as string,
      bad_command_status: refResult(outcome, ref) as string,
      bad_command_refusal_reason: refusalReason(outcome, ref),
      // Null when the refs could not be read back: the outcome is then unknown.
      good_ref_updated: read ? valueOf(branchRef) === good.commit.oid : null,
      bad_ref_updated: read ? valueOf(ref) === bad.commit.oid : null,
    };
    if (ref === notesRef && result.bad_ref_updated === true) notesFiles = badFiles;
    const state = (updated: boolean | null) => (updated === null ? "is unknown" : updated ? "WAS updated" : "was not updated");
    rec.note(`${step} (${order}, capabilities "${capabilities.join(" ")}"): ${result.report}; good ref ${state(result.good_ref_updated)}, bad ref ${state(result.bad_ref_updated)}`);
    return result;
  };
  type Mixed = Awaited<ReturnType<typeof mixed>>;
  let goodFirst: Mixed | null = null;
  let badFirst: Mixed | null = null;
  let atomic: Mixed | null = null;
  let controlAccepted: boolean | null = null;
  const atomicAdvertised = advertised.includes("atomic");
  if (probeRef !== null) {
    goodFirst = await mixed(probeRef, "mixed-good-first", "good-first");
    badFirst = await mixed(probeRef, "mixed-bad-first", "bad-first");
    if (atomicAdvertised || tryUnadvertisedAtomic) {
      if (!atomicAdvertised) rec.note('the server does not advertise "atomic"; sending it anyway as a probe (set {"try_unadvertised_atomic": false} to skip)');
      atomic = await mixed(probeRef, "mixed-atomic", "good-first", ["atomic"]);
    }
    // Control: the same kind of update of the probe ref, with the CORRECT old id. It must be
    // accepted; if it is refused too, the refusals above cannot be attributed to the old id.
    const probeNow = valueOf(probeRef);
    if (probeNow) {
      const control = rawCommit([probeNow], probeFiles(c1.commit.oid, "premise: note from the control update\n"), "spike e8: control (correct old id)");
      const controlPush = await send("control-correct-old", [{ oldOid: probeNow, newOid: control.commit.oid, ref: probeRef }], control.objects);
      const { outcome } = controlPush;
      const read = await refresh("refs-after-control-correct-old", controlPush);
      controlAccepted = read ? valueOf(probeRef) === control.commit.oid : null;
      rec.note(`control: update of ${probeRef} with the correct old id: ${describeReport(outcome)}; the ref ${controlAccepted === null ? "could not be read back" : controlAccepted ? "WAS updated" : "was not updated"}`);
    }
  }

  // 4b. A ref update that needs no new objects: a new branch that points at a commit the
  //     server already has. The git CLI sends an empty pack (32 bytes, zero objects) here.
  //     Sent last, so it cannot disturb the probes above.
  const existingCommitRef = "refs/heads/e8-existing-commit";
  let emptyPackAccepted: Decision = "not attempted";
  const tipForEmptyPack = valueOf(branchRef);
  if (tipForEmptyPack) {
    const emptyPush = await send("empty-pack-new-branch", [{ oldOid: valueOf(existingCommitRef) ?? ZERO_OID, newOid: tipForEmptyPack, ref: existingCommitRef }], []);
    const read = await refresh("refs-after-empty-pack-new-branch", emptyPush);
    emptyPackAccepted = confirmDecision(rawDecision(emptyPush.outcome, existingCommitRef), read ? valueOf(existingCommitRef) === tipForEmptyPack : null);
    rec.data.empty_pack_new_branch = structured(emptyPush.outcome);
    rec.note(`new branch ${existingCommitRef} -> ${tipForEmptyPack.slice(0, 8)} (a commit the server already has) sent with an EMPTY pack (${emptyPush.outcome.packBytes} bytes, no objects): ${describeReport(emptyPush.outcome)}`);
  } else {
    rec.note("the empty-pack push was not sent, because the current refs are not known");
  }

  rec.data.receive_pack_capabilities = advertised;
  rec.data.atomicity = { probe_ref: probeRef, without_atomic_capability: { good_first: goodFirst, bad_first: badFirst }, with_atomic_capability: atomic, control_with_correct_old_id_accepted: controlAccepted };

  // 5. Can the binding read the hand-built objects?
  let bindingReads: boolean | null = null;
  const mainNow = valueOf(branchRef);
  try {
    bindingReads = await withRepo(deps.artifacts, repo.name, async (handle) => {
      const log = await handle.log({ ref: repo.branch, limit: 10 });
      const file = await handle.readFile({ ref: repo.branch, path: "docs/notes/readme.txt" });
      const text = file === null ? null : await file.text();
      rec.note(`binding log(${repo.branch}) returned ${log.length} commits, newest ${log[0]?.hash}; readFile(docs/notes/readme.txt) ${text === null ? "returned null" : `returned ${text.length} chars`}`);
      const notesLog = await handle.log({ ref: notesRef, limit: 1 });
      rec.note(`binding log(${notesRef}) returned ${notesLog.length === 0 ? "nothing" : notesLog[0]!.hash}`);
      return mainNow !== null && log[0]?.hash === mainNow && text !== null;
    });
  } catch (e) {
    rec.checkpoint();
    rec.note(`binding read of hand-built objects threw ${errText(e)}`);
    bindingReads = false;
  }

  // "One bad command fails both": a boolean needs HTTP 200, a report-status line for BOTH
  // refs, and refs that agree with those lines. A request that failed leaves both refs
  // unchanged too, and must not read as "the server failed both".
  const failsBoth = (r: Mixed | null): Decision => {
    if (r === null) return "not tested";
    if (r.http_status === null) return "inconclusive (the request was not sent: the current refs were not known)";
    // The refs are the ground truth: only this request carried the bad command's commit.
    if (r.bad_ref_updated === true) return "the wrong-old-id command was APPLIED";
    if (r.http_status !== 200 || r.good_command_status === "missing" || r.bad_command_status === "missing") {
      return `inconclusive (the request got no report-status line for both refs, so it says nothing about atomicity: ${r.report})`;
    }
    if (r.bad_ref_updated === null || r.good_ref_updated === null) return "inconclusive (the refs could not be read back)";
    if (r.bad_command_status !== "ng" || (r.good_command_status === "ok") !== r.good_ref_updated) {
      return `inconclusive (the report-status and the refs disagree: ${r.report}; the good ref ${r.good_ref_updated ? "was" : "was not"} updated, the bad ref was not)`;
    }
    return !r.good_ref_updated;
  };
  /** True when the server itself said "ng" to the wrong-old-id command and the ref stayed where it was. */
  const refusedByServer = (r: Mixed): boolean => r.http_status === 200 && r.bad_command_status === "ng" && r.bad_ref_updated === false;
  let wrongOldRejected: Decision;
  if (probeRef === null || goodFirst === null || badFirst === null) {
    wrongOldRejected = "inconclusive (no second ref could be set up for the probe)";
  } else if ([goodFirst, badFirst, atomic].some((r) => r?.bad_ref_updated === true)) {
    wrongOldRejected = false;
  } else if (!refusedByServer(goodFirst) || !refusedByServer(badFirst)) {
    const unclear = [goodFirst, badFirst].filter((r) => !refusedByServer(r)).map((r) => `${r.order}: ${r.report}`);
    wrongOldRejected = `inconclusive (a probe got no report-status "ng" for the wrong-old-id command with the ref confirmed unchanged; a failed request is not a refusal. ${unclear.join(" | ")})`;
  } else if (controlAccepted !== true) {
    wrongOldRejected = `inconclusive (an update of ${probeRef} with the correct old id was ${controlAccepted === false ? "refused too" : "not confirmed"}, so the refusals cannot be attributed to the old id)`;
  } else {
    wrongOldRejected = true;
  }
  Object.assign(rec.verdict, {
    single_ref_push: singleOk,
    two_ref_push: { [branchRef]: twoMain, [notesRef]: twoNotes, both_updated: twoOk },
    wrong_old_id_rejected: wrongOldRejected,
    wrong_old_id_probe_ref: probeRef,
    wrong_old_id_refusal_reason: goodFirst?.bad_command_refusal_reason ?? null,
    one_bad_command_fails_both_without_atomic: { good_first: failsBoth(goodFirst), bad_first: failsBoth(badFirst) },
    atomic_capability_advertised: atomicAdvertised,
    one_bad_command_fails_both_with_atomic: failsBoth(atomic),
    binding_reads_hand_built_objects: bindingReads,
    new_branch_at_existing_commit_with_empty_pack: emptyPackAccepted,
    // True when a read of the refs did not yet show a change the server had already reported.
    ref_read_lagged_behind_push: refReadLagged,
    single_ref_post_ms: single.ms,
    two_ref_post_ms: two.ms,
  });
  rec.data.repo = { name: repo.name };
  return singleOk && twoOk;
};
