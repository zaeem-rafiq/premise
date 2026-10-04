/** e1-create-push: create a repo, then commit three files and push them from memory with the create() token. */
import {
  commitFiles,
  initRepo,
  newLocalRepo,
  pushRef,
} from "../gitops";
import {
  describeToken,
} from "../recorder";
import {
  SEED_FILES,
  createRepo,
  pushSummary,
  pushWithRetry,
  repoName,
  target,
  waitBindingHead,
  withRepo,
  type Experiment,
  type RepoState,
} from "./common";

export const e1: Experiment = async (deps, _body, rec) => {
  const repo = await createRepo(rec, deps.artifacts, repoName("e1"));
  rec.note(`create() returned defaultBranch="${repo.branch}", remote=${repo.remote}, token: ${describeToken(repo.token)}`);

  const local = newLocalRepo();
  await initRepo(local, repo.branch);
  const head1 = await commitFiles(local, SEED_FILES, "spike e1: initial commit (three files)");
  const push1 = await pushWithRetry(rec, "push1-basic", local, target(repo, "basic"), { ref: repo.branch });
  rec.timing("push1_basic_ms", push1.ms);
  rec.note(`push 1 (initial commit ${head1}, create() token, basic auth): ${pushSummary(push1)}`);

  const head2 = await commitFiles(local, { "README.md": `${SEED_FILES["README.md"]}\nSecond commit, pushed with bearer auth.\n` }, "spike e1: second commit");
  const push2 = await pushRef(rec, "push2-bearer", local, target(repo, "bearer"), { ref: repo.branch });
  rec.timing("push2_bearer_ms", push2.ms);
  rec.note(`push 2 (commit ${head2}, create() token, bearer auth): ${pushSummary(push2)}`);

  const pushedHead = push2.ok ? head2 : push1.ok ? head1 : null;
  let bindingSeesHead: boolean | null = null;
  if (pushedHead) {
    const fresh = await waitBindingHead(deps.artifacts, repo.name, repo.branch, pushedHead);
    bindingSeesHead = fresh.matched;
    rec.timing("binding_sees_head_ms", fresh.ms);
    rec.note(
      fresh.matched
        ? `binding log({ref:"${repo.branch}"}) reported the pushed head after ${fresh.ms} ms and ${fresh.staleReads} stale reads`
        : `binding log({ref:"${repo.branch}"}) did NOT report the pushed head within ${fresh.ms} ms; last value ${fresh.last}`,
    );
    const readme = await withRepo(deps.artifacts, repo.name, async (handle) => {
      const blob = await handle.readFile({ ref: repo.branch, path: "README.md" });
      return blob === null ? null : { text: await blob.text(), type: blob.type };
    });
    rec.note(readme === null ? `binding readFile(README.md) returned null` : `binding readFile(README.md) returned ${readme.text.length} chars, type "${readme.type}"`);
  }

  await deps.store.put("e1", { name: repo.name, remote: repo.remote, branch: repo.branch, token: repo.token, head: pushedHead } satisfies RepoState);
  rec.data.repo = { name: repo.name, remote: repo.remote, branch: repo.branch, head: pushedHead };
  Object.assign(rec.verdict, {
    create_token_push_basic: push1.ok,
    create_token_push_bearer: push2.ok,
    binding_sees_pushed_head: bindingSeesHead,
  });
  return pushedHead !== null;
};
