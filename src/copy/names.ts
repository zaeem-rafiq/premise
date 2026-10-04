// 03-floor 5.2: `keyLabel` and `keyShort` turn a premise key into words, `changeName` names a
// change for the owner, `modelName` shortens a model id. Every code-level name on the page goes
// through `keyLabel` (FL5).

import { CHANGE_NAME_CHARS } from "../protocol/constants.ts";
import { ABSENT, type PremiseKind } from "../protocol/premise.ts";
import { basename } from "./format.ts";
import { greenCheckLabel } from "./checks.ts";

export type LabelKind = PremiseKind | "check";

/**
 * `keyLabel(kind, key)` turns a premise key into words (03 5.2). A `check` key is the name of a
 * green-line check, optionally `<name>:<code>` (an item of rule CKL or of a revert, not a premise).
 */
export function keyLabel(kind: LabelKind, key: string): string {
  switch (kind) {
    case "entity": {
      const hash = key.indexOf("#");
      const path = hash === -1 ? "" : key.slice(0, hash);
      const name = hash === -1 ? key : key.slice(hash + 1);
      if (name.startsWith("(import ") && name.endsWith(")")) {
        return `the imports from ${name.slice(8, -1)} in ${path}`;
      }
      if (name === "(top)") return `the top-level code of ${path}`;
      if (name === "default") return `the default export of ${path}`;
      if (name.startsWith("*")) return `the re-export of ${name.slice(1)} in ${path}`;
      return `${name} in ${path}`;
    }
    case "file":
      return `the file ${key}`;
    case "listing":
      return key === "/" ? "the list of files at the top of the pool" : `the list of files in ${key}`;
    case "query": {
      if (key.startsWith("text:")) {
        const rest = key.slice(5);
        const colon = rest.indexOf(":");
        const scope = colon === -1 ? rest : rest.slice(0, colon);
        const needle = colon === -1 ? "" : rest.slice(colon + 1);
        return scope === "/"
          ? `the search for "${needle}" in the whole pool`
          : `the search for "${needle}" in ${scope}`;
      }
      if (key.startsWith("refs:")) {
        return `the list of code that uses ${keyLabel("entity", key.slice(5))}`;
      }
      if (key.startsWith("outline:")) return `the outline of ${key.slice(8)}`;
      return key;
    }
    case "check": {
      const colon = key.indexOf(":");
      const label = colon === -1 ? greenCheckLabel(key) : greenCheckLabel(key.slice(0, colon), key.slice(colon + 1));
      return `the check "${label}"`;
    }
  }
}

/** `keyShort` is the leading part only, for one-line sentences (03 5.2). */
export function keyShort(kind: LabelKind, key: string): string {
  switch (kind) {
    case "entity": {
      const hash = key.indexOf("#");
      const path = hash === -1 ? "" : key.slice(0, hash);
      const name = hash === -1 ? key : key.slice(hash + 1);
      if (name.startsWith("(import ") && name.endsWith(")")) return `imports in ${basename(path)}`;
      if (name === "(top)") return "top-level code";
      if (name === "default") return "default export";
      if (name.startsWith("*")) return "re-export";
      return name;
    }
    case "file":
      return basename(key);
    case "listing":
      return key === "/" ? "top-level files" : `files in ${key}`;
    case "query": {
      if (key.startsWith("text:")) {
        const rest = key.slice(5);
        const colon = rest.indexOf(":");
        const needle = colon === -1 ? rest : rest.slice(colon + 1);
        return `search "${needle}"`;
      }
      if (key.startsWith("refs:")) return `uses of ${keyShort("entity", key.slice(5))}`;
      if (key.startsWith("outline:")) return `outline of ${basename(key.slice(8))}`;
      return key;
    }
    case "check":
      return "a check";
  }
}

/**
 * What `changeName(attempt)` reads (03 5.2). `premises` is the attempt's premise list;
 * `PremiseView` of 4.1 carries no `hash`, so a caller that has `PremiseRef` (with `hash`) can pass
 * it and a caller with views passes `hash: undefined` — the "pinned at absent" file case then does
 * not apply (the Floor cannot see it; see the track report).
 */
export type ChangeNameInput = {
  /** The intent text, quoted verbatim in the name (CP6). */
  intentText: string;
  /** A race candidate adds its model name in brackets (attempt.race, never changes: RC7). */
  race?: boolean;
  model?: string | null;
  premises?: ReadonlyArray<{ kind: string; key: string; edit: boolean; hash?: string | null }>;
};

/**
 * `changeName(attempt)` (03 5.2): if the attempt has exactly one `file` premise pinned at `absent`
 * with `edit` true, that file's name without directory and extension; otherwise the intent text cut
 * at a word end to `CHANGE_NAME_CHARS` characters, with "…", in quotes. A race candidate adds its
 * model name in brackets.
 */
export function changeName(attempt: ChangeNameInput): string {
  const created = (attempt.premises ?? []).filter((p) => p.kind === "file" && p.edit === true && p.hash === ABSENT);
  let name: string;
  if (created.length === 1) {
    const file = created[0]!.key;
    const base = basename(file);
    name = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  } else {
    name = `"${cutAtWordEnd(attempt.intentText, CHANGE_NAME_CHARS)}"`;
  }
  if (attempt.race === true && attempt.model != null) name += ` (${modelName(attempt.model)})`;
  return name;
}

/** Cut at a word end to `max` characters, with "…" when text had to be shortened (03 5.2). */
function cutAtWordEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : head;
  return `${cut}…`;
}

/** `modelName(id)`: the last segment of the model id (03 5.2). */
export function modelName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
