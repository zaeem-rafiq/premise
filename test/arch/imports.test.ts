// docs/spec/04-build-plan.md 1.3, mechanism 2: the import allow list.
// Expected results come from the table in the plan, never from what the code happens to import (BP1).

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { FIXTURES, format, violationsIn, violationsUnder } from "./import-rules.ts";

/** The reasons `violationsIn` gives for one file with this source text. */
function reasons(file: string, text: string): string[] {
  return violationsIn(file, text).map((violation) => violation.reason);
}

function allowed(file: string, text: string): void {
  expect(reasons(file, text)).toEqual([]);
}

function refused(file: string, text: string): void {
  expect(reasons(file, text)).toHaveLength(1);
}

describe("import allow list: the repository", () => {
  it("no file under src/, test/ or scripts/ imports outside its row of the table", () => {
    const violations = violationsUnder(REPO_ROOT, [FIXTURES]);
    expect(format(violations)).toBe("");
  });
});

describe("import allow list: the negative fixture", () => {
  it("rejects a file under a fake core path that imports cloudflare:workers", () => {
    const violations = violationsUnder(join(REPO_ROOT, FIXTURES, "imports"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/core/fake/uses-cloudflare.ts",
      line: 4,
      specifier: "cloudflare:workers",
    });
  });
});

