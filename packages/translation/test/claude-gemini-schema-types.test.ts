// Gemini client -> Claude: tool schema types are lower-cased only where they are schema `type` keywords, and only when
// they are strings (upstream 9b4f3f30). Expected values come from the Go tests of that commit
// (TestConvertGeminiRequestToClaude_PreservesPropertyNamedTypeAndSchemaValues,
// TestLowercaseClaudeToolSchemaTypesPreservesNonStringType).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

const inputSchema = (schemaField: string, schema: Json): Json =>
  get(
    builtinTranslators.translateRequest("gemini", "claude", {
      format: "gemini",
      model: "claude-sonnet-4-6",
      stream: true,
      body: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly hi." }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "inspect_schedule",
                description: "Inspect a sample schedule.",
                [schemaField]: schema,
              },
            ],
          },
        ],
      },
    }).body,
    "tools.0.input_schema",
  ) ?? null;

describe("schema types are lower-cased only where they are types (9b4f3f30)", () => {
  it.each(["parameters", "parametersJsonSchema"])("%s", (schemaField) => {
    const schema = inputSchema(schemaField, {
      type: "OBJECT",
      properties: {
        schedule: {
          type: "OBJECT",
          properties: { type: { type: "STRING", enum: ["interval", "once"] } },
        },
        kind_only: {
          type: "OBJECT",
          properties: {
            type: { enum: ["alpha", "beta"], description: "Kind without nested type keyword" },
          },
        },
        flag: { properties: { type: true } },
        tags: { type: "ARRAY", items: false },
        tuple_items: { type: "ARRAY", items: [true, { type: "STRING" }] },
        nullable_count: { type: ["integer", "null"] },
        metadata: {
          type: "OBJECT",
          default: { type: "KeepCase" },
          example: { type: "AlsoKeepCase" },
        },
      },
    });

    expect(get(schema, "type")).toBe("object");
    expect(get(schema, "properties.schedule.type")).toBe("object");
    // A property named `type` is a property, not the keyword.
    expect(get(schema, "properties.schedule.properties.type")).toEqual({
      type: "string",
      enum: ["interval", "once"],
    });
    expect(get(schema, "properties.flag.properties.type")).toBe(true);
    expect(get(schema, "properties.kind_only.properties.type.description")).toBe(
      "Kind without nested type keyword",
    );
    expect(get(schema, "properties.tags.items")).toBe(false);
    expect(get(schema, "properties.tuple_items.items.0")).toBe(true);
    expect(get(schema, "properties.tuple_items.items.1.type")).toBe("string");
    // A non-string type is kept as it is.
    expect(get(schema, "properties.nullable_count.type")).toEqual(["integer", "null"]);
    // Literal values (default, example) keep their case.
    expect(get(schema, "properties.metadata.default.type")).toBe("KeepCase");
    expect(get(schema, "properties.metadata.example.type")).toBe("AlsoKeepCase");
  });

  it("keeps a non-string type of the schema itself", () => {
    const schema = inputSchema("parametersJsonSchema", {
      type: 123,
      properties: { type: { type: "STRING", enum: ["a", "b"] } },
    });

    expect(get(schema, "type")).toBe(123);
    expect(get(schema, "properties.type")).toEqual({ type: "string", enum: ["a", "b"] });
  });
});
