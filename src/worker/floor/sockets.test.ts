// FS3/EV7: the stream sockets are hibernatable. The Floor accepts them with `ctx.acceptWebSocket`
// and never calls `ws.accept()` — this test reads the lane's own source to prove no `.accept(`
// call hides in it. `ctx.acceptWebSocket(` is not a match: it ends in `WebSocket(`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path;
  }
}

describe("FS3/EV7: hibernatable sockets only", () => {
  it("no `.accept(` call appears under src/worker/floor/ (ws.accept is banned; ctx.acceptWebSocket is used)", () => {
    const offenders: string[] = [];
    for (const file of sources(__dirname)) {
      if (readFileSync(file, "utf8").includes(".accept" + "(")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
