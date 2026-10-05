// test/workerd/agent/real/imported.test.ts — 06-repos.md step 1's last item (IR9 to IR11) in
// local workerd: a real agent on a pool imported from a repository. Everything is real except
// the model — the same stand-in FakeModel behind the `AI` binding as routes.test.ts — plus the
// harness's stand-in Artifacts, whose `import` clones the test's local source repository.
//
//   the open-attempt answer carries the imported context (guide path, <owner>/<name>, branch)
//   the prompt the model reads is the imported variant: `{{GUIDE_PATH}}` is the pool's own
//   README.md, IR10's `outline answers not_a_module` wording, the `Repository:` line (IR11)
//   `guide_first` asks for README.md, not GUIDE.md; CX3 pins the README.md read
//   the model reads the guide, reads a constant by entity, replaces it and submits;
//   `landing.landed` arrives and stock git on the remote shows the landing commit differs
//   from its parent only in that module
//
// The request names no `branch` — the route resolves the remote's default off the stand-in
// `import`'s `defaultBranch` answer (the clone's checked-out branch), so `main` reaches the
// prompt's Repository line through the whole chain, not from the test's own constant.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../git/helpers.ts";
import { bearer, eventsOf } from "../../collide/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../../landing/harness.ts";
import { waitFor } from "../../trunk/harness.ts";
import { FakeModel } from "./harness.ts";
import { importedFills, firstUserMessage, systemPrompt } from "../../../../src/protocol/agent-prompt.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";

const SOURCE = "src-agent"; // the local repository the stand-in `import` clones
const POOL = "imp-agent";
const TSMOD = "src/config.ts"; // a TypeScript module; CAP is edited by entity
const INTENT = "raise CAP to 8";

/** The imported source tree: a README.md guide (the first guide file it holds) and two
 * TypeScript modules — `CAP` is the constant the model's `replace` changes. */
