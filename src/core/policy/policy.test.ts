// The policy file of 01-core.md 10.1 and the rules PO1-PO5. The policy text is the one
// 02-tidepool.md section 6 pins for the seed, byte for byte; DEFAULT_GLOBALS and the caps come
// from src/protocol/constants.ts (Appendix C).

import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBALS, MAX_CHANGE_BYTES, MAX_PATHS } from "../../protocol/constants.ts";
import { changeTier, CLOSED_POLICY, globMatch, parsePolicy, policyOf, tierOfPath } from "./policy.ts";

// `.premise/policy.json` of the tide pool seed (02-tidepool.md 6; format 01-core.md 10.1).
const SEED_POLICY = `{
  "v": 1,
  "default": "held",
  "tiers": [
    { "paths": ["creatures/*.js"], "tier": "auto" },
    { "paths": ["world/**", "main.js", "pen.js", "index.html", "selftest/**", "GUIDE.md"], "tier": "held" }
  ],
  "globals": ["Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Map", "Set", "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat"],
  "limits": { "max_paths": 64, "max_change_bytes": 65536 }
}
`;

describe("PO1: the tier of a path", () => {
  const policy = policyOf(SEED_POLICY);

  it("PO1: * matches within one segment, ** across segments, first matching rule wins", () => {
    expect(tierOfPath(policy, "creatures/fish.js")).toBe("auto"); // creatures/*.js
    expect(tierOfPath(policy, "creatures/deep/fish.js")).toBe("held"); // * cannot cross /
    expect(tierOfPath(policy, "world/energy.js")).toBe("held"); // world/**
    expect(tierOfPath(policy, "world/deep/x.js")).toBe("held"); // ** crosses /
    expect(tierOfPath(policy, "main.js")).toBe("held"); // a pattern without a wildcard is literal
    expect(tierOfPath(policy, "newfile.txt")).toBe("held"); // no rule matches: the default
  });

  it("PO1: the first matching rule decides, not the most specific", () => {
    // The tidepool-auto seed variant moves world/*.js into the first rule (02-tidepool 6).
    const variant = policyOf(SEED_POLICY.replace('"creatures/*.js"', '"creatures/*.js", "world/*.js"'));
    expect(tierOfPath(variant, "world/energy.js")).toBe("auto"); // first rule wins
    expect(tierOfPath(variant, "world/deep/x.js")).toBe("held"); // world/*.js misses, world/** hits
  });

  it("PO1: glob semantics — * does not cross /, ** does", () => {
    expect(globMatch("a/*.js", "a/b.js")).toBe(true);
    expect(globMatch("a/*.js", "a/b/c.js")).toBe(false);
    expect(globMatch("a/**", "a/b/c.js")).toBe(true);
    expect(globMatch("a/**/c.js", "a/c.js")).toBe(true); // ** covers zero segments
    expect(globMatch("a/**/c.js", "a/x/y/c.js")).toBe(true);
    expect(globMatch("a/b", "a/b")).toBe(true);
    expect(globMatch("a/b", "a/b/c")).toBe(false);
  });
});

describe("PO2: the tier of a change", () => {
  it("PO2: held when any touched path is held, else auto", () => {
    const policy = policyOf(SEED_POLICY);
    expect(changeTier(policy, ["creatures/fish.js", "creatures/snail.js"])).toBe("auto");
    expect(changeTier(policy, ["creatures/fish.js", "world/energy.js"])).toBe("held");
    expect(changeTier(policy, ["world/energy.js"])).toBe("held");
    expect(changeTier(policy, [])).toBe("held"); // a change touching nothing cannot be auto
  });
});

describe("PO3: the policy fails closed", () => {
  it("PO3: a missing or unreadable policy makes every path held", () => {
    for (const text of [null, undefined, "", "not json", "[]", "{}"]) {
      const policy = policyOf(text);
      expect(tierOfPath(policy, "creatures/fish.js"), JSON.stringify(text)).toBe("held");
      expect(tierOfPath(policy, "anything")).toBe("held");
    }
    expect(CLOSED_POLICY.defaultTier).toBe("held");
  });

  it("PO3: unknown keys and bad values are errors", () => {
    const bad = [
      '{"v":2,"default":"held"}',
      '{"v":1,"default":"held","extra":1}',
      '{"v":1,"default":"maybe"}',
      '{"v":1,"default":"held","tiers":[{"paths":["a"],"tier":"open"}]}',
      '{"v":1,"default":"held","tiers":{"paths":["a"]}}',
      '{"v":1,"default":"held","limits":{"max_paths":"many"}}',
      '{"v":1,"default":"held","limits":{"other":1}}',
    ];
    for (const text of bad) expect(parsePolicy(text), text).toBe(null);
    expect(parsePolicy(SEED_POLICY)).not.toBe(null);
  });

  it("PO3: .premise/** is always held, whatever the rules say", () => {
    const open = policyOf('{"v":1,"default":"auto","tiers":[{"paths":["**"],"tier":"auto"}]}');
    expect(tierOfPath(open, "creatures/fish.js")).toBe("auto");
    expect(tierOfPath(open, ".premise/policy.json")).toBe("held");
    expect(tierOfPath(open, ".premise/state/x.json")).toBe("held");
    // So a change that edits the policy file is itself held (PO5 consequence in the pure layer).
    expect(changeTier(open, [".premise/policy.json"])).toBe("held");
  });
});

describe("PO4: globals and limits", () => {
  it("PO4: without globals the policy's list is the protocol's DEFAULT_GLOBALS", () => {
    const minimal = policyOf('{"v":1,"default":"auto"}');
    expect(minimal.globals).toEqual([...DEFAULT_GLOBALS]);
    // The tide pool file lists the same 16 names as DEFAULT_GLOBALS (02-tidepool 6).
    expect(policyOf(SEED_POLICY).globals).toEqual([...DEFAULT_GLOBALS]);
  });

  it("PO4: a file's globals replace the default list", () => {
    const policy = policyOf('{"v":1,"default":"auto","globals":["Math"]}');
    expect(policy.globals).toEqual(["Math"]);
  });

  it("PO4: limits may only lower the limits of 4.2", () => {
    const policy = policyOf(SEED_POLICY);
    expect(policy.limits.max_paths).toBe(64);
    expect(policy.limits.max_paths).toBeLessThanOrEqual(MAX_PATHS);
    expect(policy.limits.max_change_bytes).toBe(65536);
    expect(policy.limits.max_change_bytes).toBeLessThanOrEqual(MAX_CHANGE_BYTES);
    expect(parsePolicy('{"v":1,"default":"auto","limits":{"max_paths":1000}}')).toBe(null);
    expect(parsePolicy(`{"v":1,"default":"auto","limits":{"max_change_bytes":${MAX_CHANGE_BYTES + 1}}}`)).toBe(null);
    expect(policyOf('{"v":1,"default":"auto"}').limits).toEqual({
      max_paths: MAX_PATHS,
      max_change_bytes: MAX_CHANGE_BYTES,
    });
  });
});
