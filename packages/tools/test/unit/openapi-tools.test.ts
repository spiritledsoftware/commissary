// The tools an OpenAPI document lists (`src/openapi/tools.ts`, #203), from the fixtures in test/fixtures/openapi: a 3.0
// document in YAML, a 3.1 document in JSON and a Swagger 2.0 one. Upstream names (an operationId, or the method and
// path), input schemas joining every parameter location and the body with `$ref`s resolved, what a call needs, a
// deprecated operation flagged, and schemas kept within their size.
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { MAX_YAML_DOCUMENT_BYTES } from "../../src/openapi/document.ts";
import { MAX_SCHEMA_BYTES, openApiToolList } from "../../src/openapi/tools.ts";
import petstore from "../fixtures/openapi/petstore-3.0.yaml?raw";
import swagger from "../fixtures/openapi/swagger-2.0.json?raw";
import widgets from "../fixtures/openapi/widgets-3.1.json?raw";

const listOf = (text: string, url?: string) => {
  const list = openApiToolList(text, url);

  if (Result.isFailure(list)) throw new Error(list.failure);

  return list.success;
};

const toolOf = (text: string, name: string, url?: string) => {
  const tool = listOf(text, url).tools.find((candidate) => candidate.name === name);

  if (tool === undefined) throw new Error(`no tool ${name}`);

  return tool;
};

describe("an OpenAPI 3.0 document in YAML", () => {
  it("lists one tool per operation, named by its operationId or else its method and path", () => {
    const list = listOf(petstore);

    expect(list.title).toBe("Petstore");
    expect(list.server).toBe("https://petstore.example.com/v1");
    expect(list.tools.map((tool) => [tool.name, tool.operation?.method])).toEqual([
      ["listPets", "GET"],
      ["createPet", "POST"],
      ["showPetById", "GET"],
      ["DELETE /pets/{petId}", "DELETE"],
      ["updatePet", "PATCH"],
    ]);
  });

  it("describes a tool by its summary and description", () => {
    expect(toolOf(petstore, "listPets").description).toBe("List pets\n\nEvery pet in the store.");
    expect(toolOf(petstore, "DELETE /pets/{petId}").description).toBe("Delete a pet");
  });

  it("joins query and header parameters into one input schema, leaving out the headers OpenAPI ignores", () => {
    const tool = toolOf(petstore, "listPets");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", maximum: 100 },
        tags: { type: "array", items: { type: "string" } },
        "X-Request-Id": { type: "string" },
      },
    });
    expect(tool.operation).toEqual({
      method: "GET",
      path: "/pets",
      server: "https://petstore.example.com/v1",
      parameters: [
        { name: "limit", in: "query", argument: "limit", required: false },
        {
          name: "tags",
          in: "query",
          argument: "tags",
          required: false,
          style: "form",
          explode: false,
        },
        { name: "X-Request-Id", in: "header", argument: "X-Request-Id", required: false },
      ],
      security: [[{ type: "apiKey", in: "header", name: "X-API-Key" }]],
    });
  });

  it("resolves $refs of parameters, bodies and schemas, ends a recursive one, and leaves out read-only and example", () => {
    const tool = toolOf(petstore, "updatePet");

    const pet = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        // 3.0's `nullable` is 3.1's type array.
        tag: { type: ["string", "null"] },
        owner: {
          type: "object",
          properties: {
            name: { type: "string" },
            pets: { type: "array", items: {} },
          },
        },
      },
    };

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        petId: { type: "integer", description: "The pet's id" },
        session: { type: "string" },
        body: pet,
      },
      required: ["petId", "session", "body"],
    });
    expect(tool.operation).toMatchObject({
      method: "PATCH",
      path: "/pets/{petId}",
      parameters: [
        { name: "petId", in: "path", argument: "petId", required: true },
        { name: "session", in: "cookie", argument: "session", required: true },
      ],
      body: { argument: "body", contentType: "application/json", required: true },
      deprecated: true,
    });
  });
});

