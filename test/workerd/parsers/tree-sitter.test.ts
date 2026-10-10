// Phase 0 of step 3 (06-repos.md LG1): the tree-sitter adapter, bundled by wrangler exactly as the
// production build bundles it, parses Python and Go inside local workerd. The probe Worker imports
// `src/worker/parsers/tree-sitter.ts`; wrangler writes the three `.wasm` files beside it.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { REPO_ROOT } from "../../support/source.ts";

const DIR = join(REPO_ROOT, ".tmp-test/parsers-probe");
const OUT = join(DIR, "out");

let worker: Miniflare;

type Answer = { types: string[]; hasError: boolean; processType: string; ms: number };

async function parse(language: "python" | "go", source: string): Promise<Answer> {
  const response = await worker.dispatchFetch("http://probe.test/parse", {
    method: "POST",
    body: JSON.stringify({ language, source }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Answer;
}

beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, "wrangler.jsonc"),
    JSON.stringify({
      name: "parsers-probe",
      main: join(REPO_ROOT, "test/workerd/parsers/probe-worker.mjs"),
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--config", join(DIR, "wrangler.jsonc"), "--outdir", OUT], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  const files = readdirSync(OUT);
  worker = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: "parsers-probe",
          modulesRoot: OUT,
          modules: [
            { type: "ESModule", path: join(OUT, "probe-worker.js") },
            ...files
              .filter((file) => file.endsWith(".wasm"))
              .map((file) => ({ type: "CompiledWasm" as const, path: join(OUT, file) })),
          ],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
        },
      ],
    }),
  );
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  rmSync(DIR, { recursive: true, force: true });
});

describe("LG1: tree-sitter in local workerd", () => {
  it("LG1: wrangler writes the core and both grammars as .wasm files beside the bundle", () => {
    const wasm = readdirSync(OUT)
      .filter((file) => file.endsWith(".wasm"))
      .map((file) => file.replace(/^[0-9a-f]{40}-/, ""))
      .sort();
    expect(wasm).toEqual(["tree-sitter-go.wasm", "tree-sitter-python.wasm", "web-tree-sitter.wasm"]);
  });

  it("LG1: a Python file parses into its top-level statements", async () => {
    const answer = await parse(
      "python",
      "import os\nfrom a import b\nX = 1\ndef f(a, b):\n    return a\nclass C:\n    pass\n",
    );
    expect(answer.types).toEqual([
      "import_statement",
      "import_from_statement",
      "expression_statement",
      "function_definition",
      "class_definition",
    ]);
    expect(answer.hasError).toBe(false);
    // The adapter's workaround: web-tree-sitter takes its browser path because process.type is "renderer".
    expect(answer.processType).toBe("renderer");
  });

  it("LG1: a Go file parses into its top-level declarations", async () => {
    const answer = await parse(
      "go",
      'package m\nimport "fmt"\nconst C = 1\nvar V = 2\ntype T struct{}\nfunc F() {}\nfunc (t T) M() {}\n',
    );
    expect(answer.types).toEqual([
      "package_clause",
      "import_declaration",
      "const_declaration",
      "var_declaration",
      "type_declaration",
      "function_declaration",
      "method_declaration",
    ]);
    expect(answer.hasError).toBe(false);
  });

  it("LG1: broken input parses with an error on the root", async () => {
    expect((await parse("python", "def f(:\n")).hasError).toBe(true);
    expect((await parse("go", "package m\nfunc F( {\n")).hasError).toBe(true);
  });
});
