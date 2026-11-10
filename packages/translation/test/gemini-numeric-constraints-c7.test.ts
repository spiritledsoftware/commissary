// String-encoded numeric schema constraints become numbers when Gemini tool parameters are converted (ticket C7;
// upstream ec06c3cb, issue 7149): Google's protobuf Schema carries minLength/maxLength/minItems/maxItems/minProperties/
// maxProperties as int64 strings, while a standard JSON Schema carrier (parametersJsonSchema) and the other providers
// need numbers. String literals and non-schema metadata stay untouched. Expected values are the Go tests'.
import { describe, expect, it } from "vitest";
import { get, isJsonObject, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { normalizeJsonSchemaNumericConstraints } from "../src/translator/common/schema.ts";
import { cleanJsonSchemaForGeminiJsonSchema } from "../src/translator/gemini/util/json-schema.ts";

const NUMERIC_CHECKS: ReadonlyArray<readonly [string, number]> = [
  ["minProperties", 1],
  ["maxProperties", 10],
  ["properties.Message.minLength", 1],
  ["properties.Message.maxLength", 200],
  ["properties.Items.minItems", 1],
  ["properties.Items.maxItems", 5],
  ["properties.Items.items.minLength", 2],
];

const runCommandParameters = (): Json => ({
  type: "OBJECT",
  minProperties: "1",
  maxProperties: "10",
  properties: {
    Message: {
      type: "STRING",
      minLength: "1",
      maxLength: "200",
      enum: ["1", "2"],
      default: "1",
    },
    Items: {
      type: "ARRAY",
      minItems: "1",
      maxItems: "5",
      items: { type: "STRING", minLength: "2" },
    },
  },
});

describe("CleanJSONSchemaForGeminiJSONSchema normalizes numeric constraint strings", () => {
  it("converts the keywords, inlining after normalization so an equal $ref sibling merges", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "OBJECT",
      minProperties: "1",
      maxProperties: "8",
      $defs: { Tag: { type: "STRING", minLength: "2", maxLength: "16" } },
      properties: {
        Message: {
          type: "STRING",
          minLength: "1",
          maxLength: "100",
          enum: ["1", "2"],
          default: "1",
          example: "1",
          examples: ["1", { minLength: "1" }],
        },
        Items: {
          type: "ARRAY",
          minItems: "1",
          maxItems: "4",
          items: { $ref: "#/$defs/Tag" },
        },
        EqualRef: { $ref: "#/$defs/Tag", minLength: 2 },
      },
    });

    for (const [path, want] of [
      ["minProperties", 1],
      ["maxProperties", 8],
      ["properties.Message.minLength", 1],
      ["properties.Message.maxLength", 100],
      ["properties.Items.minItems", 1],
      ["properties.Items.maxItems", 4],
      ["properties.Items.items.minLength", 2],
      ["properties.Items.items.maxLength", 16],
      ["properties.EqualRef.minLength", 2],
      ["properties.EqualRef.maxLength", 16],
    ] as const) {
      expect(get(got, path), path).toBe(want);
    }

    for (const [path, want] of [
      ["properties.Message.enum.0", "1"],
      ["properties.Message.enum.1", "2"],
      ["properties.Message.default", "1"],
      ["properties.Message.example", "1"],
      ["properties.Message.examples.0", "1"],
      ["properties.Message.examples.1.minLength", "1"],
    ] as const) {
      expect(get(got, path), path).toBe(want);
    }
  });
});

