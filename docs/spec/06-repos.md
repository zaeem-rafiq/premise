# Premise: real repositories

Status: binding. Added on 2026-10-04 by the owner's decision "approve real repos 1, 2 and 3". This file amends `01-core.md`, `03-floor.md`, `04-build-plan.md` and `05-agent.md` where it says so; where it is silent, those files hold unchanged. Rule ids of this file start with `IR` (imported repository) and `LG` (language).

A pool so far is made from a seed of the tide pool (`02-tidepool.md`). This file adds a second kind: a pool made from a public git repository. Such a pool has no live picture. Its agents, premises, heads-ups, landings, notes and git record work exactly as in a tide-pool pool.

## 1. Creating a pool from a repository

- **IR1 (the request).** `POST /api/pools` (owner) takes either `seed` (as before) or `source`, never both:

  ```ts
  type CreatePoolRequest = {
    pool: string;
    seed?: string;                                   // a seed built into the deployment (PL1)
    source?: { url: string; branch?: string };       // a public git repository (IR1)
    summary_only?: boolean;
    request_id: string;
  };
  ```

  `url` must be `https://<host>/<owner>/<name>` or the same with `.git`, with `<host>` one of `github.com`, `gitlab.com`, `codeberg.org`; no user name or password, no port, no query, no fragment; `<owner>` and `<name>` match `^[A-Za-z0-9._-]+$`. `branch`, when given, matches `^[A-Za-z0-9._/-]+$` with no `..`. Anything else answers 400 `invalid_args`. A repeated `request_id` gives the first answer (9.8); another `request_id` for an existing pool answers 409 `pool_exists`.
