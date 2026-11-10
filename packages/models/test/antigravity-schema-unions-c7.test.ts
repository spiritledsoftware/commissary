// Antigravity tool schemas: multi-branch unions are kept for Gemini models and flattened only for Claude models'
// parameter schemas (ticket C7; upstream 5efe9758, antigravity_schema_sanitize_test.go). The Antigravity Claude
// backend turns function declarations into Claude `custom.input_schema` and rejects nested multi-branch unions; the
// request translator is model-unaware, so only the executor's `constrainRequestPayload` knows to flatten.
import { describe, expect, it } from "vitest";
import { asString, get, type Json } from "@commissary/json";
import { builtinTranslators } from "@commissary/translation";
import { constrainRequestPayload } from "../src/executor/antigravity/envelope.ts";

const declaration = (parametersJsonSchema: Json, extra: Record<string, Json> = {}): Json => ({
  request: {
    tools: [
      { functionDeclarations: [{ name: "diagnostic_union", parametersJsonSchema, ...extra }] },
    ],
  },
});

const declarationOf = (payload: Json): Json | undefined =>
  get(payload, "request.tools.0.functionDeclarations.0");

const branchCount = (value: Json | undefined, path: string): number => {
  const union = get(value ?? null, path);

  return Array.isArray(union) ? union.length : 0;
};

// A nested boolean/object/array union under properties.value, plus a two-string-branch union.
const reduced: Json = {
  type: "object",
  properties: {
    value: {
      anyOf: [
        { type: "boolean" },
        { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
        { type: "array", items: { type: "string" } },
      ],
    },
    duo: { anyOf: [{ type: "string" }, { type: "string" }] },
  },
  required: ["value"],
};

const itemUnion: Json = {
  type: "object",
  properties: {
    item: {
      anyOf: [
        { type: "string" },
        { type: "object", properties: { image: { type: "string" } }, required: ["image"] },
        { type: "object", properties: { audio: { type: "string" } }, required: ["audio"] },
      ],
    },
  },
  required: ["item"],
};

const parametersOf = (model: string, schema: Json): Json | undefined => {
  const out = constrainRequestPayload(model, declaration(schema));

  expect(get(declarationOf(out) ?? null, "parametersJsonSchema")).toBeUndefined();

  return get(declarationOf(out) ?? null, "parameters");
};

const translate = (model: string, inputSchema: Json): Json => {
  const body: Json = {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "diagnostic_union", input_schema: inputSchema }],
  };

  return builtinTranslators.translateRequest(
    "claude",
    "antigravity",
    { format: "claude", model, stream: false, body },
    undefined,
  ).body;
};

describe("Antigravity tool unions by model (5efe9758)", () => {
  it("a Claude model's parameter schema flattens nested unions to the strongest branch", () => {
    const params = parametersOf("claude-opus-5-5-high", reduced);

    expect(get(params ?? null, "properties.value.anyOf")).toBeUndefined();
    expect(get(params ?? null, "properties.value.oneOf")).toBeUndefined();
    // The pre-regression behavior selected the strongest (object) branch.
    expect(get(params ?? null, "properties.value.type")).toBe("object");
    expect(get(params ?? null, "properties.value.properties.enabled")).toBeDefined();

    const description = asString(get(params ?? null, "properties.value.description"));
    expect(description).toContain("Accepts:");
    expect(description).toContain("boolean");
    expect(description).toContain("array");

    expect(get(params ?? null, "properties.duo.anyOf")).toBeUndefined();
    expect(get(params ?? null, "properties.duo.type")).toBe("string");
  });

  it.each(["gemini-3.1-pro-low", "gemini-3.6-flash-high"])(
    "%s keeps the preserved tool unions",
    (model) => {
      // gemini-3.1-pro shares the Claude VALIDATED placeholder group; gemini-3.6-flash does not. Both accept unions.
      const params = parametersOf(model, reduced);

      expect(branchCount(params, "properties.value.anyOf")).toBe(3);
      expect(get(params ?? null, "properties.value.anyOf.1.properties.enabled")).toBeDefined();
      expect(branchCount(params, "properties.duo.anyOf")).toBe(2);
    },
  );

  it("a Claude model keeps unions in function return schemas", () => {
    const out = constrainRequestPayload(
      "claude-opus-5-5-high",
      declaration(itemUnion, {
        response: itemUnion,
        responseJsonSchema: itemUnion,
        response_json_schema: itemUnion,
      }),
    );

    const decl = declarationOf(out);
    const params = get(decl ?? null, "parameters");

    expect(get(params ?? null, "properties.item.anyOf")).toBeUndefined();
    expect(get(params ?? null, "properties.item.type")).toBe("object");
    expect(get(params ?? null, "properties.item.properties.image")).toBeDefined();

    for (const key of ["response", "responseJsonSchema", "response_json_schema"]) {
      const returned = get(decl ?? null, key);

      expect(returned, key).toBeDefined();
      expect(branchCount(returned, "properties.item.anyOf"), key).toBe(3);
      expect(get(returned ?? null, "properties.item.anyOf.2.properties.audio"), key).toBeDefined();
    }
  });

  describe("the Claude request translator is model-unaware, the executor honors the model", () => {
    it.each(["gemini-3.6-flash-high", "claude-opus-5-5-high"])(
      "%s: the translator keeps three branches; the executor flattens them for Claude only",
      (model) => {
        const translated = translate(model, itemUnion);
        const translatedParams = get(declarationOf(translated) ?? null, "parametersJsonSchema");

        // Flattening belongs to the executor: the translator would lose the audio branch before a Gemini path kept it.
        expect(branchCount(translatedParams, "properties.item.anyOf")).toBe(3);
        expect(
          get(translatedParams ?? null, "properties.item.anyOf.2.properties.audio"),
        ).toBeDefined();

        const final = get(
          declarationOf(constrainRequestPayload(model, translated)) ?? null,
          "parameters",
        );

        if (model.includes("claude")) {
          expect(get(final ?? null, "properties.item.anyOf")).toBeUndefined();
          expect(get(final ?? null, "properties.item.type")).toBe("object");
          expect(get(final ?? null, "properties.item.properties.image")).toBeDefined();
        } else {
          expect(branchCount(final, "properties.item.anyOf")).toBe(3);
          expect(get(final ?? null, "properties.item.anyOf.2.properties.audio")).toBeDefined();
        }
      },
    );

    it("a nullable union keeps its nullable marker after the executor flattens it", () => {
      const model = "claude-opus-5-5-high";

      const translated = translate(model, {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
        },
        required: ["value"],
      });

      const translatedValue = get(
        declarationOf(translated) ?? null,
        "parametersJsonSchema.properties.value",
      );

      expect(branchCount(translatedValue, "anyOf")).toBe(2);
      expect(get(translatedValue ?? null, "nullable")).toBe(true);

      const finalValue = get(
        declarationOf(constrainRequestPayload(model, translated)) ?? null,
        "parameters.properties.value",
      );

      expect(get(finalValue ?? null, "anyOf")).toBeUndefined();
      expect(get(finalValue ?? null, "type")).toBe("string");
      expect(get(finalValue ?? null, "nullable")).toBe(true);
    });
  });
});
