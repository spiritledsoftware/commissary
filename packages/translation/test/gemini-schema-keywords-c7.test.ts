// Gemini / Antigravity schema cleaners strip the JSON Schema keywords the upstream rejects with 400 "Unknown name"
// (ticket C7; upstream 154d5144 readOnly/writeOnly, a43026d7 contentMediaType/contentEncoding, e9ba5c50
// discriminator, 9126772d dependentRequired/dependentSchemas/dependencies). Each keyword is removed wherever it is a
// keyword while a property that merely carries the same name stays.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
  cleanJsonSchemaForGemini,
  cleanJsonSchemaForGeminiJsonSchema,
} from "../src/translator/gemini/util/json-schema.ts";

const CLEANERS: ReadonlyArray<readonly [string, (schema: Json) => Json]> = [
  ["Antigravity", cleanJsonSchemaForAntigravity],
  ["AntigravityTool", (schema) => cleanJsonSchemaForAntigravityTool(schema, false)],
  ["AntigravityResponse", cleanJsonSchemaForAntigravityResponse],
  ["Gemini", cleanJsonSchemaForGemini],
  ["GeminiJSONSchema", cleanJsonSchemaForGeminiJsonSchema],
];

const exists = (value: Json, path: string): boolean => get(value, path) !== undefined;

describe("readOnly / writeOnly (154d5144)", () => {
  const input: Json = {
    type: "object",
    $schema: "http://json-schema.org/draft-04/schema#",
    readOnly: false,
    writeOnly: false,
    properties: {
      parent: { type: "string", description: "Parent resource name" },
      database: {
        type: "object",
        properties: {
          name: { type: "string", description: "Database resource name", readOnly: true },
          uid: { type: "string", readOnly: true },
          createTime: { type: "string", readOnly: true },
          etag: { type: "string", writeOnly: true },
          locationId: { type: "string" },
        },
      },
      itemsList: { type: "array", items: { type: "string", readOnly: true, writeOnly: false } },
      unionField: {
        anyOf: [
          { type: "string", readOnly: true },
          { type: "integer", writeOnly: true },
        ],
      },
      readOnly: {
        type: "boolean",
        readOnly: true,
        description: "Legitimate property named readOnly",
      },
      writeOnly: {
        type: "boolean",
        writeOnly: true,
        description: "Legitimate property named writeOnly",
      },
    },
    required: ["parent"],
  };

  it.each(CLEANERS)("%s removes the keywords and keeps same-named properties", (_name, clean) => {
    const got = clean(input);

    for (const path of [
      "readOnly",
      "writeOnly",
      "properties.database.properties.name.readOnly",
      "properties.database.properties.uid.readOnly",
      "properties.database.properties.createTime.readOnly",
      "properties.database.properties.etag.writeOnly",
      "properties.itemsList.items.readOnly",
      "properties.itemsList.items.writeOnly",
      "properties.unionField.readOnly",
      "properties.unionField.writeOnly",
      "properties.unionField.anyOf.0.readOnly",
      "properties.unionField.anyOf.1.writeOnly",
      "properties.readOnly.readOnly",
      "properties.writeOnly.writeOnly",
    ]) {
      expect(exists(got, path), path).toBe(false);
    }

    for (const field of ["name", "uid", "createTime", "etag", "locationId"]) {
      expect(get(got, `properties.database.properties.${field}.type`)).toBe("string");
    }

    expect(get(got, "properties.database.properties.name.description")).toBe(
      "Database resource name",
    );
    expect(get(got, "properties.readOnly.type")).toBe("boolean");
    expect(get(got, "properties.readOnly.description")).toBe("Legitimate property named readOnly");
    expect(get(got, "properties.writeOnly.type")).toBe("boolean");
    expect(get(got, "properties.writeOnly.description")).toBe(
      "Legitimate property named writeOnly",
    );
  });
});

