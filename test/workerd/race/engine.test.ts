// Pure engine unit tests live here to stay inside Slice 12's permitted test paths.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Trunk } from "../../../src/core/trunk/registry.ts";
import type { ToolRequest } from "../../../src/protocol/tools.ts";
import { sqlOver } from "../../cases/driver.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("race timing on the injected engine clock (RC2, RC3)", () => {
  it("CK8/T12: pending triage waits in submitted, then holds the race instead of landing automatically", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    let now = 1_000;
    const trunk = Trunk.create(
      sqlOver(db),
      {
        ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
        "source.js": "export const value = 1;\n",
      },
      { now: () => now },
    );
    trunk.pushOk();
    let n = 0;
    const call = (attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
      const ack = trunk.pool.attempts.get(attempt_id)!.next_hn - 1;
      const answer = trunk.tool({ attempt_id, call_id: `call-${++n}`, ack, tool, args });
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      return answer;
    };
    trunk.openAttempt("reader", { intent: "add an independent value", race: true });
    call("reader", "read", { path: "source.js", entity: "value" });
    call("reader", "write", { path: "candidate.js", content: "export const candidate = 3;\n" });
    trunk.openAttempt("writer", { intent: "change the source value" });
    call("writer", "read", { path: "source.js", entity: "value" });
    call("writer", "replace", { path: "source.js", old: "value = 1", new: "value = 2" });
    expect(call("writer", "submit", { summary: "Change source" }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.pendingTriage).toHaveLength(1);
    now = 3_999;
    expect(call("reader", "submit", { summary: "Add candidate" }).result).toMatchObject({ status: "submitted" });
    const card = trunk.pool.cards[0]!;
    expect(card.body.candidates?.reader).toMatchObject({ state: "submitted", can_choose: false });
    expect(trunk.owner({ action: "choose", attempt: "reader" })).toMatchObject({ ok: false });
    trunk.tick();
    expect(trunk.state("reader")).toBe("submitted");
    now = 10_000;
    trunk.triage({ attempt: "reader", kind: "entity", key: "source.js#value", p: 0 });
    expect(trunk.state("reader")).toBe("held");
    expect(trunk.pool.attempts.get("reader")!.validated_at).toBeNull();
    expect(card.body.candidates?.reader).toEqual({ state: "held", can_choose: true, seconds: 2, cost_usd: null });
    trunk.tick();
    expect(trunk.state("reader")).toBe("held");
    expect(card.open).toBe(true);
    expect(trunk.pool.cards).toHaveLength(1);
  });

  it.each(["auto", "held"] as const)(
    "%s candidate records whole seconds from its own opening, across reopen and resubmit",
    (tier) => {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      const sql = sqlOver(db);
      let now = 1_000;
      let trunk = Trunk.create(
        sql,
        { ".premise/policy.json": JSON.stringify({ v: 1, default: tier }) },
        { now: () => now },
      );
      trunk.openAttempt("first", { intent: "one intent", intent_id: "race", race: true });
      now = 10_000;
      trunk.openAttempt("second", { intent: "one intent", intent_id: "race", race: true });
      now = 11_000;
      trunk = Trunk.open(sql, { now: () => now });
      // A duplicate open must not restart the elapsed clock.
      trunk.openAttempt("second", { intent: "ignored retry", intent_id: "race", race: true });
      let n = 0;
      const call = (tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
        const answer = trunk.tool({ attempt_id: "second", call_id: `call-${++n}`, ack: 0, tool, args });
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
        return answer;
      };
      call("write", { path: "candidate.js", content: "export const candidate = 1;\n" });
      now = 12_999;
      const submitted = call("submit", { summary: "Add candidate" });
      expect(submitted.result).toMatchObject({ status: "held", tier });
      expect(trunk.pool.cards).toHaveLength(1);
      const card = trunk.pool.cards[0]!;
      expect(card.kind).toBe("race");
      expect(card.body.candidates?.second).toEqual({ state: "held", can_choose: true, seconds: 2, cost_usd: null });
      const durable = JSON.parse(String(sql.exec("SELECT body FROM cards").toArray()[0]!.body));
      expect(durable.candidates.second.seconds).toBe(2);

      now = 15_000;
      call("submit", { summary: "Add candidate" });
      expect(card.body.candidates?.second?.seconds).toBe(2);
      call("write", { path: "candidate.js", content: "export const candidate = 2;\n" });
      expect(card.open).toBe(true);
      expect(card.body.candidates?.second).toMatchObject({ state: "working", can_choose: false });
      expect(trunk.owner({ action: "choose", attempt: "second" })).toMatchObject({ ok: false });
      expect(card.open).toBe(true);
      expect(trunk.state("first")).toBe("opened");
      now = 18_250;
      call("submit", { summary: "Revise candidate" });
      expect(card.body.candidates?.second).toEqual({ state: "held", can_choose: true, seconds: 8, cost_usd: null });
      expect(trunk.pool.cards).toHaveLength(1);
      trunk.stop({ attempt_id: "second", reason: "cancelled" });
      expect(card.open).toBe(true);
      expect(card.body.candidates?.second).toMatchObject({ state: "stopped", can_choose: false });
      trunk.stop({ attempt_id: "first", reason: "cancelled" });
      expect(card.open).toBe(false);
      expect(trunk.out.events).toContain("card.closed");
    },
  );
});
