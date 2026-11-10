// $ref siblings stay conjunctive when local references are inlined (ticket C7; upstream 29150a22). A target and its
// sibling keywords that collide are kept as two complete schemas (an allOf) instead of the sibling silently replacing the
// target's constraint, and the parametersJsonSchema route does not rewrite shapes once a conjunction is present.
// Expected values are the Go tests' (internal/util/gemini_schema_ref_test.go, test/gemini_ref_sibling_test.go).
import { describe, expect, it } from "vitest";
import { get, isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { inlineLocalRefs } from "../src/translator/common/schema-refs.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { cleanJsonSchemaForGeminiJsonSchema } from "../src/translator/gemini/util/json-schema.ts";

const CLEANERS: ReadonlyArray<readonly [string, (schema: Json) => Json]> = [
  ["inline", inlineLocalRefs],
  ["gemini", cleanJsonSchemaForGeminiJsonSchema],
];

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const refSibling = (target: Json, sibling: JsonObject): JsonObject => ({
  $ref: "#/$defs/A",
  ...sibling,
});

/** `$ref` with `siblings`, once nested under a property and once at the document root. */
const placements = (
  target: Json,
  siblings: JsonObject,
  extra: JsonObject = {},
): ReadonlyArray<readonly [string, Json, string]> => [
  [
    "nested",
    {
      ...extra,
      $defs: { A: target },
      type: "object",
      properties: { x: refSibling(target, siblings) },
    },
    "properties.x",
  ],
  ["root", { ...extra, $defs: { A: target }, ...refSibling(target, siblings) }, ""],
];

const at = (value: Json, path: string): Json | undefined =>
  path === "" ? value : get(value, path);

const CONJUNCTIONS: ReadonlyArray<{
  name: string;
  target: JsonObject;
  sibling: JsonObject;
  checks: Record<string, Json>;
}> = [
  {
    name: "target_minimum",
    target: { type: "string", minLength: 5 },
    sibling: { minLength: 1 },
    checks: { "allOf.0.minLength": 5, minLength: 1 },
  },
  {
    name: "sibling_minimum",
    target: { type: "string", minLength: 1 },
    sibling: { minLength: 5 },
    checks: { "allOf.0.minLength": 1, minLength: 5 },
  },
  {
    name: "maximum",
    target: { type: "string", maxLength: 5 },
    sibling: { maxLength: 10 },
    checks: { "allOf.0.maxLength": 5, maxLength: 10 },
  },
  {
    name: "patterns",
    target: { type: "string", pattern: "^a" },
    sibling: { pattern: "z$" },
    checks: { "allOf.0.pattern": "^a", pattern: "z$" },
  },
  {
    name: "disjoint_types",
    target: { type: "string" },
    sibling: { type: "number" },
    checks: { "allOf.0.type": "string", type: "number" },
  },
  {
    name: "overlapping_types",
    target: { type: ["string", "number"] },
    sibling: { type: "number" },
    checks: { "allOf.0.type": ["string", "number"], type: "number" },
  },
  {
    name: "overlapping_nullable_types",
    target: { type: ["string", "null"] },
    sibling: { type: "null" },
    checks: { "allOf.0.type": ["string", "null"], type: "null" },
  },
  {
    name: "overlapping_array_types",
    target: { type: ["array", "null"], items: { type: "integer" } },
    sibling: { type: "array" },
    checks: {
      "allOf.0.type": ["array", "null"],
      "allOf.0.items.type": "integer",
      type: "array",
    },
  },
  {
    name: "overlapping_object_types",
    target: { type: ["object", "string"], properties: { a: { type: "integer" } } },
    sibling: { type: "string" },
    checks: {
      "allOf.0.type": ["object", "string"],
      "allOf.0.properties.a.type": "integer",
      type: "string",
    },
  },
  {
    name: "enums",
    target: { type: "string", enum: ["a", "b"] },
    sibling: { enum: ["b", "c"] },
    checks: { "allOf.0.enum": ["a", "b"], enum: ["b", "c"] },
  },
  {
    name: "required_without_local_properties",
    target: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    },
    sibling: { required: ["b"] },
    checks: { "allOf.0.required": ["a"], required: ["b"], "allOf.0.properties.b.type": "string" },
  },
  {
    name: "closed_object_scopes",
    target: {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    },
    sibling: { properties: { b: { type: "string" } }, additionalProperties: false },
    checks: {
      "allOf.0.properties": { a: { type: "string" } },
      properties: { b: { type: "string" } },
      "allOf.0.additionalProperties": false,
      additionalProperties: false,
    },
  },
  {
    name: "equal_closed_object_constraints",
    target: {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    },
    sibling: { additionalProperties: false },
    checks: {
      "allOf.0.properties.a.type": "string",
      "allOf.0.additionalProperties": false,
      additionalProperties: false,
    },
  },
  {
    name: "sibling_closed_object_scope",
    target: { type: "object", properties: { a: { type: "string" } } },
    sibling: { additionalProperties: false },
    checks: { "allOf.0.properties.a.type": "string", additionalProperties: false },
  },
  {
    name: "target_closed_object_scope",
    target: { type: "object", additionalProperties: false },
    sibling: { properties: { a: { type: "string" } } },
    checks: { "allOf.0.additionalProperties": false, "properties.a.type": "string" },
  },
  {
    name: "equal_contains_constraints",
    target: { type: "array", items: {}, contains: { type: "integer" }, minContains: 0 },
    sibling: { contains: { type: "integer" } },
    checks: {
      "allOf.0.minContains": 0,
      "allOf.0.contains.type": "integer",
      "contains.type": "integer",
    },
  },
  {
    name: "contains_count_scope",
    target: { type: "array", items: {}, contains: { type: "integer" } },
    sibling: { minContains: 0 },
    checks: { "allOf.0.contains.type": "integer", minContains: 0 },
  },
  {
    name: "equal_items_with_different_prefix_scope",
    target: { type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } },
    sibling: { items: { type: "integer" } },
    checks: {
      "allOf.0.prefixItems.0.type": "string",
      "allOf.0.items.type": "integer",
      "items.type": "integer",
    },
  },
  {
    name: "existing_allof",
    target: { type: "string", allOf: [{ minLength: 5 }] },
    sibling: { allOf: [{ maxLength: 8 }] },
    checks: { "allOf.0.allOf.0.minLength": 5, "allOf.1.maxLength": 8 },
  },
];

