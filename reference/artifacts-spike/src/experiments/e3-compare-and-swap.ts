/**
 * e3-compare-and-swap: does the server reject an update whose old object id is stale?
 * Can a write token force-push and delete?
 *
 * The stale-old-id probes are fast-forwards with a control, so a refusal of
 * non-fast-forwards cannot be mistaken for old-id enforcement (see Part 2).
 *
 * Every verdict needs the server's own answer. A request that failed (no answer, 5xx, 429)
 * is not a refusal: the verdict is then "inconclusive (...)", never true or false.
 */
import git from "isomorphic-git";
import {
  authHeader,
  chooseCapabilities,
  cloneRepo,
  commitFiles,
  confirmDecision,
  describeReport,
  pushDecision,
  pushRef,
  rawDecision,
  rawReceivePack,
  refResult,
  refusalReason,
  type Decision,
  type PushOutcome,
} from "../gitops";
import {
  ZERO_OID,
} from "../rawgit";
import {
  SEED_FILES,
  pushSummary,
  pushWithRetry,
  rawCommit,
  readRefsUntil,
  seedRepo,
  target,
  type Experiment,
} from "./common";

export const e3: Experiment = async (deps, _body, rec) => {
  const seed = await seedRepo(rec, deps, "e3");
  const { repo, style } = seed;
  const gitTarget = target(repo, style);
  const authorization = authHeader(repo.token, style);
  const branchRef = `refs/heads/${repo.branch}`;

  // --- Part 1: isomorphic-git, two clones at the same head ---
  const cloneA = await cloneRepo(rec, "clone-A", gitTarget, repo.branch);
  const cloneB = await cloneRepo(rec, "clone-B", gitTarget, repo.branch);
  let stalePush: PushOutcome | null = null;
  let forcePush: PushOutcome | null = null;
  let headB: string | null = null;
  // Who refused the stale push. A push that failed (no decision by anybody) is not a refusal.
  let staleRejected: Decision = "not attempted";
  let staleRejectedBy = "not attempted";
  if (cloneA.ok && cloneA.repo && cloneB.ok && cloneB.repo) {
    rec.note(`clones A and B are both at ${cloneA.head} (B: ${cloneB.head})`);
    const headA = await commitFiles(cloneA.repo, { "a.txt": "commit from clone A\n" }, "spike e3: commit from A");
    const pushA = await pushRef(rec, "A-push", cloneA.repo, gitTarget, { ref: repo.branch });
    rec.note(`A pushes ${headA}: ${pushSummary(pushA)}`);
    headB = await commitFiles(cloneB.repo, { "b.txt": "commit from stale clone B\n" }, "spike e3: commit from stale B");
    stalePush = await pushRef(rec, "B-push-noforce", cloneB.repo, gitTarget, { ref: repo.branch });
    const discovered = stalePush.statuses.length > 0 && stalePush.statuses.every((status) => status === 200);
    if (stalePush.ok) {
      staleRejected = false;
      staleRejectedBy = "nobody";
    } else if (stalePush.posted) {
      const decision = pushDecision(stalePush, branchRef);
      staleRejected = decision === false ? true : decision;
      staleRejectedBy = decision === false ? "server" : "nobody (the POST got no decision)";
    } else if (discovered) {
      staleRejected = true;
      staleRejectedBy = "client (no POST sent)";
    } else {
      staleRejected = `inconclusive (the ref discovery failed, so the push was never decided: ${stalePush.errorText ?? `HTTP ${stalePush.statuses.join(", ")}`})`;
      staleRejectedBy = "nobody (the ref discovery failed)";
    }
    rec.note(
      `stale B pushes ${headB} without force: ${pushSummary(stalePush)}. ` +
        (stalePush.posted
          ? "A receive-pack POST was sent, so the answer came from the server."
          : discovered
            ? "No receive-pack POST was sent: isomorphic-git refused on the client after reading the remote ref. This says nothing about the server."
            : "No receive-pack POST was sent, because the ref discovery failed. Nobody refused the push."),
    );
  } else {
    rec.note(`clone failed (A: ${cloneA.errorText ?? "ok"}; B: ${cloneB.errorText ?? "ok"}); skipping the isomorphic-git part`);
  }

  // --- Part 2: raw receive-pack, the real server-side check ---
  //
  // Each probe sends an update whose old id is wrong but whose new commit is a CHILD of the
  // ref's current value. The update is therefore a fast-forward, so a server that refuses
  // non-fast-forwards has no other reason to refuse it.
  //
  //  - false: the ref moved to the probe's commit. The server applied a wrong old id.
  //  - true: the server answered HTTP 200 with report-status "ng" for the ref, the ref did
  //    not move, and the same update with the correct old id (the control) was then applied.
  //  - anything else is "inconclusive": a probe that failed (503, 429, timeout) leaves the
  //    ref unchanged exactly like a refusal does, so it proves nothing about the old id.
  let enforcesOldId: Decision = "inconclusive";
  let rejectsCreateOnExisting: Decision = "inconclusive";
  let staleReason: string | null = null;
  let zeroReason: string | null = null;
  let refReadLagged = false;
  const short = (oid: string | null): string => oid?.slice(0, 8) ?? "unknown";
  /** The refs. `settled` is passed when the server has just reported a change that the read must show. */
  const readRefs = async (step: string, settled?: (refs: Record<string, string>) => boolean): Promise<Record<string, string> | null> => {
    const read = await readRefsUntil(rec, step, repo.remote, authorization, settled);
    if (read.lagged) refReadLagged = true;
    return read.refs;
  };
  /** Value of the default branch, or null. `reportedOk` is the value the server has just reported "ok" for, if any. */
  const readRef = async (step: string, reportedOk?: string): Promise<string | null> =>
    (await readRefs(step, reportedOk === undefined ? undefined : (refs) => refs[branchRef] === reportedOk))?.[branchRef] ?? null;

  const before = await readRefsUntil(rec, "raw-refs-before", repo.remote, authorization);
  if (before.refs && before.refs[branchRef]) {
    const base = before.refs[branchRef]!;
    const caps = chooseCapabilities(before.capabilities);
    rec.note(`receive-pack capabilities: "${before.capabilities.join(" ")}"; sending "${caps.join(" ")}"`);

    const probe = async (label: string, tip: string, wrongOld: string, what: string): Promise<{ enforced: Decision; reason: string | null; tip: string | null }> => {
      const next = rawCommit([tip], { ...SEED_FILES, "raw.txt": `commit for the ${label} probe, child of ${tip}\n` }, `spike e3: raw commit for the ${label} probe`);
      const command = { newOid: next.commit.oid, ref: branchRef };
      const wrong = await rawReceivePack(rec, `raw-${label}`, { url: repo.remote, authorization, commands: [{ ...command, oldOid: wrongOld }], capabilities: caps, objects: next.objects });
      // The server's own answer for the ref: "ok", "ng", or "missing" (no HTTP 200, or no line for the ref).
      const answer = refResult(wrong, branchRef);
      const after = await readRef(`raw-refs-after-${label}`, answer === "ok" ? next.commit.oid : undefined);
      rec.note(`raw fast-forward update sent with ${what} (${short(wrongOld)} -> ${short(next.commit.oid)} while the ref is at ${short(tip)}): ${describeReport(wrong)}; ref is now ${short(after)}`);
      if (after === next.commit.oid) {
        if (answer !== "ok") rec.note(`the ${label} probe got no "ok" from the server, but the ref moved to the probe's commit: the update was applied`);
        return { enforced: false, reason: null, tip: after };
      }
      if (after === null) return { enforced: "inconclusive (the ref could not be read back after the probe)", reason: null, tip: null };
      if (after !== tip) return { enforced: `inconclusive (after the probe the ref is at ${short(after)}, neither the old nor the new value)`, reason: null, tip: after };
      if (answer === "ok") {
        return { enforced: `inconclusive (the server reported "ok" for the update with the wrong old id, but the ref still reads ${short(tip)}; the answer and the refs disagree, so no control was sent)`, reason: null, tip };
      }
      const control = await rawReceivePack(rec, `raw-${label}-control`, { url: repo.remote, authorization, commands: [{ ...command, oldOid: tip }], capabilities: caps, objects: next.objects });
      const afterControl = await readRef(`raw-refs-after-${label}-control`, refResult(control, branchRef) === "ok" ? next.commit.oid : undefined);
      rec.note(`control for the ${label} probe: the same update with the correct old id ${short(tip)}: ${describeReport(control)}; ref is now ${short(afterControl)}`);
      if (afterControl !== next.commit.oid) {
        return {
          enforced: `inconclusive (the server also refused the same update with the correct old id, so the refusal cannot be attributed to the old id; probe: ${describeReport(wrong)}; control: ${describeReport(control)})`,
          reason: answer === "ng" ? refusalReason(wrong, branchRef) : null,
          tip: afterControl,
        };
      }
      if (answer !== "ng") {
        // No "ng" from the server: the probe failed for a reason that says nothing about the old id.
        return {
          enforced: `inconclusive (the probe got no report-status "ng" for the ref: ${describeReport(wrong)}. The ref did not move and the same update with the correct old id was then accepted, but a failed request looks the same as a refusal. Run e3 again)`,
          reason: null,
          tip: afterControl,
        };
      }
      return { enforced: true, reason: refusalReason(wrong, branchRef), tip: afterControl };
    };

    const r1 = rawCommit([base], { ...SEED_FILES, "raw.txt": "first raw commit on top of the current head\n" }, "spike e3: raw commit r1 (correct old id)");
    const good = await rawReceivePack(rec, "raw-correct-old", { url: repo.remote, authorization, commands: [{ oldOid: base, newOid: r1.commit.oid, ref: branchRef }], capabilities: caps, objects: r1.objects });
    const goodAnswer = refResult(good, branchRef);
    const afterGood = await readRef("raw-refs-after-correct-old", goodAnswer === "ok" ? r1.commit.oid : undefined);
    rec.note(`raw update ${short(base)} -> r1 ${short(r1.commit.oid)} with the correct old id: ${describeReport(good)}; ref is now ${short(afterGood)}`);
    if (goodAnswer !== "ok" || afterGood !== r1.commit.oid) {
      enforcesOldId = "inconclusive (the correct-old update did not succeed, so no probe was sent)";
      rejectsCreateOnExisting = enforcesOldId;
    } else {
      // The previous value of the ref is now stale: the ref points at r1.
      const stale = await probe("stale-old", r1.commit.oid, base, "a STALE old id");
      enforcesOldId = stale.enforced;
      staleReason = stale.reason;
      if (stale.enforced === false) rec.note("FINDING: the server applied a fast-forward update whose old id was stale. It does not compare the old id, so concurrent pushers can silently overwrite each other.");
      if (stale.enforced === true) rec.note(`the server answered "ng" to the stale-old update, the ref did not move, and the same update with the correct old id was accepted: the server enforces the old id. Its stated reason: "${stale.reason ?? ""}"`);

      // Claim to create a ref that already exists (old id = zero).
      if (stale.tip === null) {
        rejectsCreateOnExisting = "inconclusive (the current value of the ref could not be read)";
      } else {
        const zero = await probe("zero-old", stale.tip, ZERO_OID, 'a ZERO old id (a "create" of a ref that exists)');
        rejectsCreateOnExisting = zero.enforced;
        zeroReason = zero.reason;
      }
    }
  } else {
    rec.note(`raw part skipped: could not read ${branchRef} from the receive-pack advertisement (${before.message ?? "ref missing"})`);
  }

  // Parts 3 to 5 share one rule: "allowed" is true when the refs show the change, false
  // when the server said no (report-status "ng" or an HTTP 4xx) and the refs confirm that
  // nothing changed, and "inconclusive" when the request or the read-back failed.

  // --- Part 3: force push from stale B (correct old id, not a fast-forward) ---
  let forceAllowed: Decision = "not attempted";
  if (cloneB.repo && headB) {
    const forced = headB;
    forcePush = await pushWithRetry(rec, "B-push-force", cloneB.repo, gitTarget, { ref: repo.branch, force: true });
    const refs = await readRefs("refs-after-force", forcePush.ok ? (r) => r[branchRef] === forced : undefined);
    forceAllowed = confirmDecision(pushDecision(forcePush, branchRef), refs === null ? null : refs[branchRef] === forced);
    rec.note(`stale B pushes ${headB} WITH force: ${pushSummary(forcePush)}; ref is now ${refs?.[branchRef]?.slice(0, 8) ?? "unknown"}`);
  }

  // --- Part 4: delete a branch ---
  let deleteAllowed: Decision = "not attempted";
  const scratch = cloneB.repo ?? cloneA.repo ?? seed.local;
  const tempBranch = "e3-temp";
  const tempRef = `refs/heads/${tempBranch}`;
  await git.branch({ fs: scratch.fs, dir: scratch.dir, ref: tempBranch });
  const createTemp = await pushWithRetry(rec, "temp-branch-create", scratch, gitTarget, { ref: tempBranch, force: true });
  rec.note(`create branch ${tempBranch}: ${pushSummary(createTemp)}`);
  if (createTemp.ok) {
    // The branch must be visible before the delete, or "gone afterwards" would prove nothing.
    const created = await readRefs("refs-after-temp-create", (r) => r[tempRef] !== undefined);
    if (created?.[tempRef] === undefined) {
      deleteAllowed = `inconclusive (the server reported that ${tempBranch} was created, but ${created === null ? "the refs could not be read" : "the refs do not show it"}, so no delete was sent)`;
    } else {
      const del = await pushRef(rec, "temp-branch-delete", scratch, gitTarget, { ref: tempBranch, delete: true });
      const refs = await readRefs("refs-after-delete", del.ok ? (r) => r[tempRef] === undefined : undefined);
      const gone = refs === null ? null : refs[tempRef] === undefined;
      deleteAllowed = confirmDecision(pushDecision(del, tempRef), gone);
      rec.note(`delete branch ${tempBranch}: ${pushSummary(del)}; branch ${gone === null ? "could not be read back" : gone ? "is gone" : "is still advertised"}`);
    }
  }

  // --- Part 5: delete the default branch (raw, correct old id) ---
  let defaultDeleteAllowed: Decision = "not attempted";
  const lastRead = await readRefsUntil(rec, "refs-before-default-delete", repo.remote, authorization);
  const current = lastRead.refs?.[branchRef];
  if (lastRead.refs && current) {
    if (!lastRead.capabilities.includes("delete-refs")) rec.note('the server does not advertise "delete-refs"');
    const del = await rawReceivePack(rec, "default-branch-delete", { url: repo.remote, authorization, commands: [{ oldOid: current, newOid: ZERO_OID, ref: branchRef }], capabilities: chooseCapabilities(lastRead.capabilities), objects: [] });
    const refs = await readRefs("refs-after-default-delete", refResult(del, branchRef) === "ok" ? (r) => r[branchRef] === undefined : undefined);
    const gone = refs === null ? null : refs[branchRef] === undefined;
    defaultDeleteAllowed = confirmDecision(rawDecision(del, branchRef), gone);
    rec.note(`delete the default branch ${repo.branch}: ${describeReport(del)}; branch ${gone === null ? "could not be read back" : gone ? "is gone" : "is still advertised"}`);
  } else {
    rec.note(`the default branch delete was not sent: ${branchRef} could not be read (${lastRead.message ?? "ref missing"})`);
  }

  rec.data.repo = { name: repo.name };
  Object.assign(rec.verdict, {
    server_enforces_old_id: enforcesOldId,
    stale_old_id_refusal_reason: staleReason,
    server_rejects_create_on_existing_ref: rejectsCreateOnExisting,
    zero_old_id_refusal_reason: zeroReason,
    isogit_stale_push_rejected: staleRejected,
    isogit_stale_push_rejected_by: staleRejectedBy,
    force_push_allowed: forceAllowed,
    branch_delete_allowed: deleteAllowed,
    default_branch_delete_allowed: defaultDeleteAllowed,
    // True when a read of the refs did not yet show a change the server had already reported.
    ref_read_lagged_behind_push: refReadLagged,
  });
  return typeof enforcesOldId === "boolean";
};
