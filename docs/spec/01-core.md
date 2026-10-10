# Premise core specification (01-core)

Status: binding for implementation. Revision 2 (after review), reconciled on 2026-10-04 with `02-tidepool.md`, `03-floor.md`, `04-build-plan.md` and the platform measurements. The last two sections list what changed: "Changes after review" and "Changes in reconciliation (2026-10-04)". Sources: the architecture brief (decisions), the design brief (platform limits), the concept panel (the `stage-first` proposal and the three judges' must-fix lists), the lead's reconciliation decisions.

Scope: the rules and protocols of the pure core and the three Durable Objects. The Floor UI layout (`03-floor.md`), the tide pool codebase and the Swarm scripts (`02-tidepool.md`) and the build plan (`04-build-plan.md`) are specified elsewhere and consume the types defined here. The agent's system prompt, the tool definitions exactly as a model receives them, how a heads-up is shown to a model, the context budgets and the seeded-intent measurement protocol are in `05-agent.md` (4.11). Where this file and another specification file disagree, this file wins.

Conventions used in this file:

- "MUST", "MUST NOT" and "MAY" are requirements on the implementation. Every rule has an id (for example `E2`, `OP1`, `CK4`) so tests can cite it.
- `H(s)` is the first 32 lowercase hex characters of SHA-256 over the UTF-8 bytes of the string `s`.
- **SY1 (synchronous primitives).** `H`, git object ids (SHA-1) and deflate are computed with synchronous implementations: `node:crypto` `createHash` and `node:zlib` `deflateSync` under the `nodejs_compat` flag, or pinned pure-JavaScript libraries with an allowed licence. WebCrypto `subtle.digest` and `CompressionStream` return promises and MUST NOT be used in the core. A unit test fails if any exported function of the pure core returns a promise.
- **SY2 (no waits inside a decision).** A tool-call handler, and steps 1 to 5 of the batch tick (9.4), run from start to commit with no `await`. Every network call (push, heads-up push, Clef, events to the Floor, Artifacts reads) starts after the SQLite transaction has committed. This is what makes "served from head at the moment of the call" (TA1) and "in the same transaction" (HU1) true on a Durable Object.
- JSON in hashes is serialized with no insignificant whitespace. "Sorted" means ascending by UTF-16 code unit.
- Constants are written `LIKE_THIS`. Their values are in Appendix C. A constant marked *calibrated* MUST be set from a measurement, and the measurement MUST be recorded next to the value.
- Test vectors live in `docs/spec/premise-cases.json`. Their format is Appendix A. A vector cites rules by section number and rule id.
- The **platform record** is `docs/measurements/spikes/2026-10-04-platform.md`: the measurements on the real Cloudflare service that decide section 15. The record numbers its experiments E1 to E9. They are not the decision-table rows E0 to E4 of section 7.2. This file and the other specification files therefore cite them as **X1 to X9**: X*n* is experiment E*n* of the platform record.
- Related prior work: STORM (arXiv 2605.20563), CoAgent (arXiv 2606.15376) and the competition entry "dibs" also validate what agents relied on. This specification makes no priority claim. What Premise does differently is listed in section 1.

---

## 1. Glossary

One name per thing. These words are used with exactly these meanings in code, events, UI text and documents.

| Term | Meaning |
| --- | --- |
| Pool | One product codebase: one Artifacts repo (branch `main`) plus one Trunk. |
| Intent | A person's request in plain words. Id `i_<ULID>`. |
| Attempt | One agent's try at an intent. Id `a_<ULID>`. An intent may have several attempts (Race). |
| Premise | A platform-observed record that an attempt relied on something at a specific version. Kinds: `entity`, `file`, `listing`, `query`. |
| Change | Intent + premises + edit operations + checks. The unit that lands. Id `c_<ULID>`. Each attempt has exactly one change. |
| Trunk | The per-pool sequencer (a Durable Object). The only writer of `main`. |
| Heads-up | A message from Trunk to a running agent that something it relied on has changed, with the exact diff. |
| Go-around | An agent adapting its work after a heads-up of result `repair`, with its context intact. |
| Landing | A change becoming one ordinary commit on `main`. Numbered by `seq` (1, 2, 3, ...). |
| Green line | The newest commit that passed verification (`refs/heads/green`). |
| Floor | The one web page where a person watches and steers. |
| Why card | The record of one landing, as shown to a person. |
| Who relies | Reverse lookup: which attempts and landings hold a premise on an entity. |
| Swarm | Scripted (synthetic) agents using the same tool path. Always labelled SYNTHETIC. |
| Synthetic attempt | An attempt whose agent is a script, not a model (`agent: "synthetic"`). This flag alone decides the SYNTHETIC banner and scripted triage (TR8). |
| Synthetic pool | A pool in which at least one synthetic attempt was opened (`pool.state.synthetic`, EM1a). Its numbers are shown under the SYNTHETIC banner. |
| Summary-only pool | A pool created with the flag `summary_only: true` (the Swarm pool and the soak pools). Its stream leaves out the per-step and per-premise events (EV6). The flag says nothing about who the agents are. |
| Replay | A recorded event stream played through the same UI with no credentials. |
| Entity | A named top-level part of a JavaScript ES module (section 2.3). Key `path#name`. |
| Head | Trunk's current state of `main`: the last *accepted* landing (section 9.4). |
| Landed commit | The commit of the last landing *confirmed* on `main` (`pool.state.landed_commit`, LP9). It is what the source `main` means to the app server and to a pool frame. It can be older than head. |
| Attempt view | Head with the attempt's own edit operations replayed on top (section 5.2). |
| Blind spot | An entity that an attempt's change adds a reference to and that the agent was never shown (section 6.4). |
| Right of way | The starvation rule: a bounded priority for an attempt that was sent back twice (section 11.2). |
| Card | A decision shown to the owner. Kinds: `held`, `choice`, `race`. Its options are fixed by rule CD4. (The rail item that shows one attempt on the Floor is the "attempt card" of `03-floor.md`. It is not a Card.) |
| Shown | What the agent's context actually holds for a premise: the version last returned by a read tool or carried by a heads-up item. Stored next to the pinned hash (3.2). |
| Sweeping | An attempt is sweeping a directory or a search when its operations cover at least two of the members it found (or the only one) (7.2). |
| Pull-back | A `confirm` that takes an attempt out of the landing queue (`submitted`, `validated` or `held` → `needs_confirm`). Counted next to go-arounds (GA3). |
| Parked | A stopped attempt whose open choice card offers `retry`. It stays classified so that "Try again" resumes on current facts (GL3a). |
| Resume | The call by which Trunk starts a stopped or landed Agent again after "Try again", an undo or a revert (RS1). |
| Live frame, commit frame | A pool frame that follows a moving source (`main`, `plain`), or one that shows one fixed commit (Replay, card previews) (SE16a). |
| Plain-merge repository | The second Artifacts repository of a pool: the "same changes, merged by plain git" pool and the preview commits (11.7, PV1). |
| Preview commit | An immutable commit that holds head plus one attempt's operations, made when a held or race card opens (PV1). |
| Model gate | The one Durable Object that every model call asks first: rate limits, spend cap, kill switch (13.3). |

How Premise differs from the related work named above: reads are observed by the platform (never declared by the agent) at entity, listing and search level; premises are checked live, not only at submit; the record is stored in git notes on Artifacts; one record serves landing, review, why, who-relies and undo.

---

## 2. Keys and hashes

### 2.1 Paths

A path is relative to the repo root and MUST match `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`. No segment may be `.`, `..` or `.git`. Maximum length `MAX_PATH_LEN`. A tool call with any other path fails with `invalid_path` and records nothing.

A **directory key** is the directory's path followed by `/`. The repo root is `/`.

A **module** is a file whose path ends in `.js` or `.mjs`. A module that acorn cannot parse, and every other file, is **opaque**.

### 2.2 Premise keys

A premise is identified inside an attempt by `(kind, key)`.

| Kind | Key format | Example |
| --- | --- | --- |
| `entity` | `<path>#<name>` | `world/energy.js#ENERGY_MAX` |
| `file` | `<path>` | `world/energy.js` |
| `listing` | `<directory key>` | `creatures/` |
| `query` (text search) | `text:<scope>:<needle>` | `text:creatures/:drain(` |
| `query` (who references) | `refs:<entity key>` | `refs:world/energy.js#ENERGY_MAX` |
| `query` (outline) | `outline:<path>` | `outline:world/energy.js` |

In a `text` key, `<scope>` is a directory key or a file path, and `<needle>` is everything after the second colon. Because paths cannot contain `:`, the key parses unambiguously.

### 2.3 What counts as an entity

Parse with acorn, options `{ ecmaVersion: 2025, sourceType: "module" }`, exact acorn version pinned in `package.json`. Walk `Program.body` in source order. Each top-level statement contributes to one or more entities:

| Top-level statement | Entity name | Kind | Export names added |
| --- | --- | --- | --- |
| `function f() {}` (also async, generator) | `f` | `function` | none |
| `class C {}` | `C` | `class` | none |
| `const a = 1, b = 2;` (also `let`, `var`) | one entity per bound identifier (`a`, `b`) | `const` / `let` / `var` | none |
| `const { p, q } = obj;` | one entity per bound identifier (`p`, `q`); they share the same declarator | as above | none |
| `export function f() {}`, `export class C {}`, `export const a = 1;` | as the unexported form | as above | the binding name |
| `export default function f() {}`, `export default class C {}` | `f` / `C` | `function` / `class` | `default` |
| `export default function () {}`, `export default class {}` | `default` | `function` / `class` | `default` |
| `export default <expression>;` | `default` | `value` | `default` |
| `export { a, b as c };` (no source) | no new entity. Adds export name `a` to entity `a` and `c` to entity `b`. If the local name is an import binding, it is treated as the re-export `export { imported as c } from "<source>"`. | n/a | as written |
| `export { a as b } from "./m.js";` | `b` | `reexport` | `b` |
| `export * as ns from "./m.js";` | `ns` | `reexport` | `ns` |
| `export * from "./m.js";` | `*./m.js` (a star followed by the specifier text) | `reexport-all` | `*` |
| `import ... from "./m.js";` | `(import ./m.js)`. All import declarations with the same specifier text share one entity. | `import` | none |
| any other statement (expression statement, `if`, `for`, a block, ...) | `(top)`. All such statements share one entity. | `top` | none |

Rules:

- **EN1.** Exported and non-exported top-level declarations are both entities. Export status is part of the entity (it is in the hash, section 2.4).
- **EN2.** Declarations nested inside functions, classes or blocks are not entities. They belong to the enclosing top-level entity.
- **EN3.** Names in parentheses and names starting with `*` cannot collide with JavaScript identifiers. `default` is used only for an anonymous default export.
- **EN4.** Two statements that contribute to the same name (for example `var a; var a;`, or two imports from one specifier) form one entity whose nodes are in source order.
- **EN5.** A module with no statements has exactly one entity, `(top)`, with no nodes.
- **EN6.** Every character of a module belongs to exactly one **region**. The region of statement *i* runs from the end of statement *i-1* (or offset 0) to the end of statement *i*; the last region runs to the end of the file. So leading comments and blank lines belong to the statement that follows them. The **targets** of a character span are the entities contributed by every statement whose region intersects the span, in source order, without duplicates. For `export { a, b as c };` the statement contributes the entities it exports.
- **EN7.** An entity's **source** (what `read` returns) is the text of the regions of its statements, with leading blank lines removed.
- **EN8.** An opaque file has no entities.

### 2.4 Normalized entity hash (rule 6 of the brief)

The hash ignores comments, whitespace, redundant parentheses, semicolon style, quote style and number spelling, because it is computed from the syntax tree, not from text.

Algorithm `entityHash(entity)`:

1. For each statement that contributes to the entity, take its **node** (in source order):
   - function or class declaration (plain, `export`ed or `export default`): the `FunctionDeclaration` / `ClassDeclaration` node;
   - variable declarator: the object `{ "type": "VariableDeclarator", "kind": <"const"|"let"|"var">, "id": <id node>, "init": <init node or null> }`;
   - `export default <expression>`: the expression node;
   - import declaration: the `ImportDeclaration` node;
   - `export { a as b } from "./m.js"`: `{ "type": "ReExport", "source": "./m.js", "imported": "a" }`; for `export * as ns from`, `imported` is `"*"`;
   - `export * from "./m.js"`: `{ "type": "ReExportAll", "source": "./m.js" }`;
   - `(top)` statement: the statement node.
2. **Clean** each node recursively: drop the keys `start`, `end`, `loc`, `range`; on nodes of type `Literal` drop `raw`, and drop `value` when `regex` or `bigint` is present; on a `Literal` whose `value` is a number that is not finite (the source spelled a number too large, for example `1e999`), drop `value` and add the key `number` with the string `"Infinity"` (JSON would turn the value into `null`, which is another literal); drop keys whose value is `undefined`. Arrays and all other keys are kept.
3. Build `{ "exports": <sorted array of the entity's export names>, "nodes": <array of cleaned nodes> }`.
4. Serialize as JSON with object keys sorted at every level. Numbers and strings use ECMAScript `JSON.stringify` rules. This string is the **canonical form**.
5. `entityHash = H(canonical form)`.

Worked example. Both of these sources:

```js
// Energy is counted in points, from 0 to ENERGY_MAX.
export const ENERGY_MAX = 100;
```

```js
export   const ENERGY_MAX =
  1e2 ; // points
```

give the canonical form

```json
{"exports":["ENERGY_MAX"],"nodes":[{"id":{"name":"ENERGY_MAX","type":"Identifier"},"init":{"type":"Literal","value":100},"kind":"const","type":"VariableDeclarator"}]}
```

and the hash `5149f012fe7cd2dfd8820a214ea41ff0`. Changing the value to `1`, or removing `export`, changes the canonical form and so the hash.

Known limits (state them in the README):

- An entity's hash covers its own tokens only. If an import line is changed so that a name used by the entity now comes from another module, `(import ...)` changes and the entity does not.
- References are direct (6.2). Code that depends on a quantity only through another function it calls holds a premise on that function, whose hash does not change when the quantity does (6.5, HC3).
- The cleaned tree depends on the pinned acorn version; `hash_version` (currently `"ast1"`) is stored in every note, and a parser upgrade requires a re-index of the pool (section 3.6).

### 2.5 File, listing and query hashes

| Kind | Hash | Members stored with the premise |
| --- | --- | --- |
| `entity` | `entityHash` (2.4) | none |
| `file` | the git blob object id of the file's bytes (40 hex, SHA-1 over `"blob <len>\0" + bytes`), so `git cat-file -p <hash>` shows what was relied on | none |
| `listing` | `H(JSON array of sorted entry names)`. Entries are the directory's immediate children; a subdirectory's name ends in `/`. A directory with no entries, or that does not exist, has the array `[]`. | the entry names |
| `query` `text:` | `H(JSON array of sorted members)`, one member `<container>*<count>` per container (2.6) | the members |
| `query` `refs:` | `H(JSON array of sorted members)`: the referrer entity keys of the entity (6.2), plus one member `<path>@<module hash>` for every module that holds at least one referrer | the members |
| `query` `outline:` | `H(JSON array of sorted outline lines)` (2.7) | the outline lines |

- **KH1 (module hash).** `moduleHash(path) = H(JSON array of the sorted strings "<entity name> <entityHash>")` over every entity of the module. It changes exactly when an entity of the module is added, removed or changes its hash; comments and whitespace do not change it.
- **KH2 (absent).** An entity, a file or an outline whose target does not exist has the hash `absent` (the literal string). A premise may be pinned at `absent`. A listing is never `absent`: a missing directory has the hash of `[]`. A `text:` or `refs:` query with no member has the hash of `[]`.
- **KH3 (parsing a member).** In a `text:` member the count is the decimal digits after the last `*`. In a `refs:` member, a string that contains `#` is a referrer key and any other string is a module entry (`@` cannot occur in a path).

Examples from the vector pool: the listing `creatures/` with `fish.js` and `snail.js` has the JSON `["fish.js","snail.js"]` and hash `a55430205a91ff9e355e9502080105a5`. The empty set `[]` has hash `4f53cda18c2baa0c0354bb5f9a3ecbe5`. The module hash of `creatures/fish.js` is `854043e6f224188840f8df611e97e6db` (hash case `H19`). The premise `refs:world/energy.js#ENERGY_MAX` has six members (four referrer keys and the module entries of `creatures/fish.js` and `creatures/snail.js`) and hash `ff47aaea471d570878c4fe52260ff79a` (`H15`).

### 2.6 Text query match set

`search` is a literal, case-sensitive substring search (no regular expressions) on the files at head. The scope is a file path or a directory key. A directory scope is **recursive**: it covers every file whose path starts with the directory key (`/` covers the whole pool). `list` is not recursive (4.5).

The **container** of a match at character offset *o* in file *p* is:

- for a module: `p#<name>` for each target of the span `[o, o + needle length)` (EN6);
- for an opaque file: `p`.

Matches are counted at every offset where the needle starts (overlapping matches count). The premise's members are `<container>*<count>`, where count is the number of matches whose targets include that container. So a second match inside an entity that already matches changes the premise (`creatures/fish.js#update*1` becomes `creatures/fish.js#update*2`, vector `C43`).

- A container is **gained** when it is new or its count rose. It is **lost** when it disappeared or its count fell.
- The `containers` array in the tool result and the `added` keys of a heads-up item are plain container keys, without counts.
- The lines shown to the agent are not part of the premise.

### 2.7 Outline lines

For each entity of a module, one line: `<name>|<kind>|<export names, sorted, joined by ",">|<arity>`, where arity is the number of parameters for kind `function` and the empty string otherwise. Example: `drain|function|drain|2`. An outline changes only when an entity is added, removed or renamed, or its kind, export names or parameter count change.

---

## 3. Storage

### 3.1 What is authoritative where

| Data | Authoritative store | Rebuildable from |
| --- | --- | --- |
| Files, history, landings, premises of landed changes, green line | Artifacts pool repo (`main`, `refs/heads/green`, `refs/notes/premise`) | n/a |
| Head index, entity table, reference table, landing log | Trunk SQLite | Artifacts alone (3.6) |
| Premises, operations, heads-ups and state of in-flight attempts | Trunk SQLite | Agent Durable Objects (3.6 step 6): operations and read premises; heads-ups and judgments are created again by classification |
| Content of blobs replaced by recent landings (for undo and revert) | Trunk SQLite (`blobs`) | Artifacts |
| Cards, undo requests, the outbox | Trunk SQLite | not rebuildable; a re-index keeps them (RB2), a rebuild from Artifacts closes cards as `stale` |
| Transcript, journal, mirror of operations and premises | Agent SQLite, checkpointed to the attempt repo | n/a |
| Event stream | Floor SQLite | not rebuildable; Replay files are exports of it |

- **RB0 (what "rebuildable from Artifacts" covers).** The brief asks that everything in Trunk's SQLite can be rebuilt from Artifacts. This table narrows that on purpose, and the limit is stated to the reader (README and the limits list of `03-floor.md` 5.12): the landed history is rebuilt in full from `main` and `refs/notes/premise`; after a rebuild from Artifacts, open cards close as `stale`, queued undo requests are gone, and agents in flight register again (3.6 steps 6 to 8).

### 3.2 Trunk Durable Object SQLite

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
-- keys: schema_version, hash_version, pool_id, head_seq, head_commit, head_tree,
--       notes_commit, green_seq, green_commit, pool_state ('ready'|'rebuilding'|'paused'),
--       pause_reason, next_batch_id, next_event_n, epoch (RB5), rebuild_cursor (RB3),
--       repo, repo_generation (S2), plain_commit, plain_through_seq (11.7),
--       summary_only ('0'|'1', fixed at pool creation, PL1), synthetic ('0'|'1', EM1a)

CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT '100644',
  oid         TEXT NOT NULL,              -- git blob id
  content     BLOB,                       -- <= MAX_FILE_BYTES; NULL only for an oversize seed file (RB4)
  parse_state TEXT NOT NULL,              -- 'module' | 'opaque'
  changed_seq INTEGER NOT NULL
);                                        -- an ordinary rowid table: rows hold large values