- **IR2 (the import).** The Worker calls the Artifacts binding's `import` with `source: { url, branch, depth: 1 }` and `target: { name: <the pool's repo name> }`. Its errors answer: `REMOTE_AUTH_REQUIRED` 400 `repo_private`; `NOT_FOUND` 404 `repo_not_found`; `MEMORY_LIMIT` 413 `repo_too_large`; `UPSTREAM_UNAVAILABLE` 502 `upstream_unavailable`; `INVALID_URL` or `INVALID_INPUT` 400 `invalid_args`. The imported head commit of the branch (the default branch when none is given) is the pool's seed commit: `head_seq = 0`, `landed_seq = 0`, and nothing is pushed for it (no batch 0).
- **IR3 (ingestion).** Trunk reads the head tree and its blobs through the binding as a resumable job, like a rebuild (3.6 steps 3 and 5; RB3: a cursor in `meta`, at most `REBUILD_CALLS_PER_RUN` binding calls per alarm run, the `rebuild` timer). Event 1 of the stream is `pool.state` with `state: "rebuilding"`, `reason: "import"`, `head_seq: 0`. When the job ends: `pool.state` with `state: "ready"`, then `pool.files` (EM1). Until then tool calls answer `pool_not_ready`, and intents are refused with the same code.
- **IR4 (limits).** Before it stores anything, the job counts the tree. More than `IMPORT_MAX_ENTRIES` (5,000) entries, or more than `IMPORT_MAX_TEXT_BYTES` (24,000,000) bytes in blobs of at most `MAX_FILE_BYTES`, stops the import: `pool.state` `paused` with reason `repo_too_large`. A blob over `MAX_FILE_BYTES` is stored opaque with `content = NULL` (RB4): tools answer `too_large` for it.
- **IR5 (the tree is kept whole).** A real tree holds entries Trunk does not manage: paths that do not match 2.1, symbolic links (mode `120000`), submodules (mode `160000`), and executable files (mode `100755`). Trunk stores every entry of the imported head tree with its path, mode and object id. An entry whose path does not match 2.1, a link and a submodule are **unmanaged**: they never appear in `list`, `search`, `outline` or `read`, no tool can address them, and every commit Trunk builds writes them unchanged. A managed file keeps its mode: `replace` keeps `100755`; `write` of a new file gives `100644`; `write` over an existing file keeps its mode. The tree of every landing commit therefore differs from its parent only in the paths of its change. The test of this is stock git: `git diff --name-only <parent> <commit>` lists exactly the change's paths.
- **IR6 (policy).** An imported pool uses `.premise/policy.json` when the repository has one. Without it every path has tier `auto`. The check `policy` (CK9) runs as everywhere.
- **IR7 (what an imported pool does not have).** No app server and no live picture: `/pool/<pool>/...` answers 404 with code `no_app`. No green line and no self-test. No Swarm: `POST /api/swarm` for an imported pool answers 400 `invalid_args`. The plain-merge pool (11.7) is not built for an imported pool in this build. The check `globals_allowed` and every other check that `02-tidepool.md` defines for the tide pool's code are skipped; the checks of `01-core.md` 4.9 run.
- **IR8 (`pool.state.app`).** The event `pool.state` gains a field `app: "tidepool" | null`: `"tidepool"` for a pool made from a seed, `null` for an imported pool. This amends 12.1 of `01-core.md`; `src/protocol/events.ts`, the reducer and the fixtures follow it.

## 2. Languages

`01-core.md` 2.1 defines a module as a file ending in `.js` or `.mjs`, and every other file as opaque. An opaque file is tracked as a whole: a `file` premise when an agent reads it, rows F0 to F7 when it changes (7.2). That already works for every language. This section adds languages whose files are modules, so that their definitions become entities.

- **LG1 (the table).** This amends 2.1 of `01-core.md`:

  | Language | Extensions | Parser | Level | Status |
  | --- | --- | --- | --- | --- |
  | JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | acorn (as 2.3), with JSX for `.jsx` | entity | `.js`, `.mjs` built; `.cjs`, `.jsx` with step 2 |
  | TypeScript | `.ts`, `.mts`, `.cts`, `.tsx` | acorn with the plugin `@sveltejs/acorn-typescript`, JSX for `.tsx` | entity | step 2 |
  | Python | `.py` | tree-sitter (WebAssembly) | entity, references by name | step 3 (stretch) |
  | Go | `.go` | tree-sitter (WebAssembly) | entity, references by name | step 3 (stretch) |
  | every other file | | none | file | built |

  A file of a module language that its parser cannot parse is opaque, as in 2.1. In a tide-pool pool only `.js` and `.mjs` are modules, as before, so no vector and no hash of `docs/spec/premise-cases.json` changes.
- **LG2 (TypeScript entities).** The table of 2.3 holds for TypeScript, with these added rows: `type T = ...` gives entity `T` of kind `type`; `interface I {}` gives `I` of kind `interface`; `enum E {}` and `const enum E {}` give `E` of kind `enum`; `namespace N {}` and `module N {}` give `N` of kind `namespace`; `declare <declaration>` gives the entity of the declaration; `abstract class C {}` gives `C` of kind `class`. `import type` and `export type` follow the rows of `import` and `export`. Overloads of a function, merged interfaces and merged namespaces are one entity each (EN4). The hash of 2.4 is computed over the plugin's tokens exactly as over acorn's, types included: a change to a type is a change to the entity.
- **LG3 (TypeScript references and specifiers).** Identifiers in type positions are references like any other (6.2). A relative specifier resolves, in this order: the exact path; the path with `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs` appended; a specifier ending in `.js`, `.mjs` or `.cjs` with that ending replaced by `.ts`, `.mts` or `.cts`; the path as a directory with `index.ts`, `index.tsx`, `index.js` appended. A specifier that is not relative (a package, or an alias of `tsconfig.json`) is external: no premise, no check failure. This is a blind spot of this build and is stated in the README.
- **LG4 (references by name: Python and Go).** For Python and Go, entities are the top-level definitions (functions, classes, types, constants, variables; for Go also methods, keyed `Type.Method`), each import statement as one `(import ...)` entity, and `(top)` for the rest, with the regions of EN6. A reference is an identifier that names a definition of the same module, of the same Go package (any file of the directory), or of a module or package that the file imports and that is a file of the pool. Where a name matches several definitions, every match is a reference. Where it matches none, there is no reference. References by name can be wrong in both directions, so for these languages Trunk keeps one more premise: every module an attempt reads by entity also gets a `file` premise with `derived = 1`. A change anywhere in such a file therefore reaches the attempt, at worst as one more `confirm`.
- **LG5 (`outline` and `read`).** For every module language, `outline` and `read` with `entity` work as in 4.3 and 4.4. For an opaque file, `outline` answers `not_a_module`, and the agent reads the whole file.

The rules LG6 to LG10 settle what LG4 leaves open. They are the lead's decisions of 2026-10-09 (`docs/plans/step-3-python-go.md` section 3).

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
  `comment` nodes are dropped. A node with children also keeps its `text` when its children leave source text other than whitespace
  uncovered, and a Python `string_content` node with children (an escape sequence inside a string) always keeps
  it: every character that counts is then in the form. The hash is `H(canon({exports, nodes}))` as in 2.4, over the canonical forms of
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

## 3. The agent's prompt for an imported pool

- **IR9 (the guide).** The system prompt of `05-agent.md` names a guide with `{{GUIDE_PATH}}`. For a tide-pool pool it is `GUIDE.md`, as before. For an imported pool it is the first of `AGENTS.md`, `CONTRIBUTING.md`, `README.md` that exists in the head tree at import, stored in `meta` as `guide_path`. When none exists, step 1 of "How to work" reads: "1. Start with list on the root directory." and the sentence "The guide is the one file whose rules you follow." is left out.
- **IR10 (whole files).** In step 2 of "How to work", "Read a whole file only when it is not JavaScript" reads, for an imported pool: "Read a whole file only when outline answers not_a_module". The prompt of a tide-pool pool does not change. Each variant has its own pinned hash (PR1).
- **IR11 (the first user message).** For an imported pool the first `user` message adds one line after the request: "Repository: <owner>/<name> (<branch>)".

## 4. The page

- **IR12.** For a pool whose `pool.state.app` is null, the pool area holds no frame: its caption bar reads `frame.no_app` ("This repository has no live picture. Its files and the changes to them are below."), and the file tiles take the frame's place and height. The Compare button and the key C are absent. The header shows the repository as `<owner>/<name>`. Everything else is as for every pool.

## 5. Build steps and acceptance

The three steps of the owner's decision. Each is verified by the lead on merged `main` (BP3), then on the `test` deployment.

**Step 1: any repository, any language, file level.** IR1 to IR12 except LG2 to LG4. Tests in local workerd with a real bare repository imported through the harness's stand-in for Artifacts: a pool from a repository that holds a symbolic link, an executable script, a path with a space, files in three languages and one file over `MAX_FILE_BYTES`; a scripted agent lands a change; stock git on the remote shows that the landing commit differs from its parent only in the change's paths, and that the link, the script's mode and the odd path are unchanged; `git fsck --strict` passes. Every error code of IR2 and IR4. A real agent lands a change on an imported pool (fake model). The page's no-app pool area (IR12) in the browser tests. On `test`, the lead imports one small public repository and lands one real-agent change.

**Step 2: TypeScript at entity level.** LG1 to LG3 and LG5 for JavaScript's added extensions and TypeScript. Unit tests per row of LG2 and per resolution step of LG3, with expected values worked by hand; the hash test of 2.4 on TypeScript sources; a collision of two agents on a shared TypeScript constant classified with row E2, as `C04` is for JavaScript. All 58 vectors stay green.

**Step 3 (stretch, started only if steps 1 and 2 pass by 2026-10-08): Python and Go.** LG4. Unit tests of entities and references per language; the extra `file` premise of LG4; a collision on a shared Python constant and one on a shared Go constant, each caught. The bundle size of the Worker after the two grammars is recorded in the report.

**The demo repository.** The lead picks one public repository for the video: MIT or Apache-2.0, between 10 and 200 files, JavaScript or TypeScript, with at least one shared constant or function that several modules use. Its name goes into the README.

Picked on 2026-10-04 and confirmed by the owner: **`ai/nanoid`** (MIT; 49 files at `bb68abc`; 19 JavaScript and TypeScript modules, every one parsed by acorn and the TypeScript plugin; executable files with mode `100755`). Its shared constant is `urlAlphabet` of `url-alphabet/index.js`, which four modules import; `index.js` relies on the alphabet having 64 characters. The backup is `sindresorhus/ky` (MIT; 104 files; TypeScript; `source/core/constants.ts` imported by eight modules; an `AGENTS.md` guide), which needs step 2 wired into the engine.

## Appendix A. Constants

| Constant | Value | Rule |
| --- | --- | --- |
| `IMPORT_MAX_ENTRIES` | 5,000 | IR4 |
| `IMPORT_MAX_TEXT_BYTES` | 24,000,000 | IR4 |
