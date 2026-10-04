// BP5: a bundled package must be MIT, Apache-2.0, BSD or Unlicense.

import { describe, expect, it } from "vitest";
import { licenseAllowed, packageDirectoryOf } from "./licenses.ts";

describe("licenseAllowed (BP5)", () => {
  it("allows MIT, Apache-2.0, BSD and Unlicense", () => {
    for (const license of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "Unlicense"]) {
      expect(licenseAllowed(license), license).toBe(true);
    }
  });

  it("refuses every other licence", () => {
    for (const license of ["GPL-3.0-only", "GPL-2.0", "LGPL-3.0", "AGPL-3.0", "FSL-1.1-MIT", "ISC", "MPL-2.0"]) {
      expect(licenseAllowed(license), license).toBe(false);
    }
  });

  it("refuses a package that names no licence or an unreadable one", () => {
    for (const license of ["", "UNLICENSED", "SEE LICENSE IN LICENSE.txt", "MIT OR", "(MIT", "MIT)"]) {
      expect(licenseAllowed(license), license).toBe(false);
    }
  });

  it("an OR needs one allowed side", () => {
    expect(licenseAllowed("MIT OR Apache-2.0")).toBe(true);
    expect(licenseAllowed("(MIT OR GPL-3.0-only)")).toBe(true);
    expect(licenseAllowed("GPL-2.0 OR GPL-3.0-only")).toBe(false);
  });

  it("an AND needs every side allowed", () => {
    expect(licenseAllowed("MIT AND Apache-2.0")).toBe(true);
    expect(licenseAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("(MIT AND GPL-3.0-only) OR BSD-3-Clause")).toBe(true);
    expect(licenseAllowed("MIT AND (GPL-3.0-only OR LGPL-3.0)")).toBe(false);
  });

  it("refuses a licence with an exception", () => {
    expect(licenseAllowed("Apache-2.0 WITH LLVM-exception")).toBe(false);
  });
});

describe("packageDirectoryOf", () => {
  it("finds the package of a bundled module", () => {
    expect(packageDirectoryOf("node_modules/react/index.js")).toBe("node_modules/react");
    expect(packageDirectoryOf("node_modules/react-dom/cjs/react-dom-client.production.js")).toBe(
      "node_modules/react-dom",
    );
    expect(packageDirectoryOf("node_modules/@scope/name/dist/index.js")).toBe("node_modules/@scope/name");
  });

  it("uses the innermost package of a nested one", () => {
    expect(packageDirectoryOf("node_modules/a/node_modules/b/index.js")).toBe("node_modules/a/node_modules/b");
  });

  it("answers null for a module of this repository", () => {
    expect(packageDirectoryOf("src/worker/index.ts")).toBeNull();
  });
});
