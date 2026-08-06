import assert from "node:assert/strict";
import test from "node:test";

import { checkCiGate } from "./check-ci-gate.mjs";

const fullVerificationResults = {
  documentationOnly: false,
  policyResult: "success",
  documentationResult: "skipped",
  nodeVerificationResult: "success",
  serverRuntimeResult: "success",
  chromiumResult: "success",
};

const documentationResults = {
  documentationOnly: true,
  policyResult: "success",
  documentationResult: "success",
  nodeVerificationResult: "skipped",
  serverRuntimeResult: "skipped",
  chromiumResult: "skipped",
};

void test("accepts complete source verification", () => {
  assert.deepEqual(checkCiGate(fullVerificationResults), {
    ok: true,
    message: "CI gate accepted full verification.",
  });
});

void test("accepts intentional documentation-only skips", () => {
  assert.deepEqual(checkCiGate(documentationResults), {
    ok: true,
    message: "CI gate accepted documentation-only verification.",
  });
});

void test("rejects a failed source job", () => {
  assert.deepEqual(checkCiGate({ ...fullVerificationResults, chromiumResult: "failure" }), {
    ok: false,
    message: "CI gate rejected job results: chromium expected success, received failure",
  });
});

void test("rejects an unexpected source-job skip", () => {
  assert.deepEqual(checkCiGate({ ...fullVerificationResults, serverRuntimeResult: "skipped" }), {
    ok: false,
    message: "CI gate rejected job results: serverRuntime expected success, received skipped",
  });
});

void test("rejects source jobs for a documentation-only change", () => {
  assert.deepEqual(checkCiGate({ ...documentationResults, nodeVerificationResult: "success" }), {
    ok: false,
    message: "CI gate rejected job results: nodeVerification expected skipped, received success",
  });
});

void test("rejects a failed policy job", () => {
  assert.deepEqual(checkCiGate({ ...fullVerificationResults, policyResult: "failure" }), {
    ok: false,
    message: "CI gate rejected job results: policy expected success, received failure",
  });
});
