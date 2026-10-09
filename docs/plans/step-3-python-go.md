# Step 3: Python and Go modules (plan)

Written by the lead on 2026-10-09 at the owner's request: "write the plan for step 3: I will pick it up on
another device." The binding specification is `docs/spec/06-repos.md` (LG1, LG4, LG5 and step 3 of section 5).
Section 3 of this plan settles what that file leaves open. Facts about the code are cited at commit `2e48d5c`.

## 1. For the owner

**What step 3 adds.** Premise understands JavaScript and TypeScript piece by piece: each function, class and
constant is an entity, so an agent's premises, heads-ups and go-arounds are precise. Files in other languages
are tracked only as whole files. Step 3 gives Python and Go files the same piece-by-piece treatment in a pool
imported from a repository. The tide pool and the demo do not change.

**Deadline.** The build plan freezes features at the end of Saturday Oct 10 (Day 7: "No feature code after
this day"). Step 3 is in the submitted build only if its branch is handed back by **Saturday Oct 10, 15:00 CDT
(13:00 PDT)**. The lead then needs about two hours to verify, merge and test it on the test site before the
freeze. If it is not ready by then, nothing breaks: the branch stays unmerged, the build ships without Python
and Go, and the README keeps the line "Not built: … Python and Go modules".

**Risk: high for the deadline.** The first two hours (Phase 0) prove whether the parser runs inside
Cloudflare's runtime. A research spike on Oct 9 made it run once, with a workaround. If Phase 0 fails, step 3
is out of this build.

**How to start on the other device.**

1. Check that the device has Node.js 22.18 or later, npm 10 and git. Ask the agent to install them if not.
2. Start a new Claude Code session in an empty folder on that device.
3. Paste this message: "Clone https://github.com/zaeem-rafiq/premise.git, read docs/plans/step-3-python-go.md and carry out section 2. Report to me in plain English."
4. When the agent asks for GitHub access, sign in with your GitHub account. The repository is private.
5. Do not give that device a Cloudflare login or the owner key. The work needs neither.
6. When the agent says the branch is ready, reply "merge step 3" in the session on the Mac.

## 2. For the agent that builds it

### 2.1 Your role and the rules

- You build step 3 for the lead on the branch `step3/python-go`. Read `AGENTS.md` first (`CLAUDE.md` points
  there), then `docs/spec/06-repos.md` in full, then the parts of `docs/spec/01-core.md` that this plan names:
  2.1 to 2.4 (modules, entities, hash), 4.3 and 4.4 (`outline`, `read`), 6.2 (references), 7.2 (decision
  table).
- This plan changes three rules of `AGENTS.md`, for this task only:
  1. You may edit every path this plan names, across lanes, the lead's paths included.
  2. You may add the three dependencies of 2.3, at exact versions.
  3. You may push the branch `step3/python-go` to `origin`, and you should push after each phase as a backup.
     Never push `main`, never force-push, never merge into `main`. The lead merges after verifying (BP3).
- Never deploy. Never run `npm run dev`, `npm run deploy:test` or `npm run deploy`, and never log in to
  Cloudflare. Every test of this plan runs locally.
- The specification stays binding. Do not edit `docs/spec/premise-cases.json`. All 58 case vectors stay green.
  A tide-pool pool keeps exactly `.js` and `.mjs` as modules (LG1), so no vector and no hash changes.
- Expected values in tests come from the specification, from this plan's decisions, from the Python and Go
  languages themselves, or from real git. Never from your implementation's output (BP1).
- Never weaken, skip or delete a check to get a pass. If you cannot fix a failure by the cutoff, revert that
  part on your branch and report it.
- Stop at the cutoff (Saturday Oct 10, 15:00 CDT / 13:00 PDT) whatever the state: push, write the report of
  2.8 with what is done and what is not, and tell the owner.

### 2.2 Setup and baseline

```bash
git clone https://github.com/zaeem-rafiq/premise.git
cd premise
git checkout -b step3/python-go
npm ci
npm run check
npm run test:workerd
npm run test:cases
npx vitest run --project integration
```

Record the baseline. At `81bc33f` the lead saw `npm run check` exit 0 with 2,496 tests passing and 1 expected
failure, 106 cases, 249 workerd tests and 716 integration tests. If a shell has proxy variables set, run the workerd and integration suites with them removed
(`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy …`). Put temporary files under `.tmp-test/`.

### 2.3 Phase 0: prove that the parser runs in workerd (time box: 2 hours)

Goal: the Worker, bundled by this repository's build, parses a Python file and a Go file with tree-sitter
inside local workerd.

Packages, all MIT, pinned to exact versions:

- `web-tree-sitter` 0.27.0 if its type definitions have `Language.loadSync`, otherwise 0.27.1 (published
  2026-10-08; `loadSync` came with https://github.com/tree-sitter/tree-sitter/pull/5222).
- `tree-sitter-python` 0.25.0 and `tree-sitter-go` 0.25.0. Each ships a prebuilt `.wasm` of ABI 15.

What the lead's research spike observed on 2026-10-09 (outside the repository, once):

- Cloudflare Workers refuse to compile WebAssembly from bytes at run time. A `.wasm` file must be imported as a
  module, which gives a `WebAssembly.Module`
  (https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/). Wrangler bundles `.wasm`
  imports with no extra rule.
- The runtime loads with
  `Parser.init({ instantiateWasm(imports, done) { done(new WebAssembly.Instance(coreWasm, imports), coreWasm); return {}; } })`,
  and each grammar with `Language.loadSync(grammarModule)`.
- Under `nodejs_compat`, workerd reports `process.versions.node`. web-tree-sitter then takes its Node path and
  fails on `createRequire(import.meta.url)`. Setting `process.type = "renderer"` before `Parser.init` made it
  take the browser path. Keep that line next to the call, with a comment, and pin it with a test so an upgrade
  that changes the detection fails loudly.
- `wrangler deploy --dry-run` writes `<sha1>-<name>.wasm` files beside `index.js`. A 32 KiB file parsed in
  about 5 ms. `rootNode.hasError` is true on broken input. Python's top level parses as `import_statement`,
  `import_from_statement`, `expression_statement`, `function_definition`, `class_definition` and so on. Go's
  top level parses as `package_clause`, `import_declaration`, `const_declaration`, `var_declaration`,
  `type_declaration`, `function_declaration` and `method_declaration`.

Steps:

1. Add the three packages (`npm install --save-exact …`). If a grammar package does not let a bundler import
   its `.wasm` (its `exports` field), copy the file in a build step into an ignored folder instead.
2. Add `src/worker/parsers/tree-sitter.ts`. It imports the three `.wasm` modules and exposes an async
   `initParsers()` that runs once per isolate, plus a synchronous `parse(language, source)`.
3. Add a `.d.ts` file for `*.wasm` imports in the worker program. Triple-slash references are refused in
   `src/`.
4. Write one workerd test that parses a Python sample and a Go sample and lists their top-level node types.
5. Run `npm run build:worker` and record the Worker size: `dist/worker/index.js` plus every `.wasm`, raw and
   gzip. Before step 3, `index.js` was 1,324,005 bytes (296,343 gzip).

**Go:** the test passes and the build succeeds. **No-go after 2 hours:** stop. Push what you have, write the
report and tell the owner "Phase 0 failed: step 3 is out of this build." Do not switch to a hand-written
parser. LG1 binds tree-sitter, and a new parser cannot be checked well enough before the freeze.

### 2.4 Phase 1: the parser reaches the engine

- **Core stays pure** (`test/arch`): no Cloudflare import, no DOM, no `async`, no `Promise`, test files
  included. Define in core a minimal structural type for a syntax node, with `type`, `text`, `isNamed`,
  `children`, `startIndex`, `endIndex`, `startPosition` and `hasError`. Do not import web-tree-sitter's types
  into core.
- **The Trunk Durable Object initialises the parsers** once per isolate before its first engine entry. Its
  constructor is synchronous (`src/worker/trunk/trunk-do.ts:157-162`), so use `ctx.blockConcurrencyWhile` or
  await `initParsers()` at the top of `#callEngineEntry` (`:315-345`). The engine runs only from
  `src/worker/trunk/{trunk-do,engine-session,event-recovery,card-action,plain-runner,rebuild-job,import-job}.ts`.
- **Hand core a synchronous parse function.** `Pool.languages` already reaches every parse site
  (`src/core/trunk/sets.ts:308-310`). The precedent for injecting a port is `SyncTriage`, through
  `PoolOptions.syncTriage` (`src/core/trunk/registry.ts:53-62`). Core turns the tree into plain data
  (`ModuleInfo`). The adapter calls `tree.delete()` straight after, because WebAssembly memory is not
  garbage-collected, and the isolate has 128 MB in all.
- **The language table.** `IMPORT_LANGUAGES` (`src/core/keys/paths.ts:71-90`) gains `python` (`.py`) and `go`
  (`.go`). `TIDEPOOL_LANGUAGES` (`:62-68`) does not change. In `src/core/entities/entities.ts:256-262`,
  dispatch Python and Go before the TSX fallback.
- **Parse failures.** A tree whose root has `hasError` is a parse failure, so the file is opaque (2.1).
  `write` and `replace` refuse with `parse_error` and a `loc` of the first `ERROR` or `MISSING` node, in
  acorn's form: line 1-based, column 0-based (`src/core/trunk/tools-edit.ts:211-220,271-278`).
- **The import zones.** `test/arch/import-rules.ts` ZONES lets the worker zone import only
  `cloudflare:workers` and `node:` (`:64-67`). Allow `web-tree-sitter` and the two grammar files there. Add one
  sentence to `docs/spec/04-build-plan.md` 1.3, which the table cites.
- **Licences.** `scripts/build/check-licenses.ts` reads only the metafile's inputs (`:36-40`), and the
  `.wasm` files are not inputs. Map each emitted `dist/worker/*.wasm` file to its package and check that
  package's licence.
- **Workerd harnesses.** Fourteen or more harnesses load only `dist/worker/index.js` (for example
  `test/support/workerd.ts:11,63` and `test/workerd/landing/harness.ts:28,446`). They fail to start with
  `No such module "<sha1>-core.wasm"`. Add one helper in `test/support` that lists the bundle's files, and use it
  in every harness.
- **Tests that need the real parser** cannot live under `src/core`, because they must await the
  initialisation. Put them under `test/` and initialise web-tree-sitter in Node once. Node may compile
  WebAssembly from bytes, so `Language.load(bytes)` works there. Check that `vitest.config.ts` collects the
  folder and that a `tsconfig` program includes it (`test/arch/programs.test.ts`).

### 2.5 Phase 2: entities, regions, hash and outline (LG4, and LG6 to LG8 of section 3)

- Implement section 3 for both languages: one entity per definition, EN4 merging, EN6 regions per top-level
  statement, the canonical form and hash of LG8, the kinds, `exports` and `arity`.
- `EntityKind` (`src/protocol/premise.ts:27-28`) holds only the JavaScript kinds. The TypeScript kinds were
  asserted into it inside core (`entities.ts:22-34`). Do the same for `method`, and check that the Floor shows
  every new kind sensibly wherever it lists entities.
- `outline`: since `81bc33f`, `toolOutline` returns `entitySignature` (`entities.ts:525`) as each entity's
  `signature`, the form 01-core 4.3 shows. Add these forms to `entitySignature`:
  - Python: `def f(a, b)` (or `async def f(a, b)`), `class C`, `X = …`, `type X`, `import m`.
  - Go: `func F(a, b)`, `func (T) M(a, b)`, `type T`, `const C`, `var V`, `import "p"`.
- Tests: one per rule of LG6 and LG7, one per clause of LG8, and the hash test of 2.4 for each language
  (equal under a comment or whitespace change, different under a token change). Name the rule id in each test
  title, for example `LG6: a decorated function is one entity with its decorators`.

### 2.6 Phase 3: references by name (LG4, LG9)

- `analyse` (`src/core/refs/refs.ts:772-867`) walks ESTree only, through `referencesIn` (`:169-684`). Add a
  branch in its per-module loop (`:790`), chosen by language, that computes LG4 references by name with the
  resolution of LG9.
- A by-name reference never adds to `unresolved` (CK5 refuses `import_unresolved`,
  `src/core/trunk/submit.ts:182-191`) and never adds to `banned`.
- The consumers are `setsOf` NewRefs and ModuleRefs (`sets.ts:661-725`) and `refsMembers` (`refs.ts:887-898`).
- Row L2's `literalNames` (`sets.ts:728-751`) walks ESTree `Literal` nodes. Python and Go modules contribute no
  literal names.
- Tests: same module; same Go package across two files; `from m import n as a`; `import m as a` then `a.x`;
  a Go import with and without an alias; a name with two matches (both are references); a name with none
  (none); an external import (no premise, no failure).

### 2.7 Phase 4: the extra file premise (LG4, LG10)

- Nothing creates LG4's `file` premise with `derived = 1` today. The only derived file premise is for
  whole-module references (`src/core/trunk/premises.ts:106-110`). `syncPremises` (`premises.ts:122-139`) runs
  after every operation, at submit and at register. It clears every derived flag that is not in `wantDerived`
  and deletes a premise left with no flag. So the new premise needs code both where an entity read pins
  (`src/core/trunk/tools-read.ts:154`) and in `wantDerived`.
- As 7.2 stands, F7 would delete that premise (`src/core/classify/table.ts:59-60`). LG10 makes it classify as
  a module reference instead.
- Tests: an attempt that reads one entity of a `.py` file holds a `file` premise on it with `derived = 1`, and
  keeps it after later operations. A landing that changes another entity of that file gives F3m, `confirm`. A
  comment-only change gives F2, `holds`. The file turning unparseable gives F5, `repair`.

### 2.8 Phase 5: collisions, text and hand-back

- **Collisions (06-repos step 3).** Copy "C04 on TypeScript: … repairs the referencer E2"
  (`test/cases/import-typescript.test.ts:205-279`) twice: once for a shared Python constant, once for a shared
  Go constant. Each must be caught: a heads-up E2, a go-around, then a landing. In
  `test/workerd/repos/repos.test.ts`, import a local repository with Python and Go files through the stand-in
  for Artifacts (`fillSource` `:36-60`). A scripted agent lands a change, and stock git shows that the commit
  differs from its parent only in the change's paths.
- **Tests that assert `.py` is opaque** must change: `src/core/keys/languages.test.ts:36,55`,
  `test/cases/import-typescript.test.ts:121-131` and `test/workerd/repos/repos.test.ts:291-304`. Keep an opaque
  fixture, such as `src/lib.rs`.
- **Text.**
  - `src/config/limits.ts`, line 1 (`:33`), becomes "Premise understands JavaScript, TypeScript, Python and Go modules: .js and .mjs in the tide pool, and .js, .mjs, .cjs, .jsx, .ts, .mts, .cts, .tsx, .py and .go in a pool imported from a repository. Other files are tracked as whole files."
  - Line 9 (`:43`) drops "Python and Go modules".
  - After line 10, add the LG4 blind spot: "In Python and Go, references are found by name and can be wrong both ways. Every Python or Go file an agent reads from is also watched as a whole, so any change to it asks the agent to confirm."
  - The same in `docs/spec/03-floor.md` 5.12 (`:2032`, `:2040` and the note at `:2048`), with `src/config/floor-json.test.ts` (`:64-66`, `:187-190`).
  - In `README.md`, the Limits list must equal `limitsList(FEATURES)`. `npm run check:submission` tells you when it does.
  - The comment at `src/core/keys/paths.ts:70`.
  - Do not change the agent prompt. Its hashes are pinned against `05-agent.md`, the model measurements used it, and the imported-pool prompt is already language-neutral (IR10).
- **Finish.**
  1. Merge `origin/main` into your branch and resolve conflicts. `README.md` and `docs/measurements/rules.md`
     may conflict: keep both sides' changes and regenerate the record.
  2. Run `npm run check`, `npm run test:workerd`, `npm run test:cases`, `CASES=required npm run test:cases`,
     `npx vitest run --project integration`, `npm run test:e2e`, `npm run check:submission` and
     `node scripts/ops/rules-coverage.ts`. Every new rule id (LG6 to LG10) must appear in a test title.
  3. Write `docs/measurements/integration/2026-10-10-python-go.md`. Give each acceptance item of 06-repos step 3
     with its test names and results. Give the Worker size before and after, raw and gzip (06-repos step 3 asks
     for it), and the parse timings. List every choice you made where this plan was silent, and what is not
     done.
  4. Commit (`<type>: <description>`), push the branch, and tell the owner either "Step 3 is ready for the lead
     on branch step3/python-go" or what failed.

## 3. Decisions where the specification is silent

The lead's decisions of 2026-10-09. Add them to `docs/spec/06-repos.md` section 2 as rules LG6 to LG10 in one
commit, before the code that follows them.

- **LG6 (Python entities).** The top-level statements, in source order, each with its EN6 region:
  - `def` and `async def` give an entity of kind `function`, and `class` gives one of kind `class`. A
    decorated definition is one statement with its decorators.
  - An assignment, annotated assignment or augmented assignment whose targets are names gives one entity per
    bound name, kind `var`. A statement that binds several names (`a, b = …`, `a = b = …`) contributes one
    entity per name, sharing the statement, as 2.3 does for `const { p, q } = obj`. An assignment to an
    attribute or a subscript belongs to `(top)`.
  - `type X = …` gives `X`, of kind `type`.
  - `import a.b`, `import a.b as c`, `from m import x`, `from . import x` and `from .m import x` give
    `(import <module as written>)`, of kind `import`. A statement that imports several modules contributes
    one entity per module, and statements that import the same module share its entity (EN4).
  - Every other statement belongs to `(top)`: docstrings, expression statements, `if`, `try`, `for`, `with`
    and so on. Imports nested inside them belong to `(top)` and resolve no reference.
  - A name bound twice at the top level is one entity with several nodes (EN4).
  - `exports` is `[]`. `arity` is the number of parameters as written, `self` included.
- **LG7 (Go entities).**
  - The package clause belongs to `(top)`.
  - `func F(…)` gives `F`, of kind `function`. `func (r T) M(…)`, `func (r *T) M(…)` and `func (r T[K]) M(…)`
    give `T.M`, of kind `method`. `func init()` belongs to `(top)`: Go forbids referring to it, and a file may
    have several.
  - `type T …` gives `T`, of kind `type`. `const` and `var`, single or grouped, give one entity per bound name,
    of kind `const` or `var`. Grouped specs share their statement. A spec that binds only `_` belongs to
    `(top)`.
  - In a grouped `const ( … )`, a spec with no value repeats the last explicit type and value of the group
    (Go's implicit repetition). Its canonical form (LG8) includes that type and value and its index in the
    group, which is the value of `iota`.
  - `import "p"`, `import a "p"` and `import ( … )` give `(import p)` per import path, sharing the statement
    (EN4).
  - `exports` is `[]`: Go exports by a capital initial, which the name already carries. `arity` is the number
    of parameters: `a, b int` counts two, and the receiver does not count.
- **LG8 (canonical form and hash for Python and Go).** The canonical form of a node is its tree-sitter syntax
  tree without positions. A node with children is `{"type": <node type>, "children": [ … ]}`. A node without
  children is `{"type": <node type>, "text": <its source text>}`. Named and anonymous nodes are both kept, and
  `comment` nodes are dropped. The hash is `H(canon({exports, nodes}))` as in 2.4, over the canonical forms of
  the entity's nodes in source order. A change that tree-sitter represents (parentheses, a trailing comma)
  changes the hash. Whitespace and comments do not. `hash_version` stays `ast1`: 2.4 holds for JavaScript and
  TypeScript, and LG8 holds for Python and Go. The grammar versions are pinned. Changing one changes hashes
  and is recorded in a measurement file.
- **LG9 (resolution for Python and Go).**
  - **Python modules.** An absolute module `a.b.c` is the pool file `a/b/c.py` or `a/b/c/__init__.py`. The
    repository root is the only search root. A relative module (`.`, `.m`, `..m.n`) resolves against the
    importing file's directory, as Python does. In `from p import n`, when `p`'s `__init__.py` defines no `n`
    but the file `p/n.py` exists, `n` is that whole module. Every other module is external: no premise and no
    check failure (as LG3).
  - **Go modules and packages.** The pool's module path is the `module` line of `go.mod` at the repository
    root. An import path equal to it, or starting with it and `/`, names the pool directory of the rest of the
    path. Every other import path is external. A package is the `.go` files of one directory that share a
    `package` clause. A `_test.go` file with package `<name>_test` is its own package. Without a root `go.mod`,
    every import is external.
  - **References by name (LG4)** inside an entity's nodes. Each of these is a reference:
    - an identifier that names a definition of the same module (Python) or of the same package (Go);
    - a name bound by `from m import n` or `from m import n as a`, to `n` of `m`;
    - an attribute `a.x`, where `a` is bound by `import m` or `import m as a` (Python) or is a Go import's
      package name (its alias, or the imported package's `package` clause name), to `x` of that module or
      package. In Go it also refers to every method named `x` there (`T.x`).

    Every match is a reference, and no match gives none.
- **LG10 (the extra premise of LG4 in 7.2).** The `file` premise that LG4 adds (`derived = 1`) is classified
  as if its path were in `ModuleRefs`:
  - an entity change in the file gives F3m (`confirm`, `module_reference_changed`), unless F1 or F3 applies
    first;
  - the file becoming opaque, or being removed, gives F5 (`repair`);
  - a change only to comments or whitespace gives F2 (`holds`).

  F7 never deletes the premise while the attempt holds an entity premise in that file, and `syncPremises`
  keeps it.

## 4. Working beside the lead

- The lead keeps working on `main` on the Mac: the design review's fixes, the freeze, the load test and the
  production deploy. Expect `main` to move, and merge `origin/main` into your branch before you hand it back.
- Recovery: your branch is disposable, and `main` is untouched until the lead merges. If the test site shows a
  problem with Python or Go after the merge, the lead reverts the merge commit (`git revert -m 1`), and the
  build ships without step 3.
- After the owner's "merge step 3", the lead will:
  1. review `git diff main...origin/step3/python-go`;
  2. run every suite on the merged result;
  3. deploy to the test site;
  4. import one small MIT or Apache-2.0 Python repository and one Go repository;
  5. land one real-agent change on each, which costs a few cents;
  6. merge before the end of Day 7, or leave the branch for after the contest.