describe("import allow list: each row of the table", () => {
  it("src/protocol/** may import src/protocol only", () => {
    allowed("src/protocol/events.ts", `import type { PremiseRef } from "./premise.ts";`);
    allowed("src/protocol/reducer/index.ts", `import { EVENT_TYPES } from "../events.ts";`);
    allowed("src/protocol/events.ts", `import { MAX } from "./constants.ts";`);
    refused("src/protocol/ids.ts", `import { H } from "../core/sync/h.ts";`);
    refused("src/protocol/ids.ts", `import { createHash } from "node:crypto";`);
    refused("src/protocol/redact.ts", `import { text } from "../copy/index.ts";`);
  });

  it("src/protocol/constants.ts imports nothing, because src/host/** takes values from it", () => {
    allowed("src/protocol/constants.ts", `export const ONE = 1;`);
    refused("src/protocol/constants.ts", `import { EVENT_TYPES } from "./events.ts";`);
    refused("src/protocol/constants.ts", `import type { PremiseKind } from "./premise.ts";`);
    refused("src/protocol/constants.ts", `export * from "./ids.ts";`);
    refused("src/protocol/constants.ts", `import { createHash } from "node:crypto";`);
    expect(reasons("src/protocol/constants.ts", `import { EVENT_TYPES } from "./events.ts";`)).toEqual([
      "src/protocol/constants.ts may not import src/protocol/events.ts. It may import nothing.",
    ]);
    // Its test file is an ordinary test file of src/protocol.
    allowed("src/protocol/constants.test.ts", `import { expect, it } from "vitest";`);
    allowed("src/protocol/constants.test.ts", `import { ONE } from "./constants.ts";`);
  });

  it("src/copy/** and src/config/** may import src/protocol", () => {
    allowed("src/copy/index.ts", `export * from "./cards.ts";`);
    allowed("src/copy/cards.ts", `import type { Card } from "../protocol/cards.ts";`);
    allowed("src/config/features.ts", `import type { FloorJson } from "../protocol/floor-json.ts";`);
    refused("src/copy/cards.ts", `import { tier } from "../core/policy/tier.ts";`);
    refused("src/config/pools.ts", `import { text } from "../copy/index.ts";`);
    refused("src/config/model-plan.ts", `import { env } from "cloudflare:workers";`);
  });

  it("src/core/sync/** may import node:crypto and node:zlib, and nothing else outside itself", () => {
    allowed("src/core/sync/sha1.ts", `import { createHash } from "node:crypto";`);
    allowed("src/core/sync/deflate.ts", `import { deflateSync } from "node:zlib";`);
    allowed("src/core/sync/h.ts", `import { sha1 } from "./sha1.ts";`);
    refused("src/core/sync/h.ts", `import { readFileSync } from "node:fs";`);
    refused("src/core/sync/h.ts", `import { MAX } from "../../protocol/constants.ts";`);
    refused("src/core/sync/h.ts", `import { text } from "../../copy/index.ts";`);
  });

  it("src/core/** may import src/core, src/protocol, src/copy and acorn", () => {
    allowed("src/core/entities/parse.ts", `import { parse } from "acorn";`);
    allowed("src/core/keys/key.ts", `import { H } from "../sync/h.ts";`);
    allowed("src/core/trunk/engine.ts", `import type { Sql } from "../../protocol/ports.ts";`);
    // Trunk fills card texts from src/copy (CD5).
    allowed("src/core/trunk/cards.ts", `import { text } from "../../copy/index.ts";`);
    refused("src/core/keys/key.ts", `import { createHash } from "node:crypto";`);
    refused("src/core/trunk/tick.ts", `import { DurableObject } from "cloudflare:workers";`);
    refused("src/core/trunk/cards.ts", `import { features } from "../../config/features.ts";`);
    refused("src/core/agent/inbox.ts", `import { Agent } from "../../worker/agent/agent-do.ts";`);
  });

  it("src/swarm/** may import src/core/sync and src/protocol", () => {
    allowed("src/swarm/prng.ts", `import { H } from "../core/sync/h.ts";`);
    allowed("src/swarm/pattern.ts", `import type { SwarmConfig } from "../protocol/swarm.ts";`);
    allowed("src/swarm/patterns/add-plain.ts", `import { next } from "../prng.ts";`);
    refused("src/swarm/oracle.ts", `import { entities } from "../core/entities/parse.ts";`);
    refused("src/swarm/pattern.ts", `import { parse } from "acorn";`);
    refused("src/swarm/casts/hero.ts", `import { text } from "../../copy/index.ts";`);
  });

  it("src/host/** may import src/host, types only from src/protocol/channel.ts, and src/protocol/constants.ts", () => {
    allowed("src/host/main.ts", `import { boot } from "./boot.ts";`);
    allowed("src/host/main.ts", `import type { FloorToPool } from "../protocol/channel.ts";`);
    allowed("src/host/main.ts", `export type { PoolToFloor } from "../protocol/channel.ts";`);
    allowed("src/host/main.ts", `type Message = import("../protocol/channel.ts").FloorToPool;`);
    allowed(
      "src/host/main.ts",
      `import { DEFAULT_GLOBALS, HEAD_POLL_MS, STATS_EVERY_MS } from "../protocol/constants.ts";`,
    );
    refused("src/host/main.ts", `import { check } from "../protocol/channel.ts";`);
    refused("src/host/main.ts", `import { type FloorToPool } from "../protocol/channel.ts";`);
    refused("src/host/main.ts", `import type { PoolEvent } from "../protocol/events.ts";`);
    refused("src/host/main.ts", `import { EVENT_TYPES } from "../protocol/events.ts";`);
    refused("src/host/main.ts", `import { createRoot } from "react-dom/client";`);
  });

  it("src/floor/** may import src/floor, src/protocol, src/copy, react and react-dom", () => {
    allowed("src/floor/main.tsx", `import { createRoot } from "react-dom/client";`);
    allowed("src/floor/main.tsx", `import { StrictMode } from "react";`);
    allowed("src/floor/main.tsx", `import "./styles/base.css";`);
    allowed("src/floor/state/store.ts", `import { reduce } from "../../protocol/reducer/index.ts";`);
    allowed("src/floor/components/strip/strip.tsx", `import { text } from "../../../copy/index.ts";`);
    refused("src/floor/state/store.ts", `import { classify } from "../../core/classify/table.ts";`);
    refused("src/floor/main.tsx", `import { notBuilt } from "../worker/not-built.ts";`);
    refused("src/floor/main.tsx", `import { parse } from "acorn";`);
    refused("src/floor/main.tsx", `import { render } from "react-domino";`);
  });

  it("src/worker/** may import everything under src except src/floor and src/host, cloudflare:workers and node:*", () => {
    allowed("src/worker/trunk/trunk-do.ts", `import { DurableObject } from "cloudflare:workers";`);
    allowed("src/worker/trunk/sql.ts", `import { Buffer } from "node:buffer";`);
    allowed("src/worker/trunk/trunk-do.ts", `import { engineTable } from "../../core/trunk/engine.ts";`);
    allowed("src/worker/routes/swarm.ts", `import { patterns } from "../../swarm/pattern.ts";`);
    allowed("src/worker/index.ts", `export { Trunk } from "./trunk/trunk-do.ts";`);
    refused("src/worker/index.ts", `import { App } from "../floor/app/app.tsx";`);
    refused("src/worker/app-server/boot.ts", `import { startHost } from "../../host/main.ts";`);
    refused("src/worker/adapters/pusher/push.ts", `import git from "isomorphic-git";`);
    refused("src/worker/trunk/sql.ts", `import { connect } from "cloudflare:sockets";`);
  });

  it("a file under src/ that is in no zone is refused, whatever it imports", () => {
    refused("src/tools/helper.ts", `export const one = 1;`);
  });
});

