// SPI-1415 (Go cad3ae5d, c9e6e2e3, be39c4d5, 531aea15): the native Gemini schema cleaners leave author-defined
// properties named `const`, `enum` and `additionalProperties` alone, turn tuple and non-object `items` into one Schema,
// treat an uppercase `OBJECT` as an object, and decode numeric protobuf `Schema.Type` enums. Cases follow those
// commits' Go tests.
import { asString, get, isJsonObject, type Json } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import { normalizeJsonSchemaNumericConstraints } from "../src/translator/common/schema.ts";
import { convertGeminiRequestToGemini } from "../src/translator/gemini/gemini/gemini.ts";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForAntigravityClaudeTool,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
  cleanJsonSchemaForGemini,
  cleanJsonSchemaForGeminiJsonSchema,
} from "../src/translator/gemini/util/json-schema.ts";

interface Cleaner {
  readonly clean: (schema: Json) => Json;
  readonly flattenMultiBranch?: boolean;
  readonly addMissing: boolean;
  readonly allowNullable: boolean;
}

const NATIVE_CLEANERS = {
  Antigravity: { clean: cleanJsonSchemaForAntigravity, addMissing: true, allowNullable: true },
  AntigravityTool: {
    clean: (s) => cleanJsonSchemaForAntigravityTool(s, false),
    addMissing: true,
    allowNullable: true,
  },
  AntigravityClaudeTool: {
    clean: (s) => cleanJsonSchemaForAntigravityClaudeTool(s, true),
    flattenMultiBranch: true,
    addMissing: true,
    allowNullable: true,
  },
  AntigravityClaudeToolNoPlaceholder: {
    clean: (s) => cleanJsonSchemaForAntigravityClaudeTool(s, false),
    flattenMultiBranch: true,
    addMissing: true,
    allowNullable: true,
  },
  AntigravityResponse: {
    clean: cleanJsonSchemaForAntigravityResponse,
    addMissing: false,
    allowNullable: true,
  },
  Gemini: { clean: cleanJsonSchemaForGemini, addMissing: true, allowNullable: false },
} satisfies Record<string, Cleaner>;

const ALL_CLEANERS = {
  ...Object.fromEntries(Object.entries(NATIVE_CLEANERS).map(([name, c]) => [name, c.clean])),
  GeminiJsonSchema: cleanJsonSchemaForGeminiJsonSchema,
} satisfies Record<string, (schema: Json) => Json>;

