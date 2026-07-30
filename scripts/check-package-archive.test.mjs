import assert from "node:assert/strict";
import test from "node:test";

import { validatePackageArchive } from "./check-package-archive.mjs";

const validFiles = [
  { path: "dist/index.d.ts" },
  { path: "dist/index.js" },
  { path: "LICENSE" },
  { path: "package.json" },
  { path: "README.md" },
  { path: "src/index.ts" },
];

test("accepts a complete public package archive", () => {
  assert.doesNotThrow(() => validatePackageArchive("@commissary/example", validFiles));
});

test("requires public package metadata and entry points", () => {
  for (const requiredPath of [
    "dist/index.d.ts",
    "dist/index.js",
    "LICENSE",
    "package.json",
    "README.md",
    "src/index.ts",
  ]) {
    assert.throws(
      () =>
        validatePackageArchive(
          "@commissary/example",
          validFiles.filter((file) => file.path !== requiredPath),
        ),
      new RegExp(`missing '${requiredPath.replaceAll(".", "\\.")}'`),
    );
  }
});

test("rejects test files and nested archives", () => {
  for (const unwantedPath of ["test/api.test.ts", "package.tgz"]) {
    assert.throws(
      () => validatePackageArchive("@commissary/example", [...validFiles, { path: unwantedPath }]),
      new RegExp(`must not include '${unwantedPath.replaceAll(".", "\\.")}'`),
    );
  }
});
