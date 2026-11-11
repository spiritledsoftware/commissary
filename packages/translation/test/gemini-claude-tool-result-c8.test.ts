// Claude tool_result -> Gemini functionResponse: error semantics (ticket C8; upstream 81de4b9c) and images nested in
// functionResponse.parts (be864305). Expected values come from the Go tests of those commits
// (gemini_claude_tool_result_error_test.go, gemini_claude_request_test.go, claude_tool_result_test.go).
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import {
  convertClaudeRequestToGemini,
  convertClaudeRequestToGeminiWithCompat,
} from "../src/translator/gemini/claude/request.ts";
import { convertClaudeToolResult } from "../src/translator/gemini/util/claude.ts";

const PNG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
};

describe("convertClaudeToolResult", () => {
  it.each<[string, Json, boolean]>([
    ["omitted", { content: "permission denied" }, false],
    ["false", { is_error: false, content: "permission denied" }, false],
    ["true", { is_error: true, content: "permission denied" }, true],
    ["null", { is_error: null, content: "permission denied" }, false],
    ["string", { is_error: "true", content: "permission denied" }, false],
    ["number", { is_error: 1, content: "permission denied" }, false],
  ])("is_error %s", (_name, block, isError) => {
    const got = convertClaudeToolResult(block);

    expect(got.isError).toBe(isError);
    expect(got.result).toBe("permission denied");
    expect(got.resultIsRaw).toBe(false);
    expect(got.images).toEqual([]);
  });
});

describe("Claude tool_result errors", () => {
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

  const entrypoints = [
    ["native", convertClaudeRequestToGemini],
    ["compat", convertClaudeRequestToGeminiWithCompat],
  ] as const;

  describe.each(entrypoints)("%s", (_entry, translate) => {
    it.each(cases)("$name", ({ fields, response, image }) => {
      for (const stream of [false, true]) {
        const out = translate(
          "gemini-3-flash-preview",
          {
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
          stream,
        );

        const functionResponse = get(out, "contents.1.parts.0.functionResponse");

        expect(get(functionResponse, "id")).toBe("call_1");
        expect(get(functionResponse, "name")).toBe("Read");
        expect(get(functionResponse, "response")).toEqual(response);
        const parts = get(out, "contents.1.parts") as Json[];

        if (image) {
          expect(parts).toHaveLength(2);
          expect(get(parts[1], "inline_data")).toEqual({
            mime_type: "image/png",
            data: "aGVsbG8=",
          });
        } else expect(parts).toHaveLength(1);
      }
    });
  });
});
