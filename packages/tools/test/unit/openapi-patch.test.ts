// JSON Patch (RFC 6902) over an OpenAPI document: the fixes integrations.sh records for a spec (`specOverrides`,
// #207). Each operation applies to a copy, a pointer's escapes are honoured, and an operation that does not apply
// fails the whole patch with what went wrong.
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { applyJsonPatch } from "../../src/openapi/patch.ts";

const DOCUMENT = {
  openapi: "3.0.0",
  servers: [{ url: "http://api.example.com" }],
  paths: { "/a/b": { get: { operationId: "get" } } },
};

describe("applyJsonPatch", () => {
  it("applies add, replace, remove, move, copy and test in order, leaving the input as it was", () => {
    const before = JSON.stringify(DOCUMENT);

    const patched = applyJsonPatch(DOCUMENT, [
      { op: "test", path: "/openapi", value: "3.0.0" },
      { op: "replace", path: "/servers/0/url", value: "https://api.example.com" },
      { op: "add", path: "/servers/-", value: { url: "https://eu.api.example.com" } },
      { op: "copy", from: "/paths/~1a~1b", path: "/paths/~1c" },
      { op: "move", from: "/paths/~1a~1b/get", path: "/paths/~1a~1b/post" },
      { op: "remove", path: "/openapi" },
    ]);

    expect(Result.getOrUndefined(patched)).toEqual({
      servers: [{ url: "https://api.example.com" }, { url: "https://eu.api.example.com" }],
      paths: {
        "/a/b": { post: { operationId: "get" } },
        "/c": { get: { operationId: "get" } },
      },
    });
    expect(JSON.stringify(DOCUMENT)).toBe(before);
  });

  it("replaces the whole document at the empty pointer", () => {
    expect(
      Result.getOrUndefined(applyJsonPatch(DOCUMENT, [{ op: "replace", path: "", value: {} }])),
    ).toEqual({});
  });

  it("fails the patch when an operation does not apply", () => {
    const missing = applyJsonPatch(DOCUMENT, [
      { op: "replace", path: "/servers/0/url", value: "https://api.example.com" },
      { op: "remove", path: "/info/title" },
    ]);

    expect(Result.isFailure(missing) && missing.failure).toBe(
      "operation 2 (remove /info/title): no member info",
    );

    const failedTest = applyJsonPatch(DOCUMENT, [{ op: "test", path: "/openapi", value: "3.1.0" }]);

    expect(Result.isFailure(failedTest) && failedTest.failure).toBe(
      "operation 1 (test /openapi): test of /openapi failed",
    );
    expect(
      Result.isFailure(applyJsonPatch(DOCUMENT, [{ op: "replace", path: "/servers/1", value: 1 }])),
    ).toBe(true);
    expect(
      Result.isFailure(applyJsonPatch(DOCUMENT, [{ op: "add", path: "servers", value: 1 }])),
    ).toBe(true);
  });
});
