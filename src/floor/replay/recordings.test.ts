// The embedded recordings of recordings.ts are a copy of the stream lane's fixtures so Replay
// works with no server. This test pins them to the canonical files: an update of
// test/fixtures/streams/ must regenerate recordings.ts (see its header comment).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPLAY_FORMAT, type ReplayHeader } from "../../protocol/replay.ts";
import { RECORDING_TEXTS } from "./recordings.ts";

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/streams");

describe("embedded recordings", () => {
  it("covers exactly the fixture streams", () => {
    expect(Object.keys(RECORDING_TEXTS).sort()).toEqual(["hero-c04", "hero-c05", "tracer"]);
  });

  for (const [id, text] of Object.entries(RECORDING_TEXTS)) {
    it(`recording "${id}" is byte-equal to test/fixtures/streams/${id}.ndjson`, () => {
      const canonical = readFileSync(join(STREAMS, `${id}.ndjson`), "utf8");
      expect(text).toBe(canonical);
    });

    it(`recording "${id}" has a valid header`, () => {
      const first = text.split("\n", 1)[0] ?? "";
      const header = JSON.parse(first) as ReplayHeader;
      expect(header.premise_replay).toBe(REPLAY_FORMAT);
      expect(header.pool).toBe("tidepool");
      expect(header.events).toBe(text.split("\n").filter((line) => line !== "").length - 1);
    });
  }
});
