// Typed access to the fixed sentences of 05-agent.md 3.6/4.x, held verbatim in `AGENT_TEXTS`.
// Every string the model can read comes from this table or from data it already produced.

import { AGENT_TEXTS, GUIDE_PATH } from "../../../protocol/agent-prompt.ts";

export type AgentTexts = {
  nudge: string;
  nudge_cut: string;
  elided: string;
  errors: Record<string, string>;
  because: Record<string, Record<string, string>>;
  what: Record<string, string>;
  suffix: Record<string, string>;
  dropped: Record<string, string>;
};

const parsed: AgentTexts = JSON.parse(AGENT_TEXTS) as AgentTexts;

/** `AGENT_TEXTS` with `{GUIDE_PATH}` filled where the spec text carries it (the guide_first error). */
export const TEXTS: AgentTexts = {
  ...parsed,
  errors: Object.fromEntries(
    Object.entries(parsed.errors).map(([code, text]) => [code, text.replaceAll("{GUIDE_PATH}", GUIDE_PATH)]),
  ),
};

/** Fill the `{name}` holes of a template (MR7/MR8 use `{thing}`, `{list}`, `{code}`, `{n}`). */
export function fill(template: string, holes: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => holes[name] ?? match);
}

/** The `message` for an error `code` (MR10): the sentence of 3.6, `other` when the code has none. */
export function errorSentence(code: string, texts: AgentTexts = TEXTS): string {
  return texts.errors[code] ?? texts.errors.other ?? "";
}
