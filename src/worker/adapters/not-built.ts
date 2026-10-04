// The not-built adapters: one implementation per port of `01-core` 1.7 and of plan 1.3, every method
// failing closed with the code `not_built`. `adapters/index.ts` names these as the option in use until
// a lane builds the real adapter of its port.

import type {
  AttemptRepoProvisioner,
  Driver,
  NotesReader,
  PoolSource,
  Pusher,
  RiskJudge,
  Triage,
  TokenSource,
  Verifier,
} from "../../protocol/ports.ts";
import { notBuiltError } from "../not-built.ts";

function reject(): Promise<never> {
  return Promise.reject(notBuiltError());
}

export function notBuiltPusher(): Pusher {
  return { push: reject, readRefs: reject };
}

export function notBuiltNotesReader(): NotesReader {
  return {
    readNote: reject,
    async *listNotes(): AsyncIterable<{ commit: string; blob: string }> {
      throw notBuiltError();
    },
  };
}

export function notBuiltTokenSource(): TokenSource {
  return { writeTarget: reject };
}

export function notBuiltAttemptRepoProvisioner(): AttemptRepoProvisioner {
  return { provision: reject };
}

export function notBuiltVerifier(): Verifier {
  return { verify: reject };
}

export function notBuiltPoolSource(): PoolSource {
  return { resolve: reject, read: reject, list: reject };
}

export function notBuiltTriage(): Triage {
  return { judge: reject };
}

export function notBuiltRiskJudge(): RiskJudge {
  return { judge: reject };
}

export function notBuiltDriver(): Driver {
  return { next: reject };
}