CREATE TABLE trees (                      -- cache for commit building
  dir TEXT PRIMARY KEY,                   -- directory key
  oid TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE entities (
  key         TEXT PRIMARY KEY,           -- path#name
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  exports     TEXT NOT NULL,              -- JSON array
  arity       INTEGER,
  hash        TEXT NOT NULL,
  changed_seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX entities_path ON entities(path);

CREATE TABLE refs (                       -- references at head (section 6)
  from_key TEXT NOT NULL,                 -- entity key
  to_key   TEXT NOT NULL,                 -- entity key, or a path for a whole-module reference
  PRIMARY KEY (from_key, to_key)
) WITHOUT ROWID;
CREATE INDEX refs_to ON refs(to_key);

CREATE TABLE intents (
  intent_id  TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  requester  TEXT NOT NULL,
  race       INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL,               -- 'open' | 'landed' | 'stopped' | 'undone'
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE attempts (
  attempt_id      TEXT PRIMARY KEY,
  intent_id       TEXT NOT NULL,
  change_id       TEXT NOT NULL UNIQUE,
  agent_kind      TEXT NOT NULL,          -- 'real' | 'synthetic'
  model           TEXT,
  race            INTEGER NOT NULL DEFAULT 0, -- 1 while the attempt is a race candidate (RC1); cleared when it is chosen (RC7)
  truth           TEXT,                   -- synthetic attempts only: JSON array of "<kind>:<key>" the scripted change truly depends on (TR8)
  resumes         INTEGER NOT NULL DEFAULT 0, -- counts T19 and T21; sent as resume_n (RS1)
  state           TEXT NOT NULL,          -- section 9.1
  stop_reason     TEXT,
  go_arounds      INTEGER NOT NULL DEFAULT 0,
  pull_backs      INTEGER NOT NULL DEFAULT 0, -- GA3
  revision        INTEGER NOT NULL DEFAULT 1, -- counts reopens; never reset (GR3a)
  right_of_way_at INTEGER,                -- ms; NULL when not granted
  opened_seq      INTEGER NOT NULL,
  submit_id       TEXT,                   -- NULL whenever the attempt is not in submitted, validated or held
  summary         TEXT,
  tier            TEXT,                   -- 'auto' | 'held'
  approved_by     TEXT,
  bypass_row      INTEGER NOT NULL DEFAULT 0, -- 1 after "Land now" (RW5)
  sets            TEXT,                   -- JSON: Added, Altered, NewRefs, ModuleRefs, AddedRefs (6.3), stored when operations change
  submitted_at    INTEGER,
  validated_at    INTEGER,
  landed_seq      INTEGER,
  attempt_repo    TEXT,                   -- NULL until provisioned; never read on the landing path
  last_call_id    TEXT,
  last_response   TEXT,                   -- JSON of the response to last_call_id, without heads_ups (TA2)
  ack             INTEGER NOT NULL DEFAULT 0,
  next_hn         INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX attempts_state ON attempts(state, validated_at);
CREATE INDEX attempts_intent ON attempts(intent_id);

CREATE TABLE premises (                   -- in-flight attempts only
  attempt_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  hash       TEXT NOT NULL,               -- the version the premise is pinned at: always the head version (V4); may be 'absent'
  seq        INTEGER NOT NULL,            -- head_seq when hash was pinned
  members    TEXT,                        -- JSON array for listing and query premises
  shown      TEXT,                        -- what the agent's context holds (see below); NULL = never shown
  read       INTEGER NOT NULL DEFAULT 0,  -- pinned by outline/read/list/search
  edit       INTEGER NOT NULL DEFAULT 0,  -- implied by a current operation
  derived    INTEGER NOT NULL DEFAULT 0,  -- added by Trunk (section 6)
  status     TEXT NOT NULL DEFAULT 'holds', -- 'holds'|'pending_triage'|'pending_confirm'|'pending_repair'
  PRIMARY KEY (attempt_id, kind, key)
) WITHOUT ROWID;
CREATE INDEX premises_key ON premises(kind, key);

CREATE TABLE ops (                        -- in-flight attempts only; section 5
  attempt_id TEXT NOT NULL,
  op_seq     INTEGER NOT NULL,
  op         TEXT NOT NULL,               -- 'write' | 'replace'
  path       TEXT NOT NULL,
  content    TEXT,                        -- write; NULL means delete
  old        TEXT,                        -- replace
  new        TEXT,                        -- replace
  base_oid   TEXT,                        -- every write: head oid of the path when the write was accepted, or 'absent' (W4)
  targets    TEXT,                        -- replace: JSON array of entity keys, or [path] for an opaque file
  dropped    INTEGER NOT NULL DEFAULT 0,  -- 1 when dropped by rule OP6
  PRIMARY KEY (attempt_id, op_seq)
) WITHOUT ROWID;

CREATE TABLE ops_first (                  -- snapshot for the plain-merge pool, section 11.7 (PM2)
  attempt_id TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  ops        TEXT NOT NULL,               -- JSON array of operations
  submitted  INTEGER NOT NULL,            -- 1 if the attempt had passed a submit before this moment (PM4)
  PRIMARY KEY (attempt_id, revision)
) WITHOUT ROWID;

CREATE TABLE heads_ups (
  attempt_id   TEXT NOT NULL,
  hn           INTEGER NOT NULL,          -- 1, 2, 3, ... per attempt
  result       TEXT NOT NULL,             -- 'info' | 'confirm' | 'repair'
  wake         INTEGER NOT NULL,          -- HE2
  body         TEXT NOT NULL,             -- JSON HeadsUp (section 8.2), <= HEADS_UP_MAX_BYTES (HU10)
  created_at   INTEGER NOT NULL,
  received_at  INTEGER,                   -- set when the Agent stored it (push returned, or carried by a response)
  delivered_at INTEGER,                   -- set when a request arrives with ack >= hn (HU8)
  resolved_at  INTEGER,                   -- set when acknowledged in a submit
  statement    TEXT,
  op_mark      INTEGER NOT NULL DEFAULT 0, -- HU12: the attempt's last op_seq when its go-around started (repair) or when it was created (info, confirm)
  PRIMARY KEY (attempt_id, hn)
) WITHOUT ROWID;

CREATE TABLE judgments (
  judgment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  old_hash    TEXT NOT NULL,
  new_hash    TEXT NOT NULL,
  cause       TEXT NOT NULL,              -- 'landing' | 'submit' | 'undo' | 'revert'
  cause_seq   INTEGER,
  rule        TEXT NOT NULL,              -- decision table row id
  class       TEXT NOT NULL,              -- 'rule' | 'triage'
  result      TEXT,                       -- 'holds' | 'confirm' | 'repair'; NULL while triage is pending
  asked_op_seq INTEGER,                   -- triage: the attempt's last op_seq when the question was asked (V7)
  asked_at    INTEGER,                    -- triage: when the request was dispatched (TR6)
  tries       INTEGER NOT NULL DEFAULT 0, -- triage: 1 after a re-ask on start-up (TR6)
  reason      TEXT NOT NULL,
  clef_model  TEXT,
  clef_p      REAL,
  clef_ms     INTEGER,
  clef_error  TEXT,
  t_repair    REAL,                       -- thresholds in force when judged
  t_confirm   REAL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX judgments_attempt ON judgments(attempt_id);

CREATE TABLE landings (
  seq          INTEGER PRIMARY KEY,       -- seq 0 is the seed and has no row
  kind         TEXT NOT NULL,             -- 'change' | 'undo' | 'revert'
  change_id    TEXT NOT NULL,
  attempt_id   TEXT,                      -- NULL for undo and revert
  intent_id    TEXT,
  batch_id     INTEGER NOT NULL,
  commit_oid   TEXT NOT NULL,
  parent_oid   TEXT NOT NULL,
  tree_oid     TEXT NOT NULL,
  note_oid     TEXT NOT NULL,             -- blob id of the note
  note         TEXT NOT NULL,             -- the note JSON (3.5)
  submitted_at INTEGER,
  accepted_at  INTEGER NOT NULL,
  pushed_at    INTEGER,                   -- NULL until confirmed on main
  undone_by    INTEGER                    -- seq of the undo or revert landing
);

CREATE TABLE landing_files (              -- per-path effect of each landing
  seq     INTEGER NOT NULL,
  path    TEXT NOT NULL,
  old_oid TEXT NOT NULL,                  -- 'absent' allowed
  new_oid TEXT NOT NULL,
  PRIMARY KEY (seq, path)
) WITHOUT ROWID;

CREATE TABLE landing_writes (             -- the write set W(seq), section 9.5
  seq      INTEGER NOT NULL,
  kind     TEXT NOT NULL,                 -- 'entity' | 'file' | 'listing'
  key      TEXT NOT NULL,
  old_hash TEXT NOT NULL,
  new_hash TEXT NOT NULL,
  PRIMARY KEY (seq, kind, key)
) WITHOUT ROWID;
CREATE INDEX landing_writes_key ON landing_writes(kind, key, seq);

CREATE TABLE landing_premises (           -- frozen premises of landed changes
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  key     TEXT NOT NULL,
  hash    TEXT NOT NULL,
  pin_seq INTEGER NOT NULL,
  read    INTEGER NOT NULL,
  edit    INTEGER NOT NULL,
  derived INTEGER NOT NULL,
  PRIMARY KEY (seq, kind, key)
) WITHOUT ROWID;
CREATE INDEX landing_premises_key ON landing_premises(kind, key);

CREATE TABLE landing_ops (                -- operations of landed changes (for undo, section 11.3)
  seq    INTEGER NOT NULL,
  op_seq INTEGER NOT NULL,
  body   TEXT NOT NULL,                   -- JSON operation
  PRIMARY KEY (seq, op_seq)
) WITHOUT ROWID;

CREATE TABLE blobs (                      -- content of blobs replaced by landings, for undo and revert planning (11.3)
  oid     TEXT PRIMARY KEY,               -- git blob id
  content BLOB NOT NULL,
  seq     INTEGER NOT NULL                -- the landing that replaced it
);

CREATE TABLE outbox (                     -- at most one row with state 'pending' or 'notes_pending' (LP1)
  batch_id   INTEGER PRIMARY KEY,
  state      TEXT NOT NULL,               -- 'pending' | 'notes_pending' | 'pushed' | 'diverged'
  first_seq  INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL,
  old_main   TEXT NOT NULL,
  new_main   TEXT NOT NULL,
  old_notes  TEXT NOT NULL,               -- 40 zeros when the notes ref does not exist yet
  new_notes  TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  rejects    INTEGER NOT NULL DEFAULT 0,  -- rejections while both refs kept their old value (LP5b)
  next_try   INTEGER,
  last_error TEXT,                        -- after redact() (SE5a); never sent in an event
  created_at INTEGER NOT NULL,
  pushed_at  INTEGER
);
CREATE TABLE outbox_chunks (              -- the exact pack bytes, <= 1 MiB per row; deleted when the batch is 'pushed'
  batch_id INTEGER NOT NULL,
  i        INTEGER NOT NULL,
  bytes    BLOB NOT NULL,
  PRIMARY KEY (batch_id, i)
);

CREATE TABLE cards (
  card_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,               -- 'held' | 'choice' | 'race'
  state      TEXT NOT NULL,               -- 'open' | 'closed'
  body       TEXT NOT NULL,               -- JSON Card (section 10.3)
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
) WITHOUT ROWID;

CREATE TABLE undo_requests (
  request_id TEXT PRIMARY KEY,
  target_seq INTEGER NOT NULL,
  cause      TEXT NOT NULL,               -- 'undo' | 'revert'
  state      TEXT NOT NULL,               -- 'queued' | 'landed' | 'refused'
  detail     TEXT                         -- JSON: { requested_by, reverted: number[] } as confirmed (UN5); or { reason } when refused
) WITHOUT ROWID;

CREATE TABLE events_out (                 -- Trunk's outbox to the Floor (section 12.2); a row is deleted when the Floor confirmed it
  n    INTEGER PRIMARY KEY,               -- source_n within meta.epoch
  ts   INTEGER NOT NULL,                  -- Trunk's clock when the state change committed
  body TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
-- plus the `timers` table of 3.3 (rule AL1)
```

The `shown` value of a premise is what the agent's context holds, as opposed to `hash`, which follows head:

| Kind | `shown` holds | Set by | Used by |
| --- | --- | --- | --- |
| `file` | the blob id returned by the attempt's last whole-file `read` | whole-file `read` only | W1 |
| `listing` | the entry names (JSON array) the agent was last shown | `list`; a heads-up item for this premise (L1, L2) | L1 |
| `entity` | the entity hash the agent was last shown | `read` of the entity; any heads-up item for this premise that carries its source | B1 |
| `query` | not used | | |

Retention: `blobs` keeps a row while its `seq` is within the last `UNDO_WINDOW` landings or newer than `green_seq`. `outbox_chunks` rows are deleted when their batch is `pushed`. `landing_writes`, `landing_premises` and `landing_ops` may be dropped for landings older than `UNDO_WINDOW` (the note in Artifacts keeps them). `premises`, `ops` and `heads_ups` of an attempt are deleted when it lands (after its note is built), when it stops without becoming parked, or when the card of a parked attempt closes with an option other than `retry` (GL3a).

Trunk keeps no in-memory git client and no state that is not in SQLite. Memory holds only caches that can be dropped.

### 3.3 Agent Durable Object SQLite

```sql
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
-- keys: attempt_id, intent_id, change_id, pool_id, intent_text, agent_kind, model,
--       revision, resumed_n (highest resume_n accepted, RS2),
--       state, step, shown_hn (highest heads-up placed in the model's context),
--       tokens_in, tokens_out, model_calls, started_at, deadline_at, stop_reason

CREATE TABLE transcript (                 -- everything the model saw and said, in order
  step        INTEGER PRIMARY KEY,
  role        TEXT NOT NULL,              -- 'system' | 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,              -- JSON
  tool        TEXT,
  call_id     TEXT,
  model       TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE journal (                    -- write-ahead record of the one call in progress
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  kind        TEXT NOT NULL,              -- 'model' | 'tool'
  call_id     TEXT NOT NULL,
  request     TEXT NOT NULL,              -- JSON
  tries       INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL
);

CREATE TABLE ops (                        -- mirror of operations Trunk acknowledged
  op_seq INTEGER PRIMARY KEY,
  body   TEXT NOT NULL
);

CREATE TABLE premises (                   -- mirror of ToolResponse.premises
  kind TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL,
  read INTEGER NOT NULL, edit INTEGER NOT NULL, derived INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;

CREATE TABLE inbox (                      -- pending heads-ups
  hn          INTEGER PRIMARY KEY,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  shown_step  INTEGER                     -- transcript step that carried it to the model
);

CREATE TABLE checkpoints (
  n          INTEGER PRIMARY KEY,
  step       INTEGER NOT NULL,
  commit_oid TEXT,
  pushed_at  INTEGER
);
```

Recovery rules (an evicted agent MUST end in a recorded state, never a silent stall):

- **AG1.** Before every model call and every tool call, the agent writes the `journal` row and a `call` timer (AL1) at `deadline_at`. After the call it writes the transcript row and deletes the journal row in one transaction.
- **AG2.** On start-up or alarm with a `journal` row present: a tool call is retried with the same `call_id` (Trunk returns the stored response, rule TA2); a model call is retried up to `MODEL_RETRIES` times with a new reservation (SE6). When retries are exhausted the attempt stops with `model_error` or `tool_timeout`, and Trunk is told with the `stop` call (4.1, TA9). The Agent tells Trunk the same way whenever it ends its own attempt (AG3, AG4, the kill switch, an owner cancel, a scripted withdrawal); it repeats the call until Trunk answers. On start-up with **no** `journal` row and a state of `working`, `going_around` or `needs_confirm`, the agent continues its loop at the next step (a deploy between two steps must not end the attempt).
- **AG3 (watchdog).** While the state is not `landed` or `stopped`, a `watchdog` timer is always set (`AGENT_WATCHDOG_MS`). The watchdog stops the attempt with `stalled` only when all of these hold: no `journal` row exists whose `deadline_at` is in the future; `step` has not changed since the previous watchdog run; and the agent is not in an **exempt wait**. Exempt waits: waiting for the owner on a card (`held`); waiting for a landing (`submitted`, `validated`, `accepted`); waiting for the model gate (SE8: a `gate` timer exists); `opened` while queued behind `MAX_REAL_AGENTS`; a scripted agent held before its `submit` until its release (`02-tidepool.md` SW8, SWR3; added 2026-10-05: a live run showed the cast of the hero conflict stopped as `stalled` while it waited for the held card).
- **AG4.** Budgets: `MAX_STEPS`, `MAX_MODEL_CALLS`, `MAX_ATTEMPT_TOKENS`, `MAX_ATTEMPT_USD`, `ATTEMPT_TIMEOUT_MS`. Exceeding any stops the attempt with `budget` or `timeout`. A refusal by the global spend cap stops it with `spend_cap` (SE7), a different reason.
- **AG5.** Checkpoints to the attempt repo are asynchronous and are never awaited by a tool call or a landing. A failed or missing attempt repo changes nothing on the landing path. Each provisioning result is reported as an `attempt.repo` event.
- **AG6 (budgets after a reopen or a retry).** On T19 and T21 the step, model-call and time budgets are each extended by a fixed allowance (`RESUME_STEPS`, `RESUME_MODEL_CALLS`, `RESUME_TIMEOUT_MS`) counted from the resume. `MAX_ATTEMPT_TOKENS` and `MAX_ATTEMPT_USD` are never reset, so one attempt's total spend stays bounded whatever happens to it. The Agent applies the allowance when it accepts the `resume` call (RS2).
- **AG7 (redaction).** Every string the Agent writes to its transcript, to an event or to the attempt repo passes `redact()` (SE5a) first.
- **AG8 (an Agent that ended can be started again).** An Agent whose state is `landed` or `stopped` keeps its transcript, its mirrors and its `meta`. It sets no timer and makes no call. Only the `resume` call from Trunk (8.3, RS1 to RS5) starts it again. AG6 and AG8 are needed by "Try again" on the go-around-limit card, so they belong to every build, also one without Undo and without the green line.

Timers (both Durable Objects). A Durable Object has one alarm slot, so several timers share it:

```sql
CREATE TABLE timers (                     -- in Trunk and in every Agent
  kind   TEXT NOT NULL,                   -- Trunk: 'tick' | 'push' | 'repush' | 'resume' | 'triage' | 'right_of_way' | 'rebuild' | 'green' | 'plain' | 'events'
                                          -- Agent: 'call' | 'watchdog' | 'gate' | 'attempt_timeout'
  key    TEXT NOT NULL,                   -- '' when the kind has one instance
  due_at INTEGER NOT NULL,                -- ms since epoch
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;
```

- **AL1.** The single alarm is always set to the smallest `due_at` in `timers`. The alarm handler runs every timer whose `due_at` has passed, in `due_at` order, deletes or re-schedules each one, and sets the alarm again before it returns.
- **AL2.** The alarm handler catches every error of a timer's work, records it (Trunk: event `trunk.error` with a fixed code; Agent: transcript row), keeps the timer with a backoff, and still re-arms the alarm. A thrown alarm is never the only thing that would have re-armed it.
- **AL3.** Every request handler ends by checking that an alarm is set whenever `timers` is not empty. This recovers from an alarm that the platform stopped retrying.
- **AL4.** No handler waits on the network inside `blockConcurrencyWhile` or inside a SQLite transaction (SY2).

### 3.4 Floor Durable Object SQLite

```sql
CREATE TABLE events (
  n    INTEGER PRIMARY KEY,               -- 1, 2, 3, ... no gaps
  t    INTEGER NOT NULL,                  -- ms since epoch: arrival at the Floor
  ts   INTEGER NOT NULL,                  -- ms since epoch: the source's clock when the state change committed
  type TEXT NOT NULL,
  body TEXT NOT NULL                      -- JSON of the whole event (section 12)
);
CREATE TABLE sources (                    -- de-duplication of at-least-once delivery
  source TEXT PRIMARY KEY,                -- 'trunk' | 'agent:<attempt_id>' | 'gate' | 'swarm' (EV2a); the Floor's own events need no row
  epoch  INTEGER NOT NULL DEFAULT 1,      -- RB5
  last_n INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE snapshots (                  -- reducer state for fast joins, in parts of at most 1 MiB
  n     INTEGER NOT NULL,
  part  INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (n, part)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
```

- **FS1 (bounded state).** The reducer state that is snapshotted holds: every in-flight attempt in full; for landed changes the last `FLOOR_KEEP_LANDINGS` landings in full and older ones as one summary line each; counters. An attempt of a `summary_only` pool is held as state, counters and its last heads-up only (EV6), whether its agent is real or synthetic.
- **FS2 (public reads).** Why cards, who-relies, metrics, landing notes and the current commit of each ref are answered from this Durable Object's reducer state. A public request never reaches Trunk (SE19). The same state gives the app server what its generated modules need (`02-tidepool.md` 4.4): the `seq` of the landed commit, and for each path the `seq` of the last confirmed landing that changed it (from `landing.accepted.paths`, counted when its `landing.landed` arrives). Nothing the app server serves is read from Trunk's `files` table.
- **FS3 (sockets).** Stream sockets are accepted with the WebSocket hibernation API, and the only per-socket state is the socket's attachment (EV7).

### 3.5 What lives in Artifacts

Pool repo:

| Ref | Content |
| --- | --- |
| `refs/heads/main` | One ordinary commit per landing, first-parent linear. The commit that `main` pointed to when the pool was created is the **seed** (`seq` 0). |
| `refs/heads/green` | The newest verified commit (section 11.5). |
| `refs/notes/premise` | A notes commit chain. Its tree maps each landing commit id to one note blob, with fan-out `<first 2 hex>/<remaining 38 hex>`. |

Plain-merge repository (one per pool, 11.7): `refs/heads/main` holds the "same changes, merged by plain git" pool; `refs/previews/<submit_id>` holds preview commits (PV1; the fallback ref is in PV1a). Nothing on the landing path reads or writes it.

Attempt repo (one per attempt, provisioned asynchronously by a fork off the landing path (S3), in a separate Artifacts namespace, SE22): `refs/heads/attempt` holds checkpoint commits whose tree contains `transcript.jsonl`, `ops.json`, `premises.json` and the attempt view of every touched file.

**Commit** (one per landing). The object's bytes are exactly these lines, each ended by one LF, with one empty line before the message:

```
tree <tree id>
parent <previous head commit id>
author <author name> <<attempt id>@agents.premise.invalid> <accepted_at seconds> +0000
committer Premise Trunk <trunk@premise.invalid> <accepted_at seconds> +0000

<summary>

Intent: <intent text>

Change-Id: <change id>
Intent-Id: <intent id>
```

The e-mail of the author is written between literal angle brackets, like the committer's. For undo and revert landings the author line is `author Premise Trunk <trunk@premise.invalid> <seconds> +0000`.

- **CM1 (author name).** The model id for a real agent, `SYNTHETIC swarm` for a synthetic agent, `Premise Trunk` for undo and revert landings.
- **CM2 (sanitizing).** In the author name, the summary and the intent text: every control character (U+0000 to U+001F, U+007F) and every `<` and `>` in the author name is removed; line breaks in the intent text are replaced by one space first. So no user text can start a line that looks like a header or a trailer, and no NUL can reach the object.
- **CM3 (summary).** The submit summary after CM2, cut to one line of at most 72 Unicode code points (never inside a surrogate pair). If it is empty, the first 72 code points of the intent text.
- **CM4 (trailers).** The trailer block is exactly the two lines shown, in this order. Undo and revert landings add `Undoes: <commit id>` lines after them, one per reverted landing in ascending `seq`.
- **CM5.** The message ends with exactly one LF after the last trailer line.

Example (438 bytes; tree is git's empty tree, the parent id is arbitrary). Real git gives it the object id `6bd48525d87d048e928a6dce65cd7e033fcbd839`, and `git interpret-trailers --parse` finds exactly the two trailers:

```
tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
parent 8a1f0c2d3e4b5a69788796a5b4c3d2e1f0a9b8c7
author @cf/openai/gpt-oss-120b <a_01JB2M7B5D9F3H7K1N5R9T3V7X@agents.premise.invalid> 1791655424 +0000
committer Premise Trunk <trunk@premise.invalid> 1791655424 +0000

Add a crab that hides when its energy is low

Intent: a crab that hides when its energy is low

Change-Id: c_01JB2M8Q4T6Y3W9XKZ5R7N1V0P
Intent-Id: i_01JB2M7A0C4E8G2J6M0Q4S8U2W
```

**Note** (one per landing commit). Bytes:

- **NT1 (canonical bytes).** The note blob is the JSON value serialized with object keys sorted at every level (ascending by UTF-16 code unit), no insignificant whitespace, ECMAScript `JSON.stringify` rules for strings and numbers, UTF-8, followed by exactly one LF. Two implementations therefore produce the same blob id for the same record.
- **NT2 (size).** At most `NOTE_MAX_BYTES`. CK3a rejects a change whose note would not fit with `NOTE_RESERVE_BYTES` to spare. If the final note is still too large when it is built in the tick (many go-arounds since the submit), Trunk shrinks it in this order until it fits, and records what it did in `truncated`: drop `judgments` whose result is `holds`; cut every `statement` to 120 code points; replace the `old` and `new` of `replace` operations by their git blob ids (`old_oid`, `new_oid`). A note that still does not fit fails step 3c (`CKL`, code `note_too_large`).
- **NT3.** The note is built after the batch is complete (9.4 step 4), so `batch.size` is final.

Schema:

```ts
type Note = {
  v: 1;
  hash_version: "ast1";
  seq: number;
  kind: "change" | "undo" | "revert";
  change_id: string;
  revision: number;
  intent: { id: string; text: string; requester: string; created_at: string } | null;
  attempt: {
    id: string; agent: "real" | "synthetic"; model: string | null;
    repo: string | null; opened_seq: number;
    steps: number; model_calls: number; tokens_in: number; tokens_out: number;
  } | null;
  summary: string;
  premises: Array<{ kind: PremiseKind; key: string; hash: string; seq: number;
                    read: boolean; edit: boolean; derived: boolean }>;
  writes: Array<{ kind: "entity" | "file" | "listing"; key: string; old: string; new: string }>;
  ops: Array<
    | { op: "write"; path: string; blob: string }        // content is this blob in the commit's tree
    | { op: "write"; path: string; content: string }     // content not equal to the final blob
    | { op: "write"; path: string; delete: true }
    | { op: "replace"; path: string; old: string; new: string; targets: string[] }
    | { op: "replace"; path: string; old_oid: string; new_oid: string; targets: string[] }>;   // NT2 only
  go_arounds: Array<{ n: number; hn: number; cause: "landing" | "submit" | "undo" | "revert";
                      cause_seqs: number[]; keys: Array<{ kind: PremiseKind; key: string; rule: string }>;
                      statement: string | null; at: string }>;
  confirms: Array<{ hn: number; keys: Array<{ kind: PremiseKind; key: string; rule: string }>;
                    statement: string; at: string }>;
  judgments: Array<{ kind: PremiseKind; key: string; old: string; new: string; cause_seq: number | null;
                     rule: string; class: "rule" | "triage"; result: "holds" | "confirm" | "repair";
                     reason: string; clef?: { model: string; p: number | null; error?: string;
                     t_repair: number; t_confirm: number } }>;
  checks: Array<{ name: string; ok: true; detail?: string }>;
  policy: { tier: "auto" | "held"; approved_by: string | null; approved_at: string | null;
            option: "land" | "land_now" | "choose" | null; risk: RiskAnswers | null };
  pull_backs: number;
  truncated?: { judgments: number; statements: boolean; replace_texts: boolean };   // NT2
  batch: { id: number; index: number; size: number };
  timing: { opened_at: string; submitted_at: string; accepted_at: string };
  undo?: { requested_by: string; undoes: number[]; reopened: string[]; kept_readers: number[] };
};
```

Full example (the crab of vector `C04`, landing 2):

```json
{
  "v": 1,
  "hash_version": "ast1",
  "seq": 2,
  "kind": "change",
  "change_id": "c_01JB2M8Q4T6Y3W9XKZ5R7N1V0P",
  "revision": 1,
  "intent": {
    "id": "i_01JB2M7A0C4E8G2J6M0Q4S8U2W",
    "text": "a crab that hides when its energy is low",
    "requester": "owner",
    "created_at": "2026-10-10T18:03:11Z"
  },
  "attempt": {
    "id": "a_01JB2M7B5D9F3H7K1N5R9T3V7X",
    "agent": "real",
    "model": "@cf/openai/gpt-oss-120b",
    "repo": "attempt-a_01JB2M7B5D9F3H7K1N5R9T3V7X",
    "opened_seq": 0,
    "steps": 6,
    "model_calls": 5,
    "tokens_in": 9120,
    "tokens_out": 870
  },
  "summary": "Add a crab that hides when its energy is low",
  "premises": [
    { "kind": "entity", "key": "world/energy.js#ENERGY_MAX", "hash": "f52fdb40e9972b45534f0361ecb65cea",
      "seq": 1, "read": true, "edit": false, "derived": true },
    { "kind": "file", "key": "creatures/crab.js", "hash": "absent",
      "seq": 0, "read": false, "edit": true, "derived": false }
  ],
  "writes": [
    { "kind": "file", "key": "creatures/crab.js", "old": "absent", "new": "<blob id of the landed file>" },
    { "kind": "listing", "key": "creatures/", "old": "a55430205a91ff9e355e9502080105a5", "new": "<listing hash with crab.js>" },
    { "kind": "entity", "key": "creatures/crab.js#(import ../world/energy.js)", "old": "absent", "new": "<entity hash>" },
    { "kind": "entity", "key": "creatures/crab.js#spawn", "old": "absent", "new": "<entity hash>" },
    { "kind": "entity", "key": "creatures/crab.js#update", "old": "absent", "new": "<entity hash>" }
  ],
  "ops": [
    { "op": "write", "path": "creatures/crab.js", "content": "<the first version, with crab.energy < 30>" },
    { "op": "replace", "path": "creatures/crab.js", "old": "crab.energy < 30", "new": "crab.energy < 0.3",
      "targets": ["creatures/crab.js#update"] }
  ],
  "go_arounds": [
    { "n": 1, "hn": 1, "cause": "landing", "cause_seqs": [1],
      "keys": [{ "kind": "entity", "key": "world/energy.js#ENERGY_MAX", "rule": "E2" }],
      "statement": "Energy is now a fraction from 0 to 1, so the hide threshold is 0.3.",
      "at": "2026-10-10T18:03:41Z" }
  ],
  "confirms": [],
  "judgments": [
    { "kind": "entity", "key": "world/energy.js#ENERGY_MAX",
      "old": "5149f012fe7cd2dfd8820a214ea41ff0", "new": "f52fdb40e9972b45534f0361ecb65cea",
      "cause_seq": 1, "rule": "E2", "class": "rule", "result": "repair",
      "reason": "referenced_entity_changed" }
  ],
  "checks": [
    { "name": "replay", "ok": true },
    { "name": "non_empty", "ok": true },
    { "name": "parse", "ok": true },
    { "name": "imports_resolve", "ok": true },
    { "name": "globals_allowed", "ok": true },
    { "name": "premises_hold", "ok": true, "detail": "2 premises at seq 1" },
    { "name": "policy", "ok": true, "detail": "auto" }
  ],
  "policy": { "tier": "auto", "approved_by": null, "approved_at": null, "option": null, "risk": null },
  "pull_backs": 0,
  "batch": { "id": 2, "index": 0, "size": 1 },
  "timing": {
    "opened_at": "2026-10-10T18:03:12Z",
    "submitted_at": "2026-10-10T18:03:44Z",
    "accepted_at": "2026-10-10T18:03:44Z"
  }
}
```

(Values in angle brackets are computed at run time. In a real note they are literal strings. The example is pretty-printed for reading; the blob follows NT1.)

A stock git client that holds a read token (SE5c) reads the record with:

```
git fetch origin refs/notes/premise:refs/notes/premise
git log --notes=premise
```

### 3.6 Rebuilding Trunk

Two different procedures exist. Neither ever deletes an outbox row in state `pending` or `notes_pending`.

| Procedure | When | What it re-derives | What it keeps |
| --- | --- | --- | --- |
| **Re-index** | `schema_version` or `hash_version` in `meta` differs from the build (a deploy) | `files.parse_state`, `entities`, `refs`, `trees`; every premise's `hash` and `members` (in place); `landing_writes` and `landing_premises` hashes for the last `UNDO_WINDOW` landings | everything else: `attempts`, `premises` (rows and flags), `ops`, `heads_ups`, `judgments`, `cards`, `undo_requests`, `outbox`, `outbox_chunks`, `events_out`, `meta.next_event_n`, `meta.epoch` |
| **Rebuild from Artifacts** | Trunk's SQLite is empty (`meta.pool_id` missing), or the owner requests it after a divergence (LP8) | every table, from `main` and `refs/notes/premise` | nothing; `meta.epoch` becomes the Floor's last epoch for this pool plus 1 (RB5) |

Rules:

- **RB1 (order).** On start-up Trunk first finishes reconciliation (LP7) of a `pending` or `notes_pending` outbox row, until the row is `pushed` or `diverged`. Only then may a re-index or a rebuild start. The pack bytes in `outbox_chunks` do not depend on the schema. Exception (added 2026-10-05): a pool paused with `push_rejected` or `diverged` (LP8) stops pushing, so its row never reconciles; the owner's rebuild closes that row as `diverged` and starts at once. A wait for reconciliation backs off as a push retry does (9.6).
- **RB2 (re-index).** A re-index changes hashes, never facts. A premise is re-hashed at the head it was pinned at: because every pinned hash equals head (V4), the new hash is the new hash of the key at head; a premise with a pending status keeps its status. No judgment and no heads-up is created by a re-index. `shown` values that hold entity hashes are re-hashed the same way.
- **RB3 (resumable).** Both procedures are jobs with a cursor in `meta` (`rebuild_cursor`). One alarm run makes at most `REBUILD_CALLS_PER_RUN` Artifacts calls, commits its progress, and re-schedules itself with the `rebuild` timer. They never run inside the constructor or `blockConcurrencyWhile`. While one runs, `pool_state` is `rebuilding`, every tool call fails with `pool_not_ready`, the tick does nothing, and each run emits `pool.state` with `rebuild: { done, total }`.
- **RB4 (size).** A blob over `MAX_FILE_BYTES` (possible only in a seed) is stored with `content = NULL`: its `oid` is known, tools answer `too_large` for it, and it is opaque.

Rebuild from Artifacts, in order:

1. Read `main`'s head commit id. Walk first-parent history back to the seed (the commit recorded in the pool's creation record, else the oldest commit). List the landing commits oldest first; the *k*-th has `seq = k`.
2. Read `refs/notes/premise`. For each landing commit, read its note. Check `note.seq` equals the commit's position; a mismatch stops the rebuild with `pool_state = paused`, `pause_reason = note_seq_mismatch`.
3. Read the head tree recursively and every blob. Fill `files` and `trees`. Parse every module; fill `entities` and `refs` (sections 2 and 6).
4. From the notes fill `landings`, `intents` (state `landed` or `undone`) and `attempts` (state `landed`, or `stopped` when `undone_by` is set). `landing_files` comes from the `file` rows of `note.writes`; no tree is compared for a landing that has a note. For the last `UNDO_WINDOW` landings only, also fill `landing_writes`, `landing_premises`, `landing_ops` (reading `blob` references when needed) and `blobs` (3.2). A landing commit with no note is kept as a landing with empty premises and writes derived from a diff of its tree with its parent's; it is listed in the rebuild report and in `pool.state` as `unwitnessed`.
5. Set `head_seq`, `head_commit`, `head_tree`, `notes_commit`, `green_seq`, `green_commit` (from `refs/heads/green`; if absent, the seed). `pool_state = ready`.
6. **In-flight attempts are not in Artifacts.** A tool call for an attempt Trunk does not know fails with `attempt_unknown`, and the Agent then calls `register` itself. Trunk also emits `pool.state` with the new `epoch`. The Floor (RB5) closes every open card of the pool as `stale` and calls `register` on each Agent whose attempt it lists as in flight. The Agent answers with its mirror: intent, `revision`, operations and the premises with `read = 1`. Trunk stores them, recomputes `edit` and `derived` premises from the operations (R4, W4, D1, D2), and classifies every read premise whose hash differs from head by the normal rules (section 7), with `cause = "landing"` and no before-text (`before_unavailable: true`). `shown` is empty for every premise (so a whole-file `write` needs a new `read`, W1). An attempt that was `submitted`, `validated` or `held` re-registers as `working` and submits again.
7. An attempt that was `accepted` in a diverged batch: if a landing on the rebuilt `main` carries its `Change-Id` and its note has the same `revision`, the attempt is `landed` (T17a). Otherwise it re-registers as in step 6 and Trunk sends it a heads-up of result `repair`, reason `push_lost` (T17).
8. An Agent that cannot be reached within `REGISTER_TIMEOUT_MS`, or whose `register` is refused, is recorded as stopped with reason `lost` (event `attempt.state`), so no card and no counter waits on it.

- **RB5 (event numbering).** Events carry `(src, epoch, source_n)` (12.2). A rebuild from Artifacts starts `source_n` at 1 under a new `epoch`, which Trunk obtains from the Floor before it emits anything. The Floor accepts a higher epoch as a new sequence, so no event of the rebuilt Trunk is dropped as a duplicate.

How the rebuild reads Artifacts (decided, section 15 S1 and S7). The binding resolves short branch names (`main`, `green`) and commit ids. It does not resolve `refs/notes/premise` or any full ref name (platform record, X4). So the rebuild takes the notes commit id from the remote's ref advertisement (`Pusher.readRefs`) and reads the notes tree and every note blob through the binding by object id (`NotesReader`). The fallback is a hand-built fetch of the notes ref.

---

## 4. Agent tool API

Agents see and change code only through these seven tools. The Agent Durable Object calls Trunk; the model never holds a token and never reaches Artifacts. This section fixes what each tool does and what Trunk answers. The name, description and JSON parameters of each tool exactly as a model receives them, and the system prompt, are in `05-agent.md` (4.11).

### 4.1 Envelope

```ts
type PremiseKind = "entity" | "file" | "listing" | "query";
type PremiseRef = { kind: PremiseKind; key: string; hash: string; seq: number;
                    read: boolean; edit: boolean; derived: boolean };
type AttemptState = "opened" | "working" | "going_around" | "needs_confirm" | "submitted"
                  | "validated" | "held" | "accepted" | "landed" | "stopped";

type ToolRequest = {
  attempt_id: string;
  call_id: string;     // unique per attempt; "<attempt_id>:<step>"
  ack: number;         // highest heads-up number already placed in the model's context (HU6a)
  tool: "outline" | "read" | "list" | "search" | "write" | "replace" | "submit";
  args: object;
  usage?: { model_calls: number; tokens_in: number; tokens_out: number };  // TA10; real agents only
};

type ToolResponse = {
  call_id: string;
  ok: boolean;
  head_seq: number;                 // head when the call was served
  result?: object;                  // present when ok
  error?: { code: ErrorCode; message: string; detail?: object };
  premises: PremiseRef[];           // see TA7
  heads_ups: HeadsUp[];             // heads-ups with hn > ack, ascending, from ack + 1 with no gap (TA8)
  heads_ups_more: boolean;          // true when some heads-ups with hn > ack did not fit (TA8)
  attempt: { state: AttemptState; go_arounds: number; pull_backs: number };
};

type ErrorCode =
  | "invalid_path" | "invalid_args" | "not_found" | "not_a_module" | "binary" | "too_large"
  | "read_first" | "no_match" | "ambiguous" | "no_change" | "parse_error"
  | "heads_up_first" | "limit_reached" | "attempt_unknown" | "attempt_closed"
  | "pool_not_ready" | "timeout";
```

Rules:

- **TA1.** Every call is served from head at the moment of the call, inside one Trunk event with no `await` (SY2). There is no snapshot store.
- **TA2 (idempotency).** Trunk stores the response to the most recent `call_id` of each attempt, without its `heads_ups`. A request with the same `call_id` returns that stored response, with `heads_ups` computed again from the request's `ack`, and changes nothing else. A request with an older `call_id` fails with `invalid_args`.
- **TA3 (heads-up first).** `write`, `replace` and `submit` fail with `heads_up_first` when the attempt has any heads-up with `hn > ack`, of any result. The operation is not recorded. The response carries those heads-ups. Read tools are never blocked.
- **TA4.** A call from an attempt in state `accepted`, `landed` or `stopped` fails with `attempt_closed`, except `submit`, which answers as in 4.9. `write` and `replace` are accepted in every other state; in `submitted`, `validated` and `held` an accepted operation takes the attempt out of the landing queue (transition T22).
- **TA5.** A failed call records no premise, except `not_found` (it pins `absent`).
- **TA6.** Read tools show the **attempt view** (5.2). The premise they pin is always the **head** version of the key, and the premise's `shown` value (3.2) records what the agent was shown.
- **TA7.** `premises` in the response lists: for a read tool, the premise it pinned (always, even when nothing changed), with its current flags; for `write`, `replace` and `submit`, every premise the call created and every premise on which it set a flag (`read`, `edit`, `derived`). Nothing else. A premise the call deleted is reported by the event `premise.removed`, not in the response.
- **TA8 (bounded responses).** A response carries at most `MAX_HEADS_UPS_PER_RESPONSE` heads-ups and at most `RESPONSE_HEADS_UP_MAX_BYTES` of them, always the lowest numbers first. `heads_ups_more` tells the Agent to call `sync` before it shows anything beyond them.

Three calls are not model tools: `sync`, `register` and `stop`. Only the Agent Durable Object makes them (a model has no tool that reaches them), and they record no premise and cost no step. A fourth call goes the other way: `resume`, from Trunk to the Agent (8.3, RS1).

```ts
type SyncRequest = { attempt_id: string; ack: number };
type SyncResponse = { heads_ups: HeadsUp[]; heads_ups_more: boolean; head_seq: number;
                      attempt: { state: AttemptState; go_arounds: number; pull_backs: number } };

type RegisterRequest = {                       // after a rebuild from Artifacts (3.6 step 6)
  attempt_id: string; intent_id: string; change_id: string; revision: number;
  agent_kind: "real" | "synthetic"; model: string | null;
  ops: Operation[];                            // current operations, in op_seq order
  read_premises: Array<{ kind: PremiseKind; key: string; hash: string; seq: number }>;
  truth?: string[];                            // synthetic attempts only (TR8)
};
type RegisterResponse = { ok: true; heads_ups: HeadsUp[]; attempt: SyncResponse["attempt"] }
                      | { ok: false; error: "attempt_closed" | "pool_not_ready" | "invalid_args" };

type AgentStopReason = "budget" | "spend_cap" | "timeout" | "model_error" | "tool_timeout"
                     | "stalled" | "killed" | "cancelled" | "withdrawn";       // the stop reasons an Agent may report (9.1)
type StopRequest  = { attempt_id: string; reason: AgentStopReason };
type StopResponse = { ok: true; stop_reason: string; attempt: SyncResponse["attempt"] }
                  | { ok: false; error: "attempt_unknown" | "attempt_closed" | "invalid_args" };
```

- **TA9 (`stop`).** The Agent calls `stop` when it ends its own attempt: a budget or the time limit (AG4), the spend cap (SE7), exhausted retries (AG2), the watchdog (AG3), the kill switch (SE10), the owner's cancel (the route of 13.6 reaches the Agent, which then calls `stop` with `cancelled`), or a scripted withdrawal. Trunk runs transition T20 with that reason, in one transaction: the attempt is `stopped`, an open held card closes as `stale`, a race card is updated, and `attempt.state` is emitted. The call is idempotent: for an attempt that is already `stopped`, Trunk answers `ok: true` with the stored `stop_reason` and changes nothing. For an attempt in `accepted` or `landed` it answers `attempt_closed` (T20 does not apply; the change is landing or has landed), and the Agent takes its state from `sync`. A reason outside `AgentStopReason` is `invalid_args`: the other stop reasons of 9.1 are set by Trunk only.
- **TA9a (`withdrawn`).** `withdrawn` means the agent itself decided that its change is no longer wanted. In this build only scripted agents send it (`02-tidepool.md` 10.3: a rescale or a cosmetic edit that another change already made, a sweep that gives up). A stop with `withdrawn` opens no card.
- **TA10 (the Agent's counters).** A real agent's `ToolRequest` carries `usage`: the Agent's running totals of model calls and tokens at the moment of the call (`05-agent.md` TL1, TL4). Trunk keeps the last value it received on the attempt (`attempts.model_calls`, `tokens_in`, `tokens_out`) and freezes it into `Note.attempt` when the change is accepted. A synthetic attempt sends no `usage`, and its note holds zeros. This settles the open point O2 of `05-agent.md` (added on 2026-10-04, after the first real agent landed with `model_calls: 0` in its note).

### 4.2 Limits

| Limit | Constant |
| --- | --- |
| Tool call wall time, enforced by the Agent | `TOOL_TIMEOUT_MS` |
| File size, read or written | `MAX_FILE_BYTES` |
| `search` needle length (1 to this many characters, no line break) | `MAX_QUERY_LEN` |
| `search` lines returned | `MAX_SEARCH_LINES` |
| `list` entries returned | `MAX_LIST_ENTRIES` |
| Operations per attempt (dropped ones count) | `MAX_OPS` |
| Distinct paths written per attempt | `MAX_PATHS` |
| Sum of `content`, `old` and `new` bytes over current operations | `MAX_CHANGE_BYTES` |
| Premises per attempt | `MAX_PREMISES` |
| Statement length in `submit` | `MAX_STATEMENT_CHARS` |
| Files in the pool, and their total bytes, after the change (checked at submit, CK3a) | `MAX_POOL_FILES`, `MAX_POOL_BYTES` |

Exceeding a count limit fails the call with `limit_reached`; exceeding a size limit fails it with `too_large`.

Implementation limits that follow from the platform (each is testable against a local SQLite):

- **SQ1.** No SQL `LIKE` or `GLOB` pattern is built from a path or a needle (the platform limits patterns to 50 bytes). A directory scope is a range comparison (`path >= 'dir/' AND path < 'dir0'`, where `0` is the character after `/`); substring search runs in JavaScript over rows read with a cursor, one file in memory at a time.
- **SQ2.** No single row may exceed 1 MiB. Values that can be larger are stored in parts (`outbox_chunks`, `snapshots`) or bounded by a constant (`MAX_FILE_BYTES`, `HEADS_UP_MAX_BYTES`, `NOTE_MAX_BYTES`). The accept transaction (9.4 step 5) MUST NOT be able to fail on size: every value it writes is bounded before the transaction starts.

### 4.3 `outline`

```json
{ "path": "world/energy.js" }
```

```json
{
  "path": "world/energy.js",
  "oid": "73b9aee0919e88e8402fcc5616756bf206f17fb7",
  "entities": [
    { "name": "ENERGY_MAX", "kind": "const", "exports": ["ENERGY_MAX"], "signature": "export const ENERGY_MAX", "lines": [1, 2] },
    { "name": "drain", "kind": "function", "exports": ["drain"], "signature": "export function drain(creature, amount)", "lines": [4, 7] }
  ]
}
```

Premise: `query` `outline:<path>`, `read`. Errors: `not_found` (pins `file:<path>` at `absent`), `not_a_module` (opaque file; no premise).

### 4.4 `read`

```json
{ "path": "world/energy.js", "entity": "ENERGY_MAX" }
```

`entity` is optional.

Whole file:

```json
{ "path": "world/energy.js", "oid": "73b9aee0919e88e8402fcc5616756bf206f17fb7", "content": "...", "edited_by_you": false }
```

One entity:

```json
{
  "key": "world/energy.js#ENERGY_MAX",
  "kind": "const",
  "exports": ["ENERGY_MAX"],
  "source": "// Energy is counted in points, from 0 to ENERGY_MAX.\nexport const ENERGY_MAX = 100;",
  "lines": [1, 2],
  "edited_by_you": false
}
```

| Call | Premise |
| --- | --- |
| whole file, file exists | `file:<path>` at the blob id, `read` |
| whole file, file absent | error `not_found`; `file:<path>` at `absent`, `read` |
| entity, exists | `entity:<path>#<name>` at its hash, `read` |
| entity, module exists, entity absent | error `not_found`; `entity:<path>#<name>` at `absent`, `read` |
| entity, file absent | error `not_found`; `file:<path>` at `absent`, `read` |
| entity, opaque file | error `not_a_module`; no premise |
| file is not valid UTF-8 | error `binary`; no premise |

Reading a key again pins it again at head (`hash`, `seq` and `shown` are refreshed). It does not resolve a pending heads-up.

### 4.5 `list`

```json
{ "path": "creatures/" }
```

```json
{ "path": "creatures/", "entries": [ { "name": "fish.js", "type": "file", "bytes": 257 }, { "name": "snail.js", "type": "file", "bytes": 193 } ], "truncated": false }
```

Not recursive. A missing directory returns an empty list. Premise: `listing:<directory key>` with the head entry names as members, `read`; its `shown` names are set to the same list. Files the attempt created appear with `"yours": true` and are not part of the premise.

### 4.6 `search`

```json
{ "query": "drain(", "path": "creatures/" }
```

`path` is optional (default `/`); it is a directory key or a file path. A directory scope is recursive (2.6).

```json
{
  "query": "drain(",
  "in": "creatures/",
  "lines": [ { "path": "creatures/fish.js", "line": 10, "text": "  drain(fish, 1);", "entity": "update" } ],
  "containers": ["creatures/fish.js#update"],
  "truncated": false
}
```

Premise: `query` `text:<in>:<query>`, members = one `<container>*<count>` per container at head (2.6; never truncated), `read`.

### 4.7 `write`

```json
{ "path": "creatures/crab.js", "content": "..." }
```

or `{ "path": "creatures/old.js", "delete": true }`.

```json
{
  "path": "creatures/crab.js",
  "op_seq": 1,
  "created": true,
  "bytes": 208,
  "added": ["creatures/crab.js#(import ../world/energy.js)", "creatures/crab.js#spawn", "creatures/crab.js#update"],
  "altered": [],
  "removed": [],
  "relied_on_by": {}
}
```

`added`, `altered` and `removed` compare the attempt view after the call with head, by entity hash. `relied_on_by` maps every altered or removed head entity to its current referrers (the referrer keys of its `refs:` premise).

Rules:

- **W1 (read first, and read what is there now).** If the path exists at head, the call fails with `read_first` unless the attempt has a `file` premise on it with `read = 1` whose `shown` value equals the blob id at head. `shown` is set only by a whole-file `read`; classification never changes it (V4). So an agent can never overwrite bytes it was not shown, even when the change underneath was cosmetic and produced no heads-up (vector `C29`).
- **W2.** If the resulting module does not parse, the call fails with `parse_error` (detail: acorn message, line, column) and nothing is recorded.
- **W3.** If the content equals the attempt view of the path, the call fails with `no_change`.
- **W4 (implied premises).** On every `write`: `file:<path>` gets `edit = 1` (created now, pinned at the head blob id or `absent`, if it does not exist), and the operation's `base_oid` is the head blob id of the path at this moment, or `absent`. This holds also when earlier operations of the attempt exist on the path.
- **W5.** After the call, the implied and derived premises are synchronized (R4a, D1, D1b, D2), a pending triage is evaluated again (V7), and the late sweep check runs (L1).

### 4.8 `replace`

```json
{ "path": "world/energy.js", "old": "ENERGY_MAX = 100", "new": "ENERGY_MAX = 1" }
```

```json
{
  "path": "world/energy.js",
  "op_seq": 1,
  "targets": ["world/energy.js#ENERGY_MAX"],
  "altered": ["world/energy.js#ENERGY_MAX"],
  "added": [],
  "removed": [],
  "relied_on_by": {
    "world/energy.js#ENERGY_MAX": [
      "creatures/fish.js#(import ../world/energy.js)", "creatures/fish.js#spawn",
      "creatures/snail.js#(import ../world/energy.js)", "creatures/snail.js#spawn"
    ]
  }
}
```

Rules:

- **R1.** The path must exist in the attempt view (`not_found` otherwise). `old` must be non-empty and differ from `new` (`no_change`). No prior read is required.
- **R2.** Let *k* be the number of offsets *i* at which the attempt view of the file starts with `old`. *k* = 0 fails with `no_match`; *k* > 1 fails with `ambiguous` (detail: *k* and the line numbers). *k* = 1 replaces that occurrence.
- **R3.** `parse_error` as W2.
- **R4 (implied premises).** `targets` are the targets (EN6) of the matched span in the attempt view before the call; for an opaque file, `[path]`. For every target that exists at head, `entity:<target>` gets `edit = 1` (created at the head hash if it does not exist). For an opaque file that exists at head, `file:<path>` gets `edit = 1`.
- **R4a (absence is a premise).** After a `replace` or a `write`, every entity in `Added` (6.3) whose module exists at head gets a premise `entity:<key>` pinned at `absent` with `edit = 1`. A change that adds an entity relied on that name being free; if another landing takes the name, rule E1 gives `repair` with the diff (vector `C46`). An entity of a file the attempt creates needs no such premise: the `file` premise at `absent` (W4) covers it.
- **R5.** As W5. When the operations change so that an `edit` or `derived` flag no longer applies, the flag is cleared, and a premise left with `read = 0`, `edit = 0`, `derived = 0` is deleted (event `premise.removed`).

### 4.9 `submit`

```json
{ "summary": "Add a crab that hides when its energy is low", "acknowledge": [1], "statement": "Energy is now a fraction from 0 to 1, so the hide threshold is 0.3." }
```

`acknowledge` (heads-up numbers) and `statement` are optional; `statement` is required when `acknowledge` is not empty. The model-facing tool has only `summary` and `statement` (its definition as the model receives it is in `05-agent.md`); the Agent Durable Object fills `acknowledge` with every heads-up of result `confirm` or `repair` that was placed in the model's context before the model issued this call and is not yet resolved.

Result:

```ts
type SubmitResult =
  | { status: "validated"; submit_id: string; tier: "auto"; checks: Check[]; duplicate?: true }
  | { status: "submitted"; submit_id: string; waiting_for: Array<"clef_risk" | "triage">; checks: Check[]; duplicate?: true }
  | { status: "held"; submit_id: string; card_id: string; tier: "held"; checks: Check[]; duplicate?: true }
  | { status: "needs_confirm"; unresolved: number[] }               // heads-up numbers
  | { status: "go_around"; unresolved: number[] }
  | { status: "rejected"; errors: Array<{ code: SubmitError; detail: object }> }
  | { status: "accepted"; seq: number }                             // in the outbox, not yet confirmed on main
  | { status: "landed"; seq: number; commit: string }               // confirmed on main (LP9)
  | { status: "stopped"; reason: string };
type Check = { name: string; ok: boolean; detail?: string };
type SubmitError = "empty_change" | "parse_error" | "import_unresolved" | "banned_global"
                 | "banned_import" | "too_large";
```

Trunk runs these steps in order and stops at the first that produces a status:

| Step | Check | On failure |
| --- | --- | --- |
| CK0 | State. `accepted` answers `accepted`; `landed` answers `landed`; `stopped` answers `stopped`. `validated`, `submitted` or `held` with no new acknowledgement and a recomputed `submit_id` equal to the stored one answers the same status and `submit_id` again with `duplicate: true` and changes nothing. | n/a |
| CK1 | Acknowledgements. Each number in `acknowledge` must be a heads-up of this attempt with `hn <= ack`; it is marked resolved with the statement, and the premises it lists return to status `holds` (a premise in `pending_triage` stays pending). | `invalid_args` |
| CK2 | Replay (5.3) of the current operations on head. | Rule OP6 runs; status `go_around` |
| CK3 | `non_empty`: at least one path's blob id differs from head. | `rejected: empty_change` |
| CK3a | `fits`: the pool after the change is within `MAX_POOL_FILES` and `MAX_POOL_BYTES`; the note built now, plus `NOTE_RESERVE_BYTES`, is within `NOTE_MAX_BYTES`. | `rejected: too_large` |
| CK4 | `parse`: every resulting module parses. | `rejected: parse_error` |
| CK5 | `imports_resolve`: in the resulting tree, every import and re-export in a touched file, and every import of a touched file from any other file, resolves (6.2). Bare and URL specifiers fail with `banned_import`. | `rejected: import_unresolved` |
| CK6 | `globals_allowed`: every free global name used by an added or altered entity is in the policy's allow list (10.1). | `rejected: banned_global` |
| CK7 | Derived premises are synchronized again (D1, D1b, D2); the late sweep check runs (L1); blind spots (6.4) create one heads-up of result `confirm`. | continues to CK8 |
| CK8 | `premises_hold`: no premise has status `pending_confirm` or `pending_repair`, and no heads-up of result `confirm` or `repair` is unresolved. (A premise in `pending_triage` does not fail this step; it makes the final status `submitted`.) | `needs_confirm`, or `go_around` if any unresolved heads-up has result `repair` |
| CK9 | `policy` (10.2): the tier of the touched paths under the policy at head. | `held` when the tier is `held` |

When all pass with tier `auto`: `submit_id` is assigned and the state becomes `validated` with `validated_at` set, or `submitted` while a triage result (7.3) or a Clef risk answer (10.4) is awaited.

`submit_id` is `"s_"` followed by the first 16 characters of `H(attempt_id + "|" + revision + "|" + last op_seq + "|" + resolved heads-up numbers, ascending, joined by ",")`. It is a pure function of the attempt's current work: an unchanged resubmission has the same id, and any accepted operation or acknowledgement changes it. Wherever this file says "the `submit_id` is unchanged" (9.3, T13), the id is **recomputed** from the current values and compared with the stored one.

A `rejected` submit is not a go-around. The agent fixes its work and submits again; each try costs a step of its budget.

### 4.10 The heads-up envelope in tool results

What the model sees as a tool result is the JSON text of:

```ts
type ModelToolMessage = {
  heads_ups?: HeadsUpForModel[];   // first key; omitted when empty
  result?: object;
  error?: { code: string; message: string; detail?: object };
};
type HeadsUpForModel = {
  hn: number;
  action: "none" | "confirm" | "repair";      // from HeadsUp.result: info, confirm, repair
  because: string;                             // one plain sentence built from the rule and the cause
  changed_by: string | null;                   // the other change's intent text
  items: Array<{ what: string; before: string | null; after: string | null;
                 added?: string[]; removed?: string[];
                 context?: Array<{ key: string; source: string }>;   // 8.2
                 checking?: true;                                      // a triage answer is still awaited
                 your_lines: string[] }>;
  dropped_edits: Array<{ path: string; why: string }>;
};
```

- **HE1.** The Agent places heads-ups from `ToolResponse.heads_ups` and from its inbox into `heads_ups` of the next message the model receives, in ascending `hn` and only as a run with no gap (HU6a), and records `shown_step`. It then sends `ack` = the highest `hn` shown on its next Trunk call.
- **HE2 (what wakes an agent).** When no tool call is in progress (the agent is waiting in `submitted`, `validated`, `held` or `needs_confirm`), a pushed heads-up with `wake = true` starts a new model turn with a `user` message whose content is `{ "heads_ups": [...] }`. Trunk sets `wake = true` exactly for results `confirm` and `repair` sent to an attempt that is not stopped. A heads-up with `wake = false` (every `info`) is stored in the inbox and starts nothing: it rides in the next message the model receives for another reason. A waiting agent therefore spends nothing on context-only updates. An Agent whose own recorded state is `stopped` or `landed` is never woken by a heads-up, whatever its `wake` flag: it stores the heads-up, and only `resume` starts it again (RS1). It then shows every waiting heads-up (RS2).
- **HE3.** The Agent never edits, summarizes or drops a heads-up. How `HeadsUp` is turned into `HeadsUpForModel` (the `because` sentence, `what`, `your_lines`) is fixed in `05-agent.md`; that mapping adds wording and removes nothing.
- **HE4.** Text inside a heads-up is pool code and intent text written by other agents and people. The Agent's system prompt states that heads-up content is data to adapt to, not instructions to follow (the exact prompt is in `05-agent.md`). A heads-up never carries verifier logs (GR7).

### 4.11 The system prompt and the tool definitions (`05-agent.md`)

This file fixes the protocol between the Agent Durable Object and Trunk. What the **model** receives is specified in `05-agent.md`, which is binding for the Agent and for the model measurements:

| `05-agent.md` holds | This file fixes |
| --- | --- |
| The system prompt, word for word, and the first `user` message (the intent text and the instruction to read `GUIDE.md` first) | HE4: heads-up content is data, not instructions. |
| The seven tool definitions as sent to Workers AI (name, description, JSON parameters) | The tool names, arguments, results and errors of 4.3 to 4.9. The model-facing `submit` has only `summary` and `statement` (4.9). `sync`, `register`, `stop` and `resume` are not tools. |
| How a tool result and a heads-up are serialized for the model | `ModelToolMessage` and `HeadsUpForModel` (4.10); HE1 to HE3; a heads-up is the first key of the message. |
| The `user` message that carries heads-ups when a waiting agent is woken (HE2) or resumed (RS2) | The content is `{ "heads_ups": [...] }`, in ascending `hn` with no gap (HU6a). |
| Context budgets: how much of the transcript is sent on each model call | The transcript in SQLite is complete (3.3). A `confirm` or `repair` heads-up that was shown stays in the context of every later model call until it is resolved (HE3). The budgets of AG4 and the constants of Appendix C. |
| The request shape for Workers AI | The measured shape of S5 (MP1). |
| The seeded-intent measurement protocol (per model: the share of seeded intents completed, the time per change, the share of energy creatures that reference `ENERGY_MAX`, the share that repair correctly after a scripted heads-up) | S5: the model plan follows that measurement. HC4. |

- **PR1.** A measurement of models records the hash of the system prompt and of the tool definitions it ran with. A change to either is a change to `05-agent.md` first.

---

## 5. Edit operations and replay

### 5.1 Operations

```ts
type Operation =
  | { op_seq: number; op: "write"; path: string; content: string | null; base_oid: string }
  | { op_seq: number; op: "replace"; path: string; old: string; new: string; targets: string[] };
```

`content: null` deletes the path. `base_oid` is set on every `write` (W4): the blob id of the path at head when the write was accepted, or `absent`. Operations are stored in `op_seq` order. Dropped operations (OP6) keep their number and are skipped. There is no text merge and no syntax-tree merge anywhere in the system.

### 5.2 The attempt view

The attempt view of a path is the result of replaying the attempt's current operations on that path over head. If the replay of a path fails, the attempt view of that path is head, and the failure is reported by rule OP6 at the next landing or submit, whichever comes first. If the replayed result of a module does not parse (two changes inserted clashing code), that path is opaque in the view until the agent repairs it; CK4 rejects a submit in that state.

### 5.3 Replay

`replay(operations, tree)` processes operations in `op_seq` order over a working copy that starts as `tree`.

For `write` on path *p*:

- **OP5 (write base changed).** If the blob id of *p* in `tree`, the tree the replay started from (or `absent`), differs from the operation's `base_oid`, the operation no longer applies. This holds for every `write`, also when earlier operations on *p* exist (vector `C56`).
- Otherwise the working copy of *p* becomes `content` (or *p* is removed).

For `replace` on path *p*, with *k* the number of offsets at which the working copy of *p* starts with `old`:

- **OP4.** *p* is absent from the working copy: no longer applies.
- **OP1.** *k* = 0: no longer applies.
- **OP2.** *k* > 1: no longer applies.
- **OP3 (moved).** *k* = 1 but the targets (EN6) of the matched span in the working copy differ from the recorded `targets`: no longer applies. This prevents an edit from landing in a different entity than the one the agent edited.
- Otherwise the occurrence is replaced by `new`.

Replay succeeds when every operation applies. Its result is the set of changed paths with their new contents.

### 5.4 When an operation no longer applies

- **OP6.** When replay finds an operation on path *p* that no longer applies, **all** of the attempt's current operations on *p* are dropped (`dropped = 1`). Operations on other paths are kept. The attempt receives a heads-up of result `repair` whose `dropped_ops` lists each dropped operation with the rule (`OP1` to `OP5`) of the one that failed. The heads-up carries the current content of *p*. After the drop, the implied and derived premises are recomputed from the remaining operations (R5, D1, D2).
- **OP7.** Trunk replays an attempt's operations: (a) on every tool call that needs the attempt view; (b) at each landing, for every classified attempt (7.1) that has operations on a path the landing changed; (c) at submit (CK2); (d) in the batch tick (9.4).
- **OP8.** A go-around caused only by OP6 is counted like any other go-around (9.2).

A dropped operation stays in the transcript and in `ops_first`; the agent re-applies its intention with new operations. A new whole-file `write` on the path needs a new `read` first (W1).

---

## 6. Derived premises

Derived premises make the catch independent of what the model chose to read, and correct in both landing orders, for every reference that the changed module holds. Section 6.5 states exactly what is and is not covered.

### 6.1 Module specifiers

`resolve(fromPath, specifier)`: only specifiers starting with `./` or `../` resolve. Join with the directory of `fromPath`, normalize `.` and `..`, and require the result to be a path (2.1). No extension is added. Any other specifier is **external**: it creates no reference and fails CK5 with `banned_import`.

### 6.2 Reference extraction

Input: all modules of a tree. Output: for every entity *E*, the set `R(E)` of keys it references, and the set `G(E)` of global names it uses.

Step 1, per module *M* at path *P*: build

- the **import table**: local name → `(source specifier, imported name)`; `import d from` gives imported name `default`; `import * as ns from` gives `*`;
- the **top-level table**: every entity name of kind `function`, `class`, `const`, `let`, `var` or `value`.

Step 2, per entity:

- Kind `import`: for each specifier, `resolveExport(resolve(P, source), imported name)`; a namespace import references the whole module (the key is the path).
- Kind `reexport` / `reexport-all`: `resolveExport(resolve(P, source), imported name)`; `*` references the whole module.
- All other kinds: find every identifier in **reference position** in the entity's nodes and resolve it by ECMAScript lexical scoping. If it resolves to a binding declared inside the entity, ignore it. Otherwise look the name up at module level:
  1. in the top-level table: reference to `P#<name>` (ignored when it is the entity itself);
  2. in the import table with a named or default import: `resolveExport(...)`;
  3. in the import table as a namespace `ns`: for `ns.prop` with a non-computed property, `resolveExport(target, "prop")`; for any other use of `ns`, a reference to the whole module;
  4. otherwise it is a global: add the name to `G(E)`.

Reference position: every `Identifier` node except (a) the property of a non-computed `MemberExpression`; (b) the key of a non-computed `Property`, `MethodDefinition` or `PropertyDefinition`; (c) labels; (d) `MetaProperty` parts; (e) binding positions: declaration ids, function and class names, parameters, catch parameters and the identifiers of destructuring patterns in declarations. Default values and computed keys inside patterns are expressions and are searched. The left side of an assignment is a reference.

Scopes that declare bindings: function (parameters, `var` declarations anywhere in the body outside nested functions, declarations directly in the body, the name of a named function expression, `arguments` unless it is an arrow function), block and `static` block (`let`, `const`, `class`, function declarations directly inside), `for` / `for-in` / `for-of` heads (`let`, `const`), `switch` (declarations directly in any case), `catch` (its parameter), class (its own name).

`resolveExport(T, x)`:

1. If `T` is not a module in the tree, the reference is **unresolved** (`T#x`).
2. If an entity of `T` has `x` among its export names: if its kind is `reexport`, add that entity's key to the reference set (the hop) and continue with `resolveExport(resolve(T, its source), its imported name)` (or the whole target module when the imported name is `*`); otherwise the result is that entity's key.
3. Otherwise, if `x` is not `default`, try each `reexport-all` entity of `T` in source order; the first whose target resolves `x` contributes its own key (the hop) and the result. The key `T#x` is recorded as a **negative lookup** of the referring entity: the binding holds only while `T` itself does not export `x` (rule D1b).
4. Otherwise unresolved. Recursion deeper than `REEXPORT_DEPTH`, or a cycle, is unresolved.

Dynamic `import("./x.js")` with a string literal references the whole module `./x.js`. With any other argument it creates no reference (a stated limit).

Worked example (vector pool, `creatures/fish.js`):

| Entity | `R(E)` |
| --- | --- |
| `creatures/fish.js#(import ../world/energy.js)` | `world/energy.js#ENERGY_MAX`, `world/energy.js#drain` |
| `creatures/fish.js#(import ../world/movement.js)` | `world/movement.js#step` |
| `creatures/fish.js#spawn` | `world/energy.js#ENERGY_MAX` |
| `creatures/fish.js#update` | `world/movement.js#step`, `world/energy.js#drain` |

Trunk keeps `refs` for head and updates it for changed modules at every landing. The **referrers** of an entity *E* are `{ from_key : (from_key, E) in refs, or (from_key, path of E) in refs }`, excluding *E*. An entity that references the whole module of *E* (namespace import used as a value, `export *`, dynamic import) is therefore a referrer of every entity of that module (vector `C45`).

### 6.3 What Trunk derives, and when

Definitions for an attempt, computed on its attempt view (5.2). A **touched module** is a module on which the attempt has a current operation.

| Set | Definition |
| --- | --- |
| `Added` | Entities in the view that do not exist at head. |
| `Altered` | Entities that exist at head and whose hash in the view differs, or that are removed in the view. |
| `NewRefs` | `⋃ R(E)` for `E` in `Added` and in `Altered` (as they are in the view), plus the negative lookups (D1b) of those entities, minus keys in `Added`. |
| `ModuleRefs` | `⋃ R(E)` for **every** entity `E` of every touched module (as in the view), plus their negative lookups, minus `NewRefs`, minus keys in `Added`. |
| `AddedRefs` | The references the attempt itself added: `R(E)` for `E` in `Added`; and for an altered `E` that still exists, `R(E)` in the view minus `R(E)` at head. Minus keys in `Added`. Negative lookups are not in `AddedRefs`. |
| `Edited` | `Altered` ∪ every entity with an `edit` premise. |

"The patch references *K*" means `K ∈ NewRefs`. "The patch's module references *K*" means `K ∈ ModuleRefs`. Trunk recomputes these sets whenever the attempt's operations change, stores them with the attempt, and uses them live in the decision table (section 7).

Why `ModuleRefs` exists: an edit to one entity of a module is new code that runs together with the module's other entities. If `creatures/fish.js#update` gains `fish.energy < 30`, the quantity it relies on is named only by the unaltered sibling `creatures/fish.js#spawn` (`energy: ENERGY_MAX`). `NewRefs` alone would miss it in both landing orders (vectors `C36`, `C37`).

- **D1 (referenced entities; at every operation and again at submit, CK7).** For every `K ∈ NewRefs ∪ ModuleRefs` that is an entity key and exists at head: if the attempt has no `entity:K` premise, create it pinned at head with `read = 0`, `edit = 0`; in every case set `derived = 1`. A whole-module reference does the same with `file:<path>`. An unresolved reference fails CK5. Pinning at the operation, not only at submit, means a change of *K* between the edit and the submit is caught live with its diff (vector `C10`), not later as a blind spot.
- **D1b (negative lookups).** When `resolveExport(T, x)` (6.2) did not find `x` among the exports of module `T` and resolved it through a star re-export of `T`, the binding relies on `x` being absent from `T`. The key `T#x` is a **negative lookup** of the referring entity. D1 creates `entity:T#x` pinned at `absent` with `derived = 1`. If a landing later adds a local export `x` to `T`, the premise changes (`absent` → present) and row E2 or E2m applies (vector `C57`).
- **D2 (who references this; at every operation and again at submit).** For every `E ∈ Altered`: ensure a `query` premise `refs:E` exists with `derived = 1`. When created, it is pinned at the members of `refs:E` at head at that moment (2.5), and the referrer keys are returned to the agent in `relied_on_by` of the same tool result. A `refs:` premise whose entity is no longer in `Altered` is deleted.
- **D3.** Derived premises are live like any other premise from the moment they exist.
- **D4.** When the operations change so that a key leaves `NewRefs ∪ ModuleRefs`, its `derived` flag is cleared (R5).

Why D2 pins at the operation and not at submit: a referrer that lands between the edit and the submit must be caught. Pinned at the edit, the premise gains a member when the referrer lands (rule QR1).

Worked example (vector `C36`): the attempt replaces one line inside `creatures/fish.js#update`.

| Set | Value |
| --- | --- |
| `Added` | empty |
| `Altered` | `creatures/fish.js#update` |
| `NewRefs` | `world/movement.js#step`, `world/energy.js#drain` |
| `ModuleRefs` | `world/energy.js#ENERGY_MAX` (from the unaltered `#spawn` and the import entity) |
| `AddedRefs` | empty (the replace added no reference) |
| Premises after the operation | `entity:creatures/fish.js#update` (read, edit); `refs:creatures/fish.js#update` (derived); `entity:world/movement.js#step`, `entity:world/energy.js#drain`, `entity:world/energy.js#ENERGY_MAX` (derived) |

### 6.4 Blind spots and the confirm turn

- **B1.** At CK7, a key `K ∈ AddedRefs` is a **blind spot** when the agent was never shown *K*: its premise has `read = 0`, `edit = 0` and an empty `shown` value (3.2), and the attempt has no `file` premise with `read = 1` on *K*'s path. Each blind spot is recorded as a judgment (`rule B1`, result `confirm`, reason `blind_spot`). A key is a blind spot at most once per revision: the confirm heads-up sets `shown`.
- **B1a (what is not a blind spot).** A reference that the altered entity already had at head, and a reference that only a sibling entity has (`ModuleRefs`), is not a blind spot: the attempt did not add it. Its premise still exists (D1) and is live. An entity whose current source reached the agent in a heads-up item (any rule) is not a blind spot either.
- **B2.** All blind spots of one submit go into one heads-up of result `confirm`. Each item carries the **current** source of the entity (`before: null`, `after: <source>`; for a whole-module reference, the module's outline lines) and the attempt's own lines that use it. The premises' status is `pending_confirm`. The submit answers `needs_confirm`.
- **B3.** The agent takes one model turn with that heads-up in context. It may add operations. Its next submit acknowledges the heads-up with a statement; the statement is stored in the note under `confirms`. A blind spot is never a rejection and never a go-around.
- **B4.** After the confirm, the premise is an ordinary premise: if the entity changes before landing, rule E2 gives `repair`.

### 6.5 The hero conflict, both orders

Shared rule `world/energy.js#ENERGY_MAX` changes from `100` to `1` (energy becomes a fraction). A creature change compares energy with the literal `30`, in a module that starts its creature with `ENERGY_MAX`. The name, the export and every import stay valid, the files differ, and a text merge has nothing to report. The real pool and its attempts are specified in `02-tidepool.md` section 7; the vectors use a smaller pool with the same shape.

| What the creature change is | The shared-rule change lands first | The creature change lands first |
| --- | --- | --- |
| A new creature file whose `spawn` references `ENERGY_MAX` | The reference is in `NewRefs`; D1 pinned it at the write. Rule **E2**, `repair`, with the diff `100 → 1`. Vectors `C04` (the agent read the rule), `C10` (it never did). | D2 pinned `refs:ENERGY_MAX` when the rule was altered. The landing adds referrers: rule **QR1**, `repair`. The item carries the new referrers and, as `context`, every other entity the landing added to that module, including the one with `30`. Vector `C05`. |
| An edit to one entity of an existing creature, whose sibling entity references `ENERGY_MAX` | The reference is in `ModuleRefs`. Rule **E2m**, `confirm`, with the diff. Vector `C36`. | The referrer set is unchanged, the referrer module's hash changed: rule **QR1m**, `confirm`, with the altered entity as `context`. Vector `C37`. |
| The shared rule changed before the creature's agent wrote anything, and the agent never read it | Rule **B1** at submit: one confirm turn with the current definition. Vector `C30`. | (not a conflict: nothing was in flight) |
| Plain numbers only, no reference to `ENERGY_MAX` anywhere in the module; the agent read `ENERGY_MAX` | No rule can decide. Rule **E3**, triage (7.3). | No rule can decide. Rule **QR4**, triage of the altering attempt. Vector `C38`. |
| Plain numbers only, and the agent never read `ENERGY_MAX` | Nothing: no premise exists. | Nothing: no premise exists. |

What is deterministic, and what is not:

- **HC1.** Every row that names a rule in bold other than E3 and QR4 is decided by rule, in the accept transaction, without Clef, and does not depend on what the model chose to read.
- **HC2.** The rule-based catch needs one fact: the changed module references the shared quantity. It does not need the changed *entity* to reference it.
- **HC3 (stated limits, also in the README).** (a) A change that hard-codes a number and whose module never references the quantity is caught by rule in neither order; if its agent read the quantity it goes to triage in both orders, and if not, only the green line's self-test could catch it after landing. The self-test checks that the pool is healthy, not that a creature does what its intent asked: in the platform record a crab written for the old scale passed every generic invariant after the rescale (it hid for all 3,000 ticks). So this case can go unnoticed, and the README says so. (b) References are direct: code that depends on `ENERGY_MAX` only through another function it calls (`drain(creature, 5)`) holds a premise on `drain`, whose hash does not change when `ENERGY_MAX` does. (c) A sweep is recognised from operations, not from the intent text (rows L1, QT1).
- **HC4.** Because of HC3 (a), the tide pool specification requires every energy creature to take its starting energy from `ENERGY_MAX` (`02-tidepool.md`, TP16), and the seeded-intent measurement (S5; protocol in `05-agent.md`) reports, per model, the share of creature changes that reference it.

---

## 7. Validation

### 7.1 When classification runs

Classification compares a premise's pinned hash with the current hash of its key and produces one of three **results**: `holds`, `confirm`, `repair`. It runs:

1. at every accepted batch, for every premise whose key's hash changed, of every **classified attempt**: every in-flight attempt (states `opened` to `held`) and every **parked** attempt (state `stopped` with an open `choice` card that offers `retry`; GL3a) (section 8);
2. in the batch tick, for each candidate against the running state (9.4);
3. at submit, for blind spots (6.4);
4. after every accepted operation: the re-evaluation of pending triage (V7); after every accepted operation and at submit: the late sweep check (row L1);
5. on `register` after a rebuild (3.6);
6. for landed changes, when an undo or revert is planned (11.3).

- **V1.** Rule-based rows are decided synchronously, inside the transaction. Clef is called only for rows of class `triage`.
- **V2.** Clef never overrides a rule-based `repair` or `confirm`.
- **V3.** Every classification of a changed premise is recorded as a judgment (7.5), whatever its result.
- **V4.** After classification the premise is pinned at the current hash (`hash`, `seq`, `members` updated) and its status is set: `holds`, `pending_triage`, `pending_confirm` or `pending_repair`. Because of this, a pinned hash always equals head, and "all premises hold" (CK8) means "no premise has a pending status". Classification never changes `shown` except through a heads-up item it creates (3.2).
- **V5.** Rows are tried top to bottom within a kind; the first matching row decides. The rows of each kind are exhaustive. If an implementation ever finds a changed premise that no row matches, the result is `confirm` with rule `Z1` and reason `unclassified` (fail closed).
- **V6.** `Edited`, `NewRefs`, `ModuleRefs`, `Altered` and "current operations" in the table mean the attempt's sets (6.3) as they were just **before** the change being classified: computed on the attempt view over the head before the batch (in the tick: the head before the tick). Operations are replayed and dropped (OP6) only after the premises are classified, so a replace that no longer matches still counts as an edit of its target (row E1).
- **V7 (operations change while a triage is pending).** Every pending triage judgment stores the attempt's last `op_seq` at the moment it was asked (`asked_op_seq`). After every accepted operation, each pending judgment of the attempt is evaluated again with the attempt's **current** sets, against the same old and new hash:
  - if a rule row now matches with result `repair` or `confirm` (E1, E2, E2m, F1, F3, F3m, F5, QT1), that row decides: the judgment is closed with class `rule`, that row and result, a heads-up of that result is created, and any Clef answer for it is discarded when it arrives;
  - otherwise the question is asked again for the current patch and `asked_op_seq` is updated.

  A Clef answer is applied only when its `asked_op_seq` equals the judgment's current one. So an answer computed for an older patch never decides (vector `C31`).
- **V7a.** When a premise with a pending triage is deleted (R5, D2), its judgment is closed with result `holds`, reason `premise_gone`.

### 7.2 Decision table

Columns: what changed; *edits* = the premise has `edit = 1` or its key is in `Edited`; *references* = the key is in `NewRefs`; *module references* = the key is in `ModuleRefs`; *read* = the premise has `read = 1` (for an entity, a `file` premise on its path with `read = 1` also counts).

**Before any kind-specific row:**

| Row | Condition | Result | Reason | Heads-up |
| --- | --- | --- | --- | --- |
| X0 | The attempt has no current operations, and the kind-specific row that matches is a triage row (E3, F4, F6, QT2) | `holds` | `no_patch_yet` | `info`, with the diff. Nothing the attempt wrote can depend on the old version; the agent's context is updated before it writes (TA3). Clef is not called. |

**Entity premise** (`entity:K`):

| Row | What changed | Edits | References | Module references | Read | Result | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E0 | hash unchanged (includes every cosmetic edit) | any | any | any | any | `holds` | not classified, not recorded |
| E1 | hash changed, or present ↔ absent | yes | any | any | any | `repair` | `edited_entity_changed` |
| E2 | hash changed, or present ↔ absent | no | yes | any | any | `repair` | `referenced_entity_changed` |
| E2m | hash changed, or present ↔ absent | no | no | yes | any | `confirm` | `module_reference_changed` |
| E3 | hash changed, or present ↔ absent | no | no | no | yes | **triage** (7.3) | `read_not_referenced` |
| E4 | hash changed | no | no | no | no | premise deleted | `reference_gone` (a derived premise whose reference was removed) |

**File premise** (`file:P`). *D* is the set of entities of *P* whose hash differs before and after, including added and removed ones; *D* is defined only when *P* is a module before and after.

| Row | What changed | Edits | Other condition | Result | Reason |
| --- | --- | --- | --- | --- | --- |
| F0 | blob id unchanged | any | | `holds` | not classified |
| F1 | blob id changed, or present ↔ absent | yes (a `write` on *P*, or any operation on an opaque *P*) | | `repair` | `write_base_changed` (also reported as OP5) |
| F2 | blob id changed, *D* is empty | no | | `holds` | `cosmetic` (judgment recorded, no heads-up) |
| F3 | blob id changed, *D* not empty | no | *D* ∩ (`NewRefs` ∪ `Edited`) not empty, or `P ∈ NewRefs` (a whole-module reference) | `repair` | `referenced_entity_changed`; `referenced_file_changed` when it matched through `P ∈ NewRefs` |
| F3m | blob id changed, *D* not empty | no | otherwise, *D* ∩ `ModuleRefs` not empty, or `P ∈ ModuleRefs` | `confirm` | `module_reference_changed` |
| F4 | blob id changed, *D* not empty | no | otherwise, `read = 1` | **triage** | `read_not_referenced` |
| F5 | *P* opaque before or after, or present ↔ absent | no | *P*, or an entity of *P*, is in `NewRefs` ∪ `ModuleRefs` | `repair` | `referenced_file_changed` |
| F6 | *P* opaque before or after, or present ↔ absent | no | otherwise, `read = 1` | **triage** | `read_not_referenced` |
| F7 | any change | no | `read = 0` and none of the conditions above | premise deleted | `reference_gone` |

**Listing premise** (`listing:D`). The attempt is **sweeping** *D* when it has current operations on at least `min(2, n)` distinct paths directly in *D* that existed at head before the change, where *n* is the number of files directly in *D* at head before the change (*n* ≥ 1). *Unshown* names are entry names at head that are not in the premise's `shown` names (3.2) and that the attempt did not create.

| Row | What changed | Other condition | Result | Reason |
| --- | --- | --- | --- | --- |
| L0 | entry names unchanged | | `holds` | not classified |
| L1 | there is at least one unshown name | the attempt is sweeping *D* | `repair` | `sweep_incomplete`; the item's `added` lists the unshown names |
| L2 | names gained or lost | an added or altered entity of the attempt contains a string literal equal to a **gained or lost** entry name, or to such a name without its extension, for an entry the attempt did not create | `confirm` | `listing_named` |
| L3 | names gained or lost | otherwise | `holds` | `listing_unused` (judgment recorded, no heads-up; `shown` is not updated) |

- **L1 is also checked late.** After every accepted operation and at submit (CK7), for each `listing` premise of the attempt with status `holds`: if the attempt is now sweeping the directory and unshown names exist, row L1 applies at that moment. The operation stays recorded; the heads-up has `cause.type = "landing"` with the landings that added the names (`files.changed_seq`), and travels in the same tool response. This closes the window between an agent's `list` and its edits (vector `C41`).
- L3 is deliberate: every creature agent lists `creatures/`, and a new creature must not disturb every other in-flight creature (the hot-entity requirement). An attempt that edits one file of a directory with several is not sweeping it (vector `C40`). A lost entry that the patch edits or references is caught by its own `file` or `entity` premise.

**Text query premise** (`text:...`). A pinned container is **swept** when it is in `Altered`, or, for an opaque file, when the attempt has a current operation on it. *m* is the number of pinned containers.

| Row | What changed | Other condition | Result | Reason |
| --- | --- | --- | --- | --- |
| QT0 | members unchanged | | `holds` | not classified |
| QT1 | at least one container gained (2.6) | *m* ≥ 1 and at least `min(2, m)` pinned containers are swept (the agent is changing the matches it found; the sweep is now incomplete) | `repair` | `sweep_incomplete` |
| QT2 | at least one container gained | otherwise | **triage** | `search_gained_match` |
| QT3 | containers only lost | | `holds` | `match_lost` (judgment recorded, no heads-up) |

**Who-references query premise** (`refs:E`). The premise's members are referrer keys and module entries (2.5).

| Row | What changed | Other condition | Result | Reason |
| --- | --- | --- | --- | --- |
| QR0 | members unchanged, and row QR4 does not apply | | `holds` | not classified |
| QR3 | any | *E* is no longer in `Altered` | premise deleted | n/a (rule D2) |
| QR1 | at least one referrer key gained | *E* is in `Altered` | `repair` | `new_reference_to_altered_entity` |
| QR1m | no referrer key gained; a module entry changed | the change added or altered at least one entity in a module that holds a referrer | `confirm` | `referrer_module_changed` |
| QR4 | any, including no change of the members | no row above gave `repair` or `confirm`, and a landing being classified holds a frozen premise with `read = 1`, `edit = 0`, `derived = 0` on *E* (or on *E*'s file, with no `edit` or `derived` premise on *E*), and *E* exists at head, and the attempt's operations on *E*'s path still apply | **triage** | `reader_landed` |
| QR2 | otherwise (referrers only lost, entities only removed) | | `holds` | `match_lost` (judgment recorded, no heads-up) |

QR4 is the mirror image of E3: a change whose agent read *E* and did not reference it has landed while this attempt is altering *E*. In the other order that reader would get E3.

**Outline query premise** (`outline:P`):

| Row | What changed | Other condition | Result | Reason |
| --- | --- | --- | --- | --- |
| QO0 | outline lines unchanged | | `holds` | not classified |
| QO1 | lines changed | an entity whose line changed or disappeared is in `NewRefs` ∪ `Edited` | `repair` | `outlined_entity_changed` |
| QO2 | lines changed | otherwise | `holds` | `outline_unused` (judgment recorded, no heads-up) |

**Other rows that appear as `rule` in judgments and heads-up items:**

| Row | Where | Result |
| --- | --- | --- |
| B1 | blind spot at submit (6.4) | `confirm` |
| OP1 to OP5 | an operation no longer applies (section 5); reported in `dropped_ops` | `repair` |
| CKL | a check failed in the tick (9.4 step 3c); the item's premise is `{ kind: "check", key: <check name> }` | `repair`, reason `checks_failed_at_landing` |
| Z1 | no row matched (V5) | `confirm` |

Consequences that tests rely on:

- A cosmetic edit never produces a heads-up (E0, F2). The single exception is F1: a whole-file `write` over a file whose bytes changed underneath is sent back, because replaying it would silently overwrite the other change. Rule W1 covers the other order.
- A changed body of an entity the agent read never passes silently. It is `repair` (E1, E2), `confirm` (E2m), or triage (E3), which delivers the diff at once in an `info` heads-up (TR1) and records a judgment whatever Clef answers.
- By rule, a go-around is forced only where the patch edits or references the changed thing (E1, E2, F1, F3, F5, QO1), or is sweeping a set that gained a member (L1, QT1, QR1), or an operation no longer applies (OP1 to OP5), or a check fails at landing (CKL). A confirm turn is required by rule where the patch's module references the changed thing (E2m, F3m, QR1m), where a listed name is used as a string (L2), and for blind spots (B1). What the agent merely read goes to triage.

### 7.3 Triage with Clef

Rows E3, F4, F6, QT2 and QR4.

- **TR1 (the diff is never delayed).** In the accept transaction Trunk sets the premise status to `pending_triage`, records the judgment with `result = NULL` and `asked_op_seq`, and puts the item, with its diff and `result: "pending"`, into the attempt's heads-up for that batch. If no stronger item is in it, that heads-up has result `info`. So TA3 forces the diff into the agent's context before any further write or submit, and HU7 holds for triage rows too.
- **TR2.** Clef is called **after** the transaction commits, outside the landing path. An attempt with a `pending_triage` premise cannot be placed in a batch, and a held card cannot be approved for it (T13).
- **TR3 (outcome).** When the answer arrives and its `asked_op_seq` is current (V7), the judgment is closed and the premise status set. Results `repair` and `confirm` create a new heads-up of that result. Result `holds` creates no heads-up: the diff was already delivered. Every outcome emits `premise.judged`.
- **TR4.** An answer whose `asked_op_seq` is not current, or whose judgment is already closed (V7, V7a), is discarded and recorded in `judgments.clef_error` as `stale`.
- **TR5 (decided inside the transaction).** When the attempt's triage is a `SyncTriage` (S6), the outcome is decided inside the transaction, with no `await` (SY2) and no `pending` item. This is the case when triage is known to be unavailable at classification time (`CLEF_TRIAGE = off` or the kill switch is set: `OffTriage`) and for every synthetic attempt (`ScriptedTriage`, TR8). `OffTriage` answers unavailable for every premise: `confirm` with reason `triage_unavailable`, which is the behaviour of a build without Clef. A scripted answer maps through the table below like a Clef answer. The item is in the batch's heads-up with its final result: `repair`, `confirm`, or `holds` (an info-level item with the diff, so a re-affirmation is never silent). No Clef call is made and no `triage` timer is set.
- **TR6 (no lost question).** `CLEF_TIMEOUT_MS` starts when the request is dispatched. A `triage` timer (AL1) exists while any judgment is pending. A judgment pending past its deadline is unavailable. On start-up, a pending judgment with no request in flight is asked again once (`tries = 1`); if that also passes its deadline it is unavailable (vector `C52`).

Request. One request per attempt per batch carries every pending premise of that attempt, one question each, at most `CLEF_MAX_QUESTIONS` (more than that: the rest are unavailable). Shape from the saved Clef documentation:

```ts
const response = await env.AI.run(CLEF_TRIAGE_MODEL_ID, {      // "@cf/cloudflare/clef" (S6; the fallback is "@cf/cloudflare/clef-flash")
  model: CLEF_TRIAGE_MODEL,                                    // "clef" (fallback "clef-flash")
  state: {
    intent: "a crab that hides when its energy is low",
    patch: [                                                   // added and altered entities, as in the attempt view
      { key: "creatures/crab.js#update", source: "export function update(crab) { ... }" }
    ],
    premises: {
      p1: {
        kind: "entity", key: "world/movement.js#MAX_SPEED",
        read_then: "export const MAX_SPEED = 2;",              // null when unavailable
        is_now: "export const MAX_SPEED = 3;",                 // null when it no longer exists
        changed_by_intent: "let creatures move faster"
      }
    }
  },
  questions: {
    p1: {
      type: "noul",
      instructions:
        "`patch` was written by an agent that had read `premises.p1.read_then`. That code has since changed to " +
        "`premises.p1.is_now`. Does `patch` rely on the old meaning in `read_then`, so that `patch` would behave " +
        "differently than its `intent` wants now that the code is `is_now`?",
      criteria: {
        true: "patch uses a value, unit, range, name, order or behaviour that held under read_then and no longer holds under is_now",
        false: "patch behaves as intended under is_now, or does not depend on this code"
      }
    }
  }
});
const p = response.answers.p1.noul;   // probability, 0 to 1
```

- For a listing or query premise, `read_then` and `is_now` are the JSON arrays of members, and `added` lists the gained members with their source.
- For row QR4 the roles are swapped and the same question is asked: `intent` and `patch` are the **landed** change's intent and its added and altered entities; `read_then` is *E* at head (what the landed change's agent read); `is_now` is *E* in the asking attempt's view (what it is being changed to); `changed_by_intent` is the asking attempt's intent.
- **TR7 (never judge a cut patch).** If the serialized `state` exceeds `CLEF_STATE_MAX_CHARS`, the call is not made and the outcome is unavailable. Nothing is dropped from `patch` to make it fit. If the response reports `usage.input_tokens` at or above `CLEF_INPUT_TOKEN_LIMIT`, the answer is discarded as unavailable (the service may have truncated the state).
- **TR8 (synthetic attempts).** An attempt with `agent_kind = synthetic` never calls Clef, in any pool. Its triage is `ScriptedTriage`, a `SyncTriage` (S6): it answers inside the transaction (TR5) from the attempt's **truth list**, the premises the canned change truly depends on (`attempts.truth`, a JSON array of `<kind>:<key>` strings, for example `entity:world/energy.js#ENERGY_MAX`; `02-tidepool.md` 10.3 gives the list of each pattern). The list reaches Trunk when the synthetic attempt is opened, and again in `register` after a rebuild. The answer is a pure function `scriptedAnswer(truth, premise, changed)`:
  - Which list: for rows E3, F4, F6 and QT2 the attempt's own list. For row QR4 the list of the **landed** change (the reader), and the premise is that change's frozen premise on *E*.
  - No list (in row QR4, a landed change of a real agent; or an attempt that was opened without one): `null`, that is unavailable.
  - Otherwise `p = 1` when the premise's `<kind>:<key>` is in the list, or, for a `file` premise, when an entity of that file whose hash changed (the set *D* of 7.2) is in the list;
  - and `p = 0` in every other case.

  With the mapping below, `p = 1` gives `repair` (`triage_depends`), `p = 0` gives `holds` (`reaffirmed`, delivered as an info-level item, never a `confirm`), and `null` gives `confirm` (`triage_unavailable`). The judgment records `class = triage`, `clef_model = "scripted"` and `clef_p`. Swarm numbers therefore measure the protocol, not Clef, and say so.
- **TR9.** Clef calls go through the model gate (SE6) with their own per-minute bucket. A refusal by the bucket, the spend cap or the kill switch is unavailable.
- **TR10 (the question store; added 2026-10-10 by the owner's decision to build the extensions).** A pending question must survive the Trunk object's restart with what V7 and the request need, because the classification's file maps live only in the accept call. In the transaction that makes a judgment pending, Trunk writes one `triage_asks` row per pending premise (`attempt_id`, `kind`, `key` as the key; `decider_id`, the attempt whose intent, patch and truth list the request carries: the landed reader for QR4, otherwise the attempt; `frozen`, a JSON object with the question's `premises` entry of S6 and the item fields a re-evaluation needs: the hashes, the members, the added, removed, context and changed keys, and the texts before and after of every path those name; `asked_op_seq`; `dispatched_at` and `deadline_at`, null until sent; `tries`). The row is the only state the asynchronous path keeps besides the judgment:
  - **Dispatch.** After a commit, Trunk's `triage_dispatch` call marks every row with `dispatched_at` null as sent (`deadline_at` = now + `CLEF_TIMEOUT_MS`), groups them by attempt and decider into one `TriageInput` each (the patch is computed from the decider's operations at that moment), and returns the requests. Rows beyond `CLEF_MAX_QUESTIONS` in one request are closed unavailable (`too_many_questions`). The Worker sends each request through the `Triage` port and returns every answer through the `triage` call with the `asked_op_seq` it was sent with, the model, the latency and the error code. Nothing in the landing path waits for it (TR2).
  - **Re-ask (V7).** When a re-evaluation keeps a question as triage, its row gets the new `asked_op_seq` and `dispatched_at` null, so the next dispatch asks it again with the current patch, and an answer for the older patch is recorded `stale` (TR4).
  - **Deadline (TR6).** The `triage` timer is due at the earliest `deadline_at`, or `CLEF_TIMEOUT_MS` after a row was written. A row still pending past its deadline is closed unavailable (`timeout`). The first dispatch after the object starts is preceded by `triage_restart`: a row sent by an earlier instance has no request in flight, so it is asked again once (`tries = 1`), and one already asked again is closed unavailable.
  - **Reopen.** A pending judgment loaded without its classification item rebuilds it from `frozen`, so V7 runs on every operation whatever instance serves it. A row whose judgment is no longer pending is deleted.
  - **Price (TR9).** The gate reserves a Clef request at the published Workers AI price, which the model plan's price table carries: `@cf/cloudflare/clef` $0.240 per million input tokens, `@cf/cloudflare/clef-flash` $0.038, and no charge for output tokens (Workers AI pricing page, read 2026-10-10). Without a price the gate's bound is infinite and every Clef request is refused `spend_cap` (SE6a).
  - **Choice of triage (S6a) in the Worker.** `ClefTriage` is the attempt's triage only when `features.clef` is true and the variable `CLEF_TRIAGE` is `on`. Otherwise every real attempt gets `OffTriage` inside the transaction (TR5). The kill switch reaches Clef questions through the gate (TR9: `killed` is unavailable).

Mapping (constants `T_REPAIR` and `T_CONFIRM` are *calibrated*, with `T_CONFIRM < T_REPAIR`):

| Clef outcome | Result | Reason | New heads-up |
| --- | --- | --- | --- |
| `p >= T_REPAIR` | `repair` | `triage_depends` | `repair` |
| `T_CONFIRM <= p < T_REPAIR` | `confirm` | `triage_unsure` | `confirm` |
| `p < T_CONFIRM` | `holds` | `reaffirmed` | none (the `info` heads-up of TR1 already carried the diff; re-affirmation is never silent) |
| unavailable: Clef off, kill switch, spend cap, rate limit, error, time-out, malformed answer, state too large (TR7), too many questions | `confirm` | `triage_unavailable` | `confirm` |

"Unavailable gives `confirm`" is the fail-closed default.

### 7.4 What each result does

| Result | Premise status | Attempt | Agent must |
| --- | --- | --- | --- |
| `holds` | `holds` | unchanged | nothing |
| `confirm` | `pending_confirm` | `submitted`, `validated`, `held` → `needs_confirm` (T11, a counted **pull-back**); other states unchanged | take one turn with the heads-up in context, then acknowledge it in a submit with a statement |
| `repair` | `pending_repair` | → `going_around` (T8, T10, T10a) | adapt (or decide nothing needs to change), then acknowledge it in a submit with a statement |

### 7.5 What is recorded for each judgment

One `judgments` row per classified premise: attempt, premise kind and key, old and new hash, cause and `cause_seq`, the row id (`rule`), `class` (`rule` or `triage`), result, reason, and for triage `asked_op_seq`, the Clef model, probability, latency, error and the two thresholds in force. Judgments of an attempt are copied into its note when it lands. Acknowledgement statements are stored with the heads-up and copied to `go_arounds` or `confirms` in the note.

- **JE1 (events).** One `premise.judged` event when the judgment is created (`result: null` for a pending triage) and a second one when a pending triage is closed (TR3, V7, V7a). In a `summary_only` pool, judgments whose result is `holds` with no heads-up (F2, L3, QT3, QR2, QO2) are stored but emit no event (EV6).
- **JE2.** A folded file item (HU2a) is a judgment like any other; it only has no heads-up item of its own.

---

## 8. Live heads-ups

### 8.1 Trigger

- **HU1.** In the same SQLite transaction that accepts a batch (9.4 step 5), Trunk classifies every premise changed by the batch, of every classified attempt (7.1), and inserts the resulting heads-ups. It also re-replays operations (OP7b).
- **HU2.** One heads-up per attempt per trigger. All premises of the attempt changed by one batch, and all operations dropped by it, are items of that one heads-up. Its `result` is the strongest among its items: `repair` > `confirm` > `info`. An item of a pending triage (TR1) and an X0 item count as `info`. If nothing but `holds` without heads-up resulted (F2, L3, QT3, QR2, QO2), no heads-up is created.
- **HU2a (folding).** A `file` item with rule F3 or F3m is left out of the heads-up when the match came only through *D* and every entity of *D* that is in `NewRefs` ∪ `Edited` ∪ `ModuleRefs` has its own `entity` item of result `repair` or `confirm` in the same heads-up. Its judgment is recorded and its premise status is `holds`. An agent that read a whole file and references one of its entities thus receives one item, the entity's (vector `C57`).
- **HU3.** Triage outcomes of result `repair` or `confirm` (TR3) arrive later and create their own heads-up, one per attempt per batch of resolved judgments. So do rule decisions of V7 and the late L1 check; these are created inside the tool call that caused them.
- **HU4.** Other triggers use the same type: blind spots at submit (`cause.type = "submit"`), undo and revert landings (`"undo"`, `"revert"`).

### 8.2 Payload

```ts
type HeadsUp = {
  hn: number;                         // per attempt: 1, 2, 3, ...
  attempt_id: string;
  result: "info" | "confirm" | "repair";
  wake: boolean;                      // HE2: true for confirm and repair sent to an attempt that is not stopped
  cause: {
    type: "landing" | "submit" | "undo" | "revert";
    seqs: number[];                   // landings that changed something for this attempt
    changes: Array<{ seq: number; change_id: string; intent_text: string | null }>;
  };
  items: HeadsUpItem[];
  dropped_ops: Array<{ op_seq: number; path: string; rule: "OP1" | "OP2" | "OP3" | "OP4" | "OP5" }>;
  go_around: number | null;           // the go-around this heads-up started or joined
  head_seq: number;                   // head after the trigger
  created_at: number;
};

type HeadsUpItem = {
  premise: { kind: PremiseKind | "check"; key: string };
  rule: string;                       // decision table row
  result: "holds" | "pending" | "confirm" | "repair";   // "holds" and "pending" appear only as info-level items
  reason: string;
  old_hash: string;
  new_hash: string;
  cause_seq: number | null;           // first landing in the batch that changed this key
  diff: Diff;
  uses: Array<{ path: string; entity: string; line: number; text: string }>;  // the attempt's own lines that reference the key
  truncated?: true;                   // HU10: texts were left out
};

type Diff =
  | { kind: "entity"; before: string | null; after: string | null; before_unavailable?: true }
  | { kind: "file"; before_oid: string; after_oid: string; unified: string; changed_entities: string[] }
  | { kind: "listing"; added: string[]; removed: string[] }
  | { kind: "query"; added: Array<{ key: string; source: string | null }>; removed: string[];
      context: Array<{ key: string; source: string }> }
  | { kind: "check"; check: string; code: string };     // rule CKL; a fixed code, never free text
```

- `before` and `after` are complete entity sources (EN7), so the diff is exact and self-contained. `unified` is a unified diff with three context lines.
- `uses` for rows E2m and F3m lists the lines of the touched module that reference the key, whichever entity they are in.
- `context` (rows QR1, QR1m, QR4): every entity that the triggering landings added or altered in the modules that hold a referrer (for QR4: in the landed change), other than the keys already in `added`, with its source. For the hero conflict this is the entity that holds the old number (`creatures/crab.js#update`), so the agent that changed the shared rule sees the line that breaks without a read.
- **HU10 (size).** A serialized heads-up is at most `HEADS_UP_MAX_BYTES`. When the full texts do not fit, items lose their texts in this order until it fits: `context` sources, `unified`, `before` and `after`. An item that lost text has `truncated: true` and keeps its hashes and keys; the agent reads what it needs. The limit is applied before the transaction, so the insert cannot fail (SQ2).

### 8.3 Delivery and ordering

Three moments are distinguished:

| Moment | Meaning | Recorded in | Used by |
| --- | --- | --- | --- |
| **Received** | The Agent Durable Object stored the heads-up in its `inbox` (the push call returned, or a tool or sync response carried it). | `heads_ups.received_at` | stops the re-push (HU5) |
| **Delivered** | The heads-up is in the model's context: Trunk received a request with `ack >= hn`. | `heads_ups.delivered_at` | TA3, GA1 |
| **Resolved** | A `submit` acknowledged it (CK1). Only `confirm` and `repair` need this. | `heads_ups.resolved_at` | CK8, 9.3 |

- **HU5 (two paths, at least once).** (a) Every `ToolResponse` and `SyncResponse` carries the heads-ups with `hn > ack`, lowest first (TA8). (b) After the transaction commits, Trunk pushes to the attempt's Agent Durable Object. Each push carries **all** heads-ups not yet received, in ascending `hn`. It is repeated every `HEADS_UP_REPUSH_MS` until the push call returns successfully or the attempt is closed. A successful return marks them received. The Agent de-duplicates by `hn`.
- **HU6 (numbering).** `hn` is assigned in creation order, with no gaps. Heads-ups created by landings are created in landing order. A heads-up for a triage outcome (TR3) is created when the answer arrives, so it may be numbered after heads-ups of later landings.
- **HU6a (no gaps at the Agent).** The Agent shows the model, and acknowledges, heads-up *n* only when it holds every heads-up from its last shown number plus 1 up to *n*. If its inbox holds a higher number with a gap below it, it calls `sync` and takes the missing ones from the response. `ack` is therefore never raised over a heads-up the model has not seen. Worked examples (pure function `inboxNext(shown_hn, inbox)`, `inbox_cases` in the vectors):

  | `shown_hn` | inbox | shows now | calls `sync` |
  | --- | --- | --- | --- |
  | 0 | 1, 2 | 1, 2 | no |
  | 0 | 2 | nothing | yes |
  | 2 | 3, 5 | 3 | yes |
  | 2 | 1, 2 | nothing | no |

- **HU7 (consistency).** Because of HU1 and TR1, any tool response with `head_seq >= s` already contains every heads-up caused by landings up to `s`, including an `info` item for each triage that is still pending. An agent can never see post-landing content without the diff for that landing.
- **HU8 (delivered).** A heads-up is delivered when Trunk receives a request (tool or sync) with `ack >= hn`. `ack` is the Agent's statement that the heads-up is in the model's context (HE1).
- **HU9 (resolved).** A heads-up of result `confirm` or `repair` is resolved only by a `submit` that lists it in `acknowledge` (CK1). An `info` heads-up needs no resolution and never blocks a landing (9.3).
- **HU12 (`changed`: did the agent change anything).** When a submit resolves a heads-up, Trunk emits `headsup.resolved` with `result`, `go_around` and `changed`. For a heads-up of result `repair`, `changed` is `false` exactly when the attempt's current operations at the resolving submit are identical to its current operations at the moment its go-around started, before any drop (OP6) by a heads-up of that go-around: no operation was accepted and none was dropped since. Every `repair` heads-up of one go-around that one submit resolves carries the same value. For a heads-up of result `confirm` the comparison is with the operations at the moment the heads-up was created. Trunk decides it from its own tables, with no event from the agent: `heads_ups.op_mark` holds the attempt's last `op_seq` at that moment, and `changed` is true when the attempt's last `op_seq` is now greater, or when a heads-up created since then has a non-empty `dropped_ops`. This field is what lets every pool, also a `summary_only` pool whose stream has no `op.recorded`, compute the false-abort rate (14.4).

**Starting an Agent again (`resume`).** A heads-up push wakes an agent that is waiting. It does not start an Agent whose attempt had ended. Two transitions put an ended attempt back in flight: T19 (a landed change is reopened by an undo or a revert; its Agent is in `landed`) and T21 (the owner taps "Try again" on a parked attempt; its Agent is in `stopped`, and the waiting heads-ups were created with `wake = false`, GL3a). For both, Trunk calls the Agent:

```ts
// Trunk -> Agent Durable Object. Not a tool. Sent after the transaction of T19 or T21 has committed.
type ResumeRequest  = { attempt_id: string; revision: number; cause: "retry" | "undo" | "revert";
                        resume_n: number };              // attempts.resumes after the transition: 1, 2, 3, ...
type ResumeResponse = { ok: true; resume_n: number }
                    | { ok: false; error: "model_unavailable" | "budget" | "attempt_unknown" };
```

- **RS1 (when, and at least once).** In the transaction of T19 or T21 Trunk adds 1 to `attempts.resumes` and emits `attempt.reopened { cause, revision, model_changed }`. After the commit it sends `resume` to the attempt's Agent Durable Object. Like the heads-up push (HU5) the call is repeated every `HEADS_UP_REPUSH_MS` (the `resume` timer, AL1) until the Agent answers, for at most `RESUME_ACK_TIMEOUT_MS` from the first send. Nothing on the landing path waits for it.
- **RS2 (what the Agent does).** On a `resume` whose `resume_n` is greater than its stored `resumed_n`, the Agent, in one transaction: stores `resumed_n` and `revision`; clears `stop_reason`; extends its budgets (AG6); sets the `watchdog` and `attempt_timeout` timers; and writes the journal row of its next step. It then answers `ok`. Its next step is a `sync` with its current `ack`: the response gives it the state Trunk set (`going_around`, `needs_confirm` or `working`) and every heads-up it has not shown. It places them, in order and without a gap (HU6a), in one `user` message and starts a model turn, **whatever their `wake` flag**. When there is no heads-up to show (T21 into `working`), the `user` message is the resume message of `05-agent.md`. A `resume` with `resume_n <= resumed_n` is answered `ok` and changes nothing.
- **RS3 (same author, or say so).** The Agent resumes with the model and the transcript recorded for the attempt (UN6). It answers `model_unavailable` when that model is no longer in the model plan (S5), and `budget` when `MAX_ATTEMPT_TOKENS` or `MAX_ATTEMPT_USD` is already used up (AG6: these two are never extended).
- **RS4 (failure is recorded, never a silent stall).** If the Agent answers `ok: false`, or no `ok` arrived within `RESUME_ACK_TIMEOUT_MS`, Trunk stops the attempt with `reopen_failed` (transition T20r) and opens the `choice` card of UN6 (options `new_attempt` and `stop`). An attempt that was put back in flight therefore either runs or is on a card; it never sits in `going_around` with nobody working on it.
- **RS5 (scripted agents).** A scripted agent (`02-tidepool.md` section 10) implements `resume` like a real one: it calls `sync` and answers the waiting heads-ups by its pattern.

### 8.4 What the agent must do

| Heads-up result | The agent |
| --- | --- |
| `info` | Nothing. It is context. It starts no model turn (HE2). |
| `confirm` | May read and edit. Its next submit must acknowledge the heads-up with a one-sentence statement. |
| `repair` | Is in a go-around. Operations listed in `dropped_ops` are gone and must be re-applied on the new code if still wanted. It reads what it needs (each read pins the new version), edits, and submits with an acknowledgement and a statement of what it adapted or why nothing needed to change. |

No write, replace or submit is accepted until every heads-up is delivered (TA3).

---

## 9. Attempt state machine and the landing protocol

### 9.1 States

| State | Meaning |
| --- | --- |
| `opened` | Created; the agent has not called a tool yet. |
| `working` | The agent is reading and editing. |
| `going_around` | A heads-up of result `repair` is unresolved. |
| `needs_confirm` | A heads-up of result `confirm` is unresolved after a submit, or a confirm pulled the attempt out of the landing queue. |
| `submitted` | All checks passed; waiting for a Clef answer (risk or triage). |
| `validated` | In the landing queue. |
| `held` | Waiting for the owner on a card (held path, or race candidate). |
| `accepted` | In a batch that is durably recorded in the outbox; not yet confirmed on `main`. |
| `landed` | Its commit is on `main`. |
| `stopped` | Ended without landing, or undone. `stop_reason` says why. A stopped attempt with an open `choice` card that offers `retry` is **parked** (GL3a). |

Stop reasons (17). Set by Trunk only: `go_around_limit`, `contradiction`, `revert_limit`, `reopen_failed`, `declined`, `not_chosen`, `undone`, `lost` (3.6 step 8). Reported by the Agent through the `stop` call (`AgentStopReason`, TA9): `budget`, `spend_cap`, `timeout`, `model_error`, `tool_timeout`, `stalled`, `killed`, `cancelled` (owner), `withdrawn` (the agent ended its own attempt because its change is no longer wanted, TA9a).

### 9.2 Transitions

`sent_back` means `go_arounds + pull_backs` (GA3).

| # | From | Trigger | Guard | To | Effects |
| --- | --- | --- | --- | --- | --- |
| T1 | `opened` | first tool call | | `working` | |
| T2 | `working`, `going_around`, `needs_confirm` | submit, all checks pass | tier `auto`, nothing awaited | `validated` | `submit_id` and `validated_at` set |
| T3 | same | submit, all checks pass | a Clef answer is awaited | `submitted` | `submit_id` set |
| T4 | same | submit, all checks pass | tier `held`, or the attempt is a race candidate (`attempts.race = 1`; a chosen candidate no longer is one, RC7) | `held` | `submit_id` set; card opened (held) or updated (race). Built in every build (HD1). |
| T5 | same | submit answers `needs_confirm` | | `needs_confirm` | |
| T6 | same | submit answers `go_around` | | `going_around` | counted by GA1 through T8 or T10a |
| T7 | same | submit answers `rejected` | | unchanged | |
| T8 | `working`, `needs_confirm`, `submitted`, `validated`, `held` | a heads-up of result `repair` is created | `sent_back < GO_AROUND_LIMIT`, and GL3 does not apply | `going_around` | `go_arounds += 1`; `submit_id`, `validated_at`, `approved_by` cleared; an open held card is closed as `stale`; right of way checked (RW1) |
| T9 | same as T8, and `going_around` under the condition of T10a | a heads-up of result `repair` is created | `sent_back >= GO_AROUND_LIMIT` | `stopped` (`go_around_limit`) | choice card (11.1); the attempt is parked; the heads-up waits |
| T9c | same as T9 | a heads-up of result `repair` with an E1 item is created | GL3 applies | `stopped` (`contradiction`) | choice card (11.1); parked; the heads-up waits |
| T10 | `going_around` | a heads-up of result `repair` is created | an earlier unresolved `repair` heads-up is not yet delivered (HU8) | `going_around` | no increment; the heads-up joins the current go-around |
| T10a | `going_around` | a heads-up of result `repair` is created | every earlier unresolved `repair` heads-up is delivered; `sent_back < GO_AROUND_LIMIT`; GL3 does not apply | `going_around` | a new go-around: `go_arounds += 1`; right of way checked (RW1); `attempt.state` is emitted with `from = to` |
| T11 | `submitted`, `validated`, `held` | a heads-up of result `confirm` is created | `sent_back < GO_AROUND_LIMIT` | `needs_confirm` | a pull-back: `pull_backs += 1`; `submit_id`, `validated_at`, `approved_by` cleared; an open held card is closed as `stale`; right of way checked (RW1) |
| T11s | same as T11 | same | `sent_back >= GO_AROUND_LIMIT` | `stopped` (`go_around_limit`) | choice card (11.1); parked; the heads-up waits |
| T12 | `submitted` | awaited answers arrive | all premises hold | `validated` or `held` | `validated_at` set when the target is `validated` |
| T13 | `held` | owner taps Land or Land now (or chooses this race candidate) | card open; the recomputed `submit_id` equals the card's; all premises hold (none pending, triage included); no unresolved `confirm` or `repair` heads-up | `validated` | `approved_by`, `validated_at` set; Land now also sets `bypass_row` (RW5); a chosen race candidate's `race` flag is cleared (RC7). Built in every build (HD1). |
| T14 | `held` | owner taps Decline; or another race candidate is chosen | | `stopped` (`declined` / `not_chosen`) | Built in every build (HD1). |
| T15 | `validated` | batch tick includes it | 9.4 | `accepted` | |
| T16 | `accepted` | push confirmed | 9.6 | `landed` | intent → `landed` |
| T17 | `accepted` | pool rebuilt after divergence, and its change is not on the rebuilt `main` | 3.6 step 7 | `going_around` | counted as a go-around (T8 guards apply); heads-up with cause `landing`, reason `push_lost`, pushed to the Agent |
| T17a | `accepted` | pool rebuilt after divergence, and its change is on the rebuilt `main` | 3.6 step 7 | `landed` | |
| T18 | `landed` | this landing is the target of an undo | 11.3 | `stopped` (`undone`) | |
| T19 | `landed` | this landing is reverted as a dependent, or by the green line | 11.3, 11.5; `revision < MAX_REVISIONS` | `going_around` | `revision += 1`; `go_arounds += 1` (the count continues); premises and operations reloaded from the landing (UN8); budgets extended (AG6); right of way cleared; `resumes += 1` and `resume` sent to the Agent (RS1) |
| T19s | `landed` | same | `revision >= MAX_REVISIONS` | `stopped` (`revert_limit`) | choice card (11.1, GL6); the landing is still reverted; premises and operations are reloaded from the landing as in T19 (UN8), so the attempt is parked (GL3a); `revision` is not changed |
| T20 | any state except `accepted`, `landed`, `stopped` | the Agent's `stop` call (TA9): budget, spend cap, time-out, model error, tool time-out, stall, kill switch, owner cancel, withdrawn. Or Trunk finds the Agent lost (3.6 step 8). | | `stopped` (reason) | an open held card is closed as `stale`; a race card is updated |
| T20r | `going_around`, `needs_confirm`, `working` | the `resume` call of RS1 was refused, or was not answered within `RESUME_ACK_TIMEOUT_MS` (RS4) | the attempt took no step since T19 or T21 | `stopped` (`reopen_failed`) | choice card of UN6 (reason `reopen_failed`, options `new_attempt` and `stop`); the attempt is not parked: its premises and operations are deleted |
| T21 | `stopped` and parked | owner chooses `retry` on the choice card | | `going_around` when a `repair` heads-up is unresolved; else `needs_confirm` when a `confirm` heads-up is unresolved; else `working` | `go_arounds = 0`, `pull_backs = 0`, then GA1 counts the entry into `going_around` (so `go_arounds = 1`); right of way granted; budgets extended (AG6); card closed; `resumes += 1` and `resume` sent to the Agent (RS1); on a card of reason `revert_limit` also `revision += 1` (GL6) |
| T22 | `submitted`, `validated`, `held` | a `write` or `replace` is accepted (TA4) | | `working` | `submit_id`, `validated_at`, `tier`, `approved_by` cleared; an open held card is closed as `stale`; a race card is updated |

- **GA0.** For a `repair` heads-up the guards are checked in this order: T10 (join), T9c, T9, then T8 or T10a.
- **GA1.** `go_arounds` increases exactly when a go-around starts: when an attempt enters `going_around` from another state (T8, T17, T19, T21), and when a `repair` heads-up arrives in `going_around` after every earlier unresolved `repair` heads-up was delivered (T10a). Several `repair` items from one batch are one go-around. A `repair` that arrives before the previous one was delivered joins it (T10). Vector `C39`.
- **GA2.** A go-around ends when a submit acknowledges every unresolved `repair` heads-up.
- **GA3.** `pull_backs` counts T11. The go-around limit (11.1) and right of way (11.2) use `sent_back = go_arounds + pull_backs`, so an attempt that is repeatedly pulled out of the queue by confirms is protected and bounded like one that is repeatedly repaired (vector `C47`). A confirm that reaches an attempt in `working`, `going_around` or `needs_confirm`, and a blind-spot confirm, is not counted: it interrupts nothing.
- **ST1.** Every transition emits `attempt.state` (section 12). No transition happens without a recorded trigger.

### 9.3 Preconditions for landing

A change may be placed in a batch only if all of these are true at the tick: state `validated`; every premise has status `holds`; no unresolved `confirm` or `repair` heads-up (an `info` heads-up never blocks); the `submit_id` recomputed from the current operations and acknowledgements equals the stored one; for tier `held`, `approved_by` is set for that `submit_id`; the pool is `ready`; the kill switch does not block landings (13.4). T22 keeps the fourth condition true by construction; the check is the fail-closed backstop.

### 9.4 The batch tick

Trunk's `tick` timer fires every `TICK_MS` while any attempt is `validated` or any undo request is queued.

- **LP1.** If an outbox row is `pending` or `notes_pending`, the tick does nothing (the push is retried by 9.6). There is never more than one unpushed batch.
- **LP2 (order).** Queued undo and revert requests come first, in request order. Then candidates: attempts in `validated`, ordered by (has right of way first, by `right_of_way_at` ascending; then `validated_at` ascending; then `attempt_id`). At most `MAX_BATCH` landings and `MAX_PACK_BYTES` of pack per batch; the rest wait for the next tick.
- **LP2a (one transaction, no waits).** Steps 1 to 5 run inside one SQLite transaction and contain no `await` (SY2). Everything the steps decide is committed together: the batch, the skips, the failures of step 3c with their heads-ups and state changes. This holds also when the batch is empty. Step 3b is a dry run: what it computes for a candidate is committed only if that candidate is appended.
- **LP2b (budget).** If the tick has used `TICK_CPU_BUDGET_MS` before all candidates were examined, the remaining candidates wait for the next tick (`tick.skipped` is not emitted for them). Step 5 always completes.

Steps:

1. `running` = head. `batch` = empty.
2. For each undo or revert request: plan it (11.3) against `running`; append its landing; apply it to `running`.
3. For each candidate *c* in order:
   a. **Right of way.** If another attempt *P* has active right of way (11.2) and landing *c* would give *P* a `repair` or a `confirm` decided in the transaction (RW3), skip *c* (`skipped: right_of_way`), unless *c* has `bypass_row`.
   b. **Disjoint.** *c* is **disjoint from the batch** when both hold against `running`:
      - every premise of *c* whose key was changed by an earlier member of this batch classifies as `holds` by a rule (F2, L3, QT3, QR2, QO2) or is deleted by a rule (E4, F7, QR3), and row QR4 does not apply to *c* for any earlier member;
      - `replay(c.operations, running)` succeeds.

      If *c* is not disjoint, skip it (`skipped: not_disjoint`). It is classified in step 5 like every other attempt and receives its heads-up there.
   c. **Checks against `running`.** Re-run CK3, CK3a, CK4, CK5 and CK6 on the replay result. A failure skips *c* (`skipped: checks_failed`) and creates a heads-up of result `repair` with one item of rule `CKL` (T8). Then re-run CK9 with the policy as it is in `running`: if the tier is `held` and *c* has no approval for its `submit_id`, *c* goes to `held`, a held card opens, and *c* is skipped (`skipped: held`; vector `C35`).
   d. Append *c*: assign `seq = running seq + 1`; commit the judgments and pins of step b; compute its files, write set, tree and commit (9.5); apply it to `running`.
4. For every member of the batch, build its note (the batch size is now known), then the notes commit and the pack (9.5). If the batch is empty, go to step 5 with nothing to insert.
5. In the same transaction: insert `landings`, `landing_files`, `landing_writes`, `landing_premises`, `landing_ops`, `blobs`; update `files`, `entities`, `refs`, `trees`, `meta` (head moves to the last landing); set members' state to `accepted`; insert the `outbox` row (`pending`) and its pack chunks; classify every remaining classified attempt against the whole batch (HU1), using its stored sets (V6), and insert judgments and heads-ups; recompute the blast radius of every open card; insert the events.
6. After commit, in this order and none awaited by the next: hand the new events to the Floor; push (9.6); deliver heads-ups (HU5); start triage calls (7.3).

"Disjoint" is therefore not "touches different files". Two changes to different entities of one file are disjoint (vector `C02`). Two changes to one entity are not (vector `C03`). The batch is equivalent to landing its members one after another in batch order, each validated against the state its predecessors produced, with the policy of that state.

Cost. Classification in step 5 looks premises up by changed key (`premises_key`), not by attempt; listing and query premises are looked up by the directories and modules the batch touched. The sets of 6.3 are stored per attempt and recomputed only when its operations change or a landing changes a path it has operations on. Trunk sets `limits.cpu_ms` in its configuration, and the Swarm run reports tick CPU time (14.6).

### 9.5 Write set, tree, commit and note

- **Write set `W(seq)`** (stored in `landing_writes`): one `file` row per path whose blob id changed (created and deleted paths included); one `entity` row per entity whose hash changed, appeared or disappeared; one `listing` row per directory whose entry names changed. Query hashes are not stored; they are recomputed.
- **Tree**: the previous tree with the changed paths replaced, removed or added. Only directories on the path of a changed file get new tree objects; `trees` caches the rest. New files have mode `100644`; existing modes are kept. A directory that becomes empty is removed.
- **Commit**: as in 3.5. Parent is the previous landing's commit (the batch is a chain).
- **Note**: as in 3.5, built from the attempt's premises, operations, judgments, heads-ups and checks at the moment of acceptance, after the batch is complete.
- **Notes commit**: one per batch. Its tree is the previous notes tree plus one blob per landing in the batch at `<aa>/<remaining 38>`; parent is the previous notes commit (none for the first); author and committer `Premise Trunk`; message `Premise notes for batch <batch_id> (seq <first>..<last>)` followed by one newline.
- **Pack**: version 2, no deltas, containing every new blob, tree and commit of the batch and the new notes blobs, trees and commit.

All of this is pure code with no Cloudflare imports. Tests compare every object id (blob, tree, commit, note blob, notes commit) with the id real git computes for the same content, and test each pack by `git index-pack` accepting it, `git fsck --strict` passing on the result, and the unpacked objects having the expected ids. Pack bytes are not compared with git's output (zlib settings and object order may differ).

### 9.6 Outbox and push

- **LP3.** A landing is durably recorded (step 5) before any network call. The push reads only the outbox.
- **LP4 (compare-and-swap).** One receive-pack request updates `refs/heads/main` from `old_main` to `new_main` and `refs/notes/premise` from `old_notes` to `new_notes`. The server applies each command only if the ref still has the old value. If the server offers the `atomic` capability it is requested. Measured (S1; platform record, X3 and X8): Artifacts does not advertise `atomic`, and with one stale old id it refused **both** commands, in both command orders. So one request lands `main` and the notes together or not at all. Trunk does not rely on that: after any result that is not all-ok it reads both refs and decides by value (LP5), and the `retry_notes` and `retry_main` rows stay in the protocol and in the vectors, so the protocol is correct on a server that applies one command only.
- **LP5 (result, decided by ref values).** If the server reports both refs `ok`: outbox → `pushed`; `pushed_at` set on the batch's landings; members → `landed` (T16); events `batch.pushed` and one `landing.landed` per landing; `outbox_chunks` of the batch are deleted. After **any other** result (a rejection of either ref for any reason, a transport error, a time-out after `PUSH_TIMEOUT_MS`, a 5xx, a missing report) Trunk reads the current value of both refs from the remote's ref advertisement (`Pusher.readRefs`, never a binding read that may lag) and decides by value. It never interprets the server's rejection text.

  | `main` is | notes ref is | Outcome | Vector step action |
  | --- | --- | --- | --- |
  | `new_main` | `new_notes` | as "both ok" above | `mark_pushed` |
  | `new_main` | `old_notes` | members → `landed` (their commits are on `main`), `landing.landed` emitted; outbox → `notes_pending`; the next request carries the notes command only | `retry_notes` |
  | `old_main` | `old_notes` | nothing was applied; the next request carries both commands | `repush` |
  | `old_main` | `new_notes` | a non-atomic server applied the notes first; the next request carries the `main` command only; outbox stays `pending` | `retry_main` |
  | `new_main` | anything else | members → `landed`; then diverged (LP7a) | `pause` |
  | anything else | any | diverged (LP7a) | `pause` |
  | `old_main` | anything else than old or new | diverged (LP7a) | `pause` |
  | the read itself failed | | outbox unchanged; retry | none |

- **LP5a (retry).** A retry is scheduled by the `push` timer at `min(PUSH_BACKOFF_BASE_MS * 2^tries, PUSH_BACKOFF_MAX_MS)`; `tries += 1`; event `push.retry` with an error **code** (SE5b). HTTP 429 uses the server's `Retry-After` when it is longer. HTTP 401 or 403 first asks `TokenSource` for a fresh write target (S2), then retries. Retries do not stop while the refs still have old values, with one exception:
- **LP5b (poison batch).** If the same push is rejected `PUSH_REJECT_LIMIT` times while both refs still have their old values (the server refuses the pack or the commands, not the compare-and-swap), the pool is paused: `pool_state = paused`, `pause_reason = push_rejected`, event `pool.paused`. The owner's action is the one of LP8.
- **LP5c.** Every push request has an abort signal at `PUSH_TIMEOUT_MS`. The alarm handler never waits longer than that for one request.
- **LP6 (idempotency).** Every retry sends the same pack bytes. Its command list is the subset of the two commands whose ref still has its old value. Re-sending objects the server already has is harmless, and compare-and-swap makes a second successful application impossible. While `notes_pending`, no new batch is formed (LP1), and the notes ref is read before every retry, so a retry whose first response was lost ends as `pushed` (vector `C50`).

### 9.7 Reconciliation after a Trunk restart

On start-up (first request or alarm; never in the constructor), if an outbox row is `pending` or `notes_pending`:

- **LP7.** Read both remote refs and apply the table of LP5. This runs before any re-index or rebuild (RB1).
- **LP7a (diverged).** Outbox → `diverged`; `pool_state = paused`, `pause_reason = diverged`; event `pool.paused`. While paused, `write`, `replace` and `submit` fail with `pool_not_ready`, the tick does nothing, and nothing lands. Read tools still answer from head. Nothing is repaired automatically.
- **LP8.** The owner resolves a pause with reason `diverged` or `push_rejected` with "Rebuild from Artifacts" (3.6). Attempts that were `accepted` in the lost batch follow 3.6 step 7 (T17 or T17a). Other in-flight attempts re-register and are classified against the rebuilt head; heads-ups they received about the lost batch are superseded by that classification.

An attempt in `accepted` is never downgraded by a restart or a deploy alone (RB1, RB2). Vectors `C20` to `C22`, `C50`, `C51`.

### 9.8 Idempotency summary

| Operation | Key | Guarantee |
| --- | --- | --- |
| Tool call | `call_id` | Same response, no second effect (TA2). |
| Submit | `submit_id` | An unchanged resubmission does not queue a second landing (CK0). A change lands at most once per `revision`. |
| Batch acceptance | one SQLite transaction | All or nothing. |
| Push | `(old, new)` per ref | Applied at most once (LP4, LP6). |
| Heads-up delivery | `hn` | At least once, de-duplicated by the Agent, shown in order with no gap (HU5, HU6a). |
| Events | `(source, epoch, source_n)` | At least once from the source, exactly once in the stream (12.2). |
| Owner actions | `card_id` + `submit_id`, or `request_id` | A second tap on a closed card, or a repeated request id, is a no-op. |

### 9.9 What the UI may call "landed"

- **LP9.** The word "landed", the landed counter, the Why card, and the appearance of a change in the live pool depend only on the event `landing.landed`, which Trunk emits only after `refs/heads/main` was confirmed at or beyond that landing's commit (LP5 or LP7). A submit answered between acceptance and that confirmation has status `accepted`, never `landed` (CK0).
- **LP10.** Between `landing.accepted` and `landing.landed` the UI shows "landing…". The live pool is served by commit id, and the commit id the app server follows for `main` comes from `landing.landed` (SE19), so it cannot show an unpushed landing.
- **LP11.** If a push has been pending longer than `PUSH_STALL_MS`, the Floor shows "push pending" with the retry count. Counters never include accepted-but-unpushed landings.

---

## 10. Policy and held changes

### 10.1 Policy file

Path: `.premise/policy.json` in the pool repo, read from head at each submit. The example is the tide pool's file (`02-tidepool.md` section 6, which is authoritative for that pool):

```json
{
  "v": 1,
  "default": "held",
  "tiers": [
    { "paths": ["creatures/*.js"], "tier": "auto" },
    { "paths": ["world/**", "main.js", "pen.js", "index.html", "selftest/**", "GUIDE.md"], "tier": "held" }
  ],
  "globals": ["Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Map", "Set",
              "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat"],
  "limits": { "max_paths": 64, "max_change_bytes": 65536 }
}
```

`max_paths` is 64, the cap of 4.2, so that a sweep over every creature is one change while the pool has fewer than 64 kinds. (Reconciliation, finding F31: the file said 16, which undid the raise of `MAX_PATHS` to 64. `02-tidepool.md` section 6 and `seeds/tidepool/.premise/policy.json` MUST carry the same line. A pool whose policy file still says 16 is limited to 16 paths, because the policy file in the pool decides, PO4.)

- **PO1 (globs).** `*` matches within one path segment; `**` matches any number of segments. Rules are tried in order; the first rule with a matching pattern gives the path's tier; no match gives `default`.
- **PO2.** A change's tier is `held` if any touched path (written, created or deleted) is `held`; otherwise `auto`.
- **PO3 (fail closed).** A missing, unreadable or invalid policy file makes every path `held`. Unknown keys are an error. `.premise/**` is always `held`, whatever the file says.
- **PO4.** `globals` is the allow list for CK6. If absent, the list shown above applies. That list is the constant `DEFAULT_GLOBALS` of the `protocol` module (Appendix C). A part of the system that cannot read the policy file, such as the pool host inside the sandboxed frame (`.premise/` is not served, SE15), uses `DEFAULT_GLOBALS`. `limits` may only lower the limits of 4.2.
- **PO5.** A change is judged twice, by the same rules: at submit (CK9) with the policy at head, and in the tick (9.4 step 3c) with the policy of the running state, that is after every earlier member of the batch. A change that itself edits the policy is judged by the policy before the change (and is always `held`, PO3).

### 10.2 Held-change flow

1. Submit passes CK0 to CK8 and the tier is `held` (or the tick finds it `held`, 9.4 step 3c): state `held`, a card of kind `held` opens (`card.opened`).
2. The card shows: the intent text; the summary; touched paths with their tiers; premise lights; blind spots confirmed; the **blast radius** (11.6); the Clef risk answers when present; and a before/after preview (PV1).
3. The attempt's premises stay live while it waits. A `confirm` or `repair` result, or an operation of the attempt itself (T22), closes the card as `stale`; a later submit opens a new card. An approval never carries over: it is bound to the `submit_id` shown on the card, and T13 compares the recomputed id. An `info` heads-up changes nothing on the card (vector `C55`).
4. Owner taps **Land**: T13. The change lands through the same gate as every other change, in its turn. If the blast radius lists an attempt with right of way under `repair` or `confirm`, the card says so before the tap ("Landing this sends <change> around again. It will wait until that change has landed."), and the change waits behind it (RW3, vector `C48`).
5. Owner taps **Land now** (offered only in the case of step 4): T13 with `bypass_row`. The change lands in the next tick whatever right of way exists (vector `C49`).
6. Owner taps **Decline** (optional typed reason): T14.
7. A held card has no time-out. The agent sleeps and spends nothing: only a heads-up with `wake = true` starts a model turn (HE2).

`policy.approved_by`, `approved_at` and the option chosen go into the note.

- **HD1 (the held tier fails closed in every build).** Transitions T4, T13 and T14 exist in every build, whatever `features.held` says (FJ1). In a build where `features.held` is false they have their **minimal form**: a submit whose tier is `held` puts the attempt in `held` and emits `card.opened` for a card of kind `held` with `preview: null`, `risk: null`, an empty blast radius and the two options `land` and `decline`; nothing lands until the owner taps `land` (T13); `decline` stops the attempt (T14). The card still closes as `stale` by step 3. `features.held = true` adds the rest of this section: what the card shows (step 2: preview commits, blast radius, risk answers), the sentence of step 4 and the option `land_now` (step 5). So there is no build in which a change to a held path lands without the owner's tap or waits with no way to act.

**Previews.**

- **PV1.** When a held or race card opens for a `submit_id`, Trunk builds the attempt's preview tree (head plus the attempt's operations at that moment) as one parentless commit and pushes it to the pool's plain-merge repository (11.7) under `refs/previews/<submit_id>`. This happens after the transaction, off the landing path, with the pack code of 9.5. Trunk then emits `card.updated` with `preview` filled.
- **PV2.** "Before" is `{ repo: "main", commit: <the last pushed commit of main when the card opened> }`. "After" is `{ repo: "plain", commit: <the preview commit> }`. Both are immutable commit addresses served by the app server from Artifacts, so a preview needs no call to Trunk, can be cached, and plays in Replay.
- **PV3.** A preview that fails to build or push leaves `preview.after` empty and sets `preview.error` to a code; the card stays usable. A card closed as `stale` keeps its preview commit (the ref is not deleted).
- **PV4.** There is no route that serves a live attempt view. Unlanded agent code is reachable only as a preview commit of an open or past card, that is only after it passed CK0 to CK8 (parse, imports, allowed globals), and it runs under the same sandbox as landed code (SE13).
- **PV1a (reading a preview commit; fallback).** The app server reads a preview commit through the binding by commit id (S7). The platform record measured such reads for commits on branches and tags only; a commit reachable only from `refs/previews/*` was not measured. If that read fails (the "after" frame of a held card does not load), Trunk pushes previews to the branch `refs/heads/previews/<submit_id>` of the plain-merge repository instead. The constant `PREVIEW_REF_PREFIX` holds the prefix in use (`refs/previews/`, or `refs/heads/previews/`). Nothing else changes: the address is still the commit id.
- **PV5 (frame addresses and source segments).** A `FrameAddress` (10.3) names one unchanging tree. The app server (`02-tidepool.md` 4.1, 4.2) serves it under these source segments, which the `protocol` module's `frameUrl` builds:

  | `FrameAddress` | Source segment | Page address | Version token |
  | --- | --- | --- | --- |
  | `{ repo: "main", commit }` | `<40 hex>`: that commit of the pool repo | `/pool/<pool>/<40 hex>/` | `c-<40 hex>` |
  | `{ repo: "plain", commit }` | `p-<40 hex>`: that commit of the pool's plain-merge repository (a plain-merge landing or a preview commit) | `/pool/<pool>/p-<40 hex>/` | `p-<40 hex>` |

  The moving sources are `main`, `green` and `plain` (SE19). There is no source for an attempt (PV4): the segment `a_<ULID>` and the version token `a-…` do not exist.

### 10.3 Card type

```ts
type FrameAddress = { repo: "main" | "plain"; commit: string };
type BlastRadius = { repair: string[]; confirm: string[]; triage: string[];   // attempt ids
                     right_of_way: string[] };                                // those of them that hold right of way
type Card = {
  card_id: string;
  kind: "held" | "choice" | "race";
  attempt_ids: string[];                 // one for held; one or two for choice; all candidates for race
  intent_ids: string[];
  submit_ids: Record<string, string>;    // attempt_id -> submit_id the card is about
  title: string;                         // plain sentence
  body: string[];                        // plain sentences, at most two for a choice card
  options: Array<{ id: CardOption; label: string }>;
  paths: Array<{ path: string; tier: "auto" | "held" }>;
  blast_radius: Record<string, BlastRadius>;       // attempt_id -> its blast radius; empty for a choice card
  preview: { before: FrameAddress | null; after: Record<string, FrameAddress>; error: string | null } | null;
  candidates: Record<string, { state: AttemptState; can_choose: boolean; seconds: number | null;
                               cost_usd: number | null }> | null;            // race only
  risk: RiskAnswers | null;
  reason: "held_path" | "risk" | "go_around_limit" | "contradiction" | "revert_limit" | "reopen_failed" | "race";
};
type CardOption = "land" | "land_now" | "decline" | "retry" | "stop" | "keep_landed" | "new_attempt" | "choose";
type RiskAnswers = {
  model: string;
  does_what_asked: number | null;        // probabilities; null when unavailable
  changes_shared_meaning: number | null;
  unrelated_edits: number | null;
  error?: string;                        // a code (SE5b)
};
```

- **CD1.** `card.closed.action` is the `CardOption` the owner chose, or `stale` (closed by the system because its attempt changed), or `superseded` (a race card whose last candidate stopped). `card.closed.attempt_id` is the chosen candidate for `choose` and `null` otherwise. `card.closed.reason` holds only the reason the owner typed (optional, for `decline` and `choose`; at most `MAX_STATEMENT_CHARS`), or `null`.
- **CD4 (the options of each card).** `CardOption` is the only set of option ids. Trunk fills `Card.options` from this table, in this order, and the card route (13.6) accepts no other id for that card. An id that the card does not offer is refused with `invalid_args`.

  | Kind | Reason | Options, in order | What the option does |
  | --- | --- | --- | --- |
  | `held` | `held_path`, `risk` | `land`; `land_now` (only while the case of 10.2 step 4 holds: the blast radius lists an attempt with right of way under `repair` or `confirm`; and only when `features.held` is true); `decline` | T13; T13 with `bypass_row`; T14 (`declined`) |
  | `race` | `race` | `choose` (the request carries `attempt_id`, a candidate with `can_choose: true`) | T13 for that candidate, T14 (`not_chosen`) for the others (RC4) |
  | `choice` | `go_around_limit` | `retry`, `stop` | T21; the attempt stays stopped (GL2) |
  | `choice` | `contradiction` | `keep_landed`, `retry` | the attempt stays stopped; T21 (GL3) |
  | `choice` | `revert_limit` | `retry`, `stop` | T21 with `revision += 1`; the attempt stays stopped (GL6) |
  | `choice` | `reopen_failed` | `new_attempt`, `stop` | a new attempt for the same intent; the attempt stays stopped (UN6) |

  `stop` and `keep_landed` change no attempt state: the attempt is already `stopped`. They close the card, delete the attempt's premises and operations (GL3a), and set the intent to `stopped` when it has no other attempt in flight or landed.
- **CD5 (card texts).** `Card.title`, `Card.body` and `Card.options[].label` are filled by Trunk from the templates of the shared `copy` module (`03-floor.md` 5.10), which is pure and has no Cloudflare import. The Floor shows them as sent. The ids, not the labels, are what the route accepts.
- **CD2.** `card.updated` is emitted whenever a field of an open card changes: risk answers arrive, a preview arrives, a race candidate changes state, or a batch changes the blast radius (9.4 step 5).
- **CD3.** In the vectors, `cards[].blast_radius` is the blast radius of the card's first attempt, without `right_of_way`.

### 10.4 Clef risk questions

Asked once per `submit_id`, after CK8, outside the landing path. For a `held` change the card opens immediately and the answers fill in (`card.updated`). For an `auto` change, when `CLEF_RISK` is `on`, the attempt waits in `submitted` (T3) until the answers arrive or `CLEF_TIMEOUT_MS` passes.

```ts
const response = await env.AI.run(CLEF_RISK_MODEL_ID, {        // "@cf/cloudflare/clef"
  model: CLEF_RISK_MODEL,                                      // "clef"
  state: {
    intent: "make energy a fraction from 0 to 1",
    summary: "Change ENERGY_MAX from 100 to 1",
    held_paths: ["world/**", "main.js", "pen.js", "index.html", "selftest/**", "GUIDE.md"],
    files: [
      { path: "world/energy.js", tier: "held",
        entities: [{ key: "world/energy.js#ENERGY_MAX",
                     before: "export const ENERGY_MAX = 100;", after: "export const ENERGY_MAX = 1;" }] }
    ]
  },
  questions: {
    does_what_asked: {
      type: "noul",
      instructions: "Do the changes in `files` do what `intent` asks for?"
    },
    changes_shared_meaning: {
      type: "noul",
      instructions:
        "Do the changes in `files` change the meaning of existing code under `held_paths` that other code may " +
        "rely on (a value, unit, range, signature or behaviour), as opposed to only adding new things?"
    },
    unrelated_edits: {
      type: "noul",
      instructions: "Do the changes in `files` include edits that `intent` did not ask for?"
    }
  }
});
```

Answers are read from `response.answers.<id>.noul`.

- **RK1.** The answers are shown on the card as three plain lines with their probabilities, and stored in the note under `policy.risk`. They never land or decline a change by themselves.
- **RK2 (risk routing, tier `auto` only).** The change is routed to a `held` card with `reason: "risk"` when `does_what_asked < T_INTENT_MIN` or `unrelated_edits > T_UNRELATED_MAX` or `changes_shared_meaning > T_SHARED_MAX`. The three thresholds are *calibrated*.
- **RK3 (fail closed).** With `CLEF_RISK = on`, an unavailable answer routes an `auto` change to a `held` card with `risk.error` set to a code (SE5b). The request follows TR7 (a state that does not fit is unavailable) and TR9. With `CLEF_RISK = off`, no question is asked and tiers come from paths only.
- **RK4.** Whether a change touches held paths is decided by PO2, never by Clef.
- **RK5 (the held card's questions in the Worker; added 2026-10-10 by the owner's decision to build the extensions).** With `features.clef` true and `CLEF_RISK = on`, a held card in its full form (`features.held`) queues each of its submits of a real attempt (a synthetic attempt never calls Clef, as TR8 says for triage) in the transaction that opens it (`meta` key `risk_pending`, with the `risk` timer at the deadline). After the commit the Worker's `risk_dispatch` takes the queue with the `state` of each submit: the intent, the summary, the held paths of the policy, and each path of `Card.paths` with its tier and the entities whose source differs between head and the attempt's view (a path with no entities, such as a file that is not a module, is one item keyed by its path with its whole text). The answers return through `risk_answer`, which sets `Card.risk` and emits `card.updated` while the card is open and still about that submit; otherwise they are discarded. A question past `CLEF_TIMEOUT_MS`, or one an earlier instance of the object sent, fills `Card.risk` with every answer null and `error: "timeout"` (RK3). RK2's routing of `auto` changes is not built in this stage: with `CLEF_RISK = on`, tiers still come from paths only.

---

## 11. Limits on go-arounds, Undo, Race, green line

### 11.1 Go-around limit and choice cards

- **GL1.** `GO_AROUND_LIMIT` is 3. When a go-around or a pull-back would start for an attempt whose `sent_back` (GA3) is already 3, the attempt stops with `go_around_limit` (T9, T11s) and a card of kind `choice`, reason `go_around_limit`, opens.
- **GL2.** The card body is at most two plain sentences, for example: "The crab change was sent back 3 times because energy kept changing. Try once more with right of way, or stop?" Options: `retry` ("Try again", T21) and `stop`.
- **GL3 (contradiction).** When rule E1 gives `repair` for entity *K* to an attempt that already received an E1 `repair` for the same *K* earlier (found in `judgments`), and the landing that caused the newer one belongs to **an intent other than the attempt's own**, the attempt stops with `contradiction` instead of going around, and a `choice` card with reason `contradiction` opens. A landing of the attempt's own intent (a Race sibling) is an ordinary go-around (vector `C54`). Body: "<requester A> asked: '<intent A>'. <requester B> asked: '<intent B>'. Both change <entity name>." Options: `keep_landed` (the attempt stays stopped), `retry` (T21: the attempt adapts on top of what landed). The card's `attempt_ids` are the stopped attempt followed by the attempt whose landing caused the stop.
- **GL3a (parked attempts stay classified).** When an attempt stops by GL1, GL3 or T19s, the heads-up that caused the stop is still created (so operations are dropped by OP6 and premises pinned as usual). While its choice card is open the attempt is **parked**: it keeps its premises and operations, it is classified at every batch like an in-flight attempt (7.1), and the resulting heads-ups are created with `wake = false` and wait. No counter changes while it is parked. When the card closes with any option other than `retry`, the attempt's premises and operations are deleted from Trunk.
- **GL4 (optional, with Clef).** When `CLEF_CONTRADICTION` is `on`, the first E1 `repair` between different intents asks Clef one `noul` question ("Can both `intent_a` and `intent_b` be satisfied by one version of `entity`?", state: the two intent texts and the entity before and after). `p < 1 - T_CONTRADICT` opens the same card at once. Unavailable means no card (the go-around proceeds).
- **GL5.** "Try again" (T21) resumes the same agent with the same model and transcript (rule UN6). Because of GL3a its premises equal head and every change it missed is waiting as a heads-up: it enters `going_around` and cannot land until its submit has acknowledged each of them (CK8). Vector `C32`. Trunk starts the stopped Agent with `resume` (RS1, RS2); if the Agent cannot resume, the attempt stops with `reopen_failed` and the card of UN6 opens (RS4).
- **GL6 (revert limit).** The `choice` card of reason `revert_limit` (T19s) offers `retry` ("Try again", T21) and `stop`. At T19s the landing is reverted, and the attempt's frozen premises and landed operations are reloaded as for T19 (UN8); the heads-up of the revert is created with `wake = false`. The attempt is therefore parked (GL3a), and `retry` resumes it on current facts like any other parked attempt. `retry` on this card also adds 1 to `revision`, because a change lands at most once per revision (9.8). The limit stays in force: `revision` is then at or above `MAX_REVISIONS`, so the next revert of that attempt opens this card again (T19s). Past the limit, every further reopen therefore costs one owner tap. `stop` leaves the landing reverted and the attempt stopped.

### 11.2 Right of way (starvation rule)

- **RW1.** When a go-around or a pull-back starts (T8, T10a, T11) and `sent_back` becomes `STARVATION_AFTER` (2), the attempt is granted right of way: `right_of_way_at = now`. T21 grants it directly. It keeps it until it lands, stops, is reopened (T19), or `RIGHT_OF_WAY_MS` passes (`right_of_way` timer).
- **RW2.** In the tick, an attempt with right of way is ordered before all others (LP2).
- **RW3.** In the tick, a candidate *c* without an earlier right of way is skipped while landing it would give an attempt *P* with active right of way a `repair` or a `confirm` that is decided inside the transaction: any rule row with that result (E1, E2, E2m, F1, F3, F3m, F5, L1, L2, QT1, QR1, QR1m, QO1, Z1), a dropped operation (OP1 to OP5), or a triage row when triage is known to be unavailable (TR5). It is computed by classifying *c*'s write set, and *c*'s frozen premises for row QR4, against *P*. A triage row whose answer is awaited never causes a skip. An attempt already placed in the current batch no longer counts as holding right of way.
- **RW4.** Between two attempts that both have right of way, the earlier `right_of_way_at` wins.
- **RW5.** A skipped candidate stays `validated` and is counted in the metric "changes waiting behind another change" (14.6). An owner-approved held landing is a candidate like any other and is skipped by RW3 (vector `C48`). Three things are not skipped: undo landings; revert landings; and a held change the owner approved with **Land now** (`bypass_row`, vector `C49`).

This is a bounded yield, not a lock: nothing is declared or reserved by an agent, it starts only after two observed interruptions, and it ends by itself.

### 11.3 Causal Undo

The owner taps Undo on landing *u*. *u* MUST be of kind `change`, not already undone, and within the last `UNDO_WINDOW` landings. An undo or revert landing cannot be undone; an undone change comes back by asking for the intent again.

**Which landings are reverted.** The set *R* is the smallest set such that:

- **UN1.** *u* ∈ *R*.
- **UN2 (dependents).** A later landing *L* (not undone) is in *R* when it has a frozen premise *p* with `p.pin_seq >=` seq(*X*) for some *X* ∈ *R* with seq(*X*) < seq(*L*), `p.kind` ∈ {`entity`, `file`}, (`p.kind`, `p.key`) ∈ *W(X)*, and (`p.edit = 1` or `p.derived = 1`). In words: *L* edited or referenced something *X* wrote (directly or through its module, 6.3), at *X*'s version or a later one.
- **UN3 (replay failures).** Let *P* be the paths touched by landings in *R*. For each path, start from its content just before the earliest landing in *R* that touched it (from `blobs`, by the `old_oid` in `landing_files`), and replay, in `seq` order, the operations on that path of every later landing **not** in *R* (rules of 5.3, with OP5 not applied). If an operation no longer applies, its landing joins *R* and the computation restarts.

Landings that only **read** something *R* wrote (`read = 1`, `edit = 0`, `derived = 0`) are not reverted. They are listed on the confirmation and in the note as `kept_readers`.

Planning is pure and synchronous: it reads only Trunk's SQLite. The `blobs` table (3.2) keeps the content of every blob replaced by a landing that is within `UNDO_WINDOW` or newer than the green line, and is refilled from Artifacts by a rebuild.

**The undo landing.**

- **UN4 (plan first).** Before confirming, the owner's Floor reads the plan (`GET /api/pools/{pool}/undo-plan?seq=`, owner route, answered by Trunk): the landings in *R*, the attempts that reopen, the kept readers, and the in-flight attempts that would receive `repair`. A landing that neither depends on *R* nor read anything *R* wrote is in none of these lists.

  ```ts
  type UndoRefusal = "not_a_change" | "already_undone" | "too_old" | "too_many" | "plan_changed";
  type UndoPlan = { target_seq: number;
                    reverted: number[];        // R, ascending seq
                    reopened: string[];        // attempt ids (T19, T19s)
                    kept_readers: number[];    // seqs of landings that only read what R wrote
                    repairs: string[] };       // in-flight attempt ids that would receive `repair`
  type UndoPlanResponse = { ok: true; plan: UndoPlan } | { ok: false; reason: UndoRefusal };
  type UndoResponse     = { ok: true; request_id: string }
                        | { ok: false; reason: UndoRefusal; plan?: UndoPlan };   // `plan` is the new plan when reason is "plan_changed"
  ```
- **UN5 (confirm against the plan).** The confirm request carries `expect_reverted`, the *R* the owner saw. Trunk computes the plan again. If *R* differs, the request is refused with `plan_changed` and the new plan is returned; nothing is queued (vector `C53`). Otherwise the request is queued with its *R* and lands in the next tick as the first batch member (LP2). No landing can be accepted between the queueing and that tick, so the plan cannot drift after the check.
- **UN5a.** The undo landing is one commit of kind `undo` that sets each path in *P* to the content computed in UN3 (or removes it). Trailers: `Change-Id` (a new id), `Intent-Id` (the intent of *u*), `Undoes:` for each landing in *R*. Note `kind: "undo"` with `undo.undoes`, `undo.reopened`, `undo.kept_readers`. Each landing in *R* gets `undone_by`.
- It is an ordinary landing: classified attempts are classified against its write set and receive heads-ups with `cause.type = "undo"`.
- **Refusals.** A request that cannot be planned is refused with one of these reasons and nothing changes: `not_a_change`, `already_undone`, `too_old` (outside `UNDO_WINDOW`), `too_many` (*R* exceeds `MAX_BATCH`), `plan_changed`. A request of cause `revert` (11.5) is never refused for `too_old` or `too_many`.

**Which attempts reopen.**

- The attempt of *u*: `stopped` (`undone`) (T18). Its intent → `undone`.
- The attempt of every other landing in *R*: reopened (T19, or T19s at the revision limit). Its frozen premises and landed operations become in-flight again. It receives one heads-up of result `repair` with `cause.type = "undo"`. The items are the premises that made it a dependent (UN2) and whose hash changed, each with the reversed diff and a rule chosen from the frozen flags: `E1` for an entity premise with `edit = 1`, `E2` for an entity premise with `derived = 1` and `edit = 0`, `F1` for a file premise with `edit = 1`. All its premises are then pinned at the new head. Trunk starts its Agent again with `resume` (RS1); the agent resumes with its transcript and lands again through the normal path. Vector `C19`. A reopened attempt that was a chosen race candidate is an ordinary attempt (RC7, vector `C58`).
- **UN6 (same author).** A reopened attempt runs with the model and transcript recorded for it. If that model is unavailable or the Agent Durable Object cannot resume (RS3, RS4), the attempt stops with `reopen_failed` (T20r) and a `choice` card (reason `reopen_failed`, options `new_attempt` and `stop`) offers a new attempt. If a different model takes over, `attempt.reopened` carries `model_changed: true` and the UI MUST say so.
- **UN6a (`new_attempt`).** The option `new_attempt` opens a new attempt for the same intent, exactly as creating the intent did: a new `attempt_id` and `change_id`, a real agent on the workhorse model of the model plan, `attempt.opened` emitted, the intent back to `open`. It starts from the intent text, not from the old transcript. The old attempt stays `stopped` (`reopen_failed`). It is not T21: `retry` resumes the same agent, `new_attempt` does not.
- **UN8 (operations of a reopened attempt).** The reloaded operations keep their `op_seq`. Each `write` gets as `base_oid` the blob id of its path at the head after the undo landing (or `absent`). `shown` is empty for every reloaded premise.

### 11.4 Race and choose

- **RC1.** The owner taps Race on an intent. Trunk opens `RACE_SIZE` attempts for the same intent with different models (from the model plan, S5), each flagged as a race candidate (`attempts.race = 1`), and opens the intent's one card of kind `race` (`card.opened`, every candidate with `can_choose: false`).
- **RC2.** A candidate runs like any attempt. When its submit passes, it goes to `held` (T4) on the intent's single card of kind `race`, whatever its path tier. Its premises stay live while it waits.
- **RC3.** The card shows each candidate side by side: its preview (PV1), premise lights, checks, seconds taken, model cost and its own blast radius (`Card.candidates`, `Card.blast_radius`). A candidate's blast radius leaves out the other candidates of its race: choosing it stops them (RC4), so none of them receives a heads-up from it. (Amended 2026-10-06, found live: three candidates of the crab each showed "Would send back: 2 changes", which were their own siblings.)
- **RC4.** The owner chooses one (`choose`): T13 for it (it lands through the same gate; if its tier is `held` this tap is also the approval), T14 `not_chosen` for the others. The card closes with `card.closed { action: "choose", attempt_id: <the chosen candidate>, reason: <the optional typed reason> }` (CD1). Attempt repos of candidates not chosen are kept.
- **RC5.** The race card stays open while at least one candidate can still be chosen. A candidate that leaves `held` (a go-around, a pull-back, its own operation, a stop) is shown with its state and `can_choose: false`; the card is updated, not closed. When it submits again and passes, it can be chosen again. When no candidate is in flight any more, the card closes as `superseded`.
- **RC6 (optional interface).** `fork_from: { attempt_id, step }` on attempt creation starts a candidate from another attempt's transcript and premises up to that step (after it has read, before it writes). Not required for the submission build.
- **RC7 (a chosen candidate is an ordinary attempt).** When a candidate is chosen (T13 by `choose`), its `race` flag is cleared in the same transaction. From then on its submits follow its path tier only (T2, T3 or T4 by tier). This matters whenever the chosen attempt submits again: after a go-around or a pull-back before it landed, after its own operation (T22), and after it was reopened by an undo or a revert (T19). A passing submit of tier `auto` then goes to `validated` with no card; one of tier `held` opens a card of kind `held`. It never returns to the race card, which is closed. `attempt.opened.race` records how the attempt started and does not change. Vector `C58`.

### 11.5 Green line protocol (interface only)

```ts
interface Verifier {
  verify(input: { pool_id: string; seq: number; commit: string }): Promise<VerifyResult>;
}
type VerifyResult = {
  seq: number;
  commit: string;
  ok: boolean;
  runtime: "browser" | "isolate" | "container" | "static";
  checks: Array<{ name: string; ok: boolean; code?: string }>;   // names and codes from the fixed list of GR8; `code` only when ok is false
  duration_ms: number;
  log: string;                  // at most GREEN_LOG_MAX_CHARS; shown to the owner only (GR7)
};
```

- **GR1 (one at a time).** At most one verification is in flight. It starts after `batch.pushed` when none is in flight, and verifies the head commit at that moment (`seq` *s*). When it ends and the head has moved, the next one starts for the then-current head, not earlier than `GREEN_MIN_INTERVAL_MS` after the previous start. It never blocks a landing. Under continuous landings the green line therefore advances once per verification time, and never starves.
- **GR2 (pass).** Trunk (the only token holder) moves `refs/heads/green` from its old value to the verified commit by compare-and-swap and emits `green.advanced`.
- **GR3 (fail, confirmed).** A failed result is run once more on the same commit. `green.verified` is emitted for every run. Its field `confirmed` is `true` for a pass, and for a fail only when it is the second failed run on the same commit. A first failed run (`ok: false`, `confirmed: false`) changes nothing else: no revert is queued, and nothing on screen may say that a change is being taken back; the Floor may only say that the check is being run again. Only if the second run also fails does Trunk queue a request of cause `revert` for every landing in `(green_seq, s]`. It is planned like an undo (11.3) with *R* starting from that whole range (later landings join only through UN2 and UN3), lands as one commit of kind `revert` in the next tick, and reopens the attempt of every landing in *R* (T19, T19s) with a heads-up of `cause.type = "revert"` whose items carry the failing check names and codes. No bisect: every attempt in the range is reopened, and an attempt that had nothing to change acknowledges and lands again.
- **GR3a (bounded).** `revision` counts reopens and is never reset. At `MAX_REVISIONS` an attempt is not reopened again by itself; it stops with `revert_limit` and a choice card (T19s) on which the owner may tap `retry` or `stop` (GL6). The range of a revert is fixed when it is queued and lands within one tick of a free outbox, so it does not grow while it waits. `blobs` keeps everything newer than the green line, so the revert can always be planned.
- **GR4.** A result for a commit that is no longer in `main`'s first-parent history, or older than `green_seq`, is discarded.
- **GR5.** The runtime is decided (S4): a Dynamic Worker isolate (`runtime: "isolate"`), which runs the pool's headless self-test (`02-tidepool.md` section 5). There is no container and no Browser Run in the build. The fallback is runtime `static`, whose checks are: every module parses, every import resolves, and policy invariants hold; the Floor then labels the green line "static checks only". `features.green` (FJ1) says which of the two the build has, or that it has none.
- **GR6 (isolation, every runtime).** The verifier runs agent-written pool code. It MUST run it with no bindings, no secrets and no credentials in its environment, with no outbound network, and with a wall-time limit (`GREEN_TIMEOUT_MS`): a Dynamic Worker is loaded through the Worker Loader binding with an empty environment, `globalOutbound: null` and a CPU limit (`limits: { cpuMs: GREEN_CPU_MS }`); a container fetches the files through the public app server and has egress disabled; a browser loads the app-server page, which carries the sandbox policy of SE14. A verifier never receives a repository token. At most four Dynamic Workers may be in flight per Worker request (platform record), so the checks of one verification run in sequence, and GR1 keeps one verification in flight.
- **GR7 (the log is not model input).** `VerifyResult.log` is never placed in a heads-up, an event or a model context. Heads-ups carry check names and fixed codes only. The log is stored with the result and shown to the owner as escaped text, after `redact()` (SE5a).
- **GR8 (the fixed list of check names and codes).** `VerifyResult.checks`, the event `green.verified` and the `check` items of a revert heads-up carry only these names and codes. A check with `ok: true` has no `code`. Free text of a check (which may hold kind names and sentences written by agents) goes only into `log`.

  | Check name | Runtime | Code when `ok` is false |
  | --- | --- | --- |
  | `selftest_ran` | `isolate` (also `browser`, `container`) | `no_verdict` (no verdict within the time or CPU limit), `bad_verdict` (the verdict is not valid JSON of the verdict type), `harness_error` (the modules did not load or the harness threw) |
  | `files`, `no_errors`, `in_bounds`, `energy_range`, `population`, `not_exhausted`, `state_is_data`, `pen_rules`, `visible`, `within_reach`, `draw_is_pure`, `deterministic` (the twelve invariants of `02-tidepool.md` 5.2, in that order) | `isolate` (also `browser`, `container`) | the check name followed by `:failed`, for example `not_exhausted:failed` |
  | `parse`, `imports_resolve`, `policy_invariants` | `static` | the check name followed by `:failed` |

  A result of the self-test is mapped as: `selftest_ran` first, then the twelve checks in order, each `{ name, ok }` or `{ name, ok: false, code }`. The verdict's `detail`, `failed` and `rest_share` are cut to `GREEN_LOG_MAX_CHARS` and go into `log` only. When `selftest_ran` fails it is the only check.

### 11.6 Who relies, and blast radius

- **Who relies** on entity *K*: in-flight attempts with a premise `entity:K` or `file:<path of K>`, each with its flags; and landed, not undone changes with such a frozen premise. The public page computes it from the Floor's reducer state (FS2), which holds the same premises through `premise.recorded`, `premise.removed` and `landing.accepted`. In a `summary_only` pool those per-premise events are not emitted (EV6), so Who relies shows landed changes only there.
- **Blast radius** of a change (shown on held, race and undo confirmations): the in-flight attempts that would receive `repair`, `confirm` or triage if it landed now, computed by classifying its write set (and, for row QR4, its premises) against each of them, with rule rows deciding `repair` and `confirm` and triage rows listed as `triage`; and which of them hold right of way. It is computed when the card opens, again at every batch while the card is open (CD2), and again when the owner taps.

### 11.7 The "same changes, merged by plain git" pool

Neutral label, shown as constructed. It lives in a second Artifacts repository per pool, the **plain-merge repository**, branch `main` (served by the app server as repo `plain`). Trunk builds it after each `batch.pushed`, off the landing path (`plain` timer), with the pack code of 9.5. A `summary_only` pool (EV6, a Swarm pool, whose Floor shows no Compare view) and a pool imported from a repository (`06-repos.md` IR7) have none: Trunk never builds one for them (added 2026-10-05: in a busy Swarm pool, replaying every landing after each push held the Trunk Durable Object back from its own pushes).

- **PM1 (what is replayed).** Start from the seed. For each landing of kind `change` in `seq` order, replay the operations the attempt held **before its first heads-up of result `confirm` or `repair`** (`ops_first`; if it never had one, its landed operations), with no premise check.
- **PM2 (`ops_first`).** Written once per attempt and revision, when its first heads-up of result `confirm` or `repair` is created, with the operations it held at that moment (before any OP6 drop), and with `submitted = 1` if the attempt had passed a submit (reached `submitted`, `validated` or `held`) before that moment.
- **PM3 (what counts as a text conflict).** Replay uses 5.3 without OP3. A `replace` that fails OP1, OP2 or OP4, and a `write` whose base changed (OP5: the path was created or changed by an earlier replayed change), is a **text conflict**: the change is skipped and counted. This is an approximation in plain git's favour: a real three-way merge reports a conflict when both sides add the same path or change the same lines, and may merge a whole-file rewrite cleanly where this rule skips it. The Floor says "approximated" next to the count.
- **PM4 (interrupted).** A landing replayed from an `ops_first` with `submitted = 0` is marked **interrupted**: its agent was sent back in the middle of its work, so the plain-merge pool shows unfinished work for it. The Floor labels it.
- **PM5.** Undo and revert landings are applied as reverts of the same changes.
- **PM6.** After each push of the plain-merge repository Trunk emits `plain.updated { commit, tree, through_seq, skipped, interrupted }`: the plain-merge commit and its tree id, the last landing replayed, the `seq`s counted as text conflicts (PM3) and the `seq`s marked interrupted (PM4), both cumulative. A failed push is retried; it never affects a landing. A live frame on the source `plain` is told to look for the new version when this event arrives (SE16a).
- **PM7 (when the two pools are the same).** The plain-merge pool and the real pool hold the same files exactly when `plain.updated.tree` equals `landing.landed.tree` of the landing `through_seq`. The Floor may say "no visible difference in this run" only on that fact, never on a guess from what the frames draw.

The same repository holds the preview commits of PV1 under `refs/previews/`.

---

## 12. The event stream

### 12.1 Envelope and types

```ts
type EventBase = {
  n: number;            // position in the pool's stream: 1, 2, 3, ... no gaps
  t: number;            // ms since epoch: arrival at the Floor (assigned on append)
  ts: number;           // ms since epoch: the source's clock when the state change committed
  pool: string;
  src: "trunk" | "agent" | "gate" | "swarm" | "floor";   // who emitted it (EV2a)
  type: string;
};

type ErrCode = string;  // SE5b: a code from a fixed list, for example "transport", "timeout", "http_503", "rejected", "rate_limited"

type PoolEvent = EventBase & (
  | { type: "pool.state"; head_seq: number; head_commit: string; green_seq: number;
      landed_seq: number; landed_commit: string;            // the last landing confirmed on main
      state: "ready" | "rebuilding" | "paused"; reason: string | null;
      epoch: number; remote: string;                         // the pool repo's address, without credentials
      plain_remote: string | null;
      rebuild: { done: number; total: number } | null; unwitnessed: number[];
      real_agents: number; max_real_agents: number;
      synthetic: boolean;                                    // a synthetic attempt was opened in this pool (EM1a): the SYNTHETIC banner
      summary_only: boolean }                                // the pool's flag, fixed at creation (PL1, EV6)
  | { type: "pool.files"; files: Array<{ path: string; tier: "auto" | "held" }> }
  | { type: "pool.paused"; reason: "diverged" | "push_rejected" | "note_seq_mismatch" | "owner"; detail: ErrCode }
  | { type: "trunk.error"; where: string; code: ErrCode }
  | { type: "intent.created"; intent_id: string; text: string; requester: string; race: boolean; prewritten: boolean }
  | { type: "intent.state"; intent_id: string; state: "open" | "landed" | "stopped" | "undone" }
  | { type: "attempt.opened"; attempt_id: string; intent_id: string; change_id: string;
      agent: "real" | "synthetic"; model: string | null; race: boolean }
  | { type: "attempt.state"; attempt_id: string; from: AttemptState; to: AttemptState;
      transition: string; reason: string | null; go_arounds: number; pull_backs: number; right_of_way: boolean }
  | { type: "attempt.reopened"; attempt_id: string; cause: "undo" | "revert" | "retry";
      revision: number; model_changed: boolean }
  | { type: "attempt.step"; attempt_id: string; step: number; tool: string | null;   // null = model turn
      target: string | null; ok: boolean; error: ErrCode | null; ms: number;
      tokens_in: number | null; tokens_out: number | null; cost_usd: number | null }   // model turns only
  | { type: "attempt.repo"; attempt_id: string; ok: boolean; ms: number; error: ErrCode | null }
  | { type: "premise.recorded"; attempt_id: string; premise: PremiseRef; tool: string }
  | { type: "premise.removed"; attempt_id: string; kind: PremiseKind; key: string; rule: string }
  | { type: "premise.judged"; attempt_id: string; kind: PremiseKind; key: string;
      old_hash: string; new_hash: string; cause: string; cause_seq: number | null;
      rule: string; class: "rule" | "triage"; result: "holds" | "confirm" | "repair" | null;
      reason: string; clef: { model: string; p: number | null; error: ErrCode | null } | null }
  | { type: "op.recorded"; attempt_id: string; op_seq: number; op: "write" | "replace";
      path: string; targets: string[]; altered: string[]; added: string[]; removed: string[] }
  | { type: "op.dropped"; attempt_id: string; op_seqs: number[]; path: string; rule: string }
  | { type: "headsup.sent"; attempt_id: string; hn: number; result: "info" | "confirm" | "repair";
      wake: boolean; cause: HeadsUp["cause"];
      keys: Array<{ kind: PremiseKind | "check"; key: string; rule: string;
                    cause_seq?: number | null }>;             // the item's cause_seq (8.2), also when items is null; always sent, absent only in streams recorded before 2026-10-07
      items: HeadsUpItem[] | null;                           // the items as sent (8.2); null in a summary_only pool (EV6)
      dropped_ops: HeadsUp["dropped_ops"]; go_around: number | null }
  | { type: "headsup.resolved"; attempt_id: string; hn: number; result: "confirm" | "repair";
      go_around: number | null;                              // as in the heads-up
      changed: boolean;                                      // HU12: the attempt's operations differ from when it was sent back
      statement: string }
  | { type: "submit.result"; attempt_id: string; submit_id: string | null; status: SubmitResult["status"];
      tier: "auto" | "held" | null; checks: Check[]; duplicate: boolean }
  | { type: "card.opened"; card: Card }
  | { type: "card.updated"; card: Card }
  | { type: "card.closed"; card_id: string; action: CardOption | "stale" | "superseded"; by: "owner" | "system";
      attempt_id: string | null;                             // the chosen candidate when action is "choose" (CD1)
      reason: string | null }                                // only the reason the owner typed
  | { type: "landing.accepted"; seq: number; batch_id: number; kind: "change" | "undo" | "revert";
      attempt_id: string | null; change_id: string; intent_id: string | null; request_id: string | null;
      paths: string[]; writes: Note["writes"] }
  | { type: "landing.landed"; seq: number; batch_id: number; commit: string; tree: string;
      note: string;                                          // the note's git blob id
      note_json: string | null;                              // the note itself (3.5); null in a summary_only pool (EV6)
      time_to_land_ms: number | null }
  | { type: "batch.pushed"; batch_id: number; first_seq: number; last_seq: number;
      main: string; notes: string; tries: number; ms: number }
  | { type: "push.retry"; batch_id: number; tries: number; error: ErrCode; next_try_ms: number }
  | { type: "tick.skipped"; attempt_id: string; why: "not_disjoint" | "right_of_way" | "checks_failed" | "held"; behind: string | null }
  | { type: "undo.planned"; request_id: string; cause: "undo" | "revert"; target_seq: number;
      reverted: number[]; reopened: string[]; kept_readers: number[] }
  | { type: "undo.refused"; request_id: string; target_seq: number;
      reason: "not_a_change" | "already_undone" | "too_old" | "too_many" | "plan_changed" }
  | { type: "plain.updated"; commit: string; tree: string; through_seq: number; skipped: number[]; interrupted: number[] }   // PM6, PM7
  | { type: "green.verified"; seq: number; commit: string; ok: boolean; runtime: VerifyResult["runtime"];
      checks: VerifyResult["checks"]; ms: number;
      confirmed: boolean }                                   // GR3: true for a pass, and for the second failed run on one commit
  | { type: "green.advanced"; seq: number; commit: string }
  | { type: "metrics"; window_ms: number; landings_per_second: number;
      time_to_land_ms: { p50: number | null; p99: number | null };
      time_held_ms: { p50: number | null; p99: number | null };
      go_around_rate: number | null; false_abort_rate: number | null; escape_rate: number | null;
      waiting_behind: number; push_backlog: number; tick_cpu_ms: { p50: number | null; p99: number | null } }
  | { type: "limits"; spend_usd: number; reserved_usd: number; cap_usd: number; killed: boolean; refusing: boolean;
      models: Array<{ model: string; per_minute: number; used_last_minute: number }> }
  | { type: "swarm.state"; synthetic: true; running: boolean; agents: number; collision_dial: number; pools: string[] }
);
```

No event carries a token, a secret, a full transcript, a verifier log, or free text taken from a transport, a runtime or a server (SE5b). The texts that events do carry are pool code, intent text, summaries and statements, which are public by design and escaped by the UI (SE18).

When events are emitted:

- **EM1.** `pool.state` is event 1 of every stream (`head_seq = 0` at pool creation) and is emitted again whenever one of its fields changes. `pool.files` follows it and is emitted again after every landing that adds or removes a path or changes the policy. `real_agents` counts the pool's attempts with agent `real` in `working`, `going_around` or `needs_confirm`, the states in which the Agent's loop runs (`05-agent.md` MG5, 4.5); it changes in the transaction of each transition that changes it. (Amended 2026-10-06: it was never set after pool creation, and the strip read 0 while three real agents worked.)
- **EM1a (`synthetic` and `summary_only`).** `pool.state.summary_only` is the flag given at pool creation (PL1) and never changes. `pool.state.synthetic` is false at creation and becomes true, for good, when the first attempt with `agent: "synthetic"` is opened in the pool (`pool.state` is emitted again, before that attempt's `attempt.opened`). The two are independent: a canned cast on a pool that is not `summary_only` gives a synthetic pool whose stream holds every event.
- **EM2.** `premise.recorded` is emitted for every entry of `ToolResponse.premises` (TA7): a new premise, a re-pin by a read, or a flag that was set. `premise.removed` is emitted whenever a premise is deleted (rows E4, F7, QR3; rules D2, D4, R5).
- **EM3.** `premise.judged` follows JE1: at creation, and again when a pending triage is closed.
- **EM4.** `landing.accepted` for kind `undo` or `revert` carries the `request_id` of its `undo.planned`.
- **EM5.** `metrics` is appended by the Floor Durable Object (src `floor`) every `METRICS_EVERY_MS`, computed by the shared reducer over the stream (section 14). It is the authoritative value for 14.1 to 14.6 and for "time held"; clients display it and do not recompute it. 14.7 and 14.8 are computed by the reducer from `headsup.sent`, `submit.result` and `attempt.repo`.
- **EM6.** `limits` is emitted by the model gate and `swarm.state` by the Swarm launcher. Each reaches the stream of every pool (EV2a), so a page that shows two pools may use the newest `limits` event of either stream.
- **EV6 (`summary_only` pools).** In a pool created with `summary_only: true` (PL1), for every attempt of that pool, real or synthetic, these events are not emitted: `attempt.step`, `premise.recorded`, `premise.removed`, `op.recorded`, and `premise.judged` whose result is `holds` with no heads-up. `headsup.sent` has `items: null`, `landing.landed` has `note_json: null`, and the note route answers 404 (13.6). Everything else is emitted. This bounds the stream and the recording of a Swarm run; the note of every landing, in Artifacts, still holds the full record. In a pool that is not `summary_only`, every event is emitted for every attempt, also for a synthetic one: a canned cast there shows its premise lights, its operations, its heads-up diff and its Why card, under the SYNTHETIC banner (EM1a). Nothing in this file suppresses an event or a note field because an attempt is synthetic.

### 12.2 Ordering guarantees

- **EV1.** The Floor Durable Object assigns `n` and `t` on append. `n` is contiguous and total per pool.
- **EV2 (sources).** Trunk writes its events to `events_out` in the same transaction as the state change they describe, with `ts`, and sends them to the Floor in order with `(source, epoch, source_n)`. The Floor ignores a `source_n` it already has for that epoch, rejects a gap (the source re-sends from the Floor's `last_n + 1`), and treats a higher `epoch` as a new sequence starting at 1 (RB5). So each source's events appear exactly once, in the source's order. Trunk deletes an `events_out` row when the Floor has confirmed it. A confirmation counts only for the epoch it was sent under: an answer that arrives after a rebuild started a new epoch changes nothing. The Floor stores a request's events all or none: it checks the whole list before storing any event, and stores the events with the source's new `last_n` in one transaction. (Amended 2026-10-07, found on the live soak: an epoch-1 answer that arrived after a rebuild deleted the new epoch's row 1, and the Floor refused every later delivery. One narrow recovery is built for a pool already in that state: when the epoch is above 1, the Floor expects row 1, and Trunk still holds every row from 2 on, Trunk writes row 1 again as the current `pool.state`. Any other missing prefix is not recovered.)
- **EV2a (every source, and the two that serve all pools).** Five kinds of source exist. Each one except the Floor keeps its own outbox and its own `(epoch, source_n)` counter **per pool**, and follows EV2 for that pool: events in order, a re-send from the Floor's `last_n + 1` after a gap, a row deleted only when the Floor confirmed it.

  | `EventBase.src` | Source id at the Floor (`sources.source`) | Emitter | Events | Sent to |
  | --- | --- | --- | --- | --- |
  | `trunk` | `trunk` | the pool's Trunk | every type not named below | its pool |
  | `agent` | `agent:<attempt_id>` | the attempt's Agent Durable Object | `attempt.step`, `attempt.repo` (what only the Agent knows: model turns, tokens, cost, its repo) | its pool |
  | `gate` | `gate` | the model gate (one per deployment) | `limits` | every registered pool |
  | `swarm` | `swarm` | the Swarm launcher | `swarm.state` | every registered pool |
  | `floor` | none | the pool's Floor Durable Object | `metrics` | its own stream; appended directly, so no de-duplication is needed |

  A pool is **registered** with the model gate and with the Swarm launcher when it is created (PL1), in the request that creates it. The gate and the launcher send each of their events to every registered pool, with that pool's counter. A pool's first `limits` event is sent at registration, so a new stream never lacks one. Two emitters never share a source id, so "ignores a `source_n` it already has" stays true. The Swarm launcher is a Workflow with no storage of its own: its counter for a pool is the Floor's `sources` row, which it reads with the Floor's internal `swarm-source` read (the row and the newest `swarm.state` the Floor appended), before it sends `last_n + 1`; its outbox row is the emit's Workflow step, retried until the Floor confirms. A `swarm.state` that the stream already carries, or one older than the newest, is confirmed without a new append (added 2026-10-05).
- **EV3 (causal order within Trunk).** For one batch: all `landing.accepted`, then `tick.skipped`, `premise.judged`, `premise.removed`, `op.dropped`, `headsup.sent`, `attempt.state`, `card.*` caused by it. `batch.pushed` and `landing.landed` come later and always after the matching `landing.accepted`. Trunk hands the batch's events to the Floor before it starts the push (9.4 step 6), so "landing…" is visible for as long as the push takes. For one attempt, `attempt.state` events form a valid path through 9.2.
- **EV4.** Events of different sources are ordered by arrival at the Floor. The UI MUST NOT infer causality across sources from order alone; causal links are explicit fields (`cause_seq`, `hn`, `batch_id`, `request_id`).
- **EV5.** The UI state is a pure function `reduce(state, event)` over the stream from `n = 1` (or from a snapshot). The reducer lives in the shared `protocol` module and is unit-tested with recorded streams. Durations and metrics use `ts`, never `t`.

WebSocket protocol (read-only): the client sends exactly one message, `{ "hello": 1, "after": <n> }`. The Floor answers `{ "snapshot": { "n": <n>, "state": ... } }` when `after` is older than its oldest retained snapshot or 0, then `{ "events": [ ... ] }` frames in `n` order. Any second client message closes the socket. At most `MAX_SOCKETS_PER_ADDR` sockets are open per client address.

- **EV7 (hibernatable sockets).** The Floor Durable Object accepts every stream socket with the WebSocket hibernation API (`ctx.acceptWebSocket`), never with `ws.accept()`, and handles messages in `webSocketMessage`. It keeps no socket and no per-socket state in memory. The only per-socket state is the socket's attachment (`serializeAttachment`): `{ after: number }`, the highest `n` sent on that socket. The client address is the socket's tag, so the per-address limit is counted with `ctx.getWebSockets(tag)`. To fan out an appended event the Floor asks the runtime for its sockets (`ctx.getWebSockets()`) and sends each one the events above its `after`. So an open visitor page does not keep the object in memory, and an event appended after the object was evicted and started again still reaches a socket that was opened before. A test in workerd checks exactly that.

### 12.3 Replay format

A Replay file is NDJSON, UTF-8:

- line 1, the header: `{"premise_replay":2,"pool":"<id>","recorded_at":"<ISO time>","events":<count>,"synthetic":<bool>,"build":"<git commit of the build>","label":"<text>"}`;
- then exactly `events` lines, each one `PoolEvent` exactly as stored, in ascending `n` starting at 1.

Replay feeds the lines through the same reducer and components as the live stream, spaced by the differences of `ts` (scaled by a speed control). It opens no WebSocket to a live pool and calls no mutating route. Pool frames in Replay use commit addresses (`FrameAddress`), which never change. The UI shows a permanent REPLAY label, and a SYNTHETIC label when the header says so.

- **RP1.** The exporter tests every line against the patterns of `redact()` (SE5a) and refuses to export (naming the line number) if one matches. A recording is committed to a public repository, so this check is a release gate.

---

## 13. Security

### 13.1 Owner key

- **SE1.** One secret, `OWNER_KEY` (Worker secret, at least 32 random bytes, base64url). If it is not configured, every mutating route answers 503 and the Worker logs the reason: fail closed.
- **SE2.** Mutating routes require `Authorization: Bearer <key>` or the session cookie. `POST /api/session` with the key sets the cookie `premise_owner` (HttpOnly, Secure, SameSite=Strict, HMAC-signed, `SESSION_TTL_S`). Comparison is constant-time.
- **SE2a (unlock brake).** At most `UNLOCK_FAILS_PER_MIN` failed unlocks (`POST /api/session` with a wrong key) are accepted per client address per minute. Further tries in that minute answer 429 before the key is compared, also for the right key. A successful unlock does not reset the count.
- **SE3.** Mutating routes are those marked "owner" in 13.6. A cookie-authenticated request MUST carry an `Origin` header equal to the Floor's origin. A Bearer-authenticated request needs no `Origin` (a script or `curl` sends none). Every request with a body MUST have `Content-Type: application/json`; anything else is rejected with 415 before authentication, so an HTML form cannot produce an accepted request.
- **SE4.** Durable Objects are reachable only through bindings from the Worker. Tool calls come only from Agent Durable Objects. No route lets a browser call a Trunk tool.
- **SE5.** The write token for a pool repo is used only inside Trunk. It is never logged, never put in an event, an error message, a heads-up or a note, and no route returns it (the pool-create route included). Trunk mints it with `createToken()` when it needs one and mints a new one after a 401 or 403 (S2, LP5a). Any write token can force-push and delete branches, the default branch included (platform record, X3), so an Agent, a verifier, the app server and the public never receive a write token for a pool repository or for the plain-merge repository.
- **SE5a (`redact`).** One function in the `protocol` module replaces every match of the token patterns (Artifacts tokens `art_v\d+_[0-9a-f]+`, the `OWNER_KEY` value, any `Authorization` header value, and credentials inside a URL) by `[redacted]`. It is applied before any write to `outbox.last_error`, an event, a heads-up, a transcript, a note, a verifier log, or a Replay export (RP1).
- **SE5b (codes, not text).** Every error field in an event or a card is a code from a fixed list plus numbers. Raw error text from a transport, a git server, a runtime or a model provider is stored only in Trunk or Agent SQLite, after `redact()`, and is shown only to the owner.
- **SE5c (reading the pool with git).** A pool repo token is repo-scoped, not ref-scoped, so a token given to a reader must never be able to write. Read access for a person is an owner action: `POST /api/pools/{pool}/read-token` mints a token with explicit scope `read` and a lifetime of `READ_TOKEN_TTL_S`, and returns it to the owner only. `createToken` is never called without an explicit scope. Without a read token, the "show the git" drawer shows the commit, the trailers and the note from the event stream, and the clone address without credentials (`pool.state.remote`).

### 13.2 Public read-only view

Without the key a visitor can: load the Floor; open the event stream (WebSocket, read-only); read Why cards, who-relies and metrics; load the pool app by commit; run Replay. Nothing else. Public routes are GET only. No public route starts a model call. There is no crowd input path in the submission build.

- **SE19 (public requests stay off the hot path).** A public request never reaches Trunk and never calls the Artifacts control plane to resolve a ref. Pool facts (Why cards, who-relies, metrics, the commit each ref points to) come from the Floor Durable Object's reducer state (FS2). The app server resolves `main`, `green` and `plain` to commit ids from that state (`landing.landed`, `green.advanced`, `plain.updated`), then serves files by commit id through the binding (S7). A commit segment (`<40 hex>`, `p-<40 hex>`; PV5) needs no resolution. While no green commit exists (a build without the green line, or before the first verification), `green` resolves to the seed commit (`pool.state.green_seq` is 0; the first `pool.state` event of the stream carries the seed as `landed_commit`).
- **SE20 (caching).** A response for a commit-addressed file is immutable: it is stored in the Cache API and served with `Cache-Control: public, max-age=31536000, immutable`. Only a cache miss reads Artifacts.
- **SE21 (rate limits).** Per client address: `PUBLIC_RATE_PER_MIN` for the page, the session read, the stream handshake and ref-following routes; `APP_FILE_RATE_PER_MIN` for commit-addressed files, counted on cache misses only; `MAX_SOCKETS_PER_ADDR` open sockets; `UNLOCK_FAILS_PER_MIN` failed unlocks (SE2a).
- **SE22 (which repositories).** The app server serves only repositories registered as a pool's `main` or plain-merge repository. Attempt repos (which hold transcripts) are created in a separate Artifacts namespace with its own binding, and no route serves them.

### 13.3 Spend cap

- **SE6 (the gate reserves, the caller calls).** Every model call (coding models and Clef) is preceded by a request to the model gate, a single Durable Object. The gate answers `{ reservation_id, expires_at }` or a refusal. The reserved amount is an upper bound of the call's cost: `(request bytes as the input-token bound) × input price + max_tokens × output price`, from the price table in the repository. Every call sets `max_tokens`. The caller makes the call and then settles the reservation with the usage the provider reported.
- **SE6a (no usage, no discount).** A reservation that is not settled by `expires_at` (`MODEL_TIMEOUT_MS` plus `RESERVATION_MARGIN_MS`), or that is settled without a usage report (a time-out, an eviction, an error after the request was sent), is settled at its full reserved amount. Spend can be over-counted, never under-counted.
- **SE7.** If `spent + reserved + this reservation > SPEND_CAP_USD`, the call is refused with `spend_cap`. The cap is global to the deployment. An agent that is refused stops with `spend_cap` (not `budget`); Clef callers treat it as unavailable (7.3, 10.4). `limits.refusing` is true while the last request was refused for the cap.
- **SE8 (rate limits).** The gate enforces per-model requests per minute (token bucket from the model plan, S5; Clef has its own bucket) and `MAX_REAL_AGENTS`. A call over the bucket is not refused: the gate answers `{ retry_after_ms }`, and the Agent waits on a `gate` timer. This wait, and a provider's own rate-limit answer (HTTP 429, Workers AI error 3040), does not count toward `MODEL_RETRIES` and is an exempt wait for the watchdog (AG3). Attempts over `MAX_REAL_AGENTS` wait in `opened` and the Floor shows the limit.
- **SE9.** The gate emits `limits` events, to the stream of every registered pool (EV2a, EM6): when a pool registers, whenever `killed` or `refusing` changes, and at most once per `LIMITS_EVERY_MS` while spend or a bucket changes. The Floor always shows spend, cap and the real-agent limit.

### 13.4 Kill switch

- **SE10.** `POST /api/kill` (owner) with `{ "killed": true }` sets `killed` in the gate. From then on every model call is refused with `killed`; the Swarm launcher stops launching; attempts stop at their next step with reason `killed`.
- **SE11.** The kill switch does not stop Trunk from pushing an already accepted batch (that would break LP3) and does not block landings of already validated changes, which need no model. `{ "killed": true, "landings": false }` also pauses the pool (`pool_state = paused`, reason `owner`).
- **SE12.** `killed` survives restarts and is cleared only by the owner: `{ "killed": false }` clears it and resumes a pool that is paused with reason `owner`.

### 13.5 Sandboxing agent-written pool code

The boundary is the browser sandbox, and it is carried by the **response**, so it holds however the document is loaded.

- **SE13 (boundary).** Every app-server response carries a Content-Security-Policy with the `sandbox allow-scripts` directive. A document served by the app server therefore has an opaque origin in an iframe and equally when a person opens its URL directly: it cannot read the Floor's cookies, storage or DOM, cannot submit forms, cannot open windows and cannot navigate the top window. The Floor also embeds it as `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`.
- **SE14 (headers).** Every app-server response carries: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <app-server origin>; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <Floor origin>`; `X-Content-Type-Options: nosniff`; `Access-Control-Allow-Origin: *` on module files (needed by the opaque origin). `connect-src 'none'` blocks fetch, XHR, WebSocket and beacons. There is no `'unsafe-eval'`, so `eval` and `new Function` fail.
- **SE14a (the Floor's own policy).** The Floor document carries `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src <app-server origin>; connect-src 'self' wss://<Floor host>`. `frame-src` stops a pool frame from navigating itself to another site, which `connect-src` in SE14 does not cover.
- **SE14b (separate host).** When the deployment has a second hostname, `APP_HOST` is set: app-server routes answer only on `APP_HOST`, and the Floor and API only on the other host. Without it both run on one host and SE13 is the boundary. The README states which of the two the deployment uses.
- **SE15 (what is served).** The app server sends no cookies and reads none. It serves: paths that exist in the requested commit, with a content type from the table below; and the generated modules of `02-tidepool.md` 4.4, whose names start with `~` and therefore cannot be repo paths (2.1): `~head.js`, `~boot.js`, `~registry.js`, and the platform's host script. Paths under `.premise/` are not served. No error response has a body taken from a repo.

  | Path | Content type |
  | --- | --- |
  | `*.js`, `*.mjs`, generated `~*.js` | `text/javascript; charset=utf-8` |
  | `index.html` at the repo root | `text/html; charset=utf-8` |
  | `*.json` | `application/json` |
  | `*.md` | `text/plain; charset=utf-8` |
  | anything else, including any other `.html` | 404 |

- **SE16 (channel).** The Floor and the iframe talk only by `postMessage` with this fixed schema. The Floor checks `event.source` is its iframe, validates the shape, and treats every string as text, never as HTML. The pool side is implemented by the host script (`02-tidepool.md` 4.5).

  ```ts
  type FloorToPool =
    | { type: "pause" }
    | { type: "resume" }
    | { type: "probe"; selftest?: boolean }          // live frames: look for a new version now; with selftest, also run the in-page self-test
    | { type: "advance"; version: string }           // commit frames only (Replay, card previews): load this version token (PV5) without a page reload
    | { type: "highlight"; kinds: string[] };        // any frame: outline the creatures of these kinds (Who relies); [] clears

  type PoolToFloor =
    | { type: "tapped"; creature: string; path: string }      // the kind name and its file path
    | { type: "stats"; source: string; version: string; seq: number | null; tick: number; paused: boolean;
        kinds: Record<string, { count: number; resting: number; errors: number; benched: boolean }>;
        shown: number; total: number;
        swap: { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null;
        selftest: { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null };
  ```

- **SE16a (one mechanism per kind of frame).** A **live frame** follows a moving source: `main` (the pool) or `plain` (the plain-merge pool). Its address is `/pool/<pool>/main/` or `/pool/<pool>/plain/`. It moves to a new landing only by `probe`: the Floor posts `probe` to a frame on `main` when `landing.landed` arrives, and to a frame on `plain` when `plain.updated` arrives; the host then looks for the new version and swaps it in without a page reload (`02-tidepool.md` 4.6, 4.7). A live frame is never addressed by commit and never receives `advance`. A **commit frame** shows one `FrameAddress` (PV5): the frames of Replay and the before and after frames of a card. It never looks for a new version by itself; a `probe` there does nothing except run the in-page self-test when `selftest` is true. Only a commit frame receives `advance { version }`, in Replay, to step to the next recorded commit; what the host does on `advance` and on `highlight` is defined in `02-tidepool.md` 4.5. The self-test badge of any frame comes from `stats.selftest`.
- **SE17 (content controls, not a boundary).** CK6 rejects code that uses any global outside the policy allow list (so `document`, `window`, `globalThis`, `self`, `fetch`, `eval`, `Function`, `import()` of non-relative paths never land). Creatures draw only through the pen object, which has no text method and no access to the canvas element.
- **SE18.** Intent text, summaries and statements are untrusted: escaped in the UI, sanitized in commit messages (3.5), and length-limited (`MAX_INTENT_CHARS`, `MAX_STATEMENT_CHARS`).

### 13.6 Routes

The `protocol` module fixes these paths. "Owner" routes are the mutating routes of SE3, plus two reads that only the owner needs.

| Purpose | Method and path | Who | Answered by |
| --- | --- | --- | --- |
| The Floor page and assets | `GET /`, static assets | anyone | Worker assets |
| The Floor page for a named pool | `GET /p/{pool}` (a client route of the same page: that pool is the main pool; `/` is the default pool of `/floor.json`) | anyone | Worker assets |
| Static settings | `GET /floor.json` (FJ1) | anyone | Worker |
| Event stream | WebSocket `GET /api/pools/{pool}/stream` | anyone | Floor Durable Object |
| Session state | `GET /api/session` → `{ owner: boolean }` | anyone | Worker |
| Unlock | `POST /api/session` `{ key }` (429 after `UNLOCK_FAILS_PER_MIN` failed tries, SE2a) | key holder | Worker |
| Lock | `DELETE /api/session` | owner | Worker |
| Create intent | `POST /api/pools/{pool}/intents` `{ text, race, prewritten, request_id }` | owner | Trunk |
| Card action | `POST /api/pools/{pool}/cards/{card_id}` `{ option, submit_ids, attempt_id?, reason?, request_id }` (`option` is a `CardOption` that the card offers, CD4; `attempt_id` is required for `choose`; `reason` is the owner's typed text) | owner | Trunk |
| Undo plan | `GET /api/pools/{pool}/undo-plan?seq={seq}` → `UndoPlanResponse` (UN4) | owner | Trunk |
| Undo | `POST /api/pools/{pool}/undo` `{ seq, expect_reverted, request_id }` → `UndoResponse` (UN5) | owner | Trunk |
| Stop one attempt | `POST /api/pools/{pool}/attempts/{attempt_id}/stop` `{ request_id }` (stop reason `cancelled`) | owner | Agent, which calls `stop` on Trunk (TA9) |
| Swarm | `POST /api/swarm` `SwarmRequest` (SWR1 to SWR4) | owner | Swarm launcher |
| Kill switch | `POST /api/kill` `{ killed, landings? }` | owner | model gate, Trunk |
| Rebuild | `POST /api/pools/{pool}/rebuild` `{ request_id }` | owner | Trunk |
| Create pool | `POST /api/pools` `{ pool, seed, summary_only?, request_id }` (PL1; returns no token) | owner | Worker, Trunk |
| Read token | `POST /api/pools/{pool}/read-token` | owner | Worker |
| One landing's note | `GET /api/pools/{pool}/landings/{seq}/note` | anyone | Floor Durable Object (from `landing.landed.note_json`; 404 in a `summary_only` pool, EV6) |
| Recordings | `GET /replay/index.json`, `GET /replay/{id}.ndjson` | anyone | Worker assets |
| Export a recording | `GET /api/pools/{pool}/replay.ndjson` | owner | Floor Durable Object (RP1) |
| Pool files | the routes of `02-tidepool.md` 4.2, with the source segments of PV5 | anyone | app server (SE13 to SE22) |

- **PL1 (creating a pool).** `POST /api/pools` takes `{ pool, seed, summary_only?, request_id }`. `seed` names a seed tree built into the deployment: `tidepool` (the seed of `02-tidepool.md` 2.1 with the policy of its section 6), `tidepool-auto` (a generated variant: the same tree with the one-line policy variant of `02-tidepool.md` section 6, under which shared-rule files are `auto`; the main pool is created from it while `features.held` is false), or `tidepool-swarm` (`02-tidepool.md` 10.1). `summary_only` is a boolean, default `false`; it is stored in `meta`, carried by every `pool.state` event, and cannot be changed later (EV6). Only the Swarm pool and the soak pools are created with `summary_only: true`. The request also registers the pool with the model gate and the Swarm launcher (EV2a).
- **SWR1 (the Swarm route).** `POST /api/swarm` takes:

  ```ts
  type SwarmRequest = Partial<SwarmConfig> & {   // SwarmConfig: `02-tidepool.md` 10.1; a request that starts agents carries all of it
    pool: string;            // the pool the scripted agents work in; it must exist
    running: boolean;        // false: stop launching in this pool; agents in flight finish
    patterns?: string[];     // launch exactly these pattern ids (`02-tidepool.md` 10.3), one scripted agent each, in this order
    release?: string[];      // pattern ids named in `hold_before_submit` whose agents may now call `submit`
    request_id: string;
  };
  ```

  The **Swarm launcher** answers it: the Swarm Workflow of the brief for a run, or the Worker itself for a canned cast (SWR2). The agents it launches are synthetic attempts in `pool` and use the same seven tools as a real agent. Each is opened with its truth list (TR8). Opening the first one sets `pool.state.synthetic` (EM1a). A run ends by itself once its last agent is launched, as `running: false` would: its `agents` at `launch_per_second`, and while *d* > 0 one `rescale-energy` every `rescale_every_s` until then (`02-tidepool.md` 10.4). `running` means launching; the agents in flight finish (added 2026-10-05: a Workflow instance has a step limit, and a run that nobody stopped ticked until it failed with `running` still on every stream).
- **SWR2 (a canned cast).** With `patterns`, the launcher starts one scripted agent per entry, in list order (agent *n* is entry *n*; SW1 of `02-tidepool.md` applies with the request's `seed`). `agents`, `collision_dial`, `launch_per_second` and `rescale_every_s` are not used. This is how the conductor of the hero conflict, the tracer and the integration tests start a named pattern on a named pool.
- **SWR3 (holding and releasing).** A pattern id listed in `hold_before_submit` makes its agents wait before `submit`. A later request with the same `pool` and `release: [ids]` lets them submit. A request may carry only `pool`, `running: true`, `release` and `request_id`.
- **SWR4.** A repeated `request_id` is a no-op. The kill switch stops launching (SE10). Every change of what is running is reported by `swarm.state` (EM6).
- **FJ1 (`/floor.json` and `features`).** `/floor.json` is a static file built with the deployment. Its `features` field says which SHOULD features the build has. These are the only keys, and no other document may add one:

  ```ts
  type Features = {
    held: boolean;                       // 10.2 in full: previews, blast radius, risk lines, `land_now`. false: the minimal form (HD1)
    race: boolean;                       // 11.4
    undo: boolean;                       // 11.3: the owner's Undo, the undo-plan and undo routes
    green: "none" | "static" | "full";   // 11.5: no verification | static checks only (GR5) | the isolate self-test
    clef: boolean;                       // Clef triage and risk questions (7.3, 10.4). false: `CLEF_TRIAGE`, `CLEF_RISK` and `CLEF_CONTRADICTION` are off
    attempt_repos: boolean;              // S3: attempt repositories are provisioned
  };
  ```

  The Worker reads the same values (`src/config/features.ts` in the build plan), so the page and the engine cannot disagree. A request that needs a feature that is off is refused with HTTP 404 and the error code `feature_off` (an intent with `race: true`, the undo-plan and undo routes), and changes nothing. The other fields of `/floor.json` (the default pool id, the Swarm pool id, the pre-written requests, model short names, the limits list, related work) are specified in `03-floor.md` 4.5.

---

## 14. Metrics

All metrics are computed from the event stream by the shared reducer, per pool, over a sliding window `METRICS_WINDOW_MS` unless stated. Every time is the event's `ts` (the source's clock at commit), never its arrival time `t`. The Floor Durable Object runs the reducer and appends the `metrics` event (EM5); clients show that event. Real and synthetic pools are always reported separately; a number from a synthetic pool is shown under the SYNTHETIC label.

| # | Metric | Exact definition |
| --- | --- | --- |
| 14.1 | **Landings per second** | Number of `landing.landed` events of kind `change` with `ts` in the window, divided by the window length in seconds. Accepted-but-unpushed landings are not counted. |
| 14.2 | **Time to land** | For one landing: `ts(landing.landed) − ts(submit.result)` of the last `submit.result` with status `validated`, `submitted` or `held` for that attempt before acceptance. Reported as p50 and p99 over the window's landings. Owner waiting time on a card is included and also reported separately as "time held". "Intent to landed" (`ts(landing.landed) − ts(intent.created)`) is a different, separately labelled number. |
| 14.3 | **Go-around rate** | Landings of kind `change` in the window whose note has at least one entry in `go_arounds`, divided by all landings of kind `change` in the window. Pull-backs (GA3) are reported next to it as "confirm rate": landings whose note has `pull_backs > 0` or a non-empty `confirms`. The reducer decides both from the stream, not from `note_json` (which is `null` in a `summary_only` pool): a landing counts for the go-around rate when its attempt received at least one `headsup.sent` of result `repair` before the landing was accepted, and for the confirm rate when it received at least one of result `confirm`. These are the heads-ups that the note lists. |
| 14.4 | **False-abort rate** | Among go-arounds resolved in the window (GA2): the share where the attempt's operations at the resolving submit are identical to its operations when the go-around started (the agent was sent back and changed nothing). The reducer takes this from `headsup.resolved` (HU12), in every pool: a go-around is the pair `(attempt_id, go_around)`; it is a false abort when no `headsup.resolved` of result `repair` with that pair has `changed: true`; it is counted once, when `attempt.state` next shows the attempt leaving `going_around` for a state other than `stopped`. No `op.recorded` event is needed, so the rate exists in a `summary_only` pool. Target: `FALSE_ABORT_TARGET` (*calibrated*). The **truth-label rate** of a Swarm run (the share of `repair` results on keys the canned change does not truly depend on, from the truth lists of `02-tidepool.md` 10.3) is a different number. It is not in the stream and not in `metrics`: the soak script computes it from the landed notes and the truth lists and publishes it in `SoakResult` (`04-build-plan.md`, VE6). |
| 14.5 | **Escape rate** | Landings of kind `change` in the window that were later reverted by the green line (11.5): their `seq` is in `reverted` of an `undo.planned` event with cause `revert`. Divided by landings of kind `change` in the window. `null` when the build has no green line (`features.green` is `"none"`). This is the only escape rate shown on screen, in every pool. The **ground-truth escape count** of a Swarm run (SW2 of `02-tidepool.md` 10.3: a landed file whose number does not fit the scale at head) is computed by the soak script from the final tree and published in `SoakResult`, not in `metrics`. Target: `ESCAPE_TARGET`. |
| 14.6 | **Changes waiting behind another change** | Gauge, sampled at the end of each tick: the number of attempts in `validated` with all premises holding that the tick did not accept because of `right_of_way` (RW3) or because the batch was full. Attempts on a card are waiting for a person, not for a change, and are not counted. `push_backlog` (attempts in `validated` while an outbox row is pending) and tick CPU time (`tick_cpu_ms`, p50 and p99) are reported next to it. |
| 14.7 | **Repair latency** (real agents only) | For one go-around: `ts` of the first `submit.result` with status `validated`, `submitted` or `held` after the heads-up, minus `ts` of the `headsup.sent` of result `repair` that started the go-around. (`held` counts: a race candidate and a held change end their repair on a card.) Reported as p50 and p90, never mixed with synthetic agents, because scripted agents answer at once. |
| 14.8 | **Fork throughput** | Attempt repos provisioned per second and their failure rate, from `attempt.repo` events. Reported separately from 14.1, because no landing waits for a fork. |

The Floor quotes no number that the current stream or a named recorded run did not produce.

---

## 15. Decided by spike

Each item is a **port**: an interface that the rest of the system codes against, with one adapter per option. The options were measured on the real Cloudflare service on 2026-10-04. The measurements are in the platform record, `docs/measurements/spikes/2026-10-04-platform.md` (X*n* is its experiment E*n*). For each port this section states the **chosen** option, the **evidence**, the **fallback**, and what is **not yet measured**. The interface stays as it is, so an option can still be swapped: the adapter in use changes only together with a new record under `docs/measurements/spikes/` (question, measurement, choice, date).

Limits of the evidence, as the record states them: every experiment ran once, from one location, on small repositories (a few files). Latency is one sample set, not a benchmark.

| Port | Chosen | Fallback |
| --- | --- | --- |
| S1 Push path | Trunk builds the pack by hand and posts `git-receive-pack` itself. One request carries both ref commands. | isomorphic-git inside Trunk, for the push only |
| S1 Reading notes | The notes commit id from the ref advertisement, then binding reads by object id | A hand-built fetch of the notes ref |
| S2 Token source | `createToken()` when needed, refreshed on 401 or 403. Only Trunk holds a write token. | The token returned by `create()`, with rotation |
| S3 Attempt repos | `fork()` off the landing path, at most four in flight, with retry and backoff | `create()` per attempt, or no attempt repo |
| S4 Green line runtime | A Dynamic Worker isolate, no network, with a CPU limit | Static checks only, stated on screen |
| S5 Models | Workhorse `@cf/openai/gpt-oss-120b`; Race adds `@cf/moonshotai/kimi-k2.7-code` and `@cf/zai-org/glm-5.3-flash` | The next model of the measured list; the final mix follows the seeded-intent measurement |
| S6 Clef | `@cf/cloudflare/clef` for triage and for risk | `@cf/cloudflare/clef-flash` when latency matters; off |
| S7 Reading pool files | `readFile({ ref: <commit id>, path })` through the binding | Binding reads by object id |

### S1. Push path

```ts
type RefUpdate = { ref: string; old: string; new: string };      // old = 40 zeros to create
type PushResult =
  | { ok: true; refs: Record<string, "ok"> }
  | { ok: false; kind: "rejected"; refs: Record<string, "ok" | "ng"> }     // the reason text is not interpreted (LP5)
  | { ok: false; kind: "transport"; code: ErrCode; http_status: number | null; retry_after_ms: number | null };
interface Pusher {
  push(input: { remote: string; token: string; updates: RefUpdate[]; pack: Uint8Array;
                atomic: boolean; signal: AbortSignal }): Promise<PushResult>;       // aborted at PUSH_TIMEOUT_MS (LP5c)
  // Reads the refs from the remote's ref advertisement (info/refs of receive-pack), never from a binding read that may lag a push.
  readRefs(input: { remote: string; token: string; refs: string[]; signal: AbortSignal }): Promise<Record<string, string | null>>;
}
interface NotesReader {
  readNote(commit: string): Promise<string | null>;
  listNotes(): AsyncIterable<{ commit: string; blob: string }>;
}
```

| Option | Description | Status |
| --- | --- | --- |
| A | Hand-built pack and raw receive-pack over smart HTTP v1 from Trunk (pure `rawgit` module). | **Chosen** |
| B | isomorphic-git with an in-memory filesystem inside Trunk, used only for the push. | Fallback |
| C | One warm container with the git CLI, called by Trunk. | Not built, not measured |

**Chosen: A.** Trunk builds the pack by hand (9.5) and posts `git-receive-pack` itself. No git client library is on the landing path.

Evidence:

- X8 (hand-built pack): the service accepted a hand-built pack in a single-ref request (516 ms) and in a two-ref request (362 ms), one sample each. The binding then read the hand-built objects. An update that needs no new objects works with an empty pack.
- X3 and X8 (compare-and-swap): the server checks the old object id. An update with a stale old id was refused (`stale ref`); the same update with the correct old id was then applied. Creating a ref that already exists was refused.
- X8 (landing atomicity): one request carried both commands (`refs/heads/main` and `refs/notes/premise`). With one wrong old id the service refused both commands, in both command orders, with and without the `atomic` capability, which it does not advertise.
- X4: pushes to `refs/notes/premise` were accepted, listed, and fetched back with matching content. A stock git client can therefore read the notes (3.5).
- X7: 100 commit-and-push cycles in a row from one Durable Object, 0 failures, p50 128 ms, p95 278 ms, max 449 ms. That run pushed through isomorphic-git. It speaks for the service and for option B. It does not yet speak for a hand-built pack at volume.
- X1 and X6: after a push, a binding read showed the new head within 28 to 274 ms, with no stale read in 10 rounds.

What follows for the protocol:

- **S1a (one request, two commands).** A landing push is one receive-pack request with both commands (LP4). `atomic` is passed as `true` only when the server advertises it.
- **S1b (the result is still decided by value).** Trunk does not rely on the measured all-or-nothing behaviour. After any result that is not all-ok it reads the ref advertisement (`Pusher.readRefs`) and decides by the values of both refs (LP5). The rows `retry_notes` and `retry_main` stay.
- **S1c (`NotesReader`).** Chosen: the notes commit id comes from the ref advertisement (`Pusher.readRefs`), or from `meta.notes_commit` when Trunk already knows it; the notes tree and the note blobs are then read through the binding by object id. Evidence: the binding does not resolve `refs/notes/premise` by name (X4); reads by commit id returned the content for every ref tested (X4, X6). Fallback: a hand-built fetch of the notes ref (`git-upload-pack`) in the `rawgit` module. Not yet measured: a binding read of an object that is reachable only from the notes ref.

**Fallback: B.** X7 shows that option B works on the service. The switch is one adapter (`Pusher`); the outbox, LP5 and the vectors do not change.

Not yet measured (owned by the durable-landing slice of `04-build-plan.md`): several hundred consecutive pushes with the hand-built pack; the largest pack; the size of Trunk's SQLite after 300 batches; memory against the 128 MB limit (that run fails on any memory-limit error).

### S2. Token source

```ts
interface TokenSource {
  // Where to push now. `repo` and `remote` may change between calls only under option B (rotation).
  writeTarget(pool_id: string): Promise<{ remote: string; repo: string; token: string; expires_at: number | null }>;
}
```

| Option | Description | Status |
| --- | --- | --- |
| A | Token minted with `createToken` from the Durable Object, cached until near expiry. | **Chosen** |
| B | The token returned by `create()` when the pool repo was created, stored encrypted in Trunk storage, rotated by re-creating through `fork()` (rules below). | Fallback |
| C | Push from a container, where minted tokens were reported to work. | Not built, not measured |

**Chosen: A.** Trunk mints a write token with `createToken()` when it needs one, keeps it until near its expiry, and asks for a new one after a 401 or 403 on a push (LP5a).

Evidence:

- X2: `createToken()` took 42 to 44 ms from inside a Durable Object. Pushes with a minted write token took 125 to 137 ms. Write and read tokens were accepted with Bearer and with Basic authentication, inside and outside Workers. A read token cannot push. The reported failure of minted tokens (workers-sdk issue 15429) did not reproduce.
- X3: any write token can force-push, delete a branch and delete the default branch.

What follows:

- **S2a (who may hold a write token).** Only Trunk holds a write token for a pool repository or its plain-merge repository (SE5). Agents, verifiers, the app server and the public never receive one. A person who wants to read the pool with git gets a read token (SE5c).
- **S2b.** `createToken` is always called with an explicit scope (SE5c).

**Fallback: B**, with these rules, because a rotation changes the pool's repository: rotate only while the outbox is empty and no rebuild runs; fork with `defaultBranchOnly: false` and wait for it off the landing path; before switching, read `main`, `green` and the notes ref on the fork and require them to equal Trunk's values; hold the tick (`pool_state = rebuilding`) during the switch; then increase `meta.repo_generation`, store the new `repo`, and emit `pool.state` with the new `remote` (the app server follows it, SE19). A failed check leaves the old repository in use. A 401 or 403 on a push (LP5a) triggers `writeTarget` again.

Not yet measured (needed only for option B): the real lifetime of a token returned by `create()`; whether `fork()` with `defaultBranchOnly: false` copies `refs/heads/green` and `refs/notes/premise`.

### S3. Attempt repos

```ts
interface AttemptRepoProvisioner {
  provision(attempt_id: string): Promise<{ repo: string } | { error: string; retry_after_ms: number }>;
}
```

| Option | Description | Status |
| --- | --- | --- |
| A | `create()` an empty repo per attempt and push checkpoints. | Fallback |
| B | `fork()` the pool repo per attempt, with retry. | **Chosen** |
| C | A pre-warmed pool of repos, assigned on demand. | Not built |

**Chosen: B**, with these rules:

- **S3a (off the landing path, bounded).** Forks are made off the landing path, at most `MAX_FORKS_IN_FLIGHT` (4) at a time in the deployment. A failed fork is retried up to `FORK_RETRIES` times with a backoff that starts at `FORK_BACKOFF_BASE_MS` and doubles. A fork that still fails is reported as `attempt.repo { ok: false }`, and the attempt runs without a repo (AG5).
- **S3b (its token).** `fork()` returned no token that works (X5). The token for an attempt repo is minted with `createToken()` for that repository. It is a token for the attempt repo only, in the separate namespace of SE22, never for a pool repository (S2a).
- **S3c (nothing shown depends on a fork).** Nothing on the landing path, and nothing that the Floor or the video shows as the state of a pool, an attempt or a landing, may depend on a fork having finished. The note's `attempt.repo` is `null` when the repo did not exist at acceptance.
- Fixed as before: provisioning is asynchronous (AG5); synthetic agents get no repo; fork throughput is reported separately (14.8). With `features.attempt_repos = false` nothing is provisioned.

Evidence: X5. 20 concurrent forks gave 15 usable repositories and 5 failures (`INTERNAL_ERROR`, code 10400). A fork was ready in 1.7 to 4.0 s (p50 3.4 s). A push to a fork left the source unchanged.

**Fallback: A.** `create()` an empty repository per attempt (X1: ready in 1.3 to 2.7 s; a push with its token took 168 to 245 ms). If that fails too, the attempt has no repo and says so (`attempt.repo { ok: false }`).

Not yet measured: whether `fork()` can place the fork in the separate attempt namespace that SE22 requires. If it cannot, SE22 wins and option A is used.

### S4. Green line verification runtime

Interface: `Verifier` (11.5).

| Option | Description | Status |
| --- | --- | --- |
| A | Browser Run opens the pool at the commit and runs the in-page self-test. | Not built, not measured |
| B | A Dynamic Worker isolate imports the modules of the commit and runs the headless self-test. | **Chosen** |
| C | A container with node. | Not built, not measured |
| D | `static`: parse, import resolution, policy invariants. The Floor says "static checks only". | Fallback |

**Chosen: B**, with these rules:

- **S4a (how).** The `Verifier` reads the commit's `.js` files by commit id (S7) and loads them, with the generated entry module of `02-tidepool.md` 5.4, as the modules of one Dynamic Worker through the Worker Loader binding: an empty environment, `globalOutbound: null`, and `limits: { cpuMs: GREEN_CPU_MS }`. It takes the verdict the entry module returns and maps it by GR8.
- **S4b (concurrency).** At most four Dynamic Workers may be in flight per Worker request (ten per Durable Object); a fifth is refused with a clear error. One verification uses one isolate at a time, its checks run in sequence, and at most one verification is in flight (GR1).
- **S4c.** No container and no Browser Run is in the build. `VerifyResult.runtime` keeps the values `browser` and `container` so that such an adapter can be added later; every option must meet GR6 and GR7.

Evidence (the record's sandbox test): a fresh isolate loaded and ran the pool's simulation (shared rules, one creature, 3,000 ticks) in 9 to 14 ms per run, for nine code versions. `fetch()` inside the isolate throws. A runaway loop under `cpuMs: 50` was stopped ("Worker exceeded CPU time limit."). A syntax error and a missing export were reported as errors. The limit of four in flight per request was observed.

The same test showed one thing about the product claim. With `ENERGY_MAX` rescaled from 100 to 1 and a creature still written for the old scale, every generic invariant passed: the crab hid for all 3,000 ticks. A self-test that does not encode a creature's intended behaviour accepts the merged code. The green line does not catch the hero conflict. The premise check does (6.5, HC3).

**Fallback: D.** Runtime `static`, stated on screen as "static checks only" (GR5); `features.green` is then `"static"`. With `features.green = "none"` no verification runs and the Floor shows no green line.

Not yet measured: the full pool (every seed file and every creature) in the isolate; flakiness over 50 runs (GR3 tolerates one false red per verification, not two); the value of `GREEN_CPU_MS`.

### S5. Model mix and number of live agents

```ts
type ModelPlan = {
  workhorse: string;                                   // "@cf/openai/gpt-oss-120b"
  race: string[];                                      // RACE_SIZE models
  per_minute: Record<string, number>;                  // enforced by the gate
  max_real_agents: number;
  prices_usd_per_mtok: Record<string, { in: number; out: number }>;
};
```

**Chosen (the starting plan):**

| Role | Model |
| --- | --- |
| Workhorse | `@cf/openai/gpt-oss-120b` |
| Race (`RACE_SIZE` is 3) | the workhorse, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.3-flash` |

Evidence: X9. One run per model on one small task (read two small files, change a constant, update one call site, with two tools).

| Model | Correct | Model calls | Total | Median per call |
| --- | --- | --- | --- | --- |
| `@cf/openai/gpt-oss-120b` | yes | 5 | 3.6 s | 0.78 s |
| `@cf/moonshotai/kimi-k2.7-code` | yes | 5 | 4.1 s | 0.96 s |
| `@cf/zai-org/glm-5.3-flash` | yes | 3 | 5.1 s | 1.9 s |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | yes | 3 | 10.3 s | 3.9 s |
| `@cf/zai-org/glm-5.3` | yes | 3 | 28.2 s | 3.5 s |
| `@cf/qwen/qwen3.8-27b` | yes | 3 | 55.2 s | 23.0 s |

This task is far smaller than a real intent. It shows the request shape and the relative speed, not coding quality.

- **MP1 (request shape, measured).** `env.AI.run(model, { messages, tools: [{ type: "function", function: { name, description, parameters } }], max_tokens })`. An assistant message that carries tool calls MUST have a string `content` (the empty string when the model gave none); `null` is rejected with error 5006. The tool definitions themselves are in `05-agent.md`.
- **MP2 (the final mix follows the seeded-intent measurement).** The measurement protocol is in `05-agent.md`. It reports, per model, on the seeded intents of `02-tidepool.md` section 9: the share completed; the median and p90 time per change; the tool-call error rate; for energy creatures, the share whose module references `ENERGY_MAX` and the share that write an absolute number (HC4); the share that repair correctly after a scripted heads-up (`30` to `0.3` after the `ENERGY_MAX` diff); the cost of one confirm turn of row E2m; tokens and cost per change (for `MAX_ATTEMPT_USD`). `workhorse`, `race`, `per_minute` and `max_real_agents` are set from these numbers, not from the rate-limit table. A first run of it needs no engine and no premises (the seven tools over an in-memory copy of the seed, Workers AI over REST), so it can run before Trunk exists.

**Fallback.** `ModelPlan` is data. A model that misses the marks of the build plan is replaced by the next model of the table above that completed the task, or the race list is shortened and `RACE_SIZE` lowered with it. A model outside Workers AI needs the owner's approval (`04-build-plan.md`).

Not yet measured: everything in MP2.

### S6. Clef limits and accuracy

```ts
type TriageInput = {
  attempt_id: string;
  intent: string;
  patch: Array<{ key: string; source: string }>;                 // added and altered entities, as in the attempt view
  premises: Record<string, {                                      // one entry per pending premise; the key is the question id
    kind: PremiseKind; key: string; rule: string;                 // the triage row: E3, F4, F6, QT2 or QR4
    read_then: string | null; is_now: string | null; changed_by_intent: string | null;
    added?: Array<{ key: string; source: string | null }>;        // listing and query premises: the gained members
    changed: string[];                                            // for a file premise: the entity keys of D (7.2); else []
  }>;
  truth: string[] | null;                                         // synthetic attempts only (TR8); for QR4 the landed change's list
};
type TriageAnswers = { answers: Record<string, number | null>;    // one entry per premise id; null = unavailable
                       model: string };

interface Triage {            // asynchronous: Clef. Called after the transaction (TR2). One call per attempt per batch (7.3).
  judge(input: TriageInput): Promise<TriageAnswers & { ms: number; error?: ErrCode }>;
}
interface SyncTriage {        // synchronous: answers inside the accept transaction (TR5). No promise, no `await`.
  judgeNow(input: TriageInput): TriageAnswers;
}
interface RiskJudge {
  judge(input: RiskInput): Promise<RiskAnswers>;
}
```

- **S6a (two ports, one choice per attempt).** At classification Trunk picks the triage of the attempt: `ScriptedTriage` (a `SyncTriage`) when `agent_kind = synthetic` (TR8); `OffTriage` (a `SyncTriage` whose every answer is `null`) when `CLEF_TRIAGE` is off or the kill switch is set (TR5); otherwise `ClefTriage` (a `Triage`). `SyncTriage.judgeNow` returns a value, not a promise, so `ScriptedTriage` is pure code that can live with the Swarm scripts and be called inside the transaction (SY2). `RiskInput` is the `state` object of 10.4.

| Option | Description | Status |
| --- | --- | --- |
| A | `clef-flash` for triage, `clef` for risk. | Fallback when latency matters |
| B | `clef` for both. | **Chosen** |
| C | Off (`CLEF_TRIAGE = off`): `OffTriage` answers unavailable inside the transaction (TR5, → `confirm`), no risk questions. | The build without Clef (`features.clef = false`) |
| (always) | `ScriptedTriage` for synthetic attempts (TR8), whatever option is chosen. | In every build |

**Chosen: B.** `@cf/cloudflare/clef` answers the triage questions (7.3) and the risk questions (10.4): `CLEF_TRIAGE_MODEL_ID` and `CLEF_RISK_MODEL_ID` are both `@cf/cloudflare/clef`.

Evidence (the record's Clef test): eight hand-made cases, each with the intent, the old and the new source of something the agent read, the agent's patch, and one yes/no question. Both models put every case on the correct side of 0.5. `clef` separated the classes more widely (lowest "yes" 0.93, highest "no" 0.08) than `clef-flash` (0.76 and 0.31). Latency was 130 to 930 ms per call, at about 460 input tokens per call. A burst of 40 concurrent `clef-flash` calls all succeeded in 1.1 s.

- **S6b (thresholds are not set by this evidence).** Eight cases written by the author of the question are a smoke test, not a calibration. `T_REPAIR`, `T_CONFIRM`, `T_INTENT_MIN`, `T_UNRELATED_MAX`, `T_SHARED_MAX` and `T_CONTRADICT` stay *calibrated* constants with their starting values, and `CLEF_TRIAGE`, `CLEF_RISK` and `CLEF_CONTRADICTION` stay `off`, until they are measured on a larger set and recorded with the confusion table.

**Fallback: A** for triage when latency matters (`CLEF_TIMEOUT_MS` is 2,000 and triage sits between a landing and the agents that wait for its outcome): `CLEF_TRIAGE_MODEL_ID` becomes `@cf/cloudflare/clef-flash`. Its narrower separation needs its own thresholds. Below that, option C.

Not yet measured: accuracy on the hand-labelled set (the `triage` vectors plus at least 40 more cases, including QR4 cases and cases from real agent runs); latency under load for `clef`; how many questions one request accepts (`CLEF_MAX_QUESTIONS`); the input size at which the service truncates state (`CLEF_INPUT_TOKEN_LIMIT`); whether `criteria` is accepted on `noul` questions; the answer field name.

### S7. Reading pool files

Interface: `PoolSource` (`02-tidepool.md` 4.9), used by the app server and by the verifier. Trunk's rebuild makes the same reads (3.6).

| Option | Description | Status |
| --- | --- | --- |
| By commit id | `readFile({ ref: <commit id>, path })` through the Artifacts binding. | **Chosen** |
| By object id | `readCommit`, then `readTree` one level at a time, then `readBlob`, with trees cached per version. | Fallback |
| Trunk's `files` table | Head files from Trunk. | Not built: a public request never reaches Trunk (SE19) |
| An attempt view | A live read of an attempt's view. | Not built: previews are preview commits (PV1, PV4) |
| A directory on disk | For tests and local runs. | Tests only |

- **S7a (always by commit id).** Every read of pool files names a commit id. A moving source (`main`, `green`, `plain`) is first resolved to a commit id: by the app server from the Floor's state (SE19); by Trunk from its own `meta`, or from the ref advertisement.
- **S7b (what the binding resolves).** Commit ids, short branch names (`main`, `green`) and tag names resolve. Full ref names (`refs/heads/green`) and other namespaces (`refs/notes/premise`, `refs/previews/...`) do not. Code never passes a full ref name to the binding. Notes are read by object id (S1c).

Evidence: X4 and X6. `readFile({ ref: <commit id>, path })` returned the file for every ref tested. `readFile`, `readTree`, `readCommit`, `readBlob` and `log` took about 110 ms each (p50). After a push, reads showed the new head within 109 to 274 ms. A commit-addressed response is cached for good (SE20), so this cost is paid once per file and commit.

Not yet measured: a read by commit id of a commit that is reachable only from `refs/previews/*` (PV1a) or only from the notes ref (S1c); the time to load a whole pool page (about 25 modules) on a cold cache.

---

## Appendix A. Test vector format (`premise-cases.json`)

The vectors exercise the pure core only: no network, no clock, no model. A runner builds a core state from `files`, applies `steps` in order, and checks `expect` after each step and `final` at the end.

```ts
type CasesFile = {
  format: "premise-cases/2";
  spec: "docs/spec/01-core.md";
  about: string;
  constants: Record<string, number>;          // values the runner must use (test values, not the calibrated ones)
  switches: Record<string, "on" | "off">;     // CLEF_TRIAGE is "on": triage rows wait for a `triage` step
  pools: Record<string, { files: Record<string, string> }>;
  hash_cases: HashCase[];
  inbox_cases: InboxCase[];
  cases: Case[];
};

type HashCase =
  | { id: string; rule: string; kind: "entity"; a: string; b: string; entity: string; equal: boolean }
  | { id: string; rule: string; kind: "canonical"; source: string; entity: string; canonical: string; hash: string }
  | { id: string; rule: string; kind: "members"; members: string[]; hash: string }    // listing, query and module hashes (2.5)
  | { id: string; rule: string; kind: "blob"; content: string; hash: string };       // file hash = git blob id (2.5)

type InboxCase = {                             // rule HU6a: the Agent's pure function inboxNext
  id: string; rule: string;
  shown_hn: number;                            // highest heads-up already shown to the model
  inbox: number[];                             // heads-up numbers the Agent holds
  expect: { show: number[]; sync: boolean };   // what it shows now, and whether it calls `sync`
};

type Case = {
  id: string;
  title: string;
  rules: string[];                             // section numbers and rule ids this case tests
  pool: string;                                // key of pools
  files?: Record<string, string | null>;       // overrides on top of the pool; null removes a file
  constants?: Record<string, number>;          // overrides for this case
  attempts: Record<string, { intent: string; intent_id?: string; race?: boolean }>;  // opened before step 1, in this order, at head_seq 0;
                                               // attempts with the same intent_id are attempts of one intent (GL3);
                                               // race: true marks a race candidate (RC1, runner rule 11)
  steps: Step[];
  final: Final;
  note?: string;
};

type Step = {
  by?: string;                                 // attempt name, for tool steps
  do: "outline" | "read" | "list" | "search" | "write" | "replace" | "submit"   // tool calls (section 4)
    | "tick"                                   // run the batch tick (9.4)
    | "push_ok"                                // the pending push reported every ref ok (LP5)
    | "push_result"                            // a push ended otherwise; args: { remote_main, remote_notes }, each "old" | "new" | "other" (LP5)
    | "restart"                                // Trunk restarts; args as push_result; remote_notes defaults to remote_main (LP7, TR6)
    | "triage"                                 // a Clef answer arrives; args: { attempt, kind, key, p, asked_at_op? } (p may be null = unavailable)
    | "owner";                                 // args: { action: "land" | "land_now" | "decline" | "undo" | "retry" | "stop" | "choose",
                                               //         attempt?, seq?, expect_reverted? }
  args?: object;
  call_id?: string;                            // default: unique per step
  ack?: number;                                // default: every heads-up created so far for the attempt
  expect?: Expect;
};

type Expect = {
  ok?: boolean;                                // ToolResponse.ok
  error?: string;                              // ToolResponse.error.code
  result?: object;                             // subset match on ToolResponse.result; arrays must have equal length and match element by element
  status?: string;                             // SubmitResult.status
  duplicate?: boolean;
  same_response_as?: number;                   // index of an earlier step: responses must be identical
  same_submit_id_as?: number;
  premises?: PremiseExpect[];                  // exact set of ToolResponse.premises
  judgments?: Array<{ attempt: string; kind: string; key: string; rule: string;
                      class: "rule" | "triage"; result?: string }>;   // exact set created or closed by this step;
                                               // a pending triage has no result
  heads_ups?: Array<{ to: string; hn: number; result: string; cause?: string;   // cause = HeadsUp.cause.type
                      wake?: boolean;
                      items: Array<{ kind: string; key: string; rule: string; result: string;
                                     added?: string[]; removed?: string[]; context?: string[];   // keys only
                                     after_contains?: string }>;
                      dropped_ops?: Array<{ op_seq: number; rule: string }> }>;  // exact set created by this step
  accepted?: string[];                         // tick: attempt names (or "undo:<seq>") in batch order
  skipped?: Record<string, string>;            // tick: attempt -> "not_disjoint" | "right_of_way" | "checks_failed" | "held"
  landings?: Array<{ seq: number; attempt?: string; kind: string; undoes?: number[] }>;
  landed?: number[];                           // seqs confirmed on main by this step
  action?: string;                             // restart, push_result: "repush" | "retry_main" | "retry_notes" | "mark_pushed" | "pause" (LP5)
  reasked?: Array<{ attempt: string; kind: string; key: string }>;   // triage questions asked again by this step (V7, TR6)
  pool_state?: string;
  undo?: { reverted: number[]; reopened: string[]; kept_readers: number[] };   // the plan returned by an undo request
  refused?: string;                            // undo request: the refusal reason (11.3)
  cards?: Array<{ kind: string; reason: string; attempts: string[];
                  blast_radius?: { repair: string[]; confirm: string[]; triage: string[] } }>;  // cards opened by this step (CD3)
  states?: Record<string, string>;             // attempt -> state after the step (subset)
  stop_reasons?: Record<string, string>;
  go_arounds?: Record<string, number>;
  pull_backs?: Record<string, number>;
  right_of_way?: Record<string, boolean>;
  waiting_behind?: number;                     // metric 14.6 after a tick
  events_include?: string[];                   // event types this step must emit
  events_exclude?: string[];                   // event types this step must not emit
};

type PremiseExpect = {
  kind: string; key: string;
  at?: number;                                 // the hash of the key at head_seq <at> (0 = initial files)
  hash?: "absent";                             // instead of `at`
  read: boolean; edit: boolean; derived: boolean;
};

type Final = {
  head_seq: number;
  files: Record<string, string | null>;        // exact content of these paths at head (the last accepted landing); null = absent
  states: Record<string, string>;
  go_arounds?: Record<string, number>;
  landings: Array<{ seq: number; attempt?: string; kind: string }>;   // Trunk's landing log (accepted, pushed or not): exact, in order
};
```

Runner rules:

1. Only fields present in `expect` are checked. Lists marked "exact set" must match exactly, ignoring order unless stated; `result` and `states` are subset matches.
2. `at: n` avoids hash literals: the runner computes the hash of the key in the state after landing `n` with its own implementation of section 2, which the `hash_cases` check independently.
3. Heads-ups are assumed received and shown at once: each tool step sends `ack` = the highest `hn` created so far for its attempt, unless `ack` is given. A heads-up is **delivered** (HU8, GA1) only when a tool step of its attempt is run with `ack >= hn`; an attempt that takes no step has not been delivered anything.
4. `call_id` defaults to a fresh value per step. Two steps with the same `call_id` test rule TA2.
5. Clef is never called. `CLEF_TRIAGE` is on: a `triage` class judgment stays pending until a `triage` step supplies `p`. A `triage` step for a judgment that is already closed, or with an `asked_at_op` that is not the judgment's current one, changes nothing (TR4).
6. Policy risk questions are off (`CLEF_RISK = off`), so a passing `auto` submit answers `validated`.
7. A `tick` with a pending outbox row does nothing (LP1); `push_ok` confirms it.
8. Attempt names in the file (`A`, `B`, `S`, ...) stand for attempt ids; order of `validated_at` is the order in which attempts entered `validated` (by a submit, by T12 or by an owner step).
9. All attempts are real agents (`agent_kind = real`) and the pool is not `summary_only`, so every judgment emits its event (EV6).
10. The spec cites a case by its number prefix (`C04` means `C04-hero-shared-rule-lands-first`).
11. An attempt with `race: true` is a race candidate (RC1). The candidates of one race share an `intent_id`, and that intent's race card is open before step 1 (so a candidate's submit emits `card.updated`, not `card.opened`). The `owner` action `choose` with `attempt` chooses that candidate (RC4): it is the `choose` option of the race card with that `attempt_id`.

Case index (58 cases, 23 hash cases, 5 inbox cases). Cases `C29` to `C57` were added in revision 2; "Changes after review" names the finding each one answers. Case `C58` was added in the reconciliation of 2026-10-04 (rule RC7). The reference simulator under `reference/spec-sim/` is frozen and has no race support, so it runs cases `C01` to `C57` only; `C58` was checked with a copy of it extended by the candidate flag and the `choose` action. No expected value of `C01` to `C57` changed in the reconciliation.

| Case | Tests | Rules |
| --- | --- | --- |
| `C01-disjoint-batch` | Two changes that share nothing land in one batch, in one push | 9.4, LP2, D1, W4, TA7 |
| `C02-same-file-different-entities` | Two replaces in one file that touch different entities are disjoint and land in one batch | 9.4 step 3b, R4, D2, E0, 5.3 |
| `C03-same-entity-twice` | Two changes to one entity: the second is sent around with its replace dropped, then lands on top | E1, OP1, OP6, T8, GA1, 9.4 step 3b, CK1 |
| `C04-hero-shared-rule-lands-first` | Meaning change behind an unchanged name: the shared rule lands first, the in-flight creature references it and is repaired | 6.5, D1, E2, HU1, T8, CK1 |
| `C05-hero-creature-lands-first` | The same conflict in the other order: the creature lands first, and the in-flight shared-rule change learns of the new referrer | 6.5, D2, QR1, HU1, R4, 8.2 context |
| `C06-read-not-referenced-triage` | The agent read an entity that changed but its patch does not name it: Clef triage zone (class only), then the fail-closed outcome | E3, 7.3 TR1, V1, T5, CK8 |
| `C07-triage-thresholds` | Triage probabilities map to repair, confirm and re-affirm; the diff was already delivered by the info heads-up of the landing | 7.3 TR1, TR3, E3, HU3, 7.4 |
| `C08-cosmetic-change-holds` | A comment-only landing breaks no premise: the entity hash is unchanged and the file premise holds by rule F2 | 2.4, E0, F2, R4, CK3 |
| `C09-blind-spot-confirm` | The new code references an entity the agent never read: one confirm turn with the current definition, not a rejection | 6.4, B1, B2, B3, D1, CK7, CK8, T5 |
| `C10-unread-reference-changes-after-write` | The hero conflict when the creature's agent never read the shared rule: the derived premise pinned at the write catches the change live, with the diff | 6.5, D1, D3, E2, QO0, B1 |
| `C11-search-sweep-gains-match` | A text search the agent is sweeping gains a match: rule-based repair | 2.6, QT1, HU1, D1 |
| `C12-search-gain-not-swept-triage` | A text search gains a match but the patch altered none of the old matches: triage zone, then re-affirmed | QT2, 7.3, 2.6 |
| `C13-listing-gain-additive-holds` | Two creature agents both listed creatures/ and each adds a file: the listing gain is unused, both land in one batch | L3, 9.4 step 3b, 2.5 |
| `C14-listing-gain-during-sweep` | An agent editing the existing files of a directory is told when the directory gains a file: rule-based repair | L1, HU1, T8 |
| `C15-replace-no-longer-applies` | Every premise holds, but the replace text now matches twice: the operation is dropped and the agent goes around | 5.3, OP2, OP6, OP7, OP8 |
| `C16-go-around-limit` | Three go-arounds are allowed; the fourth repair stops the attempt and opens a choice card | 11.1 GL1, T8, T9, GA1, GL3a, CK0 |
| `C17-contradiction-card` | A second repair on the same edited entity, caused by a different intent, opens a choice card instead of another go-around | GL3, T9c, E1 |
| `C18-held-path` | A change to a held path waits for one owner tap; the card shows the blast radius; landing then repairs the in-flight creature | 10.1 PO1, PO2, 10.2, T4, T13, 11.6, 9.3 |
| `C19-causal-undo-reopens-dependents` | Undo of the shared-rule change also reverts the creature that referenced it and reopens that creature's attempt; an unrelated creature stays | 11.3, UN1, UN2, UN3, UN5, T18, T19, E2 |
| `C20-restart-before-push-applied` | Trunk restarts between accepted and pushed, and main still has the old value: the same push is sent again | 9.6 LP3, LP6, 9.7 LP7, LP9, LP1 |
| `C21-restart-after-push-applied` | Trunk restarts after the push was applied but before it was recorded: reconciliation marks it landed without pushing again | 9.7 LP7, LP9, T16 |
| `C22-restart-diverged` | Trunk restarts and main has an unknown value: the pool pauses, nothing is called landed, writes are refused | 9.7 LP7, LP9, LP10 |
| `C23-duplicate-submit` | A retried submit and an unchanged second submit do not queue a second landing | TA2, CK0, 9.8 |
| `C24-right-of-way` | After two go-arounds an attempt gets right of way: a change that would send it around a third time waits | 11.2 RW1, RW2, RW3, RW5, LP2, 14.6 |
| `C25-changed-before-any-edit` | An entity the agent read changes before the agent has written anything: info heads-up, no go-around, no Clef | X0, HU2, 8.4 |
| `C26-heads-up-first` | An edit sent before the agent has seen a pending heads-up is refused and not recorded | TA3, HU7, HU8 |
| `C27-whole-file-write-base-changed` | A whole-file write needs a prior read, and is sent back when the file's bytes changed underneath, even cosmetically | W1, W4, F1, OP5, OP6, 7.2 |
| `C28-empty-change-rejected` | A change whose operations cancel out is rejected, not landed | CK3, T7, D2 |
| `C29-write-after-landing-needs-reread` | A whole-file write is refused when the file changed after the agent read it, even cosmetically and with no heads-up: the agent must read the bytes that are at head | W1, 3.2 shown, F2, V4 |
| `C30-blind-spot-after-meaning-change` | The shared rule changed before the creature's agent wrote anything, and the agent never read it: the blind-spot confirm at submit shows the current definition | 6.4, B1, B2, D1, QO0 |
| `C31-triage-window-new-reference` | While a triage is pending the agent adds code that references the changed entity: the rule rows are run again and decide (E2 repair); the late Clef answer is discarded | V7, 7.3 TR1, TR4, E2, TA3, V2 |
| `C32-retry-resumes-classified` | An attempt stopped on a choice card stays classified while the card is open; 'Try again' resumes it in a go-around with every waiting heads-up | GL3a, GL5, T21, 7.1, CK8, GA1 |
| `C33-edit-after-validated` | An operation accepted after a passing submit takes the attempt out of the landing queue; it must submit again | T22, 9.3, CK0, TA4 |
| `C34-edit-while-held` | An operation accepted while a held card is open closes the card as stale; the owner's tap on the old card does nothing; the new submit opens a new card | T22, T13, 10.2, PO2 |
| `C35-policy-change-in-batch` | A change validated as auto is behind a policy change in the same tick: the tier is checked again against the running state and the change goes to a held card | 9.4 step 3c, CK9, PO3, PO5, T4 |
| `C36-hero-sibling-reference-rule-lands-first` | The attempt edits one entity of a module whose other entity references the shared rule: the change of the rule gives a rule-based confirm with the diff | 6.3 ModuleRefs, D1, E2m, 6.5, T5 |
| `C37-hero-sibling-reference-edit-lands-first` | The other order: the edit of a module that references the shared rule lands while the shared-rule change is in flight; the referrer set is unchanged, the referrer module changed | 2.5 module hash, D2, QR1m, 8.2 context, 6.5 |
| `C38-reader-landed-triage` | A change whose agent read the shared rule but wrote plain numbers lands while the rule is being altered: no reference exists, so no rule decides; the altering attempt gets a triage | QR4, 7.3, 6.5 limits, TR1 |
| `C39-go-around-count-under-repeated-repairs` | A repair that arrives before the previous one was delivered joins the go-around; one that arrives after it was delivered starts a new go-around, so right of way engages | GA1, T10, T10a, HU8, RW1, RW3 |
| `C40-listing-gain-single-file-edit-holds` | An attempt that listed a directory and edits one of its files is not sweeping it: a new entry breaks nothing | L3, 7.2 sweeping, 14.4 |
| `C41-listing-gain-before-sweep` | A directory gains an entry after the agent listed it and before it edits: nothing is sent then (L3); when the attempt becomes a sweep, rule L1 fires at that operation | L1 late, L3, 3.2 shown, OP7 |
| `C42-search-gain-one-of-many-altered` | A text search with four matches gains a fifth; the attempt altered only one of the four, so it is not a sweep: triage, not a rule-based repair | QT2, QT1, 7.2 sweeping, TR1 |
| `C43-search-second-match-in-same-entity` | A second match appears inside an entity that already matched: the match count is part of the premise, so the change is seen | 2.6, QT0, X0, 2.5 |
| `C44-whole-module-reference-rule-lands-first` | A namespace import used with a computed key references the whole module: a change to any entity of that module is a rule-based repair | 6.2, D1, F3, 7.2 exhaustive |
| `C45-whole-module-reference-creature-lands-first` | The other order: a new whole-module referrer is a referrer of every entity of that module | 6.2 referrers, D2, QR1 |
| `C46-same-new-entity-added-twice` | Two changes add an entity with the same name to one module from different anchors: the absence each relied on is pinned, so the second is repaired with the diff | R4a, E1, 9.4 step 3b |
| `C47-confirm-pull-backs-are-counted` | A confirm that pulls an attempt out of the landing queue is counted; after two the attempt has right of way, and a candidate that would give it another rule-based confirm waits | T11, GA3, RW1, RW3, E2m, QR1m |
| `C48-right-of-way-holds-an-approved-landing` | Under a policy that holds shared rules, an owner-approved landing still waits behind an attempt with right of way | RW3, RW5, 10.2, 11.6 |
| `C49-land-now-bypasses-right-of-way` | The owner's explicit 'Land now' on a held card bypasses right of way; the attempt with right of way takes a third go-around | RW5, 10.2, GA1, T10a |
| `C50-push-main-applied-notes-not` | A push that updates main but not the notes ref: the landings are on main and are called landed; no new batch forms until the notes ref is updated | LP5, LP1, LP9, 9.6 |
| `C51-push-outcomes-by-ref-value` | After any push result that is not all-ok, Trunk reads both refs and decides by value | LP5, LP6, LP7 |
| `C52-restart-with-pending-triage` | Trunk restarts while a Clef answer is awaited: the question is asked again; with no answer the outcome is the fail-closed confirm | TR6, 7.3, LP7 |
| `C53-undo-plan-changed` | An undo is confirmed against the plan the owner saw; if the plan is different now, nothing lands and the new plan is returned. An undo landing is not an undo target | UN4, UN5a, 11.3 |
| `C54-second-repair-from-a-race-sibling` | A second E1 repair on the same entity caused by an attempt of the attempt's own intent (a Race sibling) is an ordinary go-around, not a contradiction | GL3, T8, E1 |
| `C55-info-heads-up-does-not-wake-or-close-a-card` | An info heads-up to an attempt waiting on a held card starts no model turn and leaves the card open; the pending triage blocks the owner's tap until it is answered | HE2, HU5, TR1, TR3, T13, 11.6 |
| `C56-replace-then-write-base-changed` | A whole-file write that follows a replace on the same path records its own base: when the file changes underneath, every operation on the path is dropped | W4, OP5, OP6, F1 |
| `C57-star-reexport-name-now-shadowed` | An import resolved through `export *` relied on the name being absent from the re-exporting module: that absence is pinned, so a local export added later is caught | 6.2 resolveExport, D1b, E2, HU2a |
| `C58-chosen-race-candidate-reopened-by-undo` | A race candidate that the owner chose is an ordinary attempt afterwards: reopened by an undo, its next submit follows its path tier and lands with no card | 11.4 RC1, RC2, RC4, RC7, T4, T13, T14, T19, 11.3, UN2, E2 |

Not covered by the vectors (the vectors exercise the pure core with real attempts only). Each of these needs a Durable Object, Workflow or reducer test in the build plan: the `stop` call (TA9, T20) and `resume` (RS1 to RS5, T20r); the revert-limit card (GL6, T19s); `changed` in `headsup.resolved` (HU12) and metric 14.4; event sources and delivery (EV2a, EM6); hibernatable sockets (EV7); `summary_only` (EV6, EM1a, PL1); the minimal held form (HD1); the Swarm route (SWR1 to SWR4); scripted triage (TR5, TR8, S6a); the unlock brake (SE2a); the check codes (GR8). As before: timers and alarms (AL1 to AL4), re-index and rebuild (RB1 to RB5), push time-out and poison batch (LP5a to LP5c), model gate accounting (SE6 to SE8), sandbox headers (SE13 to SE15), the green line (GR1 to GR7), preview commits (PV1 to PV5), note shrinking (NT2).

## Appendix B. Where each must-fix item is addressed

Items that concern rules or protocol are mapped to sections. Items that are schedule, scope or measurement work are marked as outside this file.

| Judge | Must-fix item (short) | Where |
| --- | --- | --- |
| Infrastructure | Pack and push `main` plus notes with compare-and-swap from a Durable Object; two-ref atomicity; recovery when evicted between accepted and on `main`; stock git reads the notes | 9.5 to 9.8, 3.5, S1, S2; vectors `C20` to `C22` |
| Infrastructure | Change the hero conflict; meaning change behind an unchanged signature plus a search catch; cite STORM and CoAgent, no "first" | 6.5, rows E2, QR1, QT1, L1; header and section 1; vectors `C04`, `C05`, `C11`, `C14` |
| Infrastructure | Premise precision rules before coding: entity level, holds/confirm/repair, derived premises, starvation after two go-arounds, target false-abort rate; a hot entity must not send every agent back | 2.3, 2.4, 7.2 (rows X0, L3, QT3, QO2, F2; the definitions of sweeping and swept), 6.3, 11.2, 14.4; vectors `C13`, `C40`, `C42` |
| Infrastructure | Show the sequencer is not a single integrator; report real-model repair latency separately | Definitions in 14.1, 14.2, 14.6, 14.7; batch design in 9.4. The measurement run is outside this file. |
| Infrastructure | Real-agent reliability gate; resume must use the authoring model or say otherwise | UN6, GL5, S5 |
| Infrastructure | Decide the verification runtime; protect the public address (caps, kill switch, Replay) | 11.5, S4, 13.2 to 13.4, 12.3. Turnstile, moderation and per-visitor caps belong to the crowd path, which is not in the submission build (13.2). |
| Originality | Correct the novelty claim; never "first" | Header, section 1 |
| Originality | Replace the headline conflict; show a meaning change and a search or listing gain; both landing orders | 6.5; rows QR1, QT1, L1; vectors `C04`, `C05`, `C10`, `C11`, `C14` |
| Originality | Deterministic catch; define repair, acknowledgement and re-affirm exactly; a changed body the agent read never re-affirms silently; enforce blind spots | 7.2, 7.3 (the `holds` outcome of triage still records and informs), 6.4, CK7, CK8 |
| Originality | Four day-1 spikes | S1, S2, S3, S5 |
| Originality | One primitive; scope cut | Outside this file (brief section 6). This file defines one primitive, the premise, and no second one. |
| Originality | Real shared code; hard rate and spend cap on public pages; neutral wording for the plain-merge pool | 13.2, 13.3, 11.7. The seed codebase is specified elsewhere. |
| Feasibility | Day-1 landing spike with pass/fail; container fallback | S1, S2 (measured on 2026-10-04; the hand-built push and the minted token work, so the container option is not built) |
| Feasibility | Model spike; keep-alive and recovery so an evicted agent ends in a recorded state | S5 and `05-agent.md` (the seeded-intent measurement); AG1 to AG4, AG8; T20, T20r, RS4 |
| Feasibility | Freeze one primitive and one engine; green line falls back to parse and import checks and says so | Section 5 (no merge engine), GR5, S4 |
| Feasibility | Take forks off the hot path | AG5, S3, 14.8; `attempts.attempt_repo` is never read on the landing path (3.2) |
| Feasibility | Deterministic hero conflict in either order through derived premises; fix "only referenced premises force a repair"; measure false aborts | 6.3, 6.5 (HC1 to HC4), 7.2 (last consequence), 14.4; vectors `C04`, `C05`, `C10`, `C36`, `C37` |
| Feasibility | Build the board against a scripted event stream, replay first; owner key and spend cap before sharing | Section 12 (the stream is the UI's only input, EV5), 12.3, 13.1, 13.3 |

## Appendix C. Constants

Values are starting values. *Calibrated* constants MUST be replaced by measured values before the submission recording, and the measurement kept in the repository.

| Constant | Value | Notes |
| --- | --- | --- |
| `TICK_MS` | 250 | |
| `MAX_BATCH` | 64 | landings per batch |
| `MAX_PACK_BYTES` | 8 MiB | well under the platform's pack limit |
| `MAX_PATH_LEN` | 120 | |
| `MAX_FILE_BYTES` | 32,768 | also keeps rows under the SQLite value limit |
| `MAX_POOL_FILES` | 2,000 | checked at submit (CK3a) |
| `MAX_POOL_BYTES` | 8 MiB | sum of file bytes at head; keeps `search` and a rebuild within memory |
| `MAX_QUERY_LEN` | 128 | |
| `MAX_SEARCH_LINES` | 50 | |
| `MAX_LIST_ENTRIES` | 500 | |
| `MAX_OPS` | 128 | |
| `MAX_PATHS` | 64 | policy may lower it; a sweep over every creature is one change |
| `MAX_CHANGE_BYTES` | 98,304 | policy may lower it |
| `MAX_PREMISES` | 256 | |
| `MAX_STATEMENT_CHARS` | 500 | |
| `MAX_INTENT_CHARS` | 500 | |
| `NOTE_MAX_BYTES` | 262,144 | NT2 |
| `NOTE_RESERVE_BYTES` | 16,384 | room for judgments added after the submit (CK3a) |
| `HEADS_UP_MAX_BYTES` | 262,144 | HU10 |
| `MAX_HEADS_UPS_PER_RESPONSE` | 8 | TA8 |
| `RESPONSE_HEADS_UP_MAX_BYTES` | 524,288 | TA8 |
| `REEXPORT_DEPTH` | 8 | |
| `TOOL_TIMEOUT_MS` | 10,000 | |
| `MODEL_TIMEOUT_MS` | 60,000 | |
| `MODEL_RETRIES` | 2 | |
| `AGENT_WATCHDOG_MS` | 30,000 | AG3: a call in progress with a future deadline is progress |
| `MAX_STEPS` | 40 | |
| `MAX_MODEL_CALLS` | 30 | |
| `MAX_ATTEMPT_TOKENS` | 400,000 | calibrated (S5) |
| `MAX_ATTEMPT_USD` | 1.00 | calibrated (S5); never reset (AG6) |
| `RESUME_STEPS`, `RESUME_MODEL_CALLS`, `RESUME_TIMEOUT_MS` | 15, 12, 300,000 | allowance after T19 or T21 (AG6) |
| `MAX_REVISIONS` | 3 | revisions per attempt before the owner is asked: at most two reopens happen by themselves, then the revert-limit card (GR3a, T19s, GL6) |
| `RESUME_ACK_TIMEOUT_MS` | 30,000 | how long Trunk waits for the Agent's answer to `resume` before `reopen_failed` (RS1, RS4). Not the time allowance `RESUME_TIMEOUT_MS` of AG6. |
| `RESERVATION_MARGIN_MS` | 10,000 | SE6a |
| `REGISTER_TIMEOUT_MS` | 30,000 | 3.6 step 8 |
| `ATTEMPT_TIMEOUT_MS` | 600,000 | owner waiting time on a card is excluded |
| `GO_AROUND_LIMIT` | 3 | fixed by the brief |
| `STARVATION_AFTER` | 2 | |
| `RIGHT_OF_WAY_MS` | 120,000 | |
| `HEADS_UP_REPUSH_MS` | 5,000 | |
| `T_REPAIR` | 0.70 | calibrated (S6) |
| `T_CONFIRM` | 0.20 | calibrated (S6) |
| `T_INTENT_MIN` | 0.50 | calibrated (S6) |
| `T_UNRELATED_MAX` | 0.50 | calibrated (S6) |
| `T_SHARED_MAX` | 0.50 | calibrated (S6) |
| `T_CONTRADICT` | 0.80 | calibrated (S6) |
| `CLEF_TIMEOUT_MS` | 2,000 | from dispatch (TR6) |
| `CLEF_STATE_MAX_CHARS` | 60,000 | below the smaller Clef context window; a larger state is unavailable, never cut (TR7) |
| `CLEF_MAX_QUESTIONS` | 64 | per request; calibrated (S6) |
| `CLEF_INPUT_TOKEN_LIMIT` | 60,000 | calibrated (S6); TR7 |
| `CLEF_TRIAGE`, `CLEF_RISK`, `CLEF_CONTRADICTION` | `off` | switches; `on` only after the thresholds are calibrated (S6b); always `off` when `features.clef` is false |
| `CLEF_TRIAGE_MODEL_ID`, `CLEF_TRIAGE_MODEL` | `@cf/cloudflare/clef`, `clef` | S6; fallback `@cf/cloudflare/clef-flash`, `clef-flash` |
| `CLEF_RISK_MODEL_ID`, `CLEF_RISK_MODEL` | `@cf/cloudflare/clef`, `clef` | S6 |
| `DEFAULT_GLOBALS` | the 16 names of the `globals` list in 10.1 | PO4; one constant in the `protocol` module |
| `PUSH_BACKOFF_BASE_MS` | 250 | |
| `PUSH_BACKOFF_MAX_MS` | 30,000 | |
| `PUSH_STALL_MS` | 5,000 | |
| `PUSH_TIMEOUT_MS` | 20,000 | abort signal on every push and ref read (LP5c) |
| `PUSH_REJECT_LIMIT` | 5 | LP5b |
| `TICK_CPU_BUDGET_MS` | 100 | LP2b |
| `REBUILD_CALLS_PER_RUN` | 200 | RB3; well under the namespace rate limit |
| `UNDO_WINDOW` | 200 | landings |
| `RACE_SIZE` | 3 | |
| `GREEN_MIN_INTERVAL_MS` | 2,000 | GR1 |
| `GREEN_TIMEOUT_MS` | 60,000 | GR6 |
| `GREEN_LOG_MAX_CHARS` | 4,000 | |
| `GREEN_CPU_MS` | 5,000 | CPU limit of the verifier's isolate (GR6, S4a); calibrated on the full pool |
| `MAX_FORKS_IN_FLIGHT` | 4 | S3a; from the platform record (15 of 20 concurrent forks usable) |
| `FORK_RETRIES`, `FORK_BACKOFF_BASE_MS` | 3, 2,000 | S3a; the backoff doubles |
| `PREVIEW_REF_PREFIX` | `refs/previews/` | PV1; the fallback is `refs/heads/previews/` (PV1a) |
| `METRICS_WINDOW_MS` | 10,000 | |
| `METRICS_EVERY_MS` | 1,000 | EM5 |
| `LIMITS_EVERY_MS` | 1,000 | SE9: the shortest interval between two `limits` events for spend or bucket changes |
| `FLOOR_KEEP_LANDINGS` | 200 | FS1; the one name for this window in every file |
| `FALSE_ABORT_TARGET` | 0.05 | calibrated with the Swarm |
| `ESCAPE_TARGET` | 0 | |
| `SPEND_CAP_USD` | 40 | the owner's budget is 50; the cap leaves a margin for non-model usage |
| `MAX_REAL_AGENTS` | from S5 | |
| `PUBLIC_RATE_PER_MIN` | 120 | per client address (SE21) |
| `APP_FILE_RATE_PER_MIN` | 1,200 | per client address, commit-addressed files, cache misses only (SE21) |
| `MAX_SOCKETS_PER_ADDR` | 8 | counted by socket tag (EV7) |
| `UNLOCK_FAILS_PER_MIN` | 10 | failed unlocks per client address per minute, then 429 (SE2a) |
| `READ_TOKEN_TTL_S` | 3,600 | SE5c |
| `SESSION_TTL_S` | 43,200 | |

---

## Changes after review

Revision 2. Two adversarial reviews (correctness, platform) and the two parallel specifications (`02-tidepool.md`, `03-floor.md`) were applied. Every high and medium finding was accepted, except where a row says "in part". Vector format is now `premise-cases/2`: 57 cases (29 new), 23 hash cases, 5 inbox cases.

### Review findings, correctness

| # | Finding | What changed, and why | Vectors |
| --- | --- | --- | --- |
| 1 (high) | A patch could gain a reference to a changed entity while a Clef answer was pending and land with only an `info` | TR1: the diff is delivered in the accept transaction as a `pending` item, so TA3 holds before any write. V7: operations that change during a pending triage run the rule rows again; a Clef answer for an older patch is discarded (TR4). | `C31`, `C06`, `C07`, `C12` |
| 2 (high) | A whole-file `write` could overwrite another landing after a silent re-pin; a `write` after a `replace` had no base check | New premise value `shown` (3.2): W1 needs a whole-file read of the bytes at head. W4 and OP5 now apply to every `write`. | `C29`, `C56`, `C27` |
| 3 (high) | The hero catch missed a reference in an unaltered sibling entity, a hard-coded number, and the breaking line in the heads-up | `ModuleRefs`, rows E2m, F3m, QR1m (module-level references give a rule-based `confirm`). D1 now pins at every operation, which the reviewer's fix needed to be deterministic in order 1. Module hash in `refs:` members. `context` in query items. Row QR4 (the mirror of E3). Limits stated in 6.5 (HC3). | `C36`, `C37`, `C38`, `C10`, `C30`, `C05` |
| 4 (high) | An attempt hit faster than its model turn stayed in one uncounted go-around | T10a and GA1: a `repair` that arrives after the previous one was delivered starts a new go-around, so right of way and the limit engage. | `C39` |
| 5 (high) | "Try again" resumed an attempt with unclassified, stale premises | GL3a: a stopped attempt with an open choice card is parked and stays classified. T21 enters `going_around`; every missed change must be acknowledged. | `C32` |
| 6 (high) | Operations accepted after validation landed without the submit checks | T22: such an operation returns the attempt to `working` and closes its card. 9.3 and T13 compare a recomputed `submit_id`. The tick re-runs CK9 with the running policy. | `C33`, `C34`, `C35` |
| 7 | An out-of-order push could make a heads-up count as delivered unseen | HU6a (the Agent shows no gap and calls `sync`), HU5 (a push carries all heads-ups not yet received), TA8. | `inbox_cases` |
| 8 | L1 and QT1 sent back attempts that were not sweeping | "Sweeping" and "swept" need operations on `min(2, n)` members. L1 is also checked late, at the operation that makes the attempt a sweep. | `C14`, `C40`, `C41`, `C42` |
| 9 | Whole-module references matched no row | F3 and F5 cover `P ∈ NewRefs`; referrers include whole-module referrers; V5 and row Z1 make the table fail closed. | `C44`, `C45` |
| 10 | A second match inside a matching entity was invisible; scope recursion undefined | Text members carry the match count; a directory scope is recursive (2.6). | `C43`, `H20` |
| 11 | Absence was not pinned for added entities and for names resolved through `export *` | R4a (entity pinned at `absent` with `edit`), D1b (negative lookups). | `C46`, `C57` |
| 12 | Confirm loops were unbounded | T11 counts pull-backs; the limit and right of way use `sent_back` (GA3); RW3 also yields to rule-based confirms. | `C47`, `C52` |
| 13 | Right of way did not apply to owner-approved landings | RW5: an approved held landing waits like any candidate; the card states the consequence; only "Land now" bypasses. | `C48`, `C49` |
| 14 | Push outcomes were not exhaustive; `notes_pending` could stall | LP5 decides by the values of both refs after any result that is not all-ok; LP5a to LP5c add token refresh, backoff, a poison-batch pause and a time-out. | `C50`, `C51` |
| 15 | A rebuild could lose or duplicate an accepted landing | RB1 (reconcile first), re-index separated from rebuild (RB2), T17a for a change already on the rebuilt `main`, stop reason `lost`. | (Durable Object tests) |
| 16 | A pending triage was lost on restart | TR6 and the `triage` timer. | `C52` |
| 17 | Tick side effects were outside the transaction; PO5 contradicted step 3c | LP2a (one transaction, dry run in 3b, skips committed with an empty batch), CK9 in 3c. | `C35` |
| 18 | Undo needed blob contents and its plan could drift | `blobs` table; UN5 confirms against `expect_reverted`; UN8 sets `base_oid` of a reopened `write`. | `C53`, `C19` |
| 19 | Green-line reverts were unbounded | `MAX_REVISIONS` and T19s; T19 no longer resets the count; revert requests are exempt from the size refusals; a red result is confirmed by a second run (GR3). No pause was added: the revert range is fixed when queued and lands in the next tick (GR3a). | (Workflow tests) |
| 20 (low) | Ambiguous wording | GL3 ("an intent other than the attempt's own"), `validated_at` in T12 and T13, HU6, KH2 (a listing is never `absent`), row CKL. UN7 was deleted: an undo landing cannot be undone. | `C54`, `C53` |
| 21 (low) | Byte-level determinism | NT1 to NT3 (note bytes), CM1 to CM5 with a commit whose id real git confirms, packs tested by `git index-pack`, non-finite number literals in 2.4. | `H21` to `H23` |

### Review findings, platform

| # | Finding | What changed |
| --- | --- | --- |
| 1 (high) | Operations after validation or after a held card | As correctness 6. |
| 2 (high) | The sandbox existed only inside the Floor's iframe | SE13: the CSP `sandbox` directive on every app-server response; `form-action`, `base-uri`; the Floor's own CSP (SE14a); JSON-only request bodies (SE3); the content-type table (SE15); previews are immutable preview commits, and no route serves a live attempt view (PV1 to PV4). A separate host is required only when the deployment has one (SE14b): the response-level sandbox is the boundary either way. |
| 3 (high) | A deploy-triggered rebuild could discard the outbox and in-flight state, and restart event numbering | 3.6: re-index keeps all state; RB1; event `epoch` (RB5); the Floor re-registers agents and closes cards. |
| 4 | Push outcome table | As correctness 14; `Pusher.readRefs` reads the ref advertisement. |
| 5 | Hashing and deflate must be synchronous | SY1, SY2. |
| 6 | One alarm slot, several timers | `timers` table, AL1 to AL4; AG2 and AG3 rewritten (progress, exempt waits, start-up without a journal row). |
| 7 | An `info` heads-up woke waiting agents and was re-pushed for ever | Received, delivered and resolved are separate (8.3); `wake` (HE2). Vector `C55`. |
| 8 | Clef could judge a cut patch | TR7 (never cut; unavailable), one request per attempt per batch, TR8 (`ScriptedTriage` for synthetic attempts), TR9. |
| 9 | Spend-cap accounting at the edges | SE6, SE6a, SE7, SE8; `MAX_ATTEMPT_USD`; AG6; stop reason `spend_cap`. |
| 10 | Unbounded single rows | SQ2, HU10, TA8, snapshot parts, NT2, CK3a. |
| 11 | Free-text error fields could carry a token | SE5a (`redact`), SE5b (codes), SE5c (read tokens), RP1. |
| 12 | Public routes reached Trunk and Artifacts | SE19 to SE22, FS2. |
| 13 | Rebuild and tick had no budget | RB3, RB4, LP2b, stored sets (9.4 "Cost"). |
| 14 | S2 option B was incomplete | `writeTarget`, `repo_generation`, rotation rules. |
| 15 | Green line under continuous landings | GR1 (one at a time, no debounce), GR3, GR3a. |
| 16 | Verifier isolation | GR6, GR7, HE4. |
| 17 (low) | Storage details | `MAX_POOL_FILES`, `MAX_POOL_BYTES`, SQ1, rowid tables, retention (3.2). |
| 18 (low) | Event time | `ts` on every event; metrics use `ts`; EV3. |
| 19 (low) | Wordings | Author line (CM), `accepted` in `SubmitResult` (vector `C23`), `Origin` rule (SE3). |

### From the tide pool specification

| Their item | Decision |
| --- | --- |
| Generated `~` modules (SE15), channel types (SE16), separate file rate limit | Adopted: SE15, SE16 (with `advance`, `highlight` and `tapped.path` from the Floor), SE21. |
| An event for the plain-merge repository | `plain.updated` (PM6). |
| Previews by a read-only Trunk call | Not adopted. Previews are preview commits (PV1), so public requests never reach Trunk. |
| A listing gain before the first edit is missed | Fixed by the late L1 check, not by an `info` heads-up (which would bounce every creature agent's first write). |
| B1 fired for references that already existed | Adopted: blind spots are limited to `AddedRefs` (B1a). |
| Direct references only; the literal-number case | Stated limits HC3; S5 measures the share. |
| `ops_first` and half-finished work; two attempts creating one file | PM4 (interrupted), PM3 (a moved base counts as a text conflict). |
| L2 for any named kind | Adopted: only gained or lost names. |
| `MAX_PATHS` 16 | Raised to 64 (`MAX_OPS` to 128); a pool's policy may lower it. |
| L3 judgments at Swarm scale | Kept as rows; their events are not emitted in `summary_only` pools (EV6, as restated in the reconciliation); the scale run reports tick CPU time. |
| The example policy | Replaced by the tide pool's file (10.1). |

### From the Floor specification

| Their item | Decision |
| --- | --- |
| N1, N3, N5 to N12, N14, N15, N17, N20, N21, N23 | Adopted in 12.1 (`headsup.sent.items`, `note_json`, second `premise.judged`, `premise.removed`, `pool.files`, tokens and cost on `attempt.step`, per-attempt blast radius, `spend_cap` and `limits.refusing`, `attempt.repo`, `swarm.state.pools` and EV6, `prewritten`, `remote`, card reasons and actions, EM1, `request_id` on `landing.accepted`). |
| N2 | `plain.updated`. |
| N4 | Option (a): preview commits; `Card.preview` with `FrameAddress`. |
| N13 | The `metrics` event is authoritative for 14.1 to 14.6 (EM5). |
| N16, N19, N22, N25 | Routes fixed in 13.6; stop reason `cancelled`; undo plan and refusal reasons (11.3); `{ killed: false }` resumes; an undo landing cannot be undone. |
| N18 | Channel schema in SE16. |
| N24 | RC5: the race card stays open and is updated; CD2. |

---

## Changes in reconciliation (2026-10-04)

Inputs: the lead's decisions, the cross-document critic's findings F01 to F43, the architect's corrections for `02-tidepool.md` and `03-floor.md`, the planner's gaps GP1 to GP5, and the platform record. No rule id was renumbered. New rules have new ids. The vector format is still `premise-cases/2`: 58 cases (one new, `C58`), 23 hash cases, 5 inbox cases. No expected value of `C01` to `C57` changed.

### Lead decisions

| Decision | What changed in this file | Section |
| --- | --- | --- |
| Platform: push path, landing atomicity | Section 15 S1 rewritten as chosen, with evidence and fallback (S1a to S1c); LP4 states the measured behaviour; the rebuild reads notes by object id | 15 S1, 9.6 LP4, 3.6 |
| Platform: tokens | S2 chosen (`createToken()`), S2a (only Trunk holds a write token), S2b; SE5 | 15 S2, 13.1 SE5 |
| Platform: attempt repositories | S3 chosen (`fork()` off the landing path, at most four in flight), S3a to S3c; constants `MAX_FORKS_IN_FLIGHT`, `FORK_RETRIES`, `FORK_BACKOFF_BASE_MS` | 15 S3, 3.5, Appendix C |
| Platform: reading pool files | New port item S7 (S7a, S7b): reads by commit id; what the binding resolves | 15 S7, 13.2 SE19, 3.6 |
| Platform: green-line runtime | S4 chosen (Dynamic Worker isolate), S4a to S4c; GR5, GR6; `GREEN_CPU_MS`; HC3 (a) says what the self-test does not catch | 15 S4, 11.5, 6.5 |
| Platform: models | S5 starting plan; MP1 (measured request shape), MP2 (the final mix follows the seeded-intent measurement) | 15 S5 |
| Platform: Clef | S6 chosen (`clef` for triage and risk, `clef-flash` as fallback), S6b (thresholds stay calibrated); the triage request names `clef`; constants `CLEF_TRIAGE_MODEL_ID`, `CLEF_RISK_MODEL_ID` | 15 S6, 7.3, Appendix C |
| 1. Live pool frame | SE16a: live frames use `main` and `plain` and receive `probe`; commit frames (Replay, card previews) use `FrameAddress` and `advance` | 13.5 SE16, SE16a |
| 2. Card options | CD4: the options of every card kind and reason; GL6: the `revert_limit` card offers `retry` and `stop`; T19s and T21 follow | 10.3, 11.1, 9.2 |
| 4. Stopping from the Agent side | Agent-only call `stop { attempt_id, reason }` (TA9, TA9a, `AgentStopReason`); stop reason `withdrawn`; AG2 and T20 use the call | 4.1, 9.1, 9.2, 3.3 |
| GP1 | PV5: source segment `p-<40 hex>` for a commit of the plain-merge repository, and the mapping from `FrameAddress` | 10.2 |
| GP2 | The Swarm route takes `SwarmRequest` with `pool`, `patterns`, `release` (SWR1 to SWR4) | 13.6 |
| GP4 | PL1 names the seeds `tidepool`, `tidepool-auto`, `tidepool-swarm` | 13.6 |
| GP5 | The per-pool flag `summary_only` (PL1, `pool.state.summary_only`). EV6, FS1, JE1, `headsup.sent.items`, `landing.landed.note_json` and the note route are restated for `summary_only` pools; nothing is suppressed because an attempt is synthetic. EM1a defines `pool.state.synthetic`. | 12.1, 3.4, 7.5, 13.6, 1 |
| Held tier in every build | HD1: the minimal form of T4, T13 and T14 | 10.2, 9.2 |
| Agent prompt and tools | Pointer to `05-agent.md`: new section 4.11 (PR1), and at every mention of the prompt or the tool definitions | header, 4, 4.9, 4.10, 4.11, 6.5 |
| Waking or restarting an Agent | The call `resume` (RS1 to RS5), transition T20r, AG8, `attempts.resumes`, `RESUME_ACK_TIMEOUT_MS`; UN6a defines `new_attempt` | 8.3, 9.2, 3.3, 11.3 |
| Early model measurement | MP2 says the first run needs no engine; the protocol is in `05-agent.md` | 15 S5, 4.11 |

### Critic findings

| Finding | What changed in this file | Section |
| --- | --- | --- |
| F01 | As decision 1: SE16a; the comments of `probe`, `advance`, `highlight` | 13.5 |
| F02 | As decision 2: CD4, GL6; the card route names `attempt_id` for `choose` | 10.3, 11.1, 13.6 |
| F04 | As decision 4: `stop`, `withdrawn` (17 stop reasons) | 4.1, 9.1 |
| F05 | Section 4.11 points to `05-agent.md` (the lead moved the prompt and the tool definitions there) | 4.11 |
| F06 | `resume`, RS1 to RS5, T20r; AG8 says the Agent side belongs to every build | 8.3, 9.2, 3.3 |
| F07 | RC7: a chosen candidate's race flag is cleared; `attempts.race`; RC1 says when the race card opens; vector `C58` | 11.4, 3.2, Appendix A |
| F08 | `plain.updated` gains `tree`; PM7 defines "no visible difference" by tree equality | 11.7, 12.1 |
| F09 | Client route `GET /p/{pool}` | 13.6 |
| F14 | `headsup.resolved` gains `result`, `go_around`, `changed` (HU12, `heads_ups.op_mark`); 14.4 is defined from it for every pool; 14.3 is decided from `headsup.sent`, not from `note_json`; 14.5 on screen is green-line reverts only; truth-label numbers go to `SoakResult` | 8.3, 12.1, 14, 3.2 |
| F15 | EV2a: the sources `trunk`, `agent:<id>`, `gate`, `swarm`, `floor`; per-pool counters; registration at pool creation; `EventBase.src`; EM6; SE9 | 12.2, 12.1, 3.4, 13.3 |
| F16 | Ports `SyncTriage.judgeNow` and `Triage.judge`; `TriageInput`; TR5 and TR8 restated (`ScriptedTriage`, `OffTriage`, the truth list, p = 1 or 0) | 15 S6, 7.3, 3.2 |
| F17 | CD5: card texts come from the pure `copy` module | 10.3 |
| F18 | FS2: the app server's `seq` and per-path order come from the Floor's state | 3.4 |
| F19 | GR8: the fixed list of check names and codes | 11.5 |
| F20 | GR3 states what `confirmed` means and that a first failed run announces nothing | 11.5, 12.1 |
| F21 | FJ1: the type `Features` and the code `feature_off` | 13.6 |
| F22 | UN4 says an unrelated landing is in no list; the type `UndoPlan` | 11.3 |
| F25 | `withdrawn` is the stop reason a sweep pattern uses when it gives up (TA9a) | 4.1 |
| F26 | `UndoPlanResponse`, `UndoResponse` (the new plan with `plan_changed`); SE19 says what `green` resolves to before any green commit | 11.3, 13.2 |
| F27 | The flag is named `summary_only` (the lead's name), applied as under GP5 | 12.1, 3.4, 7.5, 13.6 |
| F28 | EV7: hibernatable sockets; FS3 | 12.2, 3.4 |
| F29 | (g): `FLOOR_KEEP_LANDINGS` is the one name for the window | Appendix C |
| F30 | The platform record's experiments are cited as X1 to X9; glossary rows "Landed commit" and "Card" | header, 1 |
| F31 | `max_paths` is 64 in the example policy | 10.1 |
| F32 | 14.7 ends at the first `submit.result` of status `validated`, `submitted` or `held`; p50 and p90 | 14 |
| F33 | S1 lists memory, pack size and SQLite size as not yet measured, with their owner | 15 S1 |
| F35 | `card.closed` gains `attempt_id`; `reason` is only the typed reason (CD1, RC4) | 10.3, 11.4, 12.1 |
| F39 | PO4: the constant `DEFAULT_GLOBALS` | 10.1, Appendix C |
| F40 | PV1a: the fallback ref for preview commits; `PREVIEW_REF_PREFIX` | 10.2 |
| F42 | SE2a: at most `UNLOCK_FAILS_PER_MIN` failed unlocks per address per minute, then 429 | 13.1, 13.2, 13.6 |
| F43 | RB0: what a rebuild from Artifacts does not bring back | 3.1 |
| F03, F10 to F13, F23, F24, F34, F36 to F38, F41 | No change in this file. Their corrections are in `02-tidepool.md`, `03-floor.md` or `04-build-plan.md`, and this file is their reference (D1, HU2a, QT1, L2, PM3, SE15, HC3 are unchanged). | |

### Architect's corrections and notes for the lead

| Item | What changed in this file | Section |
| --- | --- | --- |
| S5 must report the share that references `ENERGY_MAX` and the cost of an E2m confirm | MP2 | 15 S5 |
| S6 must measure questions per request, the truncation point and QR4 cases | "Not yet measured" of S6 | 15 S6 |
| S2 must measure the lifetime of a `create()` token and what a fork copies | "Not yet measured" of S2 (needed only for the fallback) | 15 S2 |
| Rules not covered by vectors | The list after the case index, extended by the rules added here | Appendix A |
| Corrections for `02-tidepool.md` and `03-floor.md` | No change here: they bring those files to this file's revision 2. | |
