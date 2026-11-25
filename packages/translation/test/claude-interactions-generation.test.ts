// Claude Messages -> Interactions generation constraints (Go:
// internal/translator/interactions/claude/interactions_claude_request_test.go, internal/translator/common/request_test.go;
// upstream ac415c08, 62c419e0: the Interactions translator's part, which the claude-interactions golden fixture pins).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertClaudeRequestToInteractions } from "../src/translator/interactions/claude/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const translate = (fields: string): Json =>
  convertClaudeRequestToInteractions(
    "gemini-3.1-flash-lite",
    parse(`{${fields}${fields === "" ? "" : ","}"messages":[{"role":"user","content":"hi"}]}`),
    false,
  );

describe("Claude -> Interactions generation constraints (ac415c08, 62c419e0)", () => {
  it("forwards a numeric max_tokens as is, zero included", () => {
    expect(get(translate(`"max_tokens":0`), "generation_config.max_output_tokens")).toBe(0);
    expect(get(translate(`"max_tokens":1048576`), "generation_config.max_output_tokens")).toBe(
      1048576,
    );
  });

  it("drops a non-numeric max_tokens", () => {
    for (const value of [`null`, `"12"`, `true`]) {
      expect(
        get(translate(`"max_tokens":${value}`), "generation_config.max_output_tokens"),
      ).toBeUndefined();
    }
  });

  it("keeps only the non-empty string stop sequences", () => {
    expect(
      get(translate(`"stop_sequences":["a","",1,null,"b"]`), "generation_config.stop_sequences"),
    ).toEqual(["a", "b"]);
    expect(
      get(translate(`"stop_sequences":["",2]`), "generation_config.stop_sequences"),
    ).toBeUndefined();
    expect(
      get(translate(`"stop_sequences":"stop"`), "generation_config.stop_sequences"),
    ).toBeUndefined();
  });

  it("maps a json_schema output format to response_format", () => {
    expect(
      get(
        translate(
          `"output_config":{"format":{"type":"JSON_SCHEMA","schema":{"type":"object","properties":{"a":{"type":"string"}}}}}`,
        ),
        "response_format",
      ),
    ).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: { type: "object", properties: { a: { type: "string" } } },
    });
  });

  it("ignores other output formats and non-object schemas", () => {
    for (const format of [
      `{"type":"text"}`,
      `{"type":"json_schema"}`,
      `{"type":"json_schema","schema":"x"}`,
      `"json_schema"`,
    ]) {
      expect(
        get(translate(`"output_config":{"format":${format}}`), "response_format"),
      ).toBeUndefined();
    }
  });
});
