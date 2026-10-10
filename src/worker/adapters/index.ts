// The ports the deployment uses (plan 1.7): this file names the option in use for each port. Until a
// lane builds its adapter, every port resolves to the not-built implementation of `./not-built.ts`,
// whose methods fail closed with the code `not_built`.
//
// `SyncTriage` has no not-built form: a synchronous judge is pure code (`ScriptedTriage` for
// synthetic attempts, `OffTriage` when Clef is off, S6a) and lives with the engine.

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
import {
  notBuiltAttemptRepoProvisioner,
  notBuiltDriver,
  notBuiltNotesReader,
  notBuiltPoolSource,
  notBuiltPusher,
  notBuiltRiskJudge,
  notBuiltTokenSource,
  notBuiltTriage,
  notBuiltVerifier,
} from "./not-built.ts";

export const pusher: Pusher = notBuiltPusher();
export const notesReader: NotesReader = notBuiltNotesReader();
export const tokenSource: TokenSource = notBuiltTokenSource();
// The environment-free seam stays fail-closed. The gate binds ATTEMPTS to the factory
// only when features.attempt_repos is on; option A is selected in the adapter.
export const attemptRepoProvisioner: AttemptRepoProvisioner = notBuiltAttemptRepoProvisioner();
export { artifactsAttemptRepoProvisioner } from "./attempt-repo/index.ts";
export const verifier: Verifier = notBuiltVerifier();
export const poolSource: PoolSource = notBuiltPoolSource();
export const triage: Triage = notBuiltTriage();
export const riskJudge: RiskJudge = notBuiltRiskJudge();
export const driver: Driver = notBuiltDriver();
