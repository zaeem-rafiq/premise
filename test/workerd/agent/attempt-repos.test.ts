// 04-build-plan 2.5 item 7: full local workerd, actual smart-HTTP checkpoint
// pushes, and stock-git tree reads. Expected limits/backoffs are S3a's 4 and
// three retries at 2/4/8 seconds; they do not come from implementation output.
import { afterEach, describe, expect, it } from "vitest";
import { git, refValue } from "../../git/helpers.ts";
import { FakeModel, waitFor } from "./real/harness.ts";
import { RETURNED_TOKEN, startAttemptWorker, type AttemptWorker } from "./attempt-repos-harness.ts";

const KEY = "owner-key-for-attempt-repo-tests-0123456789abcdef";
const FILE = "creatures/jellyfish.js";
const SOURCE = `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "cyan";

export function spawn() {
  return { vy: 1 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;

function landingScript() {
  return [
    { tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] },
    { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
    { tool_calls: [{ name: "read", arguments: { path: "creatures/fish.js" } }] },
    { tool_calls: [{ name: "write", arguments: { path: FILE, content: SOURCE } }] },
    { tool_calls: [{ name: "submit", arguments: { summary: "a jellyfish that drifts up and down" } }] },
    ...Array.from({ length: 2 }, () => ({
      tool_calls: [
        {
          name: "submit",
          arguments: {
            summary: "a jellyfish that drifts up and down",
            statement: "checked the heads-up: nothing relied on those changed files",
          },
        },
      ],
    })),
  ];
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

let worker: AttemptWorker | null = null;
let model: FakeModel | null = null;
afterEach(async () => {
  await worker?.dispose();
  await model?.close();
  worker = null;
  model = null;
});

async function fixture(enabled: boolean): Promise<{ worker: AttemptWorker; model: FakeModel }> {
  model = new FakeModel();
  await model.listen();
  worker = await startAttemptWorker({ ownerKey: KEY, modelUrl: model.url, enabled });
  return { worker, model };
}

async function createPool(worker: AttemptWorker, pool: string): Promise<void> {
  const response = await worker.fetch(
    "/api/pools",
    post({ pool, seed: "tidepool", summary_only: false, request_id: `create-${pool}` }),
  );
  expect(response.status).toBe(200);
  await waitFor(() => {
    const dir = worker.repoDir("pools", pool);
    return dir !== "" && refValue(dir, "refs/heads/main") !== null;
  }, 60_000);
}

async function intent(worker: AttemptWorker, pool: string, requestId: string): Promise<string> {
  const response = await worker.fetch(
    `/api/pools/${pool}/intents`,
    post({
      text: "a jellyfish that drifts up and down",
      race: false,
      prewritten: false,
      request_id: requestId,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { intent_id: string };
  let attemptId = "";
  await waitFor(async () => {
    const event = (await worker.events(pool)).find(
      (event) => event.type === "attempt.opened" && event.intent_id === body.intent_id,
    );
    attemptId = String(event?.attempt_id ?? "");
    return attemptId !== "";
  });
  return attemptId;
}

async function repoEvents(worker: AttemptWorker, pool: string, attemptId?: string) {
  return (await worker.events(pool)).filter(
    (event) => event.type === "attempt.repo" && (attemptId === undefined || event.attempt_id === attemptId),
  );
}

async function landing(worker: AttemptWorker, pool: string): Promise<Record<string, unknown>> {
  let landed: Record<string, unknown> | undefined;
  await waitFor(async () => {
    landed = (await worker.events(pool)).find((event) => event.type === "landing.landed");
    return landed !== undefined;
  }, 90_000);
  return landed!;
}

type ProvisionRow = { attempt_id: string; tries: number; due_at: number; last_completed_at: number; status: string };
async function provisionRow(worker: AttemptWorker, attemptId: string): Promise<ProvisionRow | undefined> {
  const response = await worker.object("GATE", "premise").fetch("/internal/state");
  const body = (await response.json()) as { attempt_repositories: ProvisionRow[] };
  return body.attempt_repositories.find((row) => row.attempt_id === attemptId);
}

describe("attempt repositories: 04-build-plan 2.5 item 7", () => {
  it("AG5 S3 S3b SE22: a real-agent landing archives the three metadata files and touched view with explicitly minted write tokens", async () => {
    const { worker, model } = await fixture(true);
    const pool = "p-attempt-success";
    await createPool(worker, pool);
    model.script = landingScript();
    const firstTurn = model.hold();
    let attemptId = "";
    try {
      attemptId = await intent(worker, pool, "attempt-success");
      await waitFor(async () => {
        const response = await worker.object("AGENT", attemptId).fetch("/internal/inspect");
        const inspection = (await response.json()) as { meta: Record<string, string> };
        return inspection.meta.repo_notified === "1";
      });
    } finally {
      firstTurn.release();
    }
    const landed = await landing(worker, pool);
    await waitFor(async () => (await repoEvents(worker, pool, attemptId)).length === 1);
    expect(await repoEvents(worker, pool, attemptId)).toEqual([
      expect.objectContaining({ attempt_id: attemptId, src: "agent", ok: true, error: null, ms: expect.any(Number) }),
    ]);
    const repo = worker.provisionCalls[0]!.repo;
    expect(JSON.parse(String(landed.note_json)).attempt.repo).toBe(repo);
    expect(worker.provisionCalls).toHaveLength(1);
    expect(worker.provisionCalls[0]!.method).toBe("create");
    const directory = worker.repoDir("attempts", repo);
    await waitFor(() => {
      if (refValue(directory, "refs/heads/attempt") === null) return false;
      try {
        return git(directory, ["show", `refs/heads/attempt:files/${FILE}`]) === SOURCE.trimEnd();
      } catch {
        return false;
      }
    }, 30_000);
    const paths = git(directory, ["ls-tree", "-r", "--name-only", "refs/heads/attempt"]).split("\n");
    expect(paths).toEqual(expect.arrayContaining(["transcript.jsonl", "ops.json", "premises.json", `files/${FILE}`]));
    const transcriptText = git(directory, ["show", "refs/heads/attempt:transcript.jsonl"]);
    const transcript = transcriptText.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(transcript.some((row) => row.role === "system")).toBe(true);
    expect(transcript.some((row) => row.tool === "submit")).toBe(true);
    expect(transcript.some((row) => row.tool === "write")).toBe(true);
    const ops = JSON.parse(git(directory, ["show", "refs/heads/attempt:ops.json"])) as Array<Record<string, unknown>>;
    expect(ops).toEqual(expect.arrayContaining([expect.objectContaining({ path: FILE })]));
    const premises = JSON.parse(git(directory, ["show", "refs/heads/attempt:premises.json"])) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(premises)).toBe(true);
    expect(premises.length).toBeGreaterThan(0);
    git(directory, ["fsck", "--full"]);
    // The repository is private in ATTEMPTS. No fake POOLS repository with
    // the attempt name exists, and no public route returns its contents.
    expect(worker.repoDir("pools", repo)).toBe("");
    expect((await worker.fetch(`/api/pools/${pool}/attempts/${attemptId}/repo`)).status).toBe(404);
    expect((await worker.fetch(`/api/pools/${pool}/attempts/${attemptId}/repo/read-token`, post({}))).status).toBe(404);
    const tokens = worker.mintCalls.filter((call) => call.namespace === "attempts");
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).toMatchObject({ repo, scope: "write" });
      expect(typeof token.ttl).toBe("number");
      expect(Number(token.ttl)).toBeGreaterThan(0);
    }
    const pushes = worker.gitRequests().filter((request) => request.path.startsWith(`/attempts--${repo}/`));
    expect(pushes.some((request) => request.method === "POST")).toBe(true);
    for (const push of pushes) expect(push.authorization).toBe(`Bearer minted-attempts--${repo}-write`);
    expect(JSON.stringify(await worker.events(pool))).not.toContain(RETURNED_TOKEN);
    expect(transcriptText).not.toContain(RETURNED_TOKEN);
    expect(transcriptText).not.toContain(KEY);
    expect(git(worker.repoDir("pools", pool), ["show", `${String(landed.commit)}:${FILE}`])).toBe(SOURCE.trimEnd());
  }, 120_000);

  it("AG5 S3a S3c: a held failing provisioner cannot delay landing, then three alarm retries emit one failure and the accepted note keeps repo null", async () => {
    const { worker, model } = await fixture(true);
    const pool = "p-attempt-failure";
    await createPool(worker, pool);
    worker.holdProvisioning();
    worker.failProvisioning();
    model.script = landingScript();
    const attemptId = await intent(worker, pool, "attempt-failure");
    await waitFor(() => worker.inFlight === 1);
    const landed = await landing(worker, pool);
    expect(worker.inFlight).toBe(1);
    expect(await repoEvents(worker, pool, attemptId)).toEqual([]);
    const note = JSON.parse(String(landed.note_json)) as { attempt: { repo: string | null } };
    expect(note.attempt.repo).toBeNull();
    worker.releaseProvisioning();
    for (const [index, backoff] of [2_000, 4_000, 8_000].entries()) {
      let row: ProvisionRow | undefined;
      await waitFor(async () => {
        row = await provisionRow(worker, attemptId);
        const completedAt = worker.provisionCalls[index]?.completed_at;
        return (
          row?.tries === index + 1 &&
          completedAt !== null &&
          completedAt !== undefined &&
          row.last_completed_at >= completedAt &&
          row.due_at > row.last_completed_at
        );
      });
      expect(row!.due_at - row!.last_completed_at).toBe(backoff);
      expect(await repoEvents(worker, pool, attemptId)).toEqual([]);
      expect(worker.provisionCalls).toHaveLength(index + 1);
      const response = await worker.object("GATE", "premise").fetch("/internal/alarm", post({ now: row!.due_at }));
      expect(response.status).toBe(200);
    }
    await waitFor(async () => (await repoEvents(worker, pool, attemptId)).length === 1);
    expect(worker.provisionCalls).toHaveLength(4);
    expect(await repoEvents(worker, pool, attemptId)).toEqual([
      expect.objectContaining({
        attempt_id: attemptId,
        src: "agent",
        ok: false,
        ms: expect.any(Number),
        error: expect.any(String),
      }),
    ]);
    expect(worker.mintCalls.filter((call) => call.namespace === "attempts")).toEqual([]);
    expect((await worker.events(pool)).filter((event) => event.type === "landing.landed")).toHaveLength(1);
    expect(JSON.parse(String(landed.note_json)).attempt.repo).toBeNull();
  }, 120_000);

  it("S3a AG5: twelve real attempts across two pools share the deployment-wide maximum of four provisioning calls", async () => {
    const { worker, model } = await fixture(true);
    const pools = ["p-attempt-many-a", "p-attempt-many-b"];
    for (const pool of pools) await createPool(worker, pool);
    worker.holdProvisioning();
    model.script = Array.from({ length: 12 }, () => ({ content: "Nothing further to change.", finish_reason: "stop" }));
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => intent(worker, pools[i % 2]!, `attempt-many-${i}`)),
    );
    await waitFor(() => worker.inFlight === 4);
    expect(attempts).toHaveLength(12);
    expect(new Set(attempts).size).toBe(12);
    expect(worker.provisionCalls).toHaveLength(4);
    expect(worker.maxInFlight).toBe(4);
    worker.releaseProvisioning();
    await waitFor(async () => {
      const results = await Promise.all(pools.map((pool) => repoEvents(worker, pool)));
      return results.flat().length === 12;
    }, 45_000);
    expect(worker.provisionCalls).toHaveLength(12);
    expect(worker.maxInFlight).toBeLessThanOrEqual(4);
    const events = (await Promise.all(pools.map((pool) => repoEvents(worker, pool)))).flat();
    expect(events.every((event) => event.ok === true && event.src === "agent")).toBe(true);
    expect(new Set(events.map((event) => event.attempt_id)).size).toBe(12);
  }, 120_000);

  it("AG5 S3c: a blocked checkpoint push cannot delay landing and submit/end checkpoints coalesce to one in-flight push", async () => {
    const { worker, model } = await fixture(true);
    const pool = "p-attempt-push-held";
    await createPool(worker, pool);
    worker.holdPushes();
    model.script = landingScript();
    const attemptId = await intent(worker, pool, "attempt-push-held");
    await waitFor(() => worker.pushesInFlight === 1, 30_000);
    const landed = await landing(worker, pool);
    expect(worker.pushesInFlight).toBe(1);
    // Trunk has landed; Agent learns that fact through its normal watchdog
    // sync (AG3). Drive that alarm instead of waiting thirty real seconds,
    // which would deliberately exhaust the twenty-second git transport limit.
    const beforeSync = await worker.object("AGENT", attemptId).fetch("/internal/inspect");
    const before = (await beforeSync.json()) as { timers: Array<{ kind: string; due_at: number }> };
    const watchdog = before.timers.find((timer) => timer.kind === "watchdog");
    if (watchdog !== undefined) {
      expect((await worker.object("AGENT", attemptId).fetch(`/internal/alarm?now=${watchdog.due_at}`)).status).toBe(
        200,
      );
    }
    let latest = 0;
    await waitFor(async () => {
      const response = await worker.object("AGENT", attemptId).fetch("/internal/inspect");
      const inspection = (await response.json()) as { meta: Record<string, string> };
      latest = Number(inspection.meta.checkpoint_requested);
      return (
        inspection.meta.state === "landed" && latest >= 2 && Number(inspection.meta.checkpoint_captured) === latest
      );
    });
    // Even a recovery alarm cannot launch the same attempt's next push
    // while the current receive-pack request is held at the remote.
    const alarm = await worker.object("AGENT", attemptId).fetch(`/internal/alarm?now=${Date.now() + 2_000}`);
    expect(alarm.status).toBe(200);
    expect(worker.maxConcurrentPushesPerAttempt).toBe(1);
    expect(worker.pushesInFlight).toBe(1);
    worker.releasePushes();
    await waitFor(async () => {
      const response = await worker.object("AGENT", attemptId).fetch("/internal/inspect");
      const inspection = (await response.json()) as { meta: Record<string, string> };
      return Number(inspection.meta.checkpoint_pushed) === latest && worker.pushesInFlight === 0;
    }, 30_000);
    expect(worker.maxConcurrentPushesPerAttempt).toBe(1);
    const repo = worker.provisionCalls[0]!.repo;
    const directory = worker.repoDir("attempts", repo);
    expect(git(directory, ["show", `refs/heads/attempt:files/${FILE}`])).toBe(SOURCE.trimEnd());
    const commits = Number(git(directory, ["rev-list", "--count", "refs/heads/attempt"]));
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(latest);
    expect(git(worker.repoDir("pools", pool), ["show", `${String(landed.commit)}:${FILE}`])).toBe(SOURCE.trimEnd());
  }, 120_000);

  it("FJ1 S3 AG5: switch off makes no provisioning call or attempt.repo event while a real-agent landing remains unchanged", async () => {
    const { worker, model } = await fixture(false);
    const pool = "p-attempt-off";
    await createPool(worker, pool);
    model.script = landingScript();
    const attemptId = await intent(worker, pool, "attempt-off");
    const landed = await landing(worker, pool);
    expect(worker.provisionCalls).toEqual([]);
    expect(worker.mintCalls.filter((call) => call.namespace === "attempts")).toEqual([]);
    expect(await repoEvents(worker, pool, attemptId)).toEqual([]);
    expect(JSON.parse(String(landed.note_json)).attempt.repo).toBeNull();
    expect(git(worker.repoDir("pools", pool), ["show", `${String(landed.commit)}:${FILE}`])).toBe(SOURCE.trimEnd());
  }, 120_000);

  it("S3 AG5: synthetic scripted agents never provision an attempt repository even with the switch on", async () => {
    const { worker } = await fixture(true);
    const pool = "p-attempt-synthetic";
    await createPool(worker, pool);
    const id = "a_synthetic_attempt_repo_exclusion";
    const opened = await worker.object("TRUNK", pool).fetch(
      "/internal/open-attempt",
      post({
        attempt_id: id,
        intent: "a jellyfish that drifts up and down",
        agent_kind: "synthetic",
        truth: [],
        requester: "swarm",
      }),
    );
    expect(opened.status).toBe(200);
    const ids = (await opened.json()) as { attempt_id: string; intent_id: string; change_id: string };
    const response = await worker.object("AGENT", id).fetch(
      "/open",
      post({
        pool,
        ...ids,
        agent_kind: "synthetic",
        model: null,
        script: {
          pattern: "add-plain",
          truth: [],
          steps: landingScript().flatMap((turn) =>
            turn.tool_calls.map((call) => ({ tool: call.name, args: call.arguments })),
          ),
        },
      }),
    );
    expect(response.status).toBe(200);
    // A completed landing covers the whole synthetic path, including the
    // background submit and terminal checkpoints that real agents use.
    await landing(worker, pool);
    expect(worker.provisionCalls).toEqual([]);
    expect(worker.mintCalls.filter((call) => call.namespace === "attempts")).toEqual([]);
    expect(await repoEvents(worker, pool)).toEqual([]);
  }, 90_000);
});
