// The Gemini cleaner's passes that rewrite a node's `required` list: nullable properties leave it
// (`flattenTypeArrays`), and `allOf` branches merge theirs into it (`mergeAllOf`). Order and de-duplication are the
// behaviour under test.
import { describe, expect, it } from "vite-plus/test";
import { get } from "@commissary/json";
import { cleanJsonSchemaForGemini } from "../src/translator/gemini/util/json-schema.ts";

describe("Gemini cleaner: required lists", () => {
  it("drops every nullable property from required and keeps the rest in order", () => {
    const got = cleanJsonSchemaForGemini({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { type: ["integer", "null"] },
        c: { type: "string" },
        d: { type: "boolean" },
      },
      required: ["d", "a", "c", "b"],
    });

    expect(get(got, "required")).toEqual(["d", "c"]);
  });

  it("removes required when every listed property is nullable", () => {
    const got = cleanJsonSchemaForGemini({
      type: "object",
      properties: { a: { type: ["string", "null"] }, b: { type: ["null", "number"] } },
      required: ["a", "b"],
    });

    expect(get(got, "required")).toBeUndefined();
  });

  it("merges the allOf branches' required lists into the node's, once each and in order", () => {
    const got = cleanJsonSchemaForGemini({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      allOf: [{ required: ["a", "b"] }, { required: ["c", "b"] }],
    });

    expect(get(got, "required")).toEqual(["a", "b", "c"]);
    expect(get(got, "allOf")).toBeUndefined();
  });
});