describe("properties named like keywords stay parameters (Go cad3ae5d)", () => {
  for (const [name, clean] of Object.entries(ALL_CLEANERS)) {
    it(`${name}: keeps properties named const, enum and additionalProperties`, () => {
      const constOut = clean({ type: "object", properties: { const: { type: "string" } } });

      expect(get(constOut, "properties.const.type")).toBe("string");

      for (const forbidden of ["properties.description", "properties.enum", "properties.type"]) {
        expect(get(constOut, forbidden), forbidden).toBeUndefined();
      }

      const enumOut = clean({
        type: "object",
        properties: { enum: { type: "string", description: "Enum name" } },
        required: ["enum"],
      });

      expect(get(enumOut, "properties.enum.type")).toBe("string");
      expect(get(enumOut, "properties.enum.description")).toBe("Enum name");
      expect(get(enumOut, "required")).toEqual(["enum"]);
      expect(get(enumOut, "properties.description")).toBeUndefined();

      const additionalOut = clean({
        type: "object",
        properties: { additionalProperties: false },
      });

      expect(get(additionalOut, "properties.additionalProperties")).toBe(false);
      expect(get(additionalOut, "properties.description")).toBeUndefined();
    });
  }

  it("still applies a property's own const, enum and additionalProperties", () => {
    const constOut = cleanJsonSchemaForAntigravityTool(
      {
        type: "object",
        properties: { const: { type: "string", const: "v1" } },
        required: ["const"],
      },
      true,
    );

    expect(get(constOut, "properties.const.description")).toBe("Allowed: v1");
    expect(get(constOut, "properties.const.const")).toBeUndefined();

    const enumOut = cleanJsonSchemaForAntigravityTool(
      {
        type: "object",
        properties: { enum: { type: "string", enum: ["a", "b"] } },
        required: ["enum"],
      },
      true,
    );

    expect(get(enumOut, "properties.enum.description")).toBe("Allowed: a, b");
    expect(get(enumOut, "properties.enum.enum")).toBeUndefined();
    expect(get(enumOut, "properties.description")).toBeUndefined();

    const additionalOut = cleanJsonSchemaForAntigravityTool(
      {
        type: "object",
        properties: {
          additionalProperties: {
            type: "object",
            properties: { x: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      false,
    );

    expect(get(additionalOut, "properties.additionalProperties.description")).toBe(
      "No extra properties allowed",
    );
    expect(
      get(additionalOut, "properties.additionalProperties.additionalProperties"),
    ).toBeUndefined();
  });

  it("converts a root-level const to a root enum", () => {
    const out = cleanJsonSchemaForGemini({ type: "string", const: "fixed" });

    expect(get(out, "enum")).toEqual(["fixed"]);
    expect(get(out, "")).toBeUndefined();
  });
});

describe("tuple and non-object items become one Schema (Go c9e6e2e3)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Json;
    readonly itemsPath: string;
    readonly verify: (spec: Cleaner, root: Json, items: Json) => void;
  }> = [
    {
      name: "root mixed tuple",
      input: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      itemsPath: "items",
      verify: (spec, _root, items) => {
        if (spec.flattenMultiBranch === true) {
          expect(get(items, "anyOf")).toBeUndefined();
          expect(get(items, "type")).toBe("string");
          expect(get(items, "description")).toContain("string | number");
        } else {
          expect(get(items, "anyOf")).toHaveLength(2);
        }
      },
    },
    {
      name: "single-element tuple",
      input: { type: "array", items: [{ type: "integer" }] },
      itemsPath: "items",
      verify: (_spec, _root, items) => {
        expect(get(items, "anyOf")).toBeUndefined();
        expect(get(items, "type")).toBe("integer");
      },
    },
    {
      name: "homogeneous tuple",
      input: { type: "array", items: [{ type: "number" }, { type: "number" }] },
      itemsPath: "items",
      verify: (_spec, _root, items) => {
        expect(get(items, "anyOf")).toBeUndefined();
        expect(get(items, "type")).toBe("number");
      },
    },
    {
      name: "empty tuple",
      input: { type: "array", items: [] },
      itemsPath: "items",
      verify: (spec, _root, items) => {
        if (spec.addMissing) expect(get(items, "type")).toBe("string");
        else expect(items).toEqual({});
      },
    },
    {
      name: "nullable tuple",
      input: { type: "array", items: [{ type: "string" }, { type: "null" }] },
      itemsPath: "items",
      verify: (spec, _root, items) => {
        expect(get(items, "anyOf")).toBeUndefined();
        expect(get(items, "type")).toBe("string");

        if (spec.allowNullable) expect(get(items, "nullable")).toBe(true);
        else expect(get(items, "nullable")).toBeUndefined();
      },
    },
    {
      name: "null-only tuple",
      input: { type: "array", items: [{ type: "null" }] },
      itemsPath: "items",
      verify: (spec, _root, items) => {
        expect(get(items, "type")).not.toBe("null");

        if (!spec.allowNullable) expect(get(items, "nullable")).toBeUndefined();
      },
    },
    {
      name: "nested tuples",
      input: {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: [
              { type: "array", items: [{ type: "string" }, { type: "integer" }] },
              { type: "boolean" },
            ],
          },
        },
      },
      itemsPath: "properties.matrix.items",
      verify: (spec, _root, items) => {
        if (spec.flattenMultiBranch === true) {
          expect(get(items, "anyOf")).toBeUndefined();
          expect(get(items, "items.anyOf")).toBeUndefined();
          expect(get(items, "items")).toBeTypeOf("object");
        } else {
          expect(get(items, "anyOf.0.items.anyOf")).toHaveLength(2);
        }
      },
    },
    {
      name: "tuples behind $ref and allOf",
      input: {
        $defs: { Pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
        type: "object",
        properties: {
          pair: { $ref: "#/$defs/Pair" },
          merged: { allOf: [{ items: [{ type: "string" }, { type: "boolean" }] }] },
        },
      },
      itemsPath: "properties.pair.items",
      verify: (_spec, root) => {
        expect(get(root, "properties.merged.items")).toBeTypeOf("object");
        expect(Array.isArray(get(root, "properties.merged.items"))).toBe(false);
        expect(get(root, "properties.merged.type")).toBe("array");
      },
    },
    {
      name: "a property named items",
      input: {
        type: "object",
        properties: { items: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
      },
      itemsPath: "properties.items.items",
      verify: (_spec, root) => {
        expect(get(root, "type")).toBe("object");
        expect(get(root, "properties.items.type")).toBe("array");
      },
    },
  ];

  for (const [cleanerName, spec] of Object.entries(NATIVE_CLEANERS)) {
    for (const testCase of cases) {
      it(`${cleanerName}: ${testCase.name}`, () => {
        const out = spec.clean(testCase.input);
        const items = get(out, testCase.itemsPath);

        expect(items).toBeTypeOf("object");
        expect(Array.isArray(items)).toBe(false);
        // SAFETY: the two assertions above established a non-array object.
        testCase.verify(spec, out, items as Json);
        expect(spec.clean(out)).toEqual(out);
      });
    }
  }

  it("cleans the same through the Antigravity then Claude tool chain", () => {
    const input: Json = { type: "array", items: [{ type: "string" }, { type: "number" }] };

    expect(
      cleanJsonSchemaForAntigravityClaudeTool(cleanJsonSchemaForAntigravity(input), true),
    ).toEqual(cleanJsonSchemaForAntigravityClaudeTool(input, true));
  });

  const nonObjectInputs = {
    items_false: { type: "array", items: false },
    prefix_items_with_items_false: {
      type: "array",
      prefixItems: [{ type: "integer" }],
      items: false,
    },
    empty_prefix_items_false: { type: "array", prefixItems: [], items: false },
    items_null: { type: "array", items: null },
    items_number: { type: "array", items: 42 },
    items_string: { type: "array", items: "string" },
    nested_items_false: {
      type: "object",
      properties: { emptyList: { type: "array", description: "Must be empty", items: false } },
    },
  } satisfies Record<string, Json>;

  for (const [cleanerName, spec] of Object.entries(NATIVE_CLEANERS)) {
    for (const [caseName, input] of Object.entries(nonObjectInputs)) {
      it(`${cleanerName}: non-object items ${caseName}`, () => {
        const out = spec.clean(input);
        const nested = caseName === "nested_items_false";
        const items = get(out, nested ? "properties.emptyList.items" : "items");

        const description = asString(
          get(out, nested ? "properties.emptyList.description" : "description"),
        );

        if (spec.addMissing) expect(get(items, "type")).toBe("string");
        else expect(items).toEqual({});

        if (["items_false", "empty_prefix_items_false", "nested_items_false"].includes(caseName)) {
          expect(description).toContain("No items allowed");
        } else if (caseName === "prefix_items_with_items_false") {
          expect(description).toContain("No additional items allowed");
          expect(description).not.toContain("No items allowed");
        }

        expect(spec.clean(out)).toEqual(out);
      });
    }
  }

  it("keeps prefixItems and items: false on the standard JSON Schema carrier", () => {
    const out = cleanJsonSchemaForGeminiJsonSchema({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });

    expect(get(out, "items")).toBe(false);
    expect(get(out, "prefixItems")).toHaveLength(2);
  });
});

describe("an uppercase OBJECT gets the empty-schema placeholder (Go be39c4d5)", () => {
  it("adds the reason placeholder to an empty OBJECT tool schema", () => {
    const out = cleanJsonSchemaForAntigravity({ type: "OBJECT" });

    expect(get(out, "properties.reason.type")).toBe("string");
    expect(get(out, "required")).toEqual(["reason"]);
  });
});

describe("numeric protobuf Schema.Type enums (Go 531aea15)", () => {
  it("decodes 1..7 on schema nodes and leaves literals and other values alone", () => {
    const out = normalizeJsonSchemaNumericConstraints({
      type: 6,
      properties: {
        strField: {
          type: 1,
          default: { type: 1 },
          example: { type: 2 },
          examples: [{ type: 3 }],
          const: { type: 4 },
          enum: [{ type: 5 }],
        },
        numField: { type: 2 },
        intField: { type: 3 },
        boolField: { type: 4 },
        arrField: { type: 5, items: { type: 1 } },
        objField: { type: 6, additionalProperties: { type: 2 } },
        nullField: { type: 7 },
        type: { type: 1 },
        unionField: { anyOf: [{ type: 1 }, { type: 7 }] },
        unspecifiedType: { type: 0 },
        outOfRangeType: { type: 8 },
        negativeType: { type: -1 },
        floatType: { type: 1.5 },
        stringDigitType: { type: "1" },
        "a.b": { type: 3, minLength: "2" },
      },
      $defs: { Tag: { type: 1 } },
      "x-metadata": { type: 6 },
    });

    const props = get(out, "properties");

    const prop = (name: string, path: string): Json | undefined =>
      isJsonObject(props) ? get(props[name], path) : undefined;

    expect(get(out, "type")).toBe("object");
    expect(prop("strField", "type")).toBe("string");
    expect(prop("numField", "type")).toBe("number");
    expect(prop("intField", "type")).toBe("integer");
    expect(prop("boolField", "type")).toBe("boolean");
    expect(prop("arrField", "type")).toBe("array");
    expect(prop("arrField", "items.type")).toBe("string");
    expect(prop("objField", "additionalProperties.type")).toBe("number");
    expect(prop("nullField", "type")).toBe("null");
    expect(prop("type", "type")).toBe("string");
    expect(prop("unionField", "anyOf.1.type")).toBe("null");
    expect(prop("a.b", "type")).toBe("integer");
    expect(prop("a.b", "minLength")).toBe(2);
    expect(get(out, "$defs.Tag.type")).toBe("string");

    expect(prop("strField", "default.type")).toBe(1);
    expect(prop("strField", "examples.0.type")).toBe(3);
    expect(prop("strField", "const.type")).toBe(4);
    expect(prop("strField", "enum.0.type")).toBe(5);
    expect(prop("unspecifiedType", "type")).toBe(0);
    expect(prop("outOfRangeType", "type")).toBe(8);
    expect(prop("negativeType", "type")).toBe(-1);
    expect(prop("floatType", "type")).toBe(1.5);
    expect(prop("stringDigitType", "type")).toBe("1");
    expect(get(out, "x-metadata.type")).toBe(6);
  });

  it("keeps array items and adds the empty-object placeholder in the Antigravity cleaner", () => {
    const out = cleanJsonSchemaForAntigravity({
      type: 6,
      properties: {
        query: { type: 1 },
        tags: { type: 5, items: { type: 1 } },
        emptyObj: { type: 6 },
      },
      required: ["query"],
    });

    expect(get(out, "type")).toBe("object");
    expect(get(out, "properties.tags.type")).toBe("array");
    expect(get(out, "properties.tags.items.type")).toBe("string");
    expect(get(out, "properties.emptyObj.properties.reason.type")).toBe("string");
    expect(get(out, "properties.emptyObj.required")).toEqual(["reason"]);
  });

  it("adds no tool placeholder in the Antigravity response cleaner", () => {
    const out = cleanJsonSchemaForAntigravityResponse({
      type: 6,
      properties: { tags: { type: 5, items: { type: 1 } }, emptyObj: { type: 6 } },
    });

    expect(get(out, "properties.tags.items.type")).toBe("string");
    expect(get(out, "properties.emptyObj.type")).toBe("object");
    expect(get(out, "properties.emptyObj.properties.reason")).toBeUndefined();
  });

  it("does not wrap an unknown map into properties under a non-object numeric type", () => {
    const out = cleanJsonSchemaForGemini({ type: 1, customNested: { k: "v" } });

    expect(get(out, "type")).toBe("string");
    expect(get(out, "properties")).toBeUndefined();
  });

  it("normalizes snake_case schema carriers in the Gemini request translator", () => {
    const out = convertGeminiRequestToGemini(
      "gemini-2.5-pro",
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            function_declarations: [
              { name: "f", parameters_json_schema: { type: 6, properties: { q: { type: 1 } } } },
            ],
          },
        ],
        generation_config: { response_schema: { type: 6, properties: { a: { type: 3 } } } },
      },
      false,
    );

    expect(get(out, "tools.0.function_declarations.0.parameters_json_schema.type")).toBe("object");
    expect(
      get(out, "tools.0.function_declarations.0.parameters_json_schema.properties.q.type"),
    ).toBe("string");
    expect(get(out, "generation_config.response_schema")).toBeUndefined();
    expect(get(out, "generation_config.response_json_schema.properties.a.type")).toBe("integer");
  });

  it("moves a snake_case response_schema of generationConfig to responseJsonSchema", () => {
    const out = convertGeminiRequestToGemini(
      "gemini-2.5-pro",
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { response_schema: { type: 6 } },
      },
      false,
    );

    expect(get(out, "generationConfig.response_schema")).toBeUndefined();
    expect(get(out, "generationConfig.responseJsonSchema.type")).toBe("object");
  });
});
