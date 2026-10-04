// The git lane's wiring module for the engine seam (04-build-plan 3.2). The lane registers its
// engine entries (the outbox, register and restart work of plan 3.1) here; it edits this file,
// never `../engine.ts`.
//
// The push lifecycle lives in the engine's `push_ok`, `push_result` and `restart` entries (wired
// by the engine lane — they are its table entries, not the git lane's) and in the Durable
// Object's after-commit push work (`src/worker/trunk/push.ts`, wired into the effects seam by
// this lane's `src/worker/trunk/wiring/git.ts`). This module has no entries of its own.

import type { EngineTable } from "../engine.ts";

export function wire(_table: EngineTable): void {
  // Nothing to register: the outbox work is the engine's own entries plus the DO's effects.
}
