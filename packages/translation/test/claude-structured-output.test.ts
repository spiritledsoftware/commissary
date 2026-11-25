// Native Claude structured outputs: a json_schema response format becomes `output_config.format` (Go:
// internal/translator/common/claude_system_test.go, internal/runtime/executor/helps/claude_input_tokens_test.go;
// upstream 43806c86).
import { describe, expect, it } from "vite-plus/test";
import {
  asString,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  collectClaudeInputSegments,
  countClaudeInputTokens,
} from "../src/tokenizer/claude-input.ts";
import { convertOpenAIRequestToClaude } from "../src/translator/claude/openai/chat-completions/request.ts";
import {
  buildClaudeOutputFormatDescription,
  claudeOutputFormatSchema,
} from "../src/translator/common/claude-system.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const parseObject = (text: string): JsonObject => {
  const value = parse(text);

  if (!isJsonObject(value)) throw new Error(`not a JSON object in test: ${text}`);

  return value;
};

describe("claudeOutputFormatSchema (43806c86)", () => {
  it("returns a Chat Completions json_schema schema unchanged", () => {
    const schema = `{"type":"object","properties":{"tags":{"type":"array","maxItems":3,"items":{"type":"string","pattern":"^[a-z]+$"}}},"required":["tags"],"additionalProperties":false}`;

    expect(
      claudeOutputFormatSchema(
        "claude-sonnet-5-5",
        parse(
          `{"type":"json_schema","json_schema":{"name":"tags","strict":true,"schema":${schema}}}`,
        ),
      ),
    ).toEqual(parse(schema));
  });

  it("returns a Responses json_schema schema, whatever the type's case", () => {
    const schema = `{"required":["facts"],"type":"object","properties":{"facts":{"type":"array","items":{"type":"string"}}}}`;

    expect(
      claudeOutputFormatSchema(
        "claude-sonnet-5-5",
        parse(`{"type":"JSON_SCHEMA","name":"facts","strict":true,"schema":${schema}}`),
      ),
    ).toEqual(parse(schema));
  });

  for (const [name, format] of [
    ["missing", undefined],
    ["text", `{"type":"text"}`],
    ["json_object", `{"type":"json_object"}`],
    ["json_schema without schema", `{"type":"json_schema","json_schema":{"name":"empty"}}`],
    ["json_schema non-object schema", `{"type":"json_schema","schema":"not a schema"}`],
    ["json_schema nested null schema", `{"type":"json_schema","json_schema":{"schema":null}}`],
  ] as const) {
    it(`falls back to the instruction for ${name}`, () => {
      expect(
        claudeOutputFormatSchema(
          "claude-sonnet-5-5",
          format === undefined ? undefined : parse(format),
        ),
      ).toBeUndefined();
    });
  }

  const format = parse(
    `{"type":"json_schema","name":"facts","schema":{"type":"object","properties":{"facts":{"type":"string"}}}}`,
  );

  for (const [model, native] of [
    ["claude-2.1", false],
    ["claude-instant-1.2", false],
    ["claude-3-5-haiku-20241022", false],
    ["claude-3.5-sonnet", false],
    ["claude-3-7-sonnet-20250219", false],
    ["claude-3-7-sonnet-20250219-thinking", false],
    ["claude-sonnet-4-20250514", false],
    ["claude-sonnet-4-0", false],
    ["claude-sonnet-4", false],
    ["claude-sonnet-4-latest", false],
    ["claude-opus-4-20250514", false],
    ["claude-opus-4-0", false],
    ["claude-opus-4", false],
    ["claude-opus-4-latest", false],
    ["claude-opus-4-1-20250805", false],
    ["claude-opus-4-1", false],
    ["claude-opus-4-1-latest", false],
    ["anthropic/claude-sonnet-4", false],
    ["anthropic/claude-opus-4-1-20250805", false],
    ["Claude-Sonnet-4-20250514(high)", false],
    ["claude-opus-4-1[1m]", false],
    ["claude-opus-4-1-thinking[1m]", false],
    ["claude-sonnet-4@20250514", false],
    ["claude-sonnet-4-5-20250929", true],
    ["claude-sonnet-4-5", true],
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-5-20251101", true],
    ["claude-opus-4-6", true],
    ["claude-opus-4-7", true],
    ["claude-opus-4-8", true],
    ["claude-haiku-4-5-20251001", true],
    ["claude-sonnet-5-5", true],
    ["claude-opus-5-5(high)", true],
    ["claude-fable-5-2", true],
    ["an-unknown-model", true],
    ["", true],
  ] as const) {
    it(`${native ? "maps" : "does not map"} the schema natively for ${JSON.stringify(model)}`, () => {
      expect(claudeOutputFormatSchema(model, format) !== undefined).toBe(native);
    });
  }
});

describe("buildClaudeOutputFormatDescription (43806c86)", () => {
  const schema = `{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}`;

  for (const [name, format] of [
    [
      "chat completions",
      `{"type":"json_schema","json_schema":{"name":"recipe","description":"A dish for two.","schema":${schema}}}`,
    ],
    [
      "responses",
      `{"type":"json_schema","name":"recipe","description":"A dish for two.","schema":${schema}}`,
    ],
  ] as const) {
    it(`keeps the ${name} name and description without repeating the schema`, () => {
      expect(buildClaudeOutputFormatDescription(parse(format))).toBe(
        "Your response must follow the JSON schema given as the output format.\nSchema Name: recipe\nSchema Description: A dish for two.",
      );
    });
  }

  it("is empty without a description", () => {
    expect(
      buildClaudeOutputFormatDescription(
        parse(`{"type":"json_schema","name":"recipe","schema":${schema}}`),
      ),
    ).toBe("");
  });
});

describe("Chat Completions -> Claude response_format (43806c86)", () => {
  const request = (model: string): Json =>
    convertOpenAIRequestToClaude(
      model,
      parse(
        `{"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_schema","json_schema":{"name":"Out","schema":{"type":"object"}}}}`,
      ),
      false,
    );

  it("sets output_config.format and adds no instruction without a description", () => {
    const out = request("claude-sonnet-4-5");

    expect(get(out, "output_config")).toEqual({
      format: { type: "json_schema", schema: { type: "object" } },
    });
    expect(get(out, "system")).toBeUndefined();
  });

  it("keeps the system prompt instruction for a legacy model", () => {
    const out = request("claude-3-7-sonnet-20250219");

    expect(get(out, "output_config")).toBeUndefined();
    expect(asString(get(out, "system.0.text"))).toContain("JSON Schema:");
  });
});

describe("Claude input token estimate (43806c86)", () => {
  const schema = `{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}`;
  const base = parse(`{"messages":[{"role":"user","content":"Hello."}]}`);

  const withFormat = parseObject(
    `{"messages":[{"role":"user","content":"Hello."}],"output_config":{"effort":"high","format":{"type":"json_schema","schema":${schema}}}}`,
  );

  it("counts output_config.format's type and schema", () => {
    const segments = collectClaudeInputSegments(withFormat);

    expect(segments).toContain("json_schema");
    expect(segments).toContain(schema);
    expect(countClaudeInputTokens(withFormat)).toBeGreaterThan(countClaudeInputTokens(base));
  });
});