function fillSource(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# the agent fixture\nwork at entity level; keep changes small.\n");
  writeFileSync(
    join(dir, TSMOD),
    'export const CAP: number = 4;\n\nexport function label(): string {\n  return "cap";\n}\n',
  );
  writeFileSync(join(dir, "src/other.ts"), "export const OTHER = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "the source tree"]);
}

// The model's turns: the guide first (IR9's own `guide_first` asks for README.md — a read of
// GUIDE.md would not count, and none exists), then the constant by entity, the replace, submit.
const SCRIPT = [
  { tool_calls: [{ name: "list", arguments: { path: "/" } }] },
  { tool_calls: [{ name: "read", arguments: { path: "README.md" } }] },
  { tool_calls: [{ name: "read", arguments: { path: TSMOD, entity: "CAP" } }] },
  {
    tool_calls: [
      {
        name: "replace",
        arguments: { path: TSMOD, old: "export const CAP: number = 4;", new: "export const CAP: number = 8;" },
      },
    ],
  },
  { tool_calls: [{ name: "submit", arguments: { summary: INTENT } }] },
  // A spare submit with a statement in case a heads-up interrupted the first (TD6).
  {
    tool_calls: [
      {
        name: "submit",
        arguments: { summary: INTENT, statement: "checked the heads-up: nothing relied on the old cap" },
      },
    ],
  },
];

describe("a real agent lands on an imported pool (06-repos step 1, IR9-IR11)", () => {
  let model: FakeModel;
  let worker: LandingWorker;

  beforeAll(async () => {
    model = new FakeModel();
    await model.listen();
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: [],
      importSources: [SOURCE],
      modelUrl: model.url,
    });
    fillSource(worker.repoDir(SOURCE));
    // The create names no branch: the stand-in import's `defaultBranch` resolves it.
    const res = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, source: { url: `https://github.com/tldrs/${SOURCE}` }, request_id: "r-imp-agent" }),
    );
    expect(res.status, `create: ${await res.clone().text()}`).toBe(200);
    await waitFor(async () => (await worker.eventTypes(POOL)).includes("pool.files"), 60_000);
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
    await model?.close();
  });

  it("the model reads the pool's guide, edits the constant by entity, submits; the commit diffs only that module", async () => {
    model.script = [...SCRIPT];
    model.requests = [];

    const res = await worker.fetch(
      `/api/pools/${POOL}/intents`,
      bearer({ text: INTENT, race: false, prewritten: false, request_id: "r-intent-imp" }),
    );
    expect(res.status, `intent: ${await res.clone().text()}`).toBe(200);

    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length >= 1, 180_000);

    // The landing commit sits on the imported head and changes only the module (IR5).
    const landed = (await eventsOf(worker, POOL, "landing.landed"))[0];
    const commit = String(landed?.commit);
    const repo = worker.repoDir(POOL);
    const parent = git(repo, ["rev-parse", `${commit}^`]);
    expect(parent).toBe(git(worker.repoDir(SOURCE), ["rev-parse", "refs/heads/main"]));
    expect(git(repo, ["diff", "--name-only", parent, commit]).split("\n")).toEqual([TSMOD]);
    expect(git(repo, ["show", `${commit}:${TSMOD}`])).toContain("export const CAP: number = 8;");
    git(repo, ["fsck", "--strict"]);

    // The requests the model saw carry the imported prompt variant (IR9 to IR11): the guide
    // path is the pool's own README.md, IR10's wording, and the Repository line of IR11.
    expect(model.requests.length).toBeGreaterThanOrEqual(5);
    const first = model.requests[0]!.request.messages as Array<{ role: string; content: string }>;
    const system = first[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("Read the guide first: call read with path README.md. Follow its rules.");
    expect(system.content).toContain("Read a whole file only when outline answers not_a_module");
    expect(system.content).not.toContain("GUIDE.md");
    // IR11: `Repository: <owner>/<name> (<branch>)` after the request — the branch resolved
    // from the import's defaultBranch, never from the request.
    expect(first[1]).toEqual({
      role: "user",
      content: `Request:\n${INTENT}\nRepository: tldrs/${SOURCE} (main)\n\nRead README.md first. Then make the change and call submit.`,
    });
    // Every request repeats the same imported system prompt — and it is exactly the variant
    // the prompt module builds from the context the open-attempt answer carried.
    const fills = importedFills({ guide_path: "README.md", source: `tldrs/${SOURCE}`, branch: "main" });
    for (const r of model.requests) {
      const messages = r.request.messages as Array<{ role: string; content: string }>;
      expect(messages[0]).toEqual({ role: "system", content: systemPrompt(fills) });
    }
    expect(first[1]).toEqual({ role: "user", content: firstUserMessage(INTENT, fills) });
  }, 240_000);

  it("guide_first names README.md — a submit before the guide read is refused by the pool's own path", async () => {
    // A model that skips the guide: the refusal's detail and sentence both name the pool's
    // guide_path. The run then reads the guide and lands nothing more (script ends; the pool
    // is unchanged — this attempt stays open, the first test's landing stands).
    model.script = [
      { tool_calls: [{ name: "submit", arguments: { summary: "too early" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] }, // wrong guide: not_found
      { tool_calls: [{ name: "list", arguments: { path: "/" } }] },
    ];
    model.requests = [];
    const res = await worker.fetch(
      `/api/pools/${POOL}/intents`,
      bearer({ text: "submit at once", race: false, prewritten: false, request_id: "r-intent-early" }),
    );
    expect(res.status).toBe(200);
    await waitFor(async () => model.requests.length >= 3, 90_000);

    // The refused submit's tool row is the message the model read back.
    const second = model.requests[1]!.request.messages as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;
    const refused = second.find((m) => m.role === "tool" && m.content.includes("guide_first"));
    expect(refused).toBeDefined();
    const body = JSON.parse(refused!.content) as { error: { code: string; message: string; detail: { path: string } } };
    expect(body.error.code).toBe("guide_first");
    expect(body.error.detail.path).toBe("README.md");
    expect(body.error.message).toContain("README.md");
    expect(body.error.message).not.toContain("GUIDE.md");

    // The wrong-guide read answered not_found through the real Trunk (no GUIDE.md in the tree).
    const third = model.requests[2]!.request.messages as Array<{ role: string; content: string }>;
    const notFound = third.find((m) => m.role === "tool" && m.content.includes("not_found"));
    expect(notFound).toBeDefined();
  }, 180_000);
});