describe("29150a22: $ref sibling conjunctions", () => {
  for (const tc of CONJUNCTIONS) {
    for (const [placement, input, path] of placements(tc.target, tc.sibling, {
      $schema: DIALECT,
    })) {
      for (const [cleaner, clean] of CLEANERS) {
        it(`${tc.name}/${placement}/${cleaner}`, () => {
          const got = clean(input);
          const node = at(got, path);

          for (const [key, want] of Object.entries(tc.checks)) {
            expect(at(node ?? null, key), `lost constraint ${key}`).toEqual(want);
          }

          expect(clean(got)).toEqual(got);
        });
      }
    }
  }

  it.each(CLEANERS)(
    "%s: annotations and identical types override instead of conjoining",
    (_n, clean) => {
      const got = clean({
        $defs: {
          A: {
            type: "string",
            minLength: 5,
            description: "base",
            default: "base",
            examples: ["base"],
          },
        },
        properties: {
          x: {
            $ref: "#/$defs/A",
            type: "string",
            description: "local",
            default: "local",
            examples: [{ $ref: "literal" }],
          },
        },
      });

      expect(get(got, "properties.x")).toEqual({
        type: "string",
        minLength: 5,
        description: "local",
        default: "local",
        examples: [{ $ref: "literal" }],
      });
    },
  );

  it("a {schema: …} carrier keeps the conjunction inside", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      schema: {
        $defs: { A: { type: "string", minLength: 5 } },
        $ref: "#/$defs/A",
        minLength: 1,
      },
    });

    expect(got).toEqual({
      schema: { minLength: 1, allOf: [{ type: "string", minLength: 5 }] },
    });
  });

  it("a root reference keeps the document's declarations outside the allOf", () => {
    const got = inlineLocalRefs({
      $schema: DIALECT,
      $defs: { A: { type: "string", minLength: 5 } },
      $ref: "#/$defs/A",
      minLength: 1,
    });

    expect(got).toEqual({
      $schema: DIALECT,
      $defs: { A: { type: "string", minLength: 5 } },
      minLength: 1,
      allOf: [{ type: "string", minLength: 5 }],
    });
  });

  it("keeps a required property declared in an allOf", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      allOf: [{ properties: { x: { type: "string" } } }],
      required: ["x"],
    });

    expect(get(got, "required.0")).toBe("x");
  });

  describe("array conjunctions do not invent items", () => {
    const A: JsonObject = { type: "array", items: { type: "integer" }, minItems: 2 };

    it.each([
      [
        "nested",
        {
          $defs: { A },
          type: "object",
          properties: { x: { $ref: "#/$defs/A", type: "array", minItems: 1 } },
        },
        "properties.x",
      ],
      ["root", { $defs: { A }, $ref: "#/$defs/A", type: "array", minItems: 1 }, ""],
    ] as const)("%s", (_name, input, path) => {
      const got = cleanJsonSchemaForGeminiJsonSchema(input);

      // [1, 2] is valid: the sibling only constrains array length, not element type.
      expect(at(got, path)).toEqual({
        type: "array",
        minItems: 1,
        allOf: [{ type: "array", items: { type: "integer" }, minItems: 2 }],
      });
      expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
    });
  });

  describe("an array target does not invent items before inlining", () => {
    const A: JsonObject = { type: "array", minItems: 2 };

    it.each([
      [
        "nested",
        {
          $defs: { A },
          type: "object",
          properties: { x: { $ref: "#/$defs/A", minItems: 1, items: { type: "integer" } } },
        },
        "properties.x",
      ],
      ["root", { $defs: { A }, $ref: "#/$defs/A", minItems: 1, items: { type: "integer" } }, ""],
    ] as const)("%s", (_name, input, path) => {
      const got = cleanJsonSchemaForGeminiJsonSchema(input);

      // Only the sibling constrains the elements; [1, 2] must remain valid.
      expect(at(got, path)).toEqual({
        minItems: 1,
        items: { type: "integer" },
        allOf: [{ type: "array", minItems: 2 }],
      });
      expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
    });
  });

  it("an array conjunction gains no unrelated element constraint", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "array",
      allOf: [{ items: { type: "integer" } }],
    });

    expect(get(got, "items")).toBeUndefined();
    expect(get(got, "allOf.0.items.type")).toBe("integer");
  });

  it("a union cannot replace a conjunction", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      allOf: [{ properties: { x: { type: "string" } }, required: ["x"] }],
      anyOf: [{ type: "object" }],
    });

    // {} must remain invalid, even though it satisfies the anyOf branch.
    expect(get(got, "allOf.0.properties.x.type")).toBe("string");
    expect(get(got, "allOf.0.required.0")).toBe("x");
    expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
  });

  it("a conjunction preserves a required-only union", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      allOf: [
        { properties: { a: { type: "string" }, b: { type: "string" } } },
        { anyOf: [{ required: ["a"] }, { required: ["b"] }] },
      ],
    });

    expect(get(got, "allOf.1.anyOf.0.required.0")).toBe("a");
    expect(get(got, "allOf.1.anyOf.1.required.0")).toBe("b");
    expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
  });

  it("a $ref sibling's required-only union keeps its constraints", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      $defs: {
        A: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          minProperties: 1,
        },
      },
      type: "object",
      properties: {
        x: {
          $ref: "#/$defs/A",
          minProperties: 0,
          anyOf: [{ required: ["a"] }, { required: ["b"] }],
        },
      },
    });

    // {"x":{"z":1}} must remain invalid: at least a or b is required.
    expect(get(got, "properties.x.anyOf.0.required.0")).toBe("a");
    expect(get(got, "properties.x.anyOf.1.required.0")).toBe("b");
    expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
  });

  it.each([
    ["items", { items: { type: "integer" } }],
    ["properties", { properties: { ignored: { type: "integer" } } }],
  ] as const)("a conjunction does not infer a container type from %s", (_name, sibling) => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      $defs: { A: { type: "number", minimum: 5 } },
      type: "object",
      properties: { x: { $ref: "#/$defs/A", minimum: 1, ...sibling } },
    });

    const node = get(got, "properties.x");

    // 5 is valid; items/properties do not constrain non-container instances.
    expect(get(node ?? null, "type")).toBeUndefined();
    expect(get(node ?? null, "allOf.0.type")).toBe("number");
    expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
  });

  describe("an outer union preserves a conjunction", () => {
    it.each([
      {
        name: "existing_conjunction",
        input: {
          type: "object",
          properties: { x: { type: "string" } },
          anyOf: [{ allOf: [{ properties: { x: { minLength: 5 } } }] }],
        },
        path: "anyOf.0.allOf.0.properties.x.minLength",
        want: 5,
      },
      {
        name: "reference_conjunction",
        input: {
          $defs: { A: { type: "object", properties: { x: { minLength: 5 } }, minProperties: 1 } },
          type: "object",
          properties: { x: { type: "string" } },
          anyOf: [{ $ref: "#/$defs/A", minProperties: 0 }],
        },
        path: "anyOf.0.allOf.0.properties.x.minLength",
        want: 5,
      },
      {
        name: "ancestor_required",
        input: {
          required: ["x"],
          anyOf: [{ allOf: [{ properties: { x: { type: "string" } } }] }],
        },
        path: "required.0",
        want: "x",
      },
    ])("$name", ({ input, path, want }) => {
      const got = cleanJsonSchemaForGeminiJsonSchema(input);

      expect(get(got, path)).toBe(want);
      expect(cleanJsonSchemaForGeminiJsonSchema(got)).toEqual(got);
    });
  });

  describe("unevaluated keywords stay adjacent to the applicator", () => {
    const cases: ReadonlyArray<{
      name: string;
      target: JsonObject;
      sibling: JsonObject;
      want: JsonObject;
    }> = [
      {
        name: "target_properties_scope",
        target: { type: "object", unevaluatedProperties: false },
        sibling: { properties: { x: { type: "string" } } },
        want: {
          properties: { x: { type: "string" } },
          allOf: [{ type: "object", unevaluatedProperties: false }],
        },
      },
      {
        name: "target_items_scope",
        target: { type: "array", unevaluatedItems: false },
        sibling: { prefixItems: [{ type: "integer" }] },
        want: {
          prefixItems: [{ type: "integer" }],
          allOf: [{ type: "array", unevaluatedItems: false }],
        },
      },
      {
        name: "properties",
        target: {
          type: "object",
          properties: { x: { type: "string" } },
          minProperties: 1,
        },
        sibling: { minProperties: 0, unevaluatedProperties: false },
        want: {
          minProperties: 0,
          unevaluatedProperties: false,
          allOf: [{ type: "object", properties: { x: { type: "string" } }, minProperties: 1 }],
        },
      },
      {
        name: "items",
        target: { type: "array", prefixItems: [{ type: "integer" }], minItems: 1 },
        sibling: { minItems: 0, unevaluatedItems: false },
        want: {
          minItems: 0,
          unevaluatedItems: false,
          allOf: [{ type: "array", prefixItems: [{ type: "integer" }], minItems: 1 }],
        },
      },
    ];

    for (const tc of cases) {
      for (const [placement, input, path] of placements(tc.target, tc.sibling)) {
        it(`${tc.name}/${placement}`, () => {
          const got = inlineLocalRefs(input);
          const node = at(got, path);

          // Root declarations are not part of the validation assertions under test.
          if (path === "" && isJsonObject(node)) {
            const { $defs: _defs, ...rest } = node;
            expect(rest).toEqual(tc.want);
          } else {
            expect(node).toEqual(tc.want);
          }
        });
      }
    }
  });

  it("keeps both effective minLength constraints", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      $schema: DIALECT,
      $defs: { A: { type: "string", minLength: 5 } },
      type: "object",
      properties: { x: { $ref: "#/$defs/A", minLength: 1 } },
    });

    const minLength = (schema: Json | undefined): number => {
      const own = get(schema ?? null, "minLength");
      const branches = get(schema ?? null, "allOf");

      return Math.max(
        typeof own === "number" ? own : 0,
        ...(Array.isArray(branches) ? branches.map(minLength) : [0]),
      );
    };

    // "a" must remain invalid and "abcde" valid.
    expect(minLength(get(got, "properties.x"))).toBe(5);
  });
});

