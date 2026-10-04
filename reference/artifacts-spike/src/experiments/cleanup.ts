/** cleanup: delete every repo in the namespace whose name starts with "spike-". */
import {
  errText,
} from "../recorder";
import {
  REPO_PREFIX,
  type Experiment,
} from "./common";

export const cleanup: Experiment = async (deps, body, rec) => {
  const dryRun = body.dry_run === true;
  const listAll = async (): Promise<string[]> => {
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      rec.checkpoint();
      const page = await deps.artifacts.list({ limit: 200, cursor });
      pages++;
      for (const r of page.repos) names.push(r.name);
      cursor = page.cursor;
    } while (cursor && pages < 500);
    return names;
  };
  const all = await rec.time("list_ms", listAll);
  const targets = all.filter((name) => name.startsWith(REPO_PREFIX));
  rec.note(`namespace has ${all.length} repos; ${targets.length} start with "${REPO_PREFIX}"${dryRun ? " (dry run: nothing deleted)" : ""}`);
  const deleted: string[] = [];
  const notFound: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (!dryRun) {
    const queue = [...targets];
    const worker = async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          const result = await deps.artifacts.delete(name);
          (result ? deleted : notFound).push(name);
        } catch (e) {
          rec.checkpoint();
          failed.push({ name, error: errText(e) });
        }
      }
    };
    await rec.time("delete_ms", () => Promise.all(Array.from({ length: 5 }, worker)));
    await deps.store.delete("e1");
    deps.warm.e7 = undefined;
    deps.warm.e2OutsideControl = undefined;
  }
  let remaining: string[] | null = null;
  if (!dryRun) {
    try {
      remaining = (await listAll()).filter((name) => name.startsWith(REPO_PREFIX));
      if (remaining.length > 0) rec.note(`${remaining.length} "${REPO_PREFIX}" repos are still listed right after deletion (deletion may be asynchronous): ${remaining.slice(0, 10).join(", ")}`);
    } catch (e) {
      rec.checkpoint();
      rec.note(`listing after deletion threw ${errText(e)}`);
    }
  }
  for (const f of failed.slice(0, 10)) rec.note(`delete(${f.name}) threw ${f.error}`);
  rec.data.deleted = deleted;
  rec.data.delete_returned_false = notFound;
  rec.data.failed = failed;
  rec.data.would_delete = dryRun ? targets : undefined;
  Object.assign(rec.verdict, { matched: targets.length, deleted: deleted.length, delete_returned_false: notFound.length, failed: failed.length, still_listed_afterwards: remaining?.length ?? null });
  return failed.length === 0;
};
