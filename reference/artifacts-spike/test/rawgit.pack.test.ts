/**
 * Proves the hand-built objects and packfile are valid by checking them with real git.
 * Needs only a local `git` binary; no Cloudflare access.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPack, makeBlob, makeCommit, makeObject, makeTree, makeTreeFromFiles, type GitObject, type Ident } from "../src/rawgit";
import { git, gitBytes, gitWithEnv, makeTempDir, removeDir } from "./helpers/git-http-server";

const AUTHOR: Ident = { name: "Spike Tester", email: "spike@example.invalid", timestamp: 1790000000, tz: "+0000" };
const COMMITTER: Ident = { name: "Spike Committer", email: "committer@example.invalid", timestamp: 1790000100, tz: "+0530" };
const MESSAGE = "hand-built commit\n\nBody line.\n";

// Names chosen to exercise git's tree ordering: the directory "a" sorts as "a/",
// which is after "a-b" and "a.txt".
const FILES: Record<string, string> = {
  "README.md": "# hello\n",
  "a.txt": "file a.txt\n",
  "a-b": "file a-b\n",
  "a/inner.txt": "inside directory a\n",
  "a/deep/er.txt": "two levels down\n",
  "src/index.ts": 'export const x = "y";\n',
  "empty.txt": "",
  "unicode-é.txt": "accented name\n",
};

let tmp: string;

beforeAll(() => {
  tmp = makeTempDir("rawgit");
});

afterAll(() => {
  removeDir(tmp);
});

function build(): { commit: GitObject; root: GitObject; objects: GitObject[] } {
  const { root, objects } = makeTreeFromFiles(FILES);
  const commit = makeCommit({ tree: root.oid, parents: [], author: AUTHOR, committer: COMMITTER, message: MESSAGE });
  return { commit, root, objects: [...objects, commit] };
}

describe("object ids match real git", () => {
  it("blob ids equal `git hash-object`", () => {
    for (const content of ["", "hello\n", "x".repeat(70_000)]) {
      const expected = git(tmp, ["hash-object", "-t", "blob", "--stdin"], content).trim();
      expect(makeBlob(content).oid).toBe(expected);
    }
  });

  it("tree and commit bytes are accepted by `git hash-object` (which validates the format) and hash to the same id", () => {
    const { commit, root } = build();
    // Without --literally, hash-object runs git's own format checks on trees and commits.
    expect(git(tmp, ["hash-object", "-t", "tree", "--stdin"], root.content).trim()).toBe(root.oid);
    expect(git(tmp, ["hash-object", "-t", "commit", "--stdin"], commit.content).trim()).toBe(commit.oid);
  });

  it("tree and commit ids equal the ones real git computes from the same files", () => {
    const { commit, root } = build();
    const work = join(tmp, "worktree");
    mkdirSync(work, { recursive: true });
    git(work, ["init", "--quiet", "--initial-branch=main"]);
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, ["add", "--all"]);
    const gitTree = git(work, ["write-tree"]).trim();
    expect(root.oid).toBe(gitTree);

    // commit-tree reads identity and dates from the environment.
    const identity = {
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.tz ?? "+0000"}`,
      GIT_COMMITTER_NAME: COMMITTER.name,
      GIT_COMMITTER_EMAIL: COMMITTER.email,
      GIT_COMMITTER_DATE: `${COMMITTER.timestamp} ${COMMITTER.tz ?? "+0000"}`,
    };
    const gitCommit = gitWithEnv(work, ["commit-tree", gitTree, "-F", "-"], identity, MESSAGE).trim();
    expect(commit.oid).toBe(gitCommit);
  });

  it("executable files and symbolic links in a file map give the tree real git computes", () => {
    const { root } = makeTreeFromFiles({
      "README.md": "# modes\n",
      "bin/run.sh": { content: "#!/bin/sh\necho hi\n", mode: "100755" },
      "bin/plain.txt": { content: "plain\n", mode: "100644" },
      "link-to-readme": { content: "README.md", mode: "120000" },
    });
    const work = join(tmp, "modes-worktree");
    mkdirSync(join(work, "bin"), { recursive: true });
    git(work, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(work, "README.md"), "# modes\n");
    writeFileSync(join(work, "bin/run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(work, "bin/run.sh"), 0o755);
    writeFileSync(join(work, "bin/plain.txt"), "plain\n");
    symlinkSync("README.md", join(work, "link-to-readme"));
    git(work, ["add", "--all"]);
    expect(root.oid).toBe(git(work, ["write-tree"]).trim());
    // git lists the modes it stored: the comparison above is not passing by accident.
    expect(git(work, ["ls-files", "--stage"]).split("\n").filter(Boolean).map((line) => `${line.slice(0, 6)} ${line.split("\t")[1]}`)).toEqual([
      "100644 README.md",
      "100644 bin/plain.txt",
      "100755 bin/run.sh",
      "120000 link-to-readme",
    ]);
    expect(() => makeTreeFromFiles({ "x.txt": { content: "x", mode: "40000" as "100644" } })).toThrow(/invalid file mode/);
  });

  it("sorts a directory after files that share its name as a prefix", () => {
    const blob = makeBlob("x");
    const sub = makeTree([{ mode: "100644", name: "f", oid: blob.oid }]);
    const tree = makeTree([
      { mode: "40000", name: "a", oid: sub.oid },
      { mode: "100644", name: "a.txt", oid: blob.oid },
      { mode: "100644", name: "a-b", oid: blob.oid },
    ]);
    const names: string[] = [];
    const bytes = tree.content;
    let pos = 0;
    while (pos < bytes.length) {
      const nul = bytes.indexOf(0, pos);
      names.push(Buffer.from(bytes.subarray(pos, nul)).toString("utf8").split(" ")[1]!);
      pos = nul + 21;
    }
    expect(names).toEqual(["a-b", "a.txt", "a"]);
  });
});

describe("hand-built packfile is valid", () => {
  it("passes `git index-pack --strict`, `git verify-pack` and `git fsck --strict`, and git reads back the same content", () => {
    const { commit, root, objects } = build();
    const big = makeBlob(randomBytes(200_000)); // incompressible, forces multi-byte size headers
    const withBig = makeTree([{ mode: "100644", name: "big.bin", oid: big.oid }]);
    const second = makeCommit({ tree: withBig.oid, parents: [commit.oid], author: AUTHOR, message: "second commit" });
    const all = [...objects, big, withBig, second];
    const pack = buildPack(all);

    // Header and trailer.
    expect(Buffer.from(pack.subarray(0, 4)).toString("latin1")).toBe("PACK");
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(4)).toBe(2);
    const uniqueCount = new Set(all.map((o) => o.oid)).size;
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(uniqueCount);

    const packPath = join(tmp, "hand-built.pack");
    writeFileSync(packPath, pack);
    const repo = join(tmp, "verify.git");
    git(tmp, ["init", "--bare", "--quiet", "--initial-branch=main", repo]);

    // index-pack --strict: checks the trailer checksum, every object, and that all links resolve.
    const indexed = git(repo, ["index-pack", "--strict", "--stdin"], pack).trim();
    expect(indexed).toMatch(/^pack\t[0-9a-f]{40}$/);
    const packName = indexed.split("\t")[1]!;
    // The pack name is the SHA-1 trailer of the pack we built.
    expect(packName).toBe(Buffer.from(pack.subarray(pack.length - 20)).toString("hex"));

    // verify-pack on the standalone file as well (index-pack without --stdin writes the .idx next to it).
    git(tmp, ["index-pack", packPath]);
    const verified = git(tmp, ["verify-pack", "-v", packPath.replace(/\.pack$/, ".idx")]);
    for (const object of all) expect(verified).toContain(`${object.oid} ${object.type}`);

    git(repo, ["update-ref", "refs/heads/main", second.oid]);
    // fsck exits non-zero on any corrupt, missing or malformed object.
    const fsck = git(repo, ["fsck", "--strict", "--full", "--no-dangling"]);
    expect(fsck).not.toMatch(/error|missing|broken/i);

    expect(git(repo, ["cat-file", "-t", commit.oid]).trim()).toBe("commit");
    expect(git(repo, ["rev-parse", `${commit.oid}^{tree}`]).trim()).toBe(root.oid);
    expect(gitBytes(repo, ["cat-file", "commit", commit.oid]).equals(Buffer.from(commit.content))).toBe(true);
    expect(gitBytes(repo, ["cat-file", "tree", root.oid]).equals(Buffer.from(root.content))).toBe(true);
    expect(git(repo, ["rev-parse", `${second.oid}^`]).trim()).toBe(commit.oid);

    // Every file comes back byte for byte.
    const listed = git(repo, ["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", commit.oid]).trim().split("\n").sort();
    expect(listed).toEqual(Object.keys(FILES).sort());
    for (const [path, content] of Object.entries(FILES)) {
      expect(gitBytes(repo, ["cat-file", "blob", `${commit.oid}:${path}`]).toString("utf8")).toBe(content);
    }
    expect(gitBytes(repo, ["cat-file", "blob", `${second.oid}:big.bin`]).equals(Buffer.from(big.content))).toBe(true);
    expect(git(repo, ["log", "--format=%an <%ae> %at|%cn <%ce> %ct|%s", "-1", commit.oid]).trim()).toBe(
      "Spike Tester <spike@example.invalid> 1790000000|Spike Committer <committer@example.invalid> 1790000100|hand-built commit",
    );
  });

  it("writes an object only once even when it is listed twice", () => {
    const blob = makeBlob("dup\n");
    const pack = buildPack([blob, blob, makeObject("blob", blob.content)]);
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(1);
  });

  it("rejects invalid tree entries", () => {
    const blob = makeBlob("x");
    expect(() => makeTree([{ mode: "100644", name: "a/b", oid: blob.oid }])).toThrow(/invalid tree entry name/);
    expect(() => makeTree([{ mode: "100644", name: ".git", oid: blob.oid }])).toThrow(/forbidden/);
    expect(() =>
      makeTree([
        { mode: "100644", name: "a", oid: blob.oid },
        { mode: "100644", name: "a", oid: blob.oid },
      ]),
    ).toThrow(/duplicate/);
  });
});