describe("an OpenAPI 3.1 document in JSON", () => {
  it("fills its server's variables, and names each operation's security alternatives", () => {
    const list = listOf(widgets);

    expect(list.server).toBe("https://eu.widgets.example.com/api");

    expect(
      Object.fromEntries(list.tools.map((tool) => [tool.name, tool.operation?.security])),
    ).toEqual({
      listWidgets: [[{ type: "http", scheme: "bearer" }]],
      createWidget: [[{ type: "http", scheme: "basic" }]],
      getWidget: [[{ type: "apiKey", in: "query", name: "key" }]],
      replaceWidget: [[{ type: "oauth2" }]],
      archiveWidget: [[{ type: "apiKey", in: "cookie", name: "sid" }]],
      "GET /widgets/{id}/history": [[{ type: "http", scheme: "bearer" }]],
      legacyDelete: [[{ type: "http", scheme: "bearer" }]],
      status: [[]],
    });
  });

  it("names an operation without an operationId by its method and path, and flags a deprecated one", () => {
    const list = listOf(widgets);

    expect(list.tools.map((tool) => [tool.name, tool.operation?.method])).toEqual([
      ["listWidgets", "GET"],
      ["createWidget", "POST"],
      ["getWidget", "GET"],
      ["replaceWidget", "PUT"],
      ["archiveWidget", "POST"],
      ["GET /widgets/{id}/history", "GET"],
      ["legacyDelete", "DELETE"],
      ["status", "HEAD"],
    ]);
    expect(toolOf(widgets, "GET /widgets/{id}/history").description).toBe("A widget's history");
    expect(toolOf(widgets, "legacyDelete").operation?.deprecated).toBe(true);
    expect(toolOf(widgets, "listWidgets").operation?.deprecated).toBeUndefined();
  });

  it("takes header and cookie parameters, and a $ref's sibling description over the target's", () => {
    const tool = toolOf(widgets, "GET /widgets/{id}/history");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        "X-Trace": {
          type: "string",
          description: "Follows the request",
          pattern: "^[a-f0-9]{16}$",
        },
        session: { type: "string" },
      },
      required: ["id", "session"],
    });
    expect(tool.operation?.parameters).toEqual([
      { name: "id", in: "path", argument: "id", required: true },
      { name: "X-Trace", in: "header", argument: "X-Trace", required: false },
      { name: "session", in: "cookie", argument: "session", required: true },
    ]);
  });

  it("gives a parameter a name model APIs take, and a location prefix when another location has its name", () => {
    expect(toolOf(widgets, "listWidgets").operation?.parameters).toEqual([
      { name: "filter[name]", in: "query", argument: "filter_name_", required: false },
      { name: "page", in: "query", argument: "page", required: false, style: "deepObject" },
    ]);

    const tool = toolOf(widgets, "getWidget");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        query_id: { type: "string", description: "Another id" },
      },
      required: ["id"],
    });
  });

  it("prefers a JSON or form body, and keeps 3.1's type arrays", () => {
    expect(toolOf(widgets, "createWidget").operation?.body).toEqual({
      argument: "body",
      contentType: "application/x-www-form-urlencoded",
      required: true,
    });
    expect(toolOf(widgets, "replaceWidget").inputSchema).toMatchObject({
      properties: {
        body: {
          properties: {
            name: { type: "string", description: "What it is called" },
            size: { type: ["integer", "null"] },
          },
        },
      },
      required: ["id"],
    });
  });

  it("takes relative servers against the document's URL, and the document's own root without servers", () => {
    const relative = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Relative", version: "1" },
      servers: [{ url: "/api/v3" }],
      paths: { "/ping": { get: { operationId: "ping" } } },
    });

    expect(
      toolOf(relative, "ping", "https://docs.example.com/spec/openapi.json").operation?.server,
    ).toBe("https://docs.example.com/api/v3");
    // Uploaded, a relative server leads nowhere until the toolkit has a base URL.
    expect(toolOf(relative, "ping").operation?.server).toBeUndefined();

    const serverless = JSON.stringify({ ...JSON.parse(relative), servers: undefined });

    expect(
      toolOf(serverless, "ping", "https://docs.example.com/spec/openapi.json").operation?.server,
    ).toBe("https://docs.example.com/");
  });
});

