import { describe, expect, it } from "vitest";
import { createModuleParser, parseModule } from "./entities.ts";

// Identity proves reuse/eviction; expected entities and parse validity come from 2.1/2.3.
describe("bounded module content cache", () => {
  it("shares exact language/source matches across callers and separates languages", () => {
    const source = "export const cap = 100;";
    const parse = createModuleParser();
    const js = parse(source);
    expect(parse(source, "javascript")).toBe(js);
    expect(parse(source, "typescript")).not.toBe(js);
    expect(parse(`${source}\n`)).not.toBe(js);
    expect(parseModule(source)).toBe(parseModule(source));
    expect(js.entities.map((entity) => entity.name)).toEqual(["cap"]);
  });

  it("evicts the least recently used sources by total length and refreshes on a hit", () => {
    const a = "export const a = 1;";
    const b = "export const b = 2;";
    const c = "export const c = 3;";
    const parse = createModuleParser(a.length + b.length);
    const firstA = parse(a);
    const firstB = parse(b);
    expect(parse(a)).toBe(firstA); // A is newest, so C must evict B.
    parse(c);
    expect(parse(a)).toBe(firstA);
    expect(parse(b)).not.toBe(firstB);
    // Hits cannot charge the budget again: A still fits alongside B.
    expect(parse(a)).toBe(firstA);
  });

  it("evicts enough small sources for a larger one, not just one entry", () => {
    const parse = createModuleParser(30);
    const first = parse("let a=1;");
    const second = parse("let b=2;");
    const third = parse("let c=3;");
    const large = "export const larger = 100;";
    const added = parse(large); // 25 units leaves room for none of the 8-unit entries.
    expect(parse(large)).toBe(added);
    // Probe newest first: probing A first could itself evict B/C and hide under-eviction.
    expect(parse("let c=3;")).not.toBe(third);
    expect(parse("let b=2;")).not.toBe(second);
    expect(parse("let a=1;")).not.toBe(first);
  });

  it("does not retain oversized sources or evict small entries to accommodate them", () => {
    const source = "let a=1;";
    const parse = createModuleParser(source.length);
    const small = parse(source);
    const big = `${source}// outside the source budget`;
    expect(parse(big)).not.toBe(parse(big));
    expect(parse(source)).toBe(small);
  });

  it("accounts for the same source retained under two languages", () => {
    const source = "let a=1;";
    const parse = createModuleParser(source.length);
    const js = parse(source);
    const ts = parse(source, "typescript");
    expect(parse(source, "typescript")).toBe(ts);
    expect(parse(source)).not.toBe(js);
  });

  it("uses source length in UTF-16 units, including non-ASCII source", () => {
    const source = 'export const face = "🐟";';
    const parse = createModuleParser(source.length);
    const info = parse(source);
    expect(parse(source)).toBe(info);
    const under = createModuleParser(source.length - 1);
    expect(under(source)).not.toBe(under(source));
  });

  it("keeps failures throwing without poisoning a valid source or another language", () => {
    const parse = createModuleParser();
    const typed = "export const cap: number = 100;";
    const valid = parse(typed, "typescript");
    for (let n = 0; n < 2; n++) {
      expect(() => parse(typed, "javascript")).toThrow(SyntaxError);
      expect(() => parse("export const = ;")).toThrow(SyntaxError);
      expect(parse(typed, "typescript")).toBe(valid);
    }
    expect(parse("export const cap = 100;").entities[0]?.name).toBe("cap");
  });

  it("supports a disabled cache, empty modules, and rejects invalid budgets", () => {
    const cold = createModuleParser(0);
    expect(cold("")).not.toBe(cold(""));
    const parse = createModuleParser(1);
    expect(parse("")).toBe(parse(""));
    for (const bound of [-1, 1.5, Infinity, NaN]) expect(() => createModuleParser(bound)).toThrow(RangeError);
  });
});
