// 03-floor 5.7: the labels of submit checks, the submit-result lines of the attempt card, the
// error sentences of a rejected submit, and the labels of the green-line / self-test checks (GR8).

import { fill } from "./fill.ts";
import { STRINGS } from "./strings.ts";

/** Checks of a submit (`Check.name`, `01-core.md` 4.9): name -> label. */
export const SUBMIT_CHECK_LABELS: Readonly<Record<string, string>> = {
  replay: "The edits apply to the newest code",
  non_empty: "The change is not empty",
  fits: "The pool stays within its size limits",
  parse: "The code parses",
  imports_resolve: "Every import points at something",
  globals_allowed: "Only allowed globals are used",
  colours_known: "Every colour is one the pen knows",
  energy_through_rules: "Energy changes only through the shared rules",
  selftest: "The pool's self-test passes with the change",
  derived: "What the change uses and affects is recorded",
  premises_hold: "Everything it relied on is still true",
};

/** The label of a submit check: `policy` shows its `detail`; any other name shows as given. */
export function submitCheckLabel(name: string, detail?: string): string {
  if (name === "policy") return fill("Policy: {detail}", { detail: detail ?? "" });
  return SUBMIT_CHECK_LABELS[name] ?? name;
}

/**
 * The line on the attempt card for a `submit.result` status (03 5.7). `validated` and `submitted`
 * are the strings `attempt.next_batch` and `attempt.waiting_clef`; `held` has the CP7 visitor form.
 * `accepted`, `landed` and `stopped` have no line: the state says it. Returns null there.
 */
export function submitResultLine(status: string, vars: { visitor?: boolean; error?: string } = {}): string | null {
  switch (status) {
    case "validated":
      return STRINGS["attempt.next_batch"]!.text;
    case "submitted":
      return STRINGS["attempt.waiting_clef"]!.text;
    case "held":
      return vars.visitor === true
        ? "All checks passed. Waiting for the owner."
        : "All checks passed. Waiting for you.";
    case "needs_confirm":
      return "The agent must confirm one thing before this can land.";
    case "go_around":
      return "Something it relied on changed. The agent is adapting.";
    case "rejected":
      return fill("The checks sent it back: {error sentence}. The agent is fixing it.", {
        "error sentence": vars.error ?? "{error sentence}",
      });
    default:
      return null;
  }
}

/** The error sentence of a rejected submit's first failed check (03 5.7). */
export const SUBMIT_ERROR_SENTENCES: Readonly<Record<string, string>> = {
  non_empty: "the change does nothing",
  fits: "the change is too large",
  parse: "the code does not parse",
  imports_resolve: "an import points at nothing, or at something outside the pool",
  globals_allowed: "it uses something the policy does not allow",
  colours_known: "it names a colour the pen does not know",
  energy_through_rules: "it changes energy without the shared rules",
  selftest: "the pool's self-test fails with it",
};

/** The error sentence of a failed check: any other name is `the check "{label}" failed`. */
export function submitErrorSentence(check: { name: string; detail?: string }): string {
  const known = SUBMIT_ERROR_SENTENCES[check.name];
  if (known !== undefined) return known;
  return `the check "${submitCheckLabel(check.name, check.detail)}" failed`;
}

/**
 * The labels of the green-line and self-test checks (03 5.7, `01-core.md` GR8). `selftest_ran`
 * distinguishes by its failure code; a check whose code the list does not know shows the name.
 */
export const GREEN_CHECK_LABELS: Readonly<Record<string, string>> = {
  files: "Every creature file has its three parts",
  no_errors: "No creature causes an error",
  in_bounds: "Every creature stays in the water",
  energy_range: "Energy stays between empty and full",
  population: "The number of creatures is right",
  not_exhausted: "No kind of creature rests too much of the time",
  state_is_data: "The pool's state is plain data",
  pen_rules: "Drawing follows the rules of the pen",
  visible: "Every creature can be seen",
  within_reach: "Every creature draws near its own place",
  draw_is_pure: "Drawing changes nothing in the pool",
  deterministic: "The same start gives the same result",
  parse: "The code parses",
  imports_resolve: "Every import points at something",
  policy_invariants: "The rules of the policy file hold",
};

/** The `selftest_ran` labels by failure code (03 5.7, `01-core.md` GR8). */
export const SELFTEST_CODE_LABELS: Readonly<Record<string, string>> = {
  no_verdict: "The self-test did not finish in time",
  bad_verdict: "The self-test gave no readable result",
  harness_error: "The pool's code did not load, or the test stopped with an error",
};

/**
 * The label of a green-line or self-test check (03 5.7): `selftest_ran` by its `code`, every other
 * check by `name`. A name or code the table does not know shows as the name itself (the "any other"
 * row of the submit-check table). `keyLabel("check", …)` and `selftest.fail.line` build on this.
 */
export function greenCheckLabel(name: string, code?: string | null): string {
  if (name === "selftest_ran") {
    return (code != null ? SELFTEST_CODE_LABELS[code] : undefined) ?? name;
  }
  return GREEN_CHECK_LABELS[name] ?? name;
}