describe("contentMediaType / contentEncoding (a43026d7)", () => {
  const input: Json = {
    type: "object",
    contentMediaType: "application/json",
    contentEncoding: "utf-8",
    properties: {
      value: {
        anyOf: [
          { type: "object", properties: {} },
          { type: "string", contentMediaType: "application/json", contentEncoding: "base64" },
        ],
      },
      directPayload: {
        type: "string",
        contentMediaType: "application/json",
        contentEncoding: "base64",
      },
      contentMediaType: {
        type: "string",
        contentMediaType: "text/plain",
        description: "Legitimate property named contentMediaType",
      },
      contentEncoding: {
        type: "string",
        contentEncoding: "base64",
        description: "Legitimate property named contentEncoding",
      },
    },
  };

  it.each(CLEANERS)("%s removes the keywords and keeps same-named properties", (_name, clean) => {
    const got = clean(input);

    for (const path of [
      "contentMediaType",
      "contentEncoding",
      "properties.value.anyOf.1.contentMediaType",
      "properties.value.anyOf.1.contentEncoding",
      "properties.directPayload.contentMediaType",
      "properties.directPayload.contentEncoding",
      "properties.contentMediaType.contentMediaType",
      "properties.contentEncoding.contentEncoding",
    ]) {
      expect(exists(got, path), path).toBe(false);
    }

    expect(exists(got, "properties.contentMediaType")).toBe(true);
    expect(exists(got, "properties.contentEncoding")).toBe(true);
  });
});

describe("discriminator (e9ba5c50)", () => {
  const input: Json = {
    type: "object",
    properties: {
      target: {
        anyOf: [
          { type: "object", properties: { kind: { const: "a" }, url: { type: "string" } } },
          { type: "object", properties: { kind: { const: "b" }, path: { type: "string" } } },
        ],
        discriminator: { propertyName: "kind" },
      },
      deliverables: {
        type: "array",
        items: {
          anyOf: [
            { type: "object", properties: { kind: { const: "file" }, path: { type: "string" } } },
            { type: "object", properties: { kind: { const: "link" }, url: { type: "string" } } },
          ],
          discriminator: { propertyName: "kind" },
        },
      },
      polymorphicObject: {
        type: "object",
        properties: { kind: { type: "string" } },
        oneOf: [
          { properties: { a: { type: "string" } } },
          { properties: { b: { type: "number" } } },
        ],
        discriminator: {
          propertyName: "kind",
          mapping: { a: "#/definitions/A", b: "#/definitions/B" },
        },
      },
      discriminator: { type: "string", description: "Legitimate property named discriminator" },
      nestedDiscriminatorProp: {
        type: "object",
        properties: {
          discriminator: {
            type: "object",
            properties: { kind: { type: "string" } },
            discriminator: { propertyName: "kind" },
          },
        },
      },
    },
    discriminator: { propertyName: "target" },
  };

  it.each(CLEANERS)("%s removes the keyword and keeps same-named properties", (_name, clean) => {
    const got = clean(input);

    for (const path of [
      "discriminator",
      "properties.target.discriminator",
      "properties.deliverables.items.discriminator",
      "properties.polymorphicObject.discriminator",
      "properties.nestedDiscriminatorProp.properties.discriminator.discriminator",
    ]) {
      expect(exists(got, path), path).toBe(false);
    }

    expect(exists(got, "properties.discriminator")).toBe(true);
    expect(
      exists(got, "properties.nestedDiscriminatorProp.properties.discriminator.properties.kind"),
    ).toBe(true);
  });
});

describe("dependentRequired / dependentSchemas / dependencies (9126772d)", () => {
  const input: Json = {
    type: "object",
    properties: {
      baseline_url: { type: "string" },
      candidate_url: { type: "string" },
      options: {
        type: "object",
        properties: { threshold: { type: "number" }, diff_color: { type: "string" } },
        dependentRequired: { threshold: ["diff_color"] },
        dependentSchemas: { threshold: { properties: { diff_color: { type: "string" } } } },
        dependencies: { threshold: ["diff_color"] },
      },
      dependentRequired: {
        type: "string",
        description: "Legitimate property named dependentRequired",
      },
      dependentSchemas: {
        type: "object",
        properties: { nested: { type: "string" } },
        dependentRequired: { nested: ["other"] },
      },
      dependencies: { type: "string", description: "Legitimate property named dependencies" },
    },
    dependentRequired: { baseline_url: ["candidate_url"] },
    dependentSchemas: { baseline_url: { required: ["candidate_url"] } },
    dependencies: { baseline_url: ["candidate_url"] },
  };

  it.each(CLEANERS)("%s removes the keywords and keeps same-named properties", (_name, clean) => {
    const got = clean(input);

    for (const keyword of ["dependentRequired", "dependentSchemas", "dependencies"]) {
      expect(exists(got, keyword), `root ${keyword}`).toBe(false);
      expect(exists(got, `properties.options.${keyword}`), `options ${keyword}`).toBe(false);
      expect(exists(got, `properties.${keyword}`), `property ${keyword}`).toBe(true);
    }

    expect(exists(got, "properties.dependentSchemas.dependentRequired")).toBe(false);
  });
});
