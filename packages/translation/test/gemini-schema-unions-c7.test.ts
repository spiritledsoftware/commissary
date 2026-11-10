// Multi-branch anyOf/oneOf unions survive Gemini / Antigravity schema cleaning (ticket C7; upstream a0fd8448), except
// on the Antigravity Claude tool cleaner, whose upstream rejects them (5efe9758). Expected values are the Go tests'
// (internal/util/gemini_schema_test.go: TestCleanJSONSchema_PreservesMultiBranchAnyOfOneOf_Issue3662 and the
// Antigravity cases whose expectation a0fd8448 changed).
import { describe, expect, it } from "vitest";
import { asString, get, type Json } from "@commissary/json";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForAntigravityClaudeTool,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
  cleanJsonSchemaForGemini,
  cleanJsonSchemaForGeminiJsonSchema,
} from "../src/translator/gemini/util/json-schema.ts";

type Cleaner = (schema: Json) => Json;

const antigravityTool: Cleaner = (schema) => cleanJsonSchemaForAntigravityTool(schema, false);

const antigravityClaudeTool: Cleaner = (schema) =>
  cleanJsonSchemaForAntigravityClaudeTool(schema, false);

/** The cleaners that preserve multi-branch unions. */
const PRESERVING: ReadonlyArray<readonly [string, Cleaner]> = [
  ["Antigravity", cleanJsonSchemaForAntigravity],
  ["AntigravityTool", antigravityTool],
  ["AntigravityResponse", cleanJsonSchemaForAntigravityResponse],
  ["Gemini", cleanJsonSchemaForGemini],
  ["GeminiJSONSchema", cleanJsonSchemaForGeminiJsonSchema],
];

/** The native Schema carriers (`oneOf` becomes `anyOf`); `GeminiJSONSchema` keeps standard JSON Schema. */
const NATIVE = PRESERVING.filter(([name]) => name !== "GeminiJSONSchema");

const branches = (value: Json, path: string): number => {
  const union = get(value, path);

  return Array.isArray(union) ? union.length : 0;
};

const image: Json = {
  type: "object",
  properties: { image: { type: "string" } },
  required: ["image"],
};

const audio: Json = {
  type: "object",
  properties: { audio: { type: "string" } },
  required: ["audio"],
};

const itemSchema = (union: Json): Json => ({
  type: "object",
  properties: { item: union },
  required: ["item"],
});

describe("existing Antigravity cleaner expectations a0fd8448 changed", () => {
  it("oneOf [string, integer] becomes anyOf", () => {
    expect(
      cleanJsonSchemaForAntigravity({
        type: "object",
        properties: { config: { oneOf: [{ type: "string" }, { type: "integer" }] } },
      }),
    ).toEqual({
      type: "object",
      properties: { config: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    });
  });

  it("anyOf [string, integer, null] drops the null branch and marks the node nullable", () => {
    expect(
      cleanJsonSchemaForAntigravity({
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "integer" }],
          nullable: true,
          description: "(nullable)",
        },
      },
    });
  });

  it("a single branch plus null projects to the branch and merges descriptions", () => {
    expect(
      cleanJsonSchemaForAntigravity({
        type: "object",
        properties: {
          config: {
            description: "Parent desc",
            anyOf: [{ type: "string", description: "Child desc" }, { type: "null" }],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        config: {
          type: "string",
          nullable: true,
          description: "Parent desc (Child desc) (Accepts: string | null)",
        },
      },
    });
  });

  it("a two-branch union with a parent description stays as it is", () => {
    const input: Json = {
      type: "object",
      properties: {
        config: {
          description: "Parent desc",
          anyOf: [{ type: "string", description: "Child desc" }, { type: "integer" }],
        },
      },
    };

    expect(cleanJsonSchemaForAntigravity(input)).toEqual(input);
  });

  it("required-only branches materialize from the parent's properties", () => {
    const got = cleanJsonSchemaForAntigravityResponse({
      type: "object",
      anyOf: [{ required: ["left"] }, { required: ["right"] }],
      properties: { left: { type: "integer" }, right: { type: "integer" } },
      additionalProperties: false,
    });

    expect(get(got, "type")).toBe("object");
    expect(get(got, "properties.left")).toBeDefined();
    expect(get(got, "properties.right")).toBeDefined();
    expect(get(got, "anyOf")).toEqual([
      { type: "object", properties: { left: { type: "integer" } }, required: ["left"] },
      { type: "object", properties: { right: { type: "integer" } }, required: ["right"] },
    ]);
  });
});

