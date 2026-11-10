// Local $ref inlining in the Gemini / Antigravity schema cleaners (ticket C7; upstream c558d320 inlining for every
// cleaner, bounded expansion and literal values, b2fda98e array placeholders after reference and allOf resolution).
// Expected values are the Go tests' (internal/util/gemini_schema_test.go).
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject } from "@commissary/json";
import { inlineLocalRefs, inlineLocalRefsForClean } from "../src/translator/common/schema-refs.ts";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForAntigravityTool,
  cleanJsonSchemaForGemini,
  cleanJsonSchemaForGeminiJsonSchema,
} from "../src/translator/gemini/util/json-schema.ts";

const GEMINI_CLEANERS: ReadonlyArray<readonly [string, (schema: Json) => Json]> = [
  ["gemini", cleanJsonSchemaForGemini],
  ["geminiJSONSchema", cleanJsonSchemaForGeminiJsonSchema],
];

const size = (value: Json): number => JSON.stringify(value).length;

const exists = (value: Json, path: string): boolean => get(value, path) !== undefined;

const ref = (name: string): JsonObject => ({ $ref: `#/$defs/${name}` });

const person: JsonObject = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

/** Each `Di` is an object with two properties referencing `Di-1` (`D0` a leaf): expanded in full that is 2^13 leaves. */
const diamond = (): Json => {
  const defs: JsonObject = {
    leaf0: { type: "string", description: "leaf leaf leaf leaf leaf leaf leaf leaf leaf leaf" },
  };

  for (let i = 0; i < 13; i++) {
    const target = i === 0 ? "leaf0" : `D${i - 1}`;
    defs[`D${i}`] = { type: "object", properties: { a: ref(target), b: ref(target) } };
  }

  return { type: "object", properties: { leaf: ref("D12") }, $defs: defs };
};

