// The paths and keys of 01-core.md 2.1, the listing and query hashes of 2.5 (H13-H20) and the
// text query match set of 2.6. Expected values come from docs/spec/premise-cases.json and real git.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../test/support/source.ts";
import { H } from "../sync/h.ts";
import {
  directoryKey,
  fileHash,
  isModulePath,
  isPath,
  listingHash,
  listingMembers,
  membersHash,
  occurrences,
  parentKey,
  refsMember,
  textMemberContainer,
  textMemberCount,
  textMembers,
} from "./index.ts";

type VectorFile = {
  hash_cases: Array<Record<string, unknown>>;
  pools: { tidepool: { files: Record<string, string> } };
};

const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "docs/spec/premise-cases.json"), "utf8")) as VectorFile;
const cases = new Map(vectors.hash_cases.map((entry) => [entry.id as string, entry]));
const pool = vectors.pools.tidepool.files;
const tree = new Map(Object.entries(pool));

describe("paths and keys (2.1, 2.2)", () => {
  it("a path is slash-separated [A-Za-z0-9._-] segments, never . .. .git", () => {
    for (const ok of ["a", "a/b/c.js", "x-y_z.9.mjs", "creatures/fish.js", ".premise/policy.json", ".a"]) {
      expect(isPath(ok), ok).toBe(true); // a segment may start with `.`; `.premise` is one
    }
    for (const bad of [
      "/a",
      "a/",
      "a//b",
      "..",
      ".",
      "a/../b",
      "a/./b",
      ".git",
      "a/.git/hooks",
      "a b.js",
      "a#b.js",
      "",
    ]) {
      expect(isPath(bad), bad).toBe(false);
    }
    expect(isPath(`${"a".repeat(120)}`)).toBe(true);
    expect(isPath("a".repeat(121))).toBe(false); // MAX_PATH_LEN is 120
  });

  it("a directory key ends in /; the root is /; a file key is its path; an entity key is <path>#<name>", () => {
    expect(directoryKey("creatures")).toBe("creatures/");
    expect(directoryKey("creatures/")).toBe("creatures/");
    expect(directoryKey("/")).toBe("/");
    expect(parentKey("creatures/fish.js")).toBe("creatures/");
    expect(parentKey("main.js")).toBe("/");
    expect(isModulePath("a.js")).toBe(true);
    expect(isModulePath("a.mjs")).toBe(true);
    expect(isModulePath("a.jsx")).toBe(false);
  });
});

describe("the listing and file hashes of 2.5", () => {
  it("H13 (2.5): the listing creatures/ of fish.js and snail.js hashes to a55430205a91ff9e355e9502080105a5", () => {
    // 01-core.md 2.5 gives the JSON ["fish.js","snail.js"] and the hash; the vector pool holds the files.
    expect(listingMembers(tree, "creatures/")).toEqual(["fish.js", "snail.js"]);
    expect(listingHash(tree, "creatures/")).toBe("a55430205a91ff9e355e9502080105a5");
  });

  it("a listing holds immediate children only; a subdirectory appears with a trailing /", () => {
    const deeper = new Map([...tree, ["creatures/nest/egg.js", "x"], ["world/water/pond.js", "y"]]);
    expect(listingMembers(deeper, "creatures/")).toEqual(["fish.js", "nest/", "snail.js"]);
    expect(listingMembers(deeper, "/")).toEqual([".premise/", "creatures/", "world/"]);
  });

  it("H14 (2.5): a directory that does not exist has the hash of the empty set", () => {
    expect(listingMembers(tree, "abyss/")).toEqual([]);
    expect(listingHash(tree, "abyss/")).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5");
    expect(listingHash(tree, "abyss/")).toBe(H("[]"));
  });

  it("H17 (2.5): the blob id of the energy.js content", () => {
    const entry = cases.get("H17");
    expect(fileHash(entry?.content as string)).toBe(entry?.hash);
    expect(fileHash(entry?.content as string)).toBe("73b9aee0919e88e8402fcc5616756bf206f17fb7");
  });

  it("H18 (2.5): the blob id of the movement.js content", () => {
    const entry = cases.get("H18");
    expect(fileHash(entry?.content as string)).toBe(entry?.hash);
  });
});

describe("the text query of 2.6", () => {
  it("H20 (2.6): drain( in creatures/ has the member creatures/fish.js#update*1", () => {
    // 01-core.md 2.6: `drain(` matches once, in update's region, so the member carries the count 1.
    const entry = cases.get("H20");
    expect(textMembers(tree, "creatures/", "drain(")).toEqual(["creatures/fish.js#update*1"]);
    expect(membersHash(textMembers(tree, "creatures/", "drain("))).toBe(entry?.hash);
    expect(membersHash(textMembers(tree, "creatures/", "drain("))).toBe("437a872bdeb83268a63e62950d702130");
  });

  it("every occurrence counts, including overlapping matches (2.6)", () => {
    expect(occurrences("aaaa", "aa")).toEqual([0, 1, 2]);
    expect(occurrences("", "x")).toEqual([]);
  });

  it("a match in an opaque file yields the file path as its container", () => {
    const files = new Map([
      ["notes.txt", "drain(drain("],
      ["plain.js", "this is not ( a module {"],
    ]);
    const members = textMembers(files, "/", "drain(");
    expect(members).toEqual(["notes.txt*2"]);
    expect(textMembers(files, "/", "{")).toEqual(["plain.js*1"]);
  });

  it("a match inside a module that fails to parse yields the file path as its container", () => {
    const files = new Map([["broken.js", "function drain( { "]]);
    expect(textMembers(files, "/", "drain(")).toEqual(["broken.js*1"]);
  });

  it("a member's container and count are read by splitting at the last * (KH3)", () => {
    expect(textMemberContainer("creatures/fish.js#update*2")).toBe("creatures/fish.js#update");
    expect(textMemberCount("creatures/fish.js#update*2")).toBe(2);
    expect(textMemberCount("weird*name*7")).toBe(7);
    expect(textMemberContainer("weird*name*7")).toBe("weird*name");
  });
});

describe("membersHash (2.5) and refs members (KH3)", () => {
  it("members hash is H of the JSON array of sorted members", () => {
    expect(membersHash(["b", "a"])).toBe(H(JSON.stringify(["a", "b"])));
  });

  it("KH3: a refs member is a referrer key (has #) or a <path>@<hash> module entry", () => {
    expect(refsMember("creatures/fish.js#spawn")).toEqual({ kind: "referrer", key: "creatures/fish.js#spawn" });
    expect(refsMember("creatures/fish.js@854043e6f224188840f8df611e97e6db")).toEqual({
      kind: "module",
      path: "creatures/fish.js",
      hash: "854043e6f224188840f8df611e97e6db",
    });
  });
});
