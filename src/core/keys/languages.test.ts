// The language sets of 06-repos.md LG1: which extensions are modules under the tide-pool set
// (2.1, unchanged) and under the imported-pool set, and the language each names.

import { describe, expect, it } from "vitest";
import { IMPORT_LANGUAGES, isModulePath, languageOfPath, TIDEPOOL_LANGUAGES } from "./paths.ts";

describe("the language sets of LG1", () => {
  it("the tide-pool set is exactly the .js and .mjs of 2.1", () => {
    expect(Object.keys(TIDEPOOL_LANGUAGES.languages).sort()).toEqual([".js", ".mjs"]);
    expect(TIDEPOOL_LANGUAGES.languages[".js"]).toBe("javascript");
    expect(TIDEPOOL_LANGUAGES.languages[".mjs"]).toBe("javascript");
  });

  it("the imported-pool set holds LG1's JavaScript, TypeScript, Python and Go extensions", () => {
    expect(IMPORT_LANGUAGES.languages).toEqual({
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "jsx",
      ".ts": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".tsx": "tsx",
      ".py": "python",
      ".go": "go",
    });
  });

  it("languageOfPath names the language of a path under a set, or null", () => {
    expect(languageOfPath("a/b.ts", IMPORT_LANGUAGES)).toBe("typescript");
    expect(languageOfPath("a/b.tsx", IMPORT_LANGUAGES)).toBe("tsx");
    expect(languageOfPath("a/b.mts", IMPORT_LANGUAGES)).toBe("typescript");
    expect(languageOfPath("a/b.cts", IMPORT_LANGUAGES)).toBe("typescript");
    expect(languageOfPath("a/b.jsx", IMPORT_LANGUAGES)).toBe("jsx");
    expect(languageOfPath("a/b.cjs", IMPORT_LANGUAGES)).toBe("javascript");
    expect(languageOfPath("a/b.js", IMPORT_LANGUAGES)).toBe("javascript");
    expect(languageOfPath("a/b.d.ts", IMPORT_LANGUAGES)).toBe("typescript"); // ends in .ts
    expect(languageOfPath("a/b.py", IMPORT_LANGUAGES)).toBe("python");
    expect(languageOfPath("a/b.go", IMPORT_LANGUAGES)).toBe("go");
    expect(languageOfPath("a/b.rs", IMPORT_LANGUAGES)).toBeNull();
    expect(languageOfPath("a/b", IMPORT_LANGUAGES)).toBeNull();
    expect(languageOfPath("a/b.ts", TIDEPOOL_LANGUAGES)).toBeNull();
    expect(languageOfPath("a/b.js", TIDEPOOL_LANGUAGES)).toBe("javascript");
  });
});

describe("isModulePath under each set (2.1, LG1)", () => {
  it("under the tide-pool set only .js and .mjs are modules", () => {
    for (const path of ["a.js", "x/y.mjs"]) expect(isModulePath(path, TIDEPOOL_LANGUAGES)).toBe(true);
    for (const path of ["a.cjs", "a.jsx", "a.ts", "a.mts", "a.cts", "a.tsx", "a.py", "a.go", "a.txt"]) {
      expect(isModulePath(path, TIDEPOOL_LANGUAGES), path).toBe(false);
    }
  });

  it("under the imported-pool set LG1's ten extensions are modules", () => {
    for (const path of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.cts", "a.tsx", "a.py", "a.go"]) {
      expect(isModulePath(path, IMPORT_LANGUAGES), path).toBe(true);
    }
    for (const path of ["a.rs", "a.txt", "a.json", "noext"]) {
      expect(isModulePath(path, IMPORT_LANGUAGES), path).toBe(false);
    }
  });

  it("the default is the tide-pool set: a .ts file is not a module to a caller without a set", () => {
    expect(isModulePath("a.js")).toBe(true);
    expect(isModulePath("a.ts")).toBe(false);
    expect(isModulePath("a.tsx")).toBe(false);
    expect(isModulePath("a.cjs")).toBe(false);
    expect(isModulePath("a.jsx")).toBe(false);
  });
});