describe("c558d320: local references are inlined by every cleaner", () => {
  it.each(GEMINI_CLEANERS)("%s expands a $defs reference and removes $defs", (_name, clean) => {
    const got = clean({
      type: "object",
      properties: { person: ref("Person") },
      required: ["person"],
      $defs: { Person: person },
    });

    expect(get(got, "properties.person.properties.name.type")).toBe("string");
    expect(exists(got, "$defs")).toBe(false);
    expect(JSON.stringify(got)).not.toContain("See: Person");
  });

  it.each(GEMINI_CLEANERS)("%s expands a Zod-style #/properties/… reference", (_name, clean) => {
    const got = clean({
      type: "object",
      properties: {
        billing: { type: "object", properties: { zip: { type: "string" } } },
        shipping: { $ref: "#/properties/billing" },
      },
    });

    expect(get(got, "properties.shipping.properties.zip.type")).toBe("string");
  });

  it.each(GEMINI_CLEANERS)("%s keeps both uses of a shared definition", (_name, clean) => {
    const got = clean({
      type: "object",
      properties: { billing: ref("Address"), shipping: ref("Address") },
      $defs: { Address: { type: "object", properties: { zip: { type: "string" } } } },
    });

    for (const field of ["billing", "shipping"])
      expect(get(got, `properties.${field}.properties.zip.type`)).toBe("string");
  });

  it("resolves a {schema: …} carrier against the inner schema", () => {
    const got = cleanJsonSchemaForAntigravityTool(
      {
        schema: {
          type: "object",
          properties: { person: ref("Person") },
          required: ["person"],
          $defs: { Person: person },
        },
      },
      false,
    );

    expect(get(got, "schema.properties.person.properties.name.type")).toBe("string");
    expect(exists(got, "schema.$defs")).toBe(false);
    expect(JSON.stringify(got)).not.toContain("See: Person");
  });

  it("forwards a default literal verbatim on the parametersJsonSchema route", () => {
    const literal = { title: "Report", format: "pdf", id: 7, "x-owner": "ops" };

    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { report: { type: "object", default: literal } },
    });

    expect(get(got, "properties.report.default")).toEqual(literal);
  });

  it("keeps schema-looking keys inside example and examples", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: {
        a: {
          type: "string",
          example: { title: "Hi", "x-owner": "ops", id: 3 },
          examples: [{ title: "Hi2", "x-owner": "ops", id: 4 }],
        },
      },
    });

    expect(get(got, "properties.a.example")).toEqual({ title: "Hi", "x-owner": "ops", id: 3 });
    expect(get(got, "properties.a.examples.0")).toEqual({ title: "Hi2", "x-owner": "ops", id: 4 });
  });

  it("InlineLocalRefs leaves a literal $ref in a default alone and keeps the definitions", () => {
    const got = inlineLocalRefs({
      type: "object",
      properties: { a: { type: "object", default: { $ref: "#/$defs/Person" } } },
      $defs: { Person: { type: "object", properties: { name: { type: "string" } } } },
    });

    expect(get(got, "properties.a.default.$ref")).toBe("#/$defs/Person");
    expect(exists(got, "properties.a.default.properties")).toBe(false);
    expect(exists(got, "$defs.Person.properties.name")).toBe(true);
  });

  it("keeps properties named default and type as schemas", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { default: ref("Person"), type: { type: "string", title: "Kind" } },
      $defs: { Person: { type: "object", properties: { name: { type: "string" } } } },
    });

    expect(get(got, "properties.default.properties.name.type")).toBe("string");
    expect(exists(got, "properties.type.title")).toBe(false);
  });

  it("bounds the expansion of exponentially fanning shared definitions", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema(diamond());

    expect(size(got)).toBeLessThan(512 * 1024);
    expect(exists(got, "properties.leaf")).toBe(true);
    // The affordable outer levels are still expanded.
    expect(exists(got, "properties.leaf.properties.a.properties.a")).toBe(true);
    expect(exists(got, "$defs")).toBe(false);
  });

  it("unused definitions do not consume the expansion budget", () => {
    const defs: JsonObject = {
      leaf0: { type: "string", description: "leaf leaf leaf leaf leaf leaf leaf leaf leaf leaf" },
      Person: person,
    };

    for (let i = 0; i < 13; i++) {
      const target = i === 0 ? "leaf0" : `D${i - 1}`;
      defs[`D${i}`] = { type: "object", properties: { a: ref(target), b: ref(target) } };
    }

    const input: Json = {
      type: "object",
      properties: { person: ref("Person") },
      required: ["person"],
      $defs: defs,
    };

    const first = JSON.stringify(cleanJsonSchemaForGeminiJsonSchema(input));

    for (let run = 0; run < 5; run++) {
      const got = cleanJsonSchemaForGeminiJsonSchema(input);
      expect(JSON.stringify(got)).toBe(first);
      expect(get(got, "properties.person.properties.name.type")).toBe("string");
      expect(exists(got, "$defs")).toBe(false);
    }
  });

  it("does not copy a large target description into every budget-degraded reference", () => {
    const properties: JsonObject = {};

    for (let i = 0; i < 200; i++) properties[`p${i}`] = ref("Big");

    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties,
      $defs: {
        Big: {
          type: "object",
          description: "x".repeat(32 * 1024),
          properties: { name: { type: "string" } },
        },
      },
    });

    expect(size(got)).toBeLessThan(512 * 1024);
    expect(exists(got, "properties.p0")).toBe(true);
    expect(exists(got, "properties.p199")).toBe(true);
    expect(get(got, "properties.p0.properties.name.type")).toBe("string");
    expect(exists(got, "$defs")).toBe(false);
  });

  it("a nested unused definitions graph does not consume the budget", () => {
    const nestedDefs: JsonObject = { Leaf: { type: "string", description: "x".repeat(1024) } };

    for (let i = 0; i < 256; i++) nestedDefs[`U${i}`] = { $ref: "#/properties/a/$defs/Leaf" };

    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { person: ref("Person"), a: { type: "object", $defs: nestedDefs } },
      required: ["person"],
      $defs: { Person: person },
    });

    expect(get(got, "properties.person.properties.name.type")).toBe("string");
    expect(exists(got, "properties.a.$defs")).toBe(false);
    expect(exists(got, "$defs")).toBe(false);
  });

  it("expands references inside a $ref node's own name-map siblings", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { a: { ...ref("Base"), properties: { x: ref("S") } } },
      $defs: { Base: { type: "object" }, S: { type: "string" } },
    });

    expect(get(got, "properties.a.properties.x.type")).toBe("string");
  });

  it("the cleaning inliner's intermediate output carries no definition containers", () => {
    const heavy: JsonObject = {
      type: "object",
      properties: { name: { type: "string" } },
      $defs: { Unused: { type: "string", description: "x".repeat(280 * 1024) } },
    };

    const got = inlineLocalRefsForClean({
      type: "object",
      properties: { p0: ref("Person"), p1: ref("Person") },
      $defs: { Person: heavy },
    });

    expect(size(got)).toBeLessThan(64 * 1024);
    expect(exists(got, "$defs")).toBe(false);
    expect(exists(got, "properties.p0.$defs")).toBe(false);
    expect(get(got, "properties.p1.properties.name.type")).toBe("string");
  });

  it("an array reference with an explicit type keeps the target's items", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { rows: { type: "array", $ref: "#/$defs/Rows" } },
      $defs: {
        Rows: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    });

    expect(get(got, "properties.rows.items.properties.name.type")).toBe("string");
  });

  it("still resolves sibling references when the target is too large to expand", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { a: { ...ref("Big"), properties: { x: ref("S") } } },
      $defs: {
        Big: { type: "object", description: "x".repeat(280 * 1024) },
        S: { type: "string" },
      },
    });

    expect(get(got, "properties.a.properties.x.type")).toBe("string");
    expect(JSON.stringify(got)).not.toContain('"$ref"');
  });

  it("InlineLocalRefs treats definitions named like keywords as schemas", () => {
    const got = inlineLocalRefs({
      $defs: {
        S: { type: "string" },
        properties: { type: "object", default: { $ref: "#/$defs/S" } },
        default: { type: "object", properties: { x: { $ref: "#/$defs/S" } } },
      },
    });

    expect(get(got, "$defs.properties.default.$ref")).toBe("#/$defs/S");
    expect(get(got, "$defs.default.properties.x.type")).toBe("string");
  });

  it.each([
    ["propertyRef", { person: ref("Person") }, undefined],
    ["rootRef", undefined, ref("Person")],
  ] as const)(
    "definitions nested in a target do not inflate its budget charge (%s)",
    (name, properties, root) => {
      const heavy: JsonObject = {
        ...person,
        $defs: { Unused: { type: "string", description: "x".repeat(280 * 1024) } },
      };

      const input: JsonObject =
        properties === undefined
          ? { ...root, $defs: { Person: heavy } }
          : { type: "object", properties, $defs: { Person: heavy } };

      const got = cleanJsonSchemaForGeminiJsonSchema(input);

      const namePath =
        name === "rootRef" ? "properties.name.type" : "properties.person.properties.name.type";

      expect(get(got, namePath)).toBe("string");
      expect(exists(got, "$defs")).toBe(false);
    },
  );

  it("a typed array reference without target items gets the placeholder, stably", () => {
    const input: Json = {
      type: "object",
      properties: { rows: { type: "array", $ref: "#/$defs/Common" } },
      $defs: { Common: { description: "Rows" } },
    };

    const first = cleanJsonSchemaForAntigravityTool(input, false);
    expect(get(first, "properties.rows.items.type")).toBe("string");
    expect(cleanJsonSchemaForAntigravityTool(first, false)).toEqual(first);
  });

  it("thousands of references to a small target stay bounded", () => {
    const properties: JsonObject = {};

    for (let i = 0; i < 2000; i++) properties[`p${i}`] = ref("S");

    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties,
      $defs: { S: { type: "string", description: "x".repeat(512) } },
    });

    expect(size(got)).toBeLessThan(512 * 1024);
  });

  it("budget accounting covers HTML-escaped string growth", () => {
    const properties: JsonObject = {};

    for (let i = 0; i < 8; i++) properties[`p${i}`] = ref("Big");

    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties,
      $defs: {
        Big: {
          type: "object",
          description: "<".repeat(32 * 1024),
          properties: { name: { type: "string" } },
        },
      },
    });

    // Go counts `<` as six encoded bytes; the bound holds on the same estimate.
    expect(size(got)).toBeLessThan(512 * 1024);
    expect(get(got, "properties.p0.properties.name.type")).toBe("string");
  });

  it("the dependencies container is a name map whose references expand", () => {
    const got = inlineLocalRefs({
      type: "object",
      dependencies: { default: { properties: { x: { $ref: "#/definitions/S" } } } },
      definitions: { S: { type: "string" } },
    });

    expect(get(got, "dependencies.default.properties.x.type")).toBe("string");
    expect(exists(got, "dependencies.default.properties.x.$ref")).toBe(false);
  });

  it("an omitted fallback description is not charged to the budget", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { a: ref("A"), b: ref("B") },
      $defs: {
        A: { type: "string", description: "x".repeat(262142) },
        B: { type: "object", properties: { name: { type: "string" } } },
      },
    });

    expect(get(got, "properties.b.properties.name.type")).toBe("string");
  });

  it("a type inferred from a $ref node's sibling items does not override the target's type", () => {
    const input: Json = {
      $ref: "#/$defs/O",
      items: { type: "integer" },
      $defs: { O: { type: "object", properties: { x: { type: "string" } } } },
    };

    const first = cleanJsonSchemaForGeminiJsonSchema(input);

    expect(get(first, "type")).toBe("object");
    expect(exists(first, "items")).toBe(false);
    expect(get(first, "properties.x.type")).toBe("string");
    expect(cleanJsonSchemaForGeminiJsonSchema(first)).toEqual(first);
  });

  it("a property named $ref stays a property", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { $ref: { type: "string" } },
    });

    expect(get(got, "properties")).toEqual({ $ref: { type: "string" } });
    expect(JSON.stringify(got)).not.toContain("See:");
  });

  it("a property named const stays a property and fabricates no enum", () => {
    const got = cleanJsonSchemaForGeminiJsonSchema({
      type: "object",
      properties: { const: { type: "string" } },
    });

    expect(get(got, "properties")).toEqual({ const: { type: "string" } });
    expect(exists(got, "enum")).toBe(false);
  });
});

