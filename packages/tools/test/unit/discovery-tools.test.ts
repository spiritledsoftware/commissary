// The tools a Google Discovery document lists (`src/discovery/tools.ts`, #205), from a trimmed Gmail v1 document
// (test/fixtures/discovery/gmail-v1.json) and small documents of its own: one tool per method, nested resources'
// included, named by the method's id; input schemas of the path and query parameters and the request body, `$ref`s to
// the document's schemas resolved; what a call needs (method, path under rootUrl and servicePath, security, scopes);
// `{+name}` paths; methods whose only input is an upload left out; and documents Commissary cannot build from.
import { describe, expect, it } from "vitest";
import { Result, type Schema } from "effect";
import { discoveryToolList } from "../../src/discovery/tools.ts";
import gmail from "../fixtures/discovery/gmail-v1.json?raw";

const listOf = (text: string) => {
  const list = discoveryToolList(text);

  if (Result.isFailure(list)) throw new Error(list.failure);

  return list.success;
};

const toolOf = (text: string, name: string) => {
  const tool = listOf(text).tools.find((candidate) => candidate.name === name);

  if (tool === undefined) throw new Error(`no tool ${name}`);

  return tool;
};

/** A Discovery document of `resources`, served from `https://example.googleapis.com/` under `v1/`. */
const documentOf = (resources: Schema.JsonObject, schemas: Schema.JsonObject = {}) =>
  JSON.stringify({
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    name: "example",
    rootUrl: "https://example.googleapis.com/",
    servicePath: "v1/",
    schemas,
    resources,
  });

describe("a Gmail Discovery document", () => {
  it("lists one tool per method, nested resources' included, named by the method's id", () => {
    const list = listOf(gmail);

    expect(list.name).toBe("gmail");
    expect(list.rootUrl).toBe("https://gmail.googleapis.com/");
    expect(list.tools.map((tool) => tool.name)).toEqual([
      "gmail.users.getProfile",
      "gmail.users.messages.list",
      "gmail.users.messages.get",
      "gmail.users.messages.send",
      "gmail.users.messages.delete",
      "gmail.users.messages.attachments.get",
      "gmail.users.labels.list",
      "gmail.users.labels.create",
      "gmail.users.settings.forwardingAddresses.create",
    ]);
  });

  it("maps path and query parameters to an input schema, typed as Discovery's strings say, without the global ones", () => {
    const tool = toolOf(gmail, "gmail.users.messages.list");

    expect(tool.description).toBe(
      "Lists the messages in the user's mailbox. For more information, see [List Gmail messages](https://developers.google.com/workspace/gmail/api/guides/list-messages).",
    );
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        userId: { type: "string", default: "me" },
        maxResults: { type: "integer", format: "uint32", default: 100 },
        includeSpamTrash: { type: "boolean", default: false },
        labelIds: { type: "array", items: { type: "string" } },
        q: { type: "string" },
        pageToken: { type: "string" },
      },
      required: ["userId"],
    });
    expect(Object.keys(tool.inputSchema?.["properties"] ?? {})).not.toContain("key");
    expect(Object.keys(tool.inputSchema?.["properties"] ?? {})).not.toContain("alt");
  });

  it("resolves the request body's $ref to the document's schemas, and ends a recursive one", () => {
    const tool = toolOf(gmail, "gmail.users.messages.send");
    const properties = tool.inputSchema?.["properties"];

    expect(tool.inputSchema?.["required"]).toEqual(["userId", "body"]);
    expect(properties).toMatchObject({
      body: {
        type: "object",
        properties: {
          raw: { type: "string", format: "byte" },
          labelIds: { type: "array", items: { type: "string" } },
          payload: {
            type: "object",
            properties: {
              headers: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, value: { type: "string" } },
                },
              },
              // A MessagePart's parts are MessageParts: the recursion ends in an empty schema.
              parts: { type: "array", items: {} },
            },
          },
        },
      },
    });
    // Discovery's own keywords are not JSON Schema's: the schema's `id`, a property's `annotations`.
    expect(properties).not.toHaveProperty(["body", "id"]);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(?:annotations|location)":/);
  });

  it("keeps what a call needs: the method, its path under rootUrl, the API key or OAuth 2 alternatives and its scopes", () => {
    expect(toolOf(gmail, "gmail.users.messages.attachments.get").operation).toEqual({
      method: "GET",
      path: "/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}",
      server: "https://gmail.googleapis.com/",
      parameters: [
        { name: "messageId", in: "path", argument: "messageId", required: true },
        { name: "userId", in: "path", argument: "userId", required: true },
        { name: "id", in: "path", argument: "id", required: true },
      ],
      security: [[{ type: "apiKey", in: "query", name: "key" }], [{ type: "oauth2" }]],
      scopes: [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/gmail.addons.current.message.action",
        "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
    });
    expect(toolOf(gmail, "gmail.users.labels.create").operation).toMatchObject({
      method: "POST",
      body: { argument: "body", contentType: "application/json", required: true },
    });
  });
});

