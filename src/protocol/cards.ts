// Cards: what the owner decides on. Source: 01-core 10.3 (Card, FrameAddress, BlastRadius, CardOption,
// RiskAnswers), 10.4 (risk), PV5 (frame addresses).

import type { AttemptState } from "./attempt.ts";

export type FrameAddress = { repo: "main" | "plain"; commit: string };

/**
 * The page address a `FrameAddress` plays at (01-core PV5): a commit of the pool repo is
 * `/pool/<pool>/<40 hex>/`; a commit of the plain-merge repository (a plain-merge landing or a preview
 * commit) is `/pool/<pool>/p-<40 hex>/`.
 */
export function frameUrl(pool: string, address: FrameAddress): string {
  return address.repo === "plain" ? `/pool/${pool}/p-${address.commit}/` : `/pool/${pool}/${address.commit}/`;
}

/** The version token a `FrameAddress` appears as in listings and events (PV5). */
export function versionToken(address: FrameAddress): string {
  return address.repo === "plain" ? `p-${address.commit}` : `c-${address.commit}`;
}

export type BlastRadius = {
  repair: string[]; // attempt ids
  confirm: string[];
  triage: string[];
  right_of_way: string[]; // those of them that hold right of way
};

export type CardKind = "held" | "choice" | "race";

export type CardReason =
  "held_path" | "risk" | "go_around_limit" | "contradiction" | "revert_limit" | "reopen_failed" | "race";

export type Card = {
  card_id: string;
  kind: CardKind;
  attempt_ids: string[]; // one for held; one or two for choice; all candidates for race
  intent_ids: string[];
  submit_ids: Record<string, string>; // attempt_id -> submit_id the card is about
  title: string; // plain sentence
  body: string[]; // plain sentences, at most two for a choice card
  options: Array<{ id: CardOption; label: string }>;
  paths: Array<{ path: string; tier: "auto" | "held" }>;
  blast_radius: Record<string, BlastRadius>; // attempt_id -> its blast radius; empty for a choice card
  preview: {
    before: FrameAddress | null;
    after: Record<string, FrameAddress>;
    error: string | null;
  } | null;
  candidates: Record<
    string,
    { state: AttemptState; can_choose: boolean; seconds: number | null; cost_usd: number | null }
  > | null; // race only
  risk: RiskAnswers | null;
  reason: CardReason;
};

export const CARD_OPTIONS = [
  "land",
  "land_now",
  "decline",
  "retry",
  "stop",
  "keep_landed",
  "new_attempt",
  "choose",
] as const;

/** The only set of option ids a card may offer (CD4). */
export type CardOption = (typeof CARD_OPTIONS)[number];

/** The `action` values `card.closed` may carry (CD1): a `CardOption`, `stale` or `superseded`. */
export const CARD_ACTIONS = ["stale", "superseded", ...CARD_OPTIONS] as const;

export type CardAction = (typeof CARD_ACTIONS)[number];

export type RiskAnswers = {
  model: string;
  does_what_asked: number | null; // probabilities; null when unavailable
  changes_shared_meaning: number | null;
  unrelated_edits: number | null;
  error?: string; // a code (SE5b)
};
