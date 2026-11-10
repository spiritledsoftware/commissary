// Go source: internal/runtime/executor/helps/claude_tool_property_names_test.go
import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@commissary/json";
import {
  CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX,
  CLAUDE_TOOL_SCHEMA_MAX_INSPECT_DEPTH,
  claudePropertyKeyAccepted,
  claudeSchemaHasRejectedPropertyKey,
  normalizeClaudeToolPropertyNames,
} from "../../src/executor/claude/tool-property-names.ts";

const FALLBACK_SCHEMA = { type: "object" };

describe("claudePropertyKeyAccepted", () => {
  it.each([
    ["state", true],
    ["user.name", true],
    ["a-b_c", true],
    ["x".repeat(64), true],
    ["x".repeat(65), false],
    ["", false],
    ["not[labels]", false],
    ["$schema", false],
    ["a b", false],
    ["名", false],
  ])("%s -> %s", (name, want) => {
    expect(claudePropertyKeyAccepted(name)).toBe(want);
  });
});

const json = (text: string): JsonObject => JSON.parse(text) as JsonObject;

describe("normalizeClaudeToolPropertyNames", () => {
  const rejectedSchema = `{"type":"object","properties":{"not[labels]":{"type":"string"},"state":{"type":"string"}},"required":["not[labels]"]}`;
  const nestedSchema = `{"type":"object","$defs":{"f":{"type":"object","properties":{"$schema":{"type":"string"}}}},"properties":{"filter":{"$ref":"#/$defs/f"}}}`;
  const inlineSchema = `{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"id[]":{"type":"string"}}}}}}`;
  const propertyNamedDefault = `{"type":"object","properties":{"default":{"type":"object","properties":{"a b":{"type":"string"}}}}}`;
  const instanceOnly = `{"type":"object","properties":{"q":{"type":"object","default":{"properties":{"a b":1}},"examples":[{"properties":{"c d":2}}],"const":{"properties":{"e f":3}},"enum":[{"properties":{"g h":4}}]}}}`;
  const validSchema = `{"type":"object","properties":{"user.name":{"type":"string"}}}`;

  const body = (): JsonObject =>
    json(
      `{"tools":[` +
        `{"name":"list_merge_requests","description":"List merge requests.","strict":true,"cache_control":{"type":"ephemeral"},"input_schema":${rejectedSchema},"input_examples":[{"not[labels]":"bug"}]},` +
        `{"name":"nested","input_schema":${nestedSchema}},` +
        `{"name":"property_named_default","description":"Default.","input_schema":${propertyNamedDefault}},` +
        `{"name":"instance_only","description":"Data.","input_schema":${instanceOnly}},` +
        `{"name":"valid","description":"Valid.","strict":true,"input_schema":${validSchema}},` +
        `{"type":"web_search_20250305","name":"web_search","max_uses":1}],` +
        `"messages":[` +
        `{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"list_merge_requests","input":{"not[labels]":"bug"}}]},` +
        `{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"[]"}]},` +
        `{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"inline_tool","description":"Inline.","input_schema":${inlineSchema}}}}]}]}`,
    );

  it("embeds rejected schemas in the description and leaves the rest alone", () => {
    const out = body();
    normalizeClaudeToolPropertyNames(out);
    const tools = out.tools as JsonObject[];

    const inline = (
      ((out.messages as JsonObject[])[2]!.content as JsonObject[])[0]!.tool as JsonObject
    ).definition as JsonObject;

    const fallbacks: Array<[JsonObject, string]> = [
      [tools[0]!, `List merge requests.\n\n${CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX}${rejectedSchema}`],
      [tools[1]!, `${CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX}${nestedSchema}`],
      [tools[2]!, `Default.\n\n${CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX}${propertyNamedDefault}`],
      [inline, `Inline.\n\n${CLAUDE_TOOL_SCHEMA_FALLBACK_PREFIX}${inlineSchema}`],
    ];

    for (const [tool, description] of fallbacks) {
      expect(tool.input_schema).toEqual(FALLBACK_SCHEMA);
      expect(tool.description).toBe(description);
      expect("strict" in tool).toBe(false);
    }

    const original = body();
    const originalTools = original.tools as JsonObject[];
    expect(tools[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(tools[0]!.input_examples).toEqual([{ "not[labels]": "bug" }]);
    expect(tools[3]).toEqual(originalTools[3]);
    expect(tools[4]).toEqual(originalTools[4]);
    expect(tools[5]).toEqual(originalTools[5]);
    expect(((out.messages as JsonObject[])[0]!.content as JsonObject[])[0]!.input).toEqual({
      "not[labels]": "bug",
    });
  });

  it("leaves requests Claude accepts unchanged", () => {
    const text = `{"tools":[{"name":"t","description":"d","input_schema":{"type":"object","$defs":{"a[b]":{"type":"string"}},"patternProperties":{"^x\\\\[":{}},"properties":{"file.xml":{"$ref":"#/$defs/a[b]"}}}}],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"t","input":{"x[1]":2}}]}]}`;
    const out = json(text);
    normalizeClaudeToolPropertyNames(out);
    expect(out).toEqual(json(text));
  });

  it("falls back for schemas nested beyond the inspection depth", () => {
    const depth = CLAUDE_TOOL_SCHEMA_MAX_INSPECT_DEPTH + 10;
    const schema = `${'{"not":'.repeat(depth)}{}${"}".repeat(depth)}`;
    const out = json(`{"tools":[{"name":"deep","input_schema":${schema}}]}`);
    normalizeClaudeToolPropertyNames(out);
    const tool = (out.tools as JsonObject[])[0]!;
    expect(tool.input_schema).toEqual(FALLBACK_SCHEMA);
    expect((tool.description as string).endsWith(schema)).toBe(true);
  });

  it("ignores a body without tools", () => {
    const out = json(`{"messages":[]}`);
    normalizeClaudeToolPropertyNames(out);
    expect(out).toEqual({ messages: [] });
  });
});

// Keyword names are only interpreted at schema positions; named definitions, dependent schemas, patterns and
// properties are classified by their role.
describe("claudeSchemaHasRejectedPropertyKey", () => {
  const rejected = `{"type":"object","properties":{"not[labels]":{"type":"string"}}}`;
  const accepted = `{"type":"object","properties":{"value":{"type":"string"}}}`;

  const cases = {
    "defs named default": [
      `{"$defs":{"default":${rejected}},"properties":{"f":{"$ref":"#/$defs/default"}}}`,
      true,
    ],
    "definitions named enum": [`{"definitions":{"enum":${rejected}}}`, true],
    "dependent schema named const": [`{"dependentSchemas":{"const":${rejected}}}`, true],
    "dependencies schema named const": [`{"dependencies":{"const":${rejected},"a":["b"]}}`, true],
    "pattern named examples": [`{"patternProperties":{"examples":${rejected}}}`, true],
    "property named default": [`{"properties":{"default":${rejected}}}`, true],
    "property named properties": [`{"properties":{"properties":${rejected}}}`, true],
    "nested applicators": [
      `{"anyOf":[{"items":[{"not":{"if":{"then":{"contains":${rejected}}}}}]}]}`,
      true,
    ],
    "tuple items and prefix items": [
      `{"prefixItems":[true,{"additionalProperties":${rejected}}]}`,
      true,
    ],
    "defs named properties": [
      `{"$defs":{"text":{"type":"string"},"properties":{"$ref":"#/$defs/text"}},"properties":{"value":{"$ref":"#/$defs/properties"}},"additionalProperties":false}`,
      false,
    ],
    "property named properties valid": [`{"properties":{"properties":${accepted}}}`, false],
    "defs with rejected definition key": [`{"$defs":{"a[b]":${accepted}}}`, false],
    "data keywords": [
      `{"default":{"properties":{"a b":1}},"const":{"properties":{"c d":2}},"enum":[{"properties":{"e f":3}}],"examples":[{"properties":{"g h":4}}]}`,
      false,
    ],
    "unknown annotation": [`{"x-ui":{"properties":{"a b":{}}}}`, false],
  } satisfies Record<string, [string, boolean]>;

  it.each(Object.entries(cases))("%s", (_name, [schema, want]) => {
    expect(claudeSchemaHasRejectedPropertyKey(JSON.parse(schema) as Json, 0)).toBe(want);
  });
});