describe("Discovery's own forms", () => {
  it("expands a {+name} parameter with its reserved characters, under servicePath, and keeps its pattern", () => {
    const document = documentOf({
      projects: {
        resources: {
          operations: {
            methods: {
              get: {
                id: "example.projects.operations.get",
                httpMethod: "GET",
                path: "{+name}",
                flatPath: "v1/projects/{projectsId}/operations/{operationsId}",
                parameters: {
                  name: {
                    location: "path",
                    type: "string",
                    required: true,
                    pattern: "^projects/[^/]+/operations/[^/]+$",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(toolOf(document, "example.projects.operations.get").operation).toMatchObject({
      path: "/{name}",
      server: "https://example.googleapis.com/v1/",
      parameters: [
        {
          name: "name",
          in: "path",
          allowReserved: true,
          pattern: "^projects/[^/]+/operations/[^/]+$",
        },
      ],
    });
  });

  it("leaves out a method whose only input is an upload, and lists one that takes a JSON body besides", () => {
    const document = documentOf(
      {
        files: {
          methods: {
            upload: {
              id: "example.files.upload",
              httpMethod: "POST",
              path: "files",
              supportsMediaUpload: true,
            },
            create: {
              id: "example.files.create",
              httpMethod: "POST",
              path: "files",
              supportsMediaUpload: true,
              request: { $ref: "File" },
            },
            export: {
              id: "example.files.export",
              httpMethod: "GET",
              path: "files/{fileId}/export",
              supportsMediaDownload: true,
              parameters: { fileId: { location: "path", type: "string", required: true } },
            },
          },
        },
      },
      { File: { id: "File", type: "object", properties: { name: { type: "string" } } } },
    );

    expect(listOf(document).tools.map((tool) => tool.name)).toEqual([
      "example.files.create",
      "example.files.export",
    ]);
  });

  it("turns a property's required: true into its object's required, and type any into no type", () => {
    const document = documentOf(
      {
        things: {
          methods: {
            put: {
              id: "example.things.put",
              httpMethod: "PUT",
              path: "things",
              request: { $ref: "Thing" },
            },
          },
        },
      },
      {
        Thing: {
          id: "Thing",
          type: "object",
          properties: {
            name: { type: "string", required: true },
            value: { type: "any", description: "Anything" },
            count: { type: "integer", minimum: "1", maximum: "10" },
          },
        },
      },
    );

    expect(toolOf(document, "example.things.put").inputSchema?.["properties"]).toEqual({
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { description: "Anything" },
          count: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["name"],
      },
    });
  });
});

describe("documents Commissary cannot build from", () => {
  it("says why", () => {
    expect(discoveryToolList("not json")).toEqual(Result.fail("the document is not JSON"));
    expect(discoveryToolList(JSON.stringify({ openapi: "3.1.0" }))).toEqual(
      Result.fail("the document is not a Discovery document"),
    );
    expect(
      discoveryToolList(JSON.stringify({ kind: "discovery#restDescription", resources: {} })),
    ).toEqual(Result.fail("the Discovery document names no rootUrl calls can be made under"));
  });
});