describe("Issue 3662: multi-branch anyOf/oneOf unions are preserved", () => {
  const input = itemSchema({ anyOf: [{ type: "string" }, image, audio] });

  it.each(PRESERVING)("%s keeps every branch and is idempotent", (_name, clean) => {
    const got = clean(input);

    expect(got).toEqual(input);
    expect(clean(got)).toEqual(got);
  });

  describe("a nullable multi-branch union", () => {
    const nullable = itemSchema({ anyOf: [{ type: "string" }, image, audio, { type: "null" }] });

    it("Antigravity strips the null branch and sets nullable", () => {
      const got = cleanJsonSchemaForAntigravity(nullable);

      expect(branches(got, "properties.item.anyOf")).toBe(3);
      expect(get(got, "properties.item.nullable")).toBe(true);
      expect(get(got, "properties.item.anyOf.2.properties.audio")).toBeDefined();
    });

    it("GeminiJSONSchema keeps the branches, drops the nullable keyword and hints it", () => {
      const got = cleanJsonSchemaForGeminiJsonSchema(nullable);

      expect(branches(got, "properties.item.anyOf")).toBe(3);
      expect(get(got, "properties.item.nullable")).toBeUndefined();
      expect(asString(get(got, "properties.item.description"))).toContain("(nullable)");
    });

    it.each([
      {
        type: "object",
        properties: {
          item: { anyOf: [{ type: "null" }, { anyOf: [{ type: "string" }, { type: "integer" }] }] },
        },
      },
      {
        type: "object",
        properties: {
          item: { anyOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }, { type: "null" }] },
        },
      },
    ] satisfies Json[])("unwraps a nested nullable union in either order", (nested) => {
      const expected: Json = {
        type: "object",
        properties: {
          item: {
            anyOf: [{ type: "string" }, { type: "integer" }],
            nullable: true,
            description: "(nullable)",
          },
        },
      };

      const once = cleanJsonSchemaForAntigravity(nested);

      expect(once).toEqual(expected);
      expect(cleanJsonSchemaForAntigravity(once)).toEqual(expected);
    });
  });

  describe("oneOf", () => {
    const oneOfInput = itemSchema({ oneOf: [{ type: "string" }, image, audio] });

    it.each(NATIVE)("%s normalizes it to anyOf on the native Schema carrier", (_name, clean) => {
      const got = clean(oneOfInput);

      expect(get(got, "properties.item.oneOf")).toBeUndefined();
      expect(branches(got, "properties.item.anyOf")).toBe(3);
    });

    it("the parametersJsonSchema carrier keeps the standard oneOf", () => {
      expect(
        branches(cleanJsonSchemaForGeminiJsonSchema(oneOfInput), "properties.item.oneOf"),
      ).toBe(3);
    });
  });

  describe("a parent that has properties", () => {
    const parentPropsUnion: Json = {
      type: "object",
      properties: {},
      anyOf: [image, audio],
    };

    it.each(PRESERVING)("%s keeps the union and the branch required lists", (_name, clean) => {
      expect(clean(parentPropsUnion)).toEqual(parentPropsUnion);
    });

    it("materializes a required-only branch from the parent's properties", () => {
      const parentProperties = {
        image: { type: "string" },
        audio: { type: "string" },
        text: { type: "string" },
      };

      expect(
        cleanJsonSchemaForAntigravity({
          type: "object",
          properties: parentProperties,
          anyOf: [image, audio, { required: ["text"] }],
        }),
      ).toEqual({
        type: "object",
        properties: parentProperties,
        anyOf: [
          image,
          audio,
          { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        ],
      });
    });

    it("materializes a pure required-only union", () => {
      const parentProperties = { image: { type: "string" }, audio: { type: "string" } };

      expect(
        cleanJsonSchemaForAntigravity({
          type: "object",
          properties: parentProperties,
          anyOf: [{ required: ["image"] }, { required: ["audio"] }],
        }),
      ).toEqual({
        type: "object",
        properties: parentProperties,
        anyOf: [image, audio],
      });
    });
  });

  describe("boolean branches and sibling unions", () => {
    it("strips a false branch and projects the single survivor", () => {
      expect(
        cleanJsonSchemaForAntigravity({
          type: "object",
          properties: { value: { anyOf: [false, { type: "string" }] } },
        }),
      ).toEqual({ type: "object", properties: { value: { type: "string" } } });
    });

    it("strips a false branch from a multi-branch oneOf and normalizes it to anyOf", () => {
      expect(
        cleanJsonSchemaForAntigravity({
          type: "object",
          properties: { value: { oneOf: [false, { type: "string" }, { type: "integer" }] } },
        }),
      ).toEqual({
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      });
    });

    it("normalizes a true branch to an unconstrained {} branch", () => {
      expect(
        antigravityTool({
          type: "object",
          properties: { value: { anyOf: [true, { type: "string" }, { type: "integer" }] } },
        }),
      ).toEqual({
        type: "object",
        properties: { value: { anyOf: [{}, { type: "string" }, { type: "integer" }] } },
      });
    });

    const siblingUnions: Json = {
      type: "object",
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "integer" }],
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
      },
    };

    it.each(NATIVE)(
      "%s keeps anyOf and records the sibling oneOf as a hint on a native carrier",
      (_name, clean) => {
        const got = clean(siblingUnions);

        expect(get(got, "properties.value.oneOf")).toBeUndefined();
        expect(branches(got, "properties.value.anyOf")).toBe(2);
        expect(asString(get(got, "properties.value.description"))).toContain("oneOf:");
      },
    );

    it("GeminiJSONSchema keeps both unions", () => {
      const got = cleanJsonSchemaForGeminiJsonSchema(siblingUnions);

      expect(branches(got, "properties.value.anyOf")).toBe(2);
      expect(branches(got, "properties.value.oneOf")).toBe(2);
    });

    describe("Antigravity Claude tool cleaner (5efe9758)", () => {
      it("flattens the union to its strongest branch with an Accepts hint", () => {
        const flattened = antigravityClaudeTool(input);
        const item = get(flattened, "properties.item");

        expect(get(item ?? null, "anyOf")).toBeUndefined();
        expect(get(item ?? null, "oneOf")).toBeUndefined();
        expect(get(item ?? null, "type")).toBe("object");
        expect(get(item ?? null, "properties.image")).toBeDefined();

        const description = asString(get(item ?? null, "description"));
        expect(description).toContain("Accepts:");
        expect(description).toContain("string");

        // The translator cleans once, the executor again: flattening is stable across the chain.
        expect(antigravityClaudeTool(flattened)).toEqual(flattened);
        expect(antigravityClaudeTool(cleanJsonSchemaForAntigravity(input))).toEqual(flattened);
        expect(cleanJsonSchemaForAntigravity(flattened)).toEqual(flattened);
      });

      it("keeps nullability through the translator -> executor chain", () => {
        const union: Json = {
          type: "object",
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
          },
        };

        const direct = antigravityClaudeTool(union);
        expect(get(direct, "properties.value.nullable")).toBe(true);
        expect(get(direct, "properties.value.type")).toBe("string");

        const chained = antigravityClaudeTool(cleanJsonSchemaForAntigravity(union));
        expect(get(chained, "properties.value.nullable")).toBe(true);
        expect(get(chained, "properties.value.type")).toBe("string");
        expect(get(chained, "properties.value.anyOf")).toBeUndefined();
        expect(antigravityClaudeTool(chained)).toEqual(chained);
      });

      it.each([
        ["true", { anyOf: [true, { type: "string" }, { type: "integer" }] }],
        ["false", { oneOf: [false, { type: "string" }, { type: "integer" }] }],
      ] satisfies Array<[string, Json]>)(
        "a %s branch leaves no boolean or union behind",
        (_name, value) => {
          expect(antigravityClaudeTool({ type: "object", properties: { value } })).toEqual({
            type: "object",
            properties: { value: { type: "string", description: "Accepts: string | integer" } },
          });
        },
      );

      it("flattens sibling anyOf and oneOf without leaking the raw union into the description", () => {
        const got = antigravityClaudeTool(siblingUnions);

        // Paths are processed oneOf-first, so the oneOf branch set wins the single remaining node.
        expect(get(got, "properties.value")).toEqual({
          type: "string",
          description: "Accepts: string | boolean",
        });
        expect(antigravityClaudeTool(got)).toEqual(got);
      });
    });

    describe("null-only unions", () => {
      const cleaners: ReadonlyArray<readonly [string, Cleaner]> = [
        ...PRESERVING,
        ["AntigravityClaudeTool", antigravityClaudeTool],
      ];

      it.each([
        { anyOf: [{ type: "null" }] },
        { oneOf: [{ type: "null" }, { type: "null" }] },
        { anyOf: [false, { type: "null" }], description: "Null only" },
      ] satisfies Json[])("collapse to type null in every cleaner (%j)", (value) => {
        for (const [name, clean] of cleaners) {
          const got = clean({ type: "object", properties: { value } });

          expect(get(got, "properties.value.type"), name).toBe("null");
        }
      });
    });
  });
});