describe("normalizeJsonSchemaNumericConstraints", () => {
  it("visits only schema containers and leaves metadata and names alone", () => {
    const input: Json = {
      type: "string",
      minLength: "1",
      "x-metadata": { minLength: "2", maxItems: "3" },
      customAnnotation: { minProperties: "4" },
      schema: { minLength: "5" },
      defs: { metadata: { minLength: "9" } },
      properties: {
        "a\\b": { type: "string", minLength: "6" },
        "a.b": { type: "string", maxLength: "7" },
      },
      patternProperties: { "^\\d+$": { type: "string", minLength: "8" } },
    };

    const got = normalizeJsonSchemaNumericConstraints(input);

    expect(get(got, "minLength")).toBe(1);

    if (!isJsonObject(got)) throw new Error("expected an object");
    expect(got["properties"]).toEqual({
      "a\\b": { type: "string", minLength: 6 },
      "a.b": { type: "string", maxLength: 7 },
    });
    expect(got["patternProperties"]).toEqual({ "^\\d+$": { type: "string", minLength: 8 } });
    expect(got["x-metadata"]).toEqual({ minLength: "2", maxItems: "3" });
    expect(got["customAnnotation"]).toEqual({ minProperties: "4" });
    expect(got["schema"]).toEqual({ minLength: "5" });
    expect(got["defs"]).toEqual({ metadata: { minLength: "9" } });
  });

  it("reads keys written as unicode escapes", () => {
    // SAFETY: the literal is valid JSON written with \u escapes, which the parser decodes into keyword keys.
    const input = JSON.parse(
      '{"type":"string","\\u006dinLength":"1","\\u0070roperties":{"Msg":{"type":"string","\\u006daxLength":"2"}}}',
    ) as Json;

    const got = normalizeJsonSchemaNumericConstraints(input);

    expect(get(got, "minLength")).toBe(1);
    expect(get(got, "properties.Msg.maxLength")).toBe(2);
  });

  it("covers every subschema position and leaves non-canonical numbers as strings", () => {
    const got = normalizeJsonSchemaNumericConstraints({
      anyOf: [{ minLength: "3" }],
      items: [{ minItems: "4" }],
      not: { maxLength: "5" },
      $defs: { D: { minProperties: "6" } },
      minLength: "01",
      maxLength: "-1",
      minItems: "1.5",
      maxItems: 7,
    });

    expect(got).toEqual({
      anyOf: [{ minLength: 3 }],
      items: [{ minItems: 4 }],
      not: { maxLength: 5 },
      $defs: { D: { minProperties: 6 } },
      minLength: "01",
      maxLength: "-1",
      minItems: "1.5",
      maxItems: 7,
    });
  });

  it("converts any int64 and leaves larger values as strings", () => {
    expect(
      normalizeJsonSchemaNumericConstraints({
        minLength: "9223372036854775807",
        maxLength: "9007199254740993",
        minItems: "9223372036854775808",
      }),
    ).toEqual({
      // The nearest doubles: above 2^53 an int64 is no longer exact.
      minLength: Number("9223372036854775807"),
      maxLength: Number("9007199254740993"),
      minItems: "9223372036854775808",
    });
  });

  it("returns the input itself when nothing changes", () => {
    const schema: Json = { type: "object", properties: { a: { type: "string", minLength: 1 } } };

    expect(normalizeJsonSchemaNumericConstraints(schema)).toBe(schema);
  });
});