describe("b2fda98e: array placeholder items wait for reference and allOf resolution", () => {
  const cleaners: ReadonlyArray<readonly [string, (schema: Json) => Json, boolean]> = [
    ["Antigravity", cleanJsonSchemaForAntigravity, true],
    ["AntigravityTool", (schema) => cleanJsonSchemaForAntigravityTool(schema, false), true],
    ["Gemini", cleanJsonSchemaForGemini, false],
  ];

  const ids: JsonObject = { type: "array", items: { type: "integer" } };

  const cases: ReadonlyArray<{
    name: string;
    input: Json;
    path: string;
    itemType: string;
    desc?: string;
    nullable?: boolean;
  }> = [
    {
      name: "direct_allof_items",
      input: {
        type: "object",
        properties: { ids: { type: "array", allOf: [{ items: { type: "integer" } }] } },
      },
      path: "properties.ids",
      itemType: "integer",
    },
    {
      name: "ref_in_allof_items",
      input: {
        type: "object",
        properties: { ids: { type: "array", allOf: [ref("Ids")] } },
        $defs: { Ids: ids },
      },
      path: "properties.ids",
      itemType: "integer",
    },
    {
      name: "nullable_type_array_with_ref_in_allof",
      input: {
        type: "object",
        properties: { ids: { type: ["array", "null"], allOf: [ref("Ids")] } },
        $defs: { Ids: ids },
      },
      path: "properties.ids",
      itemType: "integer",
      desc: "(nullable)",
      nullable: true,
    },
    {
      name: "split_allof_branches",
      input: {
        type: "object",
        properties: {
          ids: {
            allOf: [{ type: "array", description: "ID list" }, { items: { type: "integer" } }],
          },
        },
      },
      path: "properties.ids",
      itemType: "integer",
      desc: "ID list",
    },
    {
      name: "ref_base_array_with_allof_items",
      input: {
        type: "object",
        properties: { ids: { ...ref("BaseArray"), allOf: [{ items: { type: "integer" } }] } },
        $defs: { BaseArray: { type: "array", description: "ID list" } },
      },
      path: "properties.ids",
      itemType: "integer",
      desc: "ID list",
    },
    {
      name: "root_array_with_allof_items",
      input: { type: "array", allOf: [{ items: { type: "integer" } }] },
      path: "",
      itemType: "integer",
    },
    {
      name: "allof_without_items_gets_placeholder",
      input: {
        type: "object",
        properties: { ids: { type: "array", allOf: [{ description: "x" }] } },
      },
      path: "properties.ids",
      itemType: "string",
      desc: "x",
    },
  ];

  for (const [cleanerName, clean, preservesNullable] of cleaners) {
    it.each(cases)(`${cleanerName}: $name`, (tc) => {
      const got = clean(tc.input);
      const node = tc.path === "" ? got : get(got, tc.path);

      expect(get(node, "type")).toBe("array");
      expect(get(node, "items.type")).toBe(tc.itemType);

      if (tc.desc !== undefined) expect(get(node, "description")).toBe(tc.desc);

      if (tc.nullable === true && preservesNullable) expect(get(node, "nullable")).toBe(true);
      expect(clean(got)).toEqual(got);
    });
  }
});