describe("import allow list: test files", () => {
  it("a test file may also import vitest, node:* and test/support", () => {
    allowed("src/core/keys/key.test.ts", `import { expect, it } from "vitest";`);
    allowed("src/core/keys/key.test.ts", `import { readFileSync } from "node:fs";`);
    allowed("src/core/keys/key.test.ts", `import { REPO_ROOT } from "../../../test/support/source.ts";`);
    allowed("src/protocol/redact.test.ts", `import { describe } from "vitest";`);
  });

  it("a test file gets nothing else on top of its zone", () => {
    refused("src/core/keys/key.test.ts", `import { DurableObject } from "cloudflare:workers";`);
    refused("src/core/keys/key.test.ts", `import { Miniflare } from "miniflare";`);
    refused("src/core/keys/key.test.ts", `import { features } from "../../config/features.ts";`);
    refused("src/core/sync/h.test.ts", `import { text } from "../../copy/index.ts";`);
  });

  it("a file that is no test file does not get the test extras", () => {
    refused("src/core/keys/key.ts", `import { expect } from "vitest";`);
    refused("src/core/keys/key.ts", `import { REPO_ROOT } from "../../../test/support/source.ts";`);
  });
});

describe("import allow list: rules for every checked file", () => {
  it("no file under src/, test/ or scripts/ imports from reference/ (BP6)", () => {
    refused("src/core/git/pack.ts", `import { buildPack } from "../../../reference/artifacts-spike/src/rawgit.ts";`);
    refused("test/git/pack.test.ts", `import { buildPack } from "../../reference/artifacts-spike/src/rawgit.ts";`);
    refused("scripts/soak/run.ts", `import { sim } from "../../reference/spec-sim/sim.mjs";`);
    refused("src/worker/trunk/sql.ts", `import { fs } from "../../../reference/artifacts-spike/src/memory-fs.ts";`);
  });

  it("tests and scripts outside src/ are otherwise free", () => {
    allowed("test/workerd/smoke.test.ts", `import { Miniflare } from "miniflare";`);
    allowed("test/cases/driver.ts", `import { engineTable } from "../../src/core/trunk/engine.ts";`);
    allowed("scripts/build/floor-json.ts", `import { floorJson } from "../../src/config/floor-json.ts";`);
  });

  it("every way to import is seen", () => {
    const file = "src/core/keys/key.ts";
    refused(file, `export * from "node:fs";`);
    refused(file, `export { readFileSync } from "node:fs";`);
    refused(file, `export type { Stats } from "node:fs";`);
    refused(file, `const fs = import("node:fs");`);
    refused(file, `type Fs = typeof import("node:fs");`);
    refused(file, `const fs = require("node:fs");`);
    refused(file, `import "node:fs";`);
  });

  it("a comment that adds types to a whole program is refused in every file under src/", () => {
    const core = "src/core/keys/key.ts";
    refused(core, `/// <reference path="../../../worker-configuration.d.ts" />\nexport const one = 1;`);
    refused(core, `/// <reference types="node" />\nexport const one = 1;`);
    refused(core, `/// <reference lib="dom" />\nexport const one = 1;`);
    // The compiler reads the directive without the space, in any letter case, and below other comments.
    refused(core, `///<REFERENCE lib="dom"/>\nexport const one = 1;`);
    refused(core, `// The key of a premise.\n\n/// <reference lib="dom" />\nexport const one = 1;`);
    refused("src/core/keys/key.test.ts", `/// <reference lib="dom" />\nexport const one = 1;`);
    refused("src/protocol/events.ts", `/// <reference lib="dom" />\nexport const one = 1;`);
    refused("src/floor/main.tsx", `/// <reference types="node" />\nexport const one = 1;`);
    refused("src/host/main.ts", `/// <reference types="node" />\nexport const one = 1;`);
    refused("src/worker/index.ts", `/// <reference lib="dom" />\nexport const one = 1;`);

    const two = `/// <reference path="../../../worker-configuration.d.ts" />\n/// <reference lib="dom" />\n`;
    expect(violationsIn(core, `${two}export const one = 1;`)).toMatchObject([
      { file: core, line: 1, specifier: `/// <reference path="../../../worker-configuration.d.ts" />` },
      { file: core, line: 2, specifier: `/// <reference lib="dom" />` },
    ]);
  });

  it("a comment that switches the compiler off for its file is refused in every file under src/", () => {
    refused("src/core/keys/key.ts", `// @ts-nocheck\nexport const one = 1;`);
    refused("src/core/keys/key.ts", `//@TS-NOCHECK: later\nexport const one = 1;`);
    refused("src/core/keys/key.ts", `/// @ts-nocheck\nexport const one = 1;`);
    refused("src/floor/state/store.ts", `// @ts-nocheck\nexport const one = 1;`);
    refused("src/worker/index.ts", `// @ts-nocheck\nexport const one = 1;`);
  });

  it("a comment or a string that only mentions a directive is not one", () => {
    const core = "src/core/keys/key.ts";
    allowed(core, `// A <reference path="x" /> comment is refused here.\nexport const one = 1;`);
    allowed(core, `//// <reference lib="dom" />\nexport const one = 1;`);
    allowed(core, `/* /// <reference lib="dom" /> */\nexport const one = 1;`);
    allowed(core, `export const text = \`\n/// <reference lib="dom" />\n// @ts-nocheck\n\`;`);
    allowed(core, `// Never write @ts-nocheck here.\nexport const one = 1;`);
    allowed(core, `// @ts-nocheckpoint\nexport const one = 1;`);
  });

  it("an import that cannot be read as a fixed string is refused", () => {
    refused("src/core/keys/key.ts", `const name = "./x.ts"; const mod = import(name);`);
    refused("src/floor/app/registry.ts", `const views = import.meta.glob("./views/*.tsx");`);
  });

  it("a relative import names the file that exists, with its extension", () => {
    const isFile = (path: string): boolean => path === "src/core/sync/h.ts";
    const file = "src/core/keys/key.ts";
    expect(violationsIn(file, `import { H } from "../sync/h.ts";`, isFile)).toEqual([]);
    expect(violationsIn(file, `import type { Hash } from "../sync/h.ts";`, isFile)).toEqual([]);
    for (const specifier of ["../sync/h.js", "../sync/h", "../sync"]) {
      const found = violationsIn(file, `import { H } from "${specifier}";`, isFile);
      expect(found.map((violation) => violation.reason)).toEqual([expect.stringContaining("names no file")]);
    }
    const fromScript = violationsIn("scripts/build/x.ts", `import { y } from "../ops/lanes.js";`, isFile);
    expect(fromScript.map((violation) => violation.reason)).toEqual([expect.stringContaining("names no file")]);
  });

  it("an absolute address is refused", () => {
    refused("src/floor/main.tsx", `import { x } from "https://example.com/x.js";`);
    refused("src/floor/main.tsx", `import { x } from "/src/protocol/events.ts";`);
  });
});
