// docs/spec/03-floor.md AC7: "components contain no text of their own (lint)", and CP1: the
// strings live in one module (`copy`) that the Floor imports. What the rule reads and what it
// leaves out is written at the top of component-text-rules.ts.

import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { componentFiles, findingsIn, findingsUnder, format } from "./component-text-rules.ts";

/** The text a component with this source holds of its own, as "where: text". */
function found(source: string): string[] {
  return findingsIn("src/floor/components/example/example.tsx", source).map(
    (finding) => `${finding.where}: ${finding.text}`,
  );
}

describe("AC7: no component holds text of its own: the repository", () => {
  it("the lint reads the Floor's components", () => {
    const files = componentFiles(REPO_ROOT);
    expect(files).toContain("src/floor/app/app.tsx");
    expect(files).toContain("src/floor/main.tsx");
    expect(files.every((file) => file.startsWith("src/floor/") && file.endsWith(".tsx"))).toBe(true);
  });

  it("no .tsx file under src/floor shows text that is not from src/copy", () => {
    expect(format(findingsUnder(REPO_ROOT))).toBe("");
  });
});

describe("AC7: what the lint reports", () => {
  it("JSX text with a letter", () => {
    expect(found(`export const A = () => <p>Premise could not load its settings.</p>;`)).toEqual([
      "JSX text: Premise could not load its settings.",
    ]);
    expect(found(`export const A = ({ n }: { n: number }) => <span>line {n}</span>;`)).toEqual(["JSX text: line"]);
  });

  it("a string in an attribute that is shown or spoken", () => {
    expect(found(`export const A = () => <nav aria-label="views" />;`)).toEqual(["the aria-label attribute: views"]);
    expect(found(`export const A = () => <Row label="commit" />;`)).toEqual(["the label attribute: commit"]);
    expect(found(`export const A = () => <img alt="a crab" />;`)).toEqual(["the alt attribute: a crab"]);
    expect(found(`export const A = ({ on }: { on: boolean }) => <b title={on ? "On" : "Off"} />;`)).toEqual([
      "the title attribute: On",
      "the title attribute: Off",
    ]);
  });

  it("a string a JSX expression renders as it stands", () => {
    expect(found(`export const A = () => <p>{"Loading"}</p>;`)).toEqual(["a JSX expression: Loading"]);
    expect(found(`export const A = ({ a }: { a: boolean }) => <p>{a && "Held"}</p>;`)).toEqual([
      "a JSX expression: Held",
    ]);
    expect(found("export const A = ({ s }: { s: number }) => <p>{`landing ${s}`}</p>;")).toEqual([
      "a JSX expression: landing",
    ]);
  });
});

describe("AC7: what the lint leaves alone", () => {
  it("copy ids passed to t() and text(), and values from elsewhere", () => {
    expect(
      found(`export const A = ({ t, v }: { t: (id: string) => string; v: string }) => <p>{t("nav.about")}{v}</p>;`),
    ).toEqual([]);
    expect(
      found(`export const A = ({ t }: { t: (id: string) => string }) => <nav aria-label={t("nav.label")} />;`),
    ).toEqual([]);
  });

  it("attributes that are not shown: class names, roles, types, states, ids and test ids", () => {
    expect(
      found(
        `export const A = () => <div className="tray-row" role="listitem" data-testid="tray" aria-hidden="true" aria-current="step" dir="auto"><input type="range" /></div>;`,
      ),
    ).toEqual([]);
  });

  it("punctuation without a letter, written plainly or as an entity", () => {
    expect(
      found(`export const A = ({ v }: { v: string }) => <p>&ldquo;{v}&rdquo; &middot; ({v}) &#8230;</p>;`),
    ).toEqual([]);
  });

  it("an entity it does not know counts as text", () => {
    expect(found(`export const A = () => <p>&eacute;</p>;`)).toEqual(["JSX text: &eacute;"]);
  });
});