describe("translated Gemini tool parameters keep the reference conjunction", () => {
  const schema = {
    $schema: DIALECT,
    $defs: { A: { type: "string", minLength: 5 } },
    type: "object",
    properties: { x: { $ref: "#/$defs/A", minLength: 1 } },
  };

  const requests: ReadonlyArray<readonly [string, string, JsonObject]> = [
    [
      "chat_completions",
      "openai",
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function", function: { name: "check", parameters: schema } }],
      },
    ],
    [
      "responses",
      "openai-response",
      { input: "test", tools: [{ type: "function", name: "check", parameters: schema }] },
    ],
    [
      "claude",
      "claude",
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "check", input_schema: schema }],
      },
    ],
  ];

  it.each(requests)("%s", (_name, format, body) => {
    const out = builtinTranslators.translateRequest(
      format,
      "gemini",
      { format, model: "gemini-3-flash", stream: false, body },
      undefined,
    ).body;

    const parameters = get(out, "tools.0.functionDeclarations.0.parametersJsonSchema");

    expect(get(parameters ?? null, "properties.x.allOf.0.minLength")).toBe(5);
    expect(get(parameters ?? null, "properties.x.minLength")).toBe(1);
    expect(get(parameters ?? null, "$defs")).toBeUndefined();
    expect(get(parameters ?? null, "properties.x.$ref")).toBeUndefined();
  });
});