describe("a Swagger 2.0 document", () => {
  it("is upgraded: its host and base path are the server, its body parameter the body", () => {
    const tool = toolOf(swagger, "putThing");

    expect(tool.operation).toMatchObject({
      method: "PUT",
      path: "/things/{id}",
      server: "https://legacy.example.com/v2",
      body: { argument: "body", contentType: "application/json", required: true },
      security: [[{ type: "apiKey", in: "header", name: "X-Key" }]],
    });
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "object", properties: { label: { type: ["string", "null"] } } },
      },
      required: ["id", "body"],
    });
  });
});

describe("documents Commissary cannot build from", () => {
  it("says why", () => {
    expect(openApiToolList("{ not json", undefined)).toEqual(
      Result.fail("the document is neither JSON nor YAML"),
    );
    expect(openApiToolList(JSON.stringify({ openapi: "4.0.0" }), undefined)).toEqual(
      Result.fail("the document is not OpenAPI 3.0, 3.1 or 3.2, nor Swagger 2.0"),
    );
  });

  it("refuses YAML above its size, and aliases that expand too far", () => {
    // Within the JSON limit, above the YAML one.
    const large = `openapi: 3.1.0\ninfo: { title: Big, version: "1" }\npaths: {}\n# ${"x".repeat(MAX_YAML_DOCUMENT_BYTES)}\n`;

    expect(openApiToolList(large, undefined)).toEqual(
      Result.fail(
        `the YAML document is larger than ${MAX_YAML_DOCUMENT_BYTES} bytes: upload it as JSON instead`,
      ),
    );

    // Nine levels of ten aliases each: a few hundred bytes that expand to a billion values.
    const levels = Array.from(
      { length: 9 },
      (_, level) => `l${level + 1}: &l${level + 1} [${Array(10).fill(`*l${level}`).join(", ")}]`,
    );

    const laughs = ["openapi: 3.1.0", "l0: &l0 [lol]", ...levels, "paths: {}"].join("\n");

    expect(openApiToolList(laughs, undefined)).toEqual(
      Result.fail("the document's YAML aliases expand too far"),
    );
  });
});

describe("YAML", () => {
  it("reads an unquoted version as the version it names", () => {
    const list = listOf(
      [
        "openapi: 3.0",
        "info: { title: Bare, version: 1 }",
        "paths:",
        "  /ping:",
        "    get:",
        "      operationId: ping",
      ].join("\n"),
    );

    expect(list.tools.map((tool) => tool.name)).toEqual(["ping"]);
  });
});

describe("large schemas", () => {
  it("are cut at a shallower depth until they fit", () => {
    // A schema nested seven deep, four wide at every level: whole, about 4 MB, far above the limit and the node budget.
    const level = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { type: "string", description: "x".repeat(200) }
        : {
            type: "object",
            description: `level ${depth}`,
            properties: Object.fromEntries(
              Array.from({ length: 4 }, (_, index) => [`p${index}`, level(depth - 1)]),
            ),
          };

    const document = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Deep", version: "1" },
      paths: {
        "/deep": {
          post: {
            operationId: "deep",
            requestBody: { content: { "application/json": { schema: level(7) } } },
          },
        },
      },
    });

    const schema = toolOf(document, "deep").inputSchema;
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;

    expect(bytes).toBeLessThanOrEqual(MAX_SCHEMA_BYTES);
    // The top of the body is kept: its properties, and their types where the cut falls.
    expect(schema).toMatchObject({
      properties: { body: { type: "object", properties: { p0: { type: "object" } } } },
    });
  });
});
