// Attempt states, stop reasons and transition ids.
// Source: 01-core 9.1 (states and stop reasons), 9.2 (the transition table).

export const ATTEMPT_STATES = [
  "opened",
  "working",
  "going_around",
  "needs_confirm",
  "submitted",
  "validated",
  "held",
  "accepted",
  "landed",
  "stopped",
] as const;

/** The ten attempt states of 01-core 9.1. */
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** The stop reasons the Agent reports through the `stop` call (TA9). */
export const AGENT_STOP_REASONS = [
  "budget",
  "spend_cap",
  "timeout",
  "model_error",
  "tool_timeout",
  "stalled",
  "killed",
  "cancelled",
  "withdrawn",
] as const;

export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

/** The stop reasons Trunk sets itself (9.1): all seventeen reasons minus the agent-reported nine. */
export const TRUNK_STOP_REASONS = [
  "go_around_limit",
  "contradiction",
  "revert_limit",
  "reopen_failed",
  "declined",
  "not_chosen",
  "undone",
  "lost",
] as const;

export type TrunkStopReason = (typeof TRUNK_STOP_REASONS)[number];

/** All seventeen stop reasons of 01-core 9.1. */
export const STOP_REASONS = [...TRUNK_STOP_REASONS, ...AGENT_STOP_REASONS] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/** The transition ids of 01-core 9.2 (the `transition` field of `attempt.state`). */
export const TRANSITIONS = [
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "T8",
  "T9",
  "T9c",
  "T10",
  "T10a",
  "T11",
  "T11s",
  "T12",
  "T13",
  "T14",
  "T15",
  "T16",
  "T17",
  "T17a",
  "T18",
  "T19",
  "T19s",
  "T20",
  "T20r",
  "T21",
  "T22",
] as const;

export type Transition = (typeof TRANSITIONS)[number];
