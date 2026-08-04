import assert from "node:assert/strict";
import test from "node:test";

import { checkChangesetPolicy } from "./check-changeset.mjs";

const packageSource = "packages/core/src/index.ts";

void test("requires a Changeset for publishable package code", () => {
  assert.deepEqual(
    checkChangesetPolicy({
      changedFiles: [packageSource],
      labels: [],
      headRef: "feature/runtime-change",
    }),
    {
      ok: false,
      message:
        "Publishable package code changed without a Changeset. Add one with 'pnpm changeset' or apply the 'no-changeset' label.",
    },
  );
});

void test("accepts a package change with a Changeset", () => {
  assert.deepEqual(
    checkChangesetPolicy({
      changedFiles: [packageSource, ".changeset/calm-tools-smile.md"],
      labels: [],
      headRef: "feature/runtime-change",
    }),
    { ok: true, message: "Changeset found." },
  );
});

void test("accepts an explicit no-changeset exception", () => {
  assert.deepEqual(
    checkChangesetPolicy({
      changedFiles: [packageSource],
      labels: ["no-changeset"],
      headRef: "feature/runtime-change",
    }),
    { ok: true, message: "The no-changeset label allows this change." },
  );
});

void test("does not require a Changeset for non-publishable changes", () => {
  assert.deepEqual(
    checkChangesetPolicy({
      changedFiles: ["packages/core/test/api.test.ts", ".github/workflows/ci.yml"],
      labels: [],
      headRef: "test/ci-change",
    }),
    { ok: true, message: "No publishable package code changed." },
  );
});

void test("requires a Changeset for package manifest changes", () => {
  assert.equal(
    checkChangesetPolicy({
      changedFiles: ["packages/effect/package.json"],
      labels: [],
      headRef: "build/effect-dependency",
    }).ok,
    false,
  );
});

void test("allows the generated Version Packages pull request", () => {
  assert.deepEqual(
    checkChangesetPolicy({
      changedFiles: ["packages/core/package.json", "packages/core/CHANGELOG.md"],
      labels: [],
      headRef: "changeset-release/main",
    }),
    { ok: true, message: "The Version Packages pull request does not need a Changeset." },
  );
});
