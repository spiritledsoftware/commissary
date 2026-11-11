// Claude tool_result -> Antigravity functionResponse: error semantics (ticket C8; upstream 068fe153, Go test
// TestConvertClaudeRequestToAntigravity_PreservesToolResultErrors).
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

const PNG: Json = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
};

const cases: Array<{ name: string; fields: Json; response: Json; image?: boolean }> = [
  {
    name: "success_without_flag",
    fields: { content: "permission denied" },
    response: { result: "permission denied" },
  },
  {
    name: "explicit_success",
    fields: { is_error: false, content: { ok: true } },
    response: { result: { ok: true } },
  },
  {
    name: "non_bool_is_error_string_treated_as_success",
    fields: { is_error: "true", content: "permission denied" },
    response: { result: "permission denied" },
  },
  {
    name: "non_bool_is_error_number_treated_as_success",
    fields: { is_error: 1, content: "permission denied" },
    response: { result: "permission denied" },
  },
  {
    name: "failed_string",
    fields: { is_error: true, content: "permission denied" },
    response: { error: "permission denied" },
  },
  {
    name: "failed_structured_result",
    fields: { is_error: true, content: { code: "EACCES", retryable: false } },
    response: { error: { code: "EACCES", retryable: false } },
  },
  {
    name: "failed_text_and_image",
    fields: { is_error: true, content: [{ type: "text", text: "permission denied" }, PNG] },
    response: { error: { type: "text", text: "permission denied" } },
    image: true,
  },
  {
    name: "failed_image_only_array",
    fields: { is_error: true, content: [PNG] },
    response: { error: "" },
    image: true,
  },
  {
    name: "failed_single_image_object",
    fields: { is_error: true, content: PNG },
    response: { error: "" },
    image: true,
  },
  {
    name: "failed_multiple_blocks",
    fields: {
      is_error: true,
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
    response: {
      error: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  },
  { name: "failed_without_content", fields: { is_error: true }, response: { error: "" } },
  {
    name: "failed_schema_ref_remains_opaque",
    fields: { is_error: true, content: { $ref: "#/definitions/Error" } },
    response: { error: '{"$ref":"#/definitions/Error"}' },
  },
];

describe("Claude -> Antigravity: tool_result errors", () => {
  it.each(cases)("$name", ({ fields, response, image }) => {
    for (const stream of [false, true]) {
      const out = builtinTranslators.translateRequest(
        "claude",
        "antigravity",
        {
          format: "claude",
          model: "claude-sonnet-4-5",
          stream,
          body: {
            model: "claude-sonnet-4-5",
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
              },
              {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "call_1", ...(fields as object) }],
              },
            ],
          },
        },
        undefined,
      ).body;

      const functionResponse = get(out, "request.contents.1.parts.0.functionResponse");

      expect(get(functionResponse, "id")).toBe("call_1");
      expect(get(functionResponse, "name")).toBe("Read");
      expect(get(functionResponse, "response")).toEqual(response);

      if (image)
        expect(get(functionResponse, "parts.0.inlineData")).toEqual({
          mimeType: "image/png",
          data: "aGVsbG8=",
        });
      else expect(get(functionResponse, "parts")).toBeUndefined();
    }
  });
});
