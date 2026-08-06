import assert from "node:assert/strict";
import test from "node:test";

import { isDocumentationOnlyChange } from "./classify-ci-change.mjs";

void test("accepts every documented documentation path", () => {
  assert.equal(
    isDocumentationOnlyChange([
      "docs/adr/0020-ci-policy.md",
      "README.md",
      "LICENSE",
      "packages/core/README.md",
      "packages/store/CONTEXT.md",
      "packages/effect/docs/design/example.json",
      ".github/pull_request_template.md",
      ".agents/skills/grill-with-docs/SKILL.md",
      ".changeset/README.md",
    ]),
    true,
  );
});

void test("requires full verification for an empty change list", () => {
  assert.equal(isDocumentationOnlyChange([]), false);
});

void test("requires full verification for Changeset release metadata", () => {
  assert.equal(isDocumentationOnlyChange([".changeset/calm-tools-smile.md"]), false);
});

void test("requires full verification for package source", () => {
  assert.equal(isDocumentationOnlyChange(["packages/core/src/index.ts"]), false);
});

void test("requires full verification for unknown package Markdown", () => {
  assert.equal(isDocumentationOnlyChange(["packages/core/test/fixture.md"]), false);
});

void test("requires full verification for mixed documentation and source", () => {
  assert.equal(isDocumentationOnlyChange(["docs/design.md", "packages/core/src/index.ts"]), false);
});