describe("Gemini -> Gemini request", () => {
  it("normalizes parameters and responseSchema, keeping literals, names and metadata", () => {
    const body: Json = {
      contents: [{ role: "user", parts: [{ text: "run command" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "run_command",
              parameters: {
                type: "OBJECT",
                minProperties: "1",
                maxProperties: "10",
                properties: {
                  Message: {
                    type: "STRING",
                    minLength: "1",
                    maxLength: "200",
                    enum: ["1", "2"],
                    default: "1",
                    example: "1",
                    examples: ["1", { minLength: "1" }],
                  },
                  Args: {
                    type: "ARRAY",
                    minItems: "1",
                    maxItems: "5",
                    items: { type: "STRING", minLength: "2", maxLength: "50" },
                  },
                  Filter: {
                    anyOf: [
                      { type: "STRING", minLength: "3" },
                      { type: "ARRAY", minItems: "4", items: { type: "STRING" } },
                    ],
                  },
                  minLength: { type: "STRING", minLength: "6", default: "6" },
                  properties: { type: "STRING", minLength: "7" },
                  default: { type: "STRING", minLength: "8", default: "8" },
                  "a\\b": { type: "STRING", minLength: "11" },
                },
                patternProperties: { "^\\d+$": { type: "STRING", maxLength: "12" } },
                "x-metadata": { minLength: "2", maxItems: "9" },
                schema: { minLength: "10" },
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseSchema: {
          type: "OBJECT",
          minProperties: "1",
          properties: { Summary: { type: "STRING", minLength: "5" } },
        },
      },
    };

    const out = builtinTranslators.translateRequest(
      "gemini",
      "gemini",
      { format: "gemini", model: "gemini-2.5-pro", stream: false, body },
      undefined,
    ).body;

    const declaration = get(out, "tools.0.function_declarations.0");

    expect(get(declaration ?? null, "parameters")).toBeUndefined();
    const schema = get(declaration ?? null, "parametersJsonSchema");

    for (const [path, want] of [
      ["minProperties", 1],
      ["maxProperties", 10],
      ["properties.Message.minLength", 1],
      ["properties.Message.maxLength", 200],
      ["properties.Args.minItems", 1],
      ["properties.Args.maxItems", 5],
      ["properties.Args.items.minLength", 2],
      ["properties.Args.items.maxLength", 50],
      ["properties.Filter.anyOf.0.minLength", 3],
      ["properties.Filter.anyOf.1.minItems", 4],
      ["properties.minLength.minLength", 6],
      ["properties.properties.minLength", 7],
      ["properties.default.minLength", 8],
    ] as const) {
      expect(get(schema ?? null, path), path).toBe(want);
    }

    for (const [path, want] of [
      ["properties.Message.enum.0", "1"],
      ["properties.Message.enum.1", "2"],
      ["properties.Message.default", "1"],
      ["properties.Message.example", "1"],
      ["properties.Message.examples.0", "1"],
      ["properties.Message.examples.1.minLength", "1"],
      ["properties.minLength.default", "6"],
      ["properties.default.default", "8"],
      ["x-metadata.minLength", "2"],
      ["x-metadata.maxItems", "9"],
      ["schema.minLength", "10"],
    ] as const) {
      expect(get(schema ?? null, path), path).toBe(want);
    }

    if (!isJsonObject(schema)) throw new Error("expected parametersJsonSchema");

    // A property named `a\b` stays one property (no key fabricated by path splitting).
    expect(Object.keys(get(schema, "properties") as Record<string, Json>)).toContain("a\\b");
    expect(get(schema, "properties.ab")).toBeUndefined();
    expect(get(schema, "patternProperties")).toEqual({
      "^\\d+$": { type: "STRING", maxLength: 12 },
    });

    expect(get(out, "generationConfig.responseSchema")).toBeUndefined();
    expect(get(out, "generationConfig.responseJsonSchema.minProperties")).toBe(1);
    expect(get(out, "generationConfig.responseJsonSchema.properties.Summary.minLength")).toBe(5);
  });

  it("normalizes an existing parametersJsonSchema and responseJsonSchema too", () => {
    const body: Json = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "t", parametersJsonSchema: { type: "object", minProperties: "2" } },
          ],
        },
      ],
      generationConfig: { responseJsonSchema: { type: "object", maxProperties: "3" } },
    };

    const out = builtinTranslators.translateRequest(
      "gemini",
      "gemini",
      { format: "gemini", model: "gemini-2.5-pro", stream: false, body },
      undefined,
    ).body;

    expect(get(out, "tools.0.function_declarations.0.parametersJsonSchema.minProperties")).toBe(2);
    expect(get(out, "generationConfig.responseJsonSchema.maxProperties")).toBe(3);
  });
});

const geminiBody = (): Json => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  tools: [
    {
      functionDeclarations: [
        {
          name: "run_command",
          description: "Run a command",
          parameters: runCommandParameters(),
        },
      ],
    },
  ],
});

describe("Gemini -> every target", () => {
  const targets: ReadonlyArray<readonly [string, string, string]> = [
    ["gemini", "gemini", "tools.0.function_declarations.0.parametersJsonSchema"],
    ["antigravity", "antigravity", "request.tools.0.functionDeclarations.0.parametersJsonSchema"],
    ["openai", "openai", "tools.0.function.parameters"],
    ["claude", "claude", "tools.0.input_schema"],
    ["codex", "codex", "tools.0.parameters"],
    ["interactions", "interactions", "tools.0.parameters"],
  ];

  it.each(targets)("%s", (_name, to, schemaPath) => {
    const out = builtinTranslators.translateRequest(
      "gemini",
      to,
      { format: "gemini", model: "gemini-2.5-pro", stream: false, body: geminiBody() },
      undefined,
    ).body;

    const schema = get(out, schemaPath);

    expect(schema, `schema at ${schemaPath}`).toBeDefined();

    for (const [path, want] of NUMERIC_CHECKS) {
      expect(get(schema ?? null, path), path).toBe(want);
    }

    expect(get(schema ?? null, "properties.Message.enum.0")).toBe("1");
    expect(get(schema ?? null, "properties.Message.default")).toBe("1");
  });
});
