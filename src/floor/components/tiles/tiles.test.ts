// The file tiles against 03-floor 3.7's table and CO26-CO28, on the real tracer fixture plus
// fabricated `FloorState` for the edges (removed, overflow, >5 marks). `renderToStaticMarkup`
// covers structure; `tileCells`/`tileMarks` the pure order and counts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import { FileTiles } from "./tiles.tsx";
import { MARKS_MAX, dirOfPath, tileCells, tileMarks, tileName } from "./tiles-plan.ts";

const ROOT = join(fileURLToPath(import.meta.url), "../../../../..");

function tracerState(count?: number): FloorState {
  const text = readFileSync(join(ROOT, "test/fixtures/streams/tracer.ndjson"), "utf8");
  const events = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.type === "string")
    .map((line) => line as unknown as PoolEvent);
  let state = emptyFloorState();
  for (const event of events.slice(0, count)) state = reduce(state, event);
  return state;
}

function markup(state: FloorState, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(FileTiles, { state, ...props }));
}

function withFiles(
  state: FloorState,
  paths: [string, string][],
  extra: Partial<FloorState["files"][string]> = {},
): FloorState {
  const files = { ...state.files };
  for (const [path, tier] of paths) {
    files[path] = {
      path,
      exists: true,
      tier: tier as "auto" | "held" | null,
      readers: [],
      writers: [],
      last_landed_seq: null,
      keys: [],
      ...extra,
    };
  }
  return { ...state, files };
}

describe("3.7 the cells (CO26)", () => {
  it("groups the tracer's files by directory in pool.files order, label cell first", () => {
    const cells = tileCells(tracerState());
    expect(cells.map((c) => (c.kind === "label" ? c.dir : c.kind === "file" ? c.file.path : "+more"))).toEqual([
      ".premise/",
      ".premise/policy.json",
      "world/",
      "world/energy.js",
      "world/movement.js",
      "creatures/",
      "creatures/fish.js",
      "creatures/snail.js",
    ]);
  });

  it("a tile's name is the file name without directory and extension", () => {
    expect(tileName("creatures/fish.js")).toBe("fish");
    expect(tileName(".premise/policy.json")).toBe("policy");
    expect(tileName("README")).toBe("README");
    expect(dirOfPath("creatures/fish.js")).toBe("creatures/");
    expect(dirOfPath("README")).toBe("");
  });

  it("reader and writer marks come from the in-flight attempt's premises and operations", () => {
    // tracer n=10 reads creatures/fish.js#spawn, n=12 lists creatures/, n=15 writes fish.js;
    // n=16 removes the listing premise again, so the marks stand at 15.
    const cells = tileCells(tracerState(15));
    const fish = cells.find((c) => c.kind === "file" && c.file.path === "creatures/fish.js");
    expect(fish?.kind === "file" && fish.file.readers).toEqual(["a_T"]);
    expect(fish?.kind === "file" && fish.file.writers).toEqual(["a_T"]);
    const label = cells.find((c) => c.kind === "label" && c.dir === "creatures/");
    expect(label?.kind === "label" && label.readers).toEqual(["a_T"]);
  });

  it("caps marks at 5 each, then tile.more_marks counts the rest", () => {
    expect(tileMarks(["a", "b", "c", "d", "e", "f", "g"], ["x", "y", "z", "w", "v", "u"])).toEqual({
      readers: 5,
      writers: 5,
      more: 3,
    });
    expect(MARKS_MAX).toBe(5);
  });

  it("the last cell is tiles.more when there are more files than cells (CO28)", () => {
    const state = withFiles(
      emptyFloorState(),
      Array.from({ length: 10 }, (_, i) => [`d/f${i}.js`, "auto"]),
    );
    const cells = tileCells(state, { capacity: 6 });
    const last = cells[cells.length - 1]!;
    expect(cells).toHaveLength(6);
    expect(last.kind).toBe("more");
    expect(last.kind === "more" ? last.hidden : 0).toBe(6); // 10 files; label + 4 tiles shown
  });

  it("a landing's removed file keeps its cell as removed while its peers stay", () => {
    const state = withFiles(emptyFloorState(), [
      ["a/x.js", "auto"],
      ["a/y.js", "auto"],
    ]);
    const files = { ...state.files, "a/y.js": { ...state.files["a/y.js"]!, exists: false, last_landed_seq: 3 } };
    const cells = tileCells({ ...state, files }, { removedPaths: new Set(["a/y.js"]) });
    const removed = cells.find((c) => c.kind === "file" && c.removed);
    expect(removed?.kind === "file" && removed.file.path).toBe("a/y.js");
    // once the 2 s window passed (the path left removedPaths) the tile leaves.
    expect(tileCells({ ...state, files }).filter((c) => c.kind === "file")).toHaveLength(1);
  });

  it("the newest landed landing glows: glowPaths flags the file cells", () => {
    const state = withFiles(emptyFloorState(), [["a/x.js", "auto"]], { last_landed_seq: 2 });
    const cells = tileCells(state, { glowPaths: new Set(["a/x.js"]) });
    const tile = cells[1]!;
    expect(tile.kind === "file" && tile.glow).toBe(true);
  });
});

describe("3.7 the rendered table", () => {
  it("loading: no pool.files yet shows grey cells and tiles.loading", () => {
    const html = markup(emptyFloorState());
    expect(html).toContain("Loading the file list…");
    expect(html).toContain("tile-ghost");
  });

  it("live: names only, the held tile carries tile.held", () => {
    const html = markup(tracerState());
    for (const name of ["policy", "energy", "movement", "fish", "snail"]) {
      expect(html).toContain(`>${name}<`);
    }
    expect(html).toContain(">Held<");
    expect(html).toContain("A change to this file waits for one tap from the owner.");
  });

  it("every tile's accessible name is tile.name with its path and counts (AX7)", () => {
    const html = markup(tracerState(16));
    expect(html).toContain("creatures/fish.js. 1 reading, 1 writing.");
    expect(html).toContain("creatures/snail.js. 0 reading, 0 writing.");
  });

  it("the marks render as ring then square shapes, capped at five each", () => {
    const state = withFiles(emptyFloorState(), [["a/x.js", "auto"]], {
      readers: ["1", "2", "3", "4", "5", "6"],
      writers: ["a", "b"],
    });
    const html = markup(state);
    expect(html.match(/class="tile-mark tile-mark-r"/g)).toHaveLength(5);
    expect(html.match(/class="tile-mark tile-mark-w"/g)).toHaveLength(2);
    expect(html).toContain(">+1<");
  });

  it("CO27/3.9: a tile with actions is a button opening the tile menu; without them it is inert", () => {
    const withMenu = markup(tracerState(), { onTileWho: () => {}, onTileWhy: () => {} });
    expect(withMenu).toContain('aria-haspopup="menu"');
    const inert = markup(tracerState());
    expect(inert).not.toContain("aria-haspopup");
  });
});
