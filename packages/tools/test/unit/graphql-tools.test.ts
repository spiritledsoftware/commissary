// The tools a GraphQL schema lists (`src/graphql/schema.ts`, #204), from the fixture
// test/fixtures/graphql/tracker.graphql read as SDL and as an endpoint's answer to the introspection query a build
// sends: names (`query.issues`, `mutation.createIssue`), input schemas (nested input objects, enums, lists, non-null,
// defaults, `@oneOf`, a recursive input cut, a root connection's page size), what a call needs, a deprecated field
// flagged, subscriptions left out, and the default selection's rule and bound, every tool's default valid against the
// schema.
import { describe, expect, it } from "vitest";
import { buildSchema, graphqlSync, parse, validate } from "graphql";
import { Result } from "effect";
import {
  defaultSelection,
  graphQLToolList,
  INTROSPECTION_QUERY,
  LEGACY_INTROSPECTION_QUERY,
  LIST_CAP,
  MAX_SDL_BYTES,
  MAX_SELECTION_FIELDS,
  operationDocument,
  type SchemaText,
} from "../../src/graphql/schema.ts";
import { MAX_SCHEMA_BYTES } from "../../src/toolkits/input-schema.ts";
import tracker from "../fixtures/graphql/tracker.graphql?raw";

/** The fixture's answer to the introspection query `query`, as an endpoint serving it gives it. */
const answerTo = (query: string): string =>
  JSON.stringify(graphqlSync({ schema: buildSchema(tracker), source: query }));

const introspection = answerTo(INTROSPECTION_QUERY);

const listOf = (text: SchemaText) => {
  const list = graphQLToolList(text);

  if (Result.isFailure(list)) throw new Error(list.failure);

  return list.success;
};

const toolOf = (name: string) => {
  const tool = listOf({ sdl: tracker }).tools.find((candidate) => candidate.name === name);

  if (tool === undefined) throw new Error(`no tool ${name}`);

  return tool;
};

/** The properties of a tool's input schema. */
const propertiesOf = (name: string): Record<string, Record<string, unknown>> =>
  // SAFETY: a GraphQL tool's input schema is an object schema whose properties are schemas.
  (toolOf(name).inputSchema?.["properties"] ?? {}) as Record<string, Record<string, unknown>>;

/** The default selection of `query.issue`, worked out by hand from the rule (`defaultSelection`). */
const ISSUE_SELECTION =
  "{ id number title body state createdAt " +
  "author { id login name issues(first: 10) { pageInfo { hasNextPage endCursor } totalCount " +
  "edges { node { id number title body state createdAt } } } } " +
  "labels(first: 10) { pageInfo { hasNextPage endCursor } totalCount nodes { name color } } " +
  "comments(first: 10) { id body author { id login name } } " +
  "project { id name owner { id login name } } }";

describe("a GraphQL schema's tools", () => {
  it("are its query root's fields, then its mutation root's, without subscriptions", () => {
    expect(listOf({ sdl: tracker }).tools.map((tool) => tool.name)).toEqual([
      "query.issues",
      "query.issue",
      "query.issueBy",
      "query.viewer",
      "query.search",
      "query.node",
      "query.issueCount",
      "query.oldIssues",
      "mutation.createIssue",
      "mutation.closeIssue",
    ]);
  });

  it("are the same read from SDL and from an answer to introspection, which keeps @oneOf", () => {
    const fromSdl = listOf({ sdl: tracker });
    const fromIntrospection = listOf({ introspection });

    expect(fromIntrospection.tools).toEqual(fromSdl.tools);
    expect(fromSdl.schema).toContain("type Query {");
    expect(fromSdl.schema).toContain("input IssueRef @oneOf {");
    expect(fromIntrospection.schema).toContain("input IssueRef @oneOf {");
  });

  it("read an answer to the query without isOneOf, which a server older than @oneOf answers", () => {
    const legacy = listOf({ introspection: answerTo(LEGACY_INTROSPECTION_QUERY) });

    expect(legacy.tools.map((tool) => tool.name)).toEqual(
      listOf({ sdl: tracker }).tools.map((tool) => tool.name),
    );
    expect(legacy.schema).not.toContain("@oneOf");
  });

  it("describe a tool by its field's description, and flag a deprecated field", () => {
    expect(toolOf("query.issues").description).toBe("Issues of a project, newest first.");
    expect(toolOf("query.viewer").description).toBeUndefined();
    expect(toolOf("query.oldIssues").graphql?.deprecated).toBe(true);
    expect(toolOf("query.issue").graphql?.deprecated).toBeUndefined();
  });

  it("map arguments to JSON Schema: scalars, enums, lists, defaults and the required non-null ones", () => {
    const { selection, ...properties } = propertiesOf("query.issues");

    expect(toolOf("query.issues").inputSchema?.["required"]).toEqual(["project"]);
    expect(properties).toEqual({
      project: { type: "string", description: "The project's id." },
      state: { type: "string", enum: ["OPEN", "CLOSED"], default: "OPEN" },
      labels: { type: "array", items: { type: "string" } },
      first: { type: "integer", default: LIST_CAP },
      after: { type: "string" },
    });
    expect(selection).toMatchObject({ type: "string" });
  });

  it("cap a root list or connection's page size the schema leaves to the server, and only that", () => {
    expect(toolOf("query.issues").graphql?.arguments).toContainEqual({
      name: "first",
      type: "Int",
      required: false,
      default: LIST_CAP,
    });

    const list = listOf({
      sdl:
        "type Query { a(first: Int = 50): [T!]! b(limit: Int): [T] c(first: Int!): [T] d(first: Int): T } " +
        "type T { id: ID }",
    });

    expect(
      list.tools.map((tool) => tool.graphql?.arguments.map((argument) => argument.default)),
    ).toEqual([[undefined], [LIST_CAP], [undefined], [undefined]]);
  });

  it("select a valid default: every tool's document checks out against the schema", () => {
    const schema = buildSchema(tracker);

    for (const tool of listOf({ sdl: tracker }).tools) {
      const operation = tool.graphql;

      if (operation?.selection === undefined) continue;
      const document = operationDocument(operation, operation.arguments, operation.selection);

      expect([tool.name, validate(schema, parse(document))]).toEqual([tool.name, []]);
    }
  });

  it("map a nested input object, with its own required fields, enums, lists and a custom scalar", () => {
    const tool = toolOf("mutation.createIssue");

    expect(tool.inputSchema?.["required"]).toEqual(["input"]);
    expect(propertiesOf("mutation.createIssue")["input"]).toEqual({
      type: "object",
      description: "The issue to open.",
      properties: {
        project: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" }, default: [] },
        state: { type: "string", enum: ["OPEN", "CLOSED"], default: "OPEN" },
        meta: {
          type: "object",
          properties: {
            priority: { type: "integer", description: "From 0 (none) to 4 (urgent)." },
            dueAt: { description: "A DateTime." },
          },
          additionalProperties: false,
        },
        clientMutationId: { type: "string" },
      },
      required: ["project", "title"],
      additionalProperties: false,
    });
  });

  it("leave a deprecated enum value out, take one key of a @oneOf input, and cut a recursive input", () => {
    expect(propertiesOf("mutation.closeIssue")["reason"]).toEqual({
      type: "string",
      enum: ["COMPLETED", "NOT_PLANNED"],
    });
    expect(propertiesOf("query.issueBy")["ref"]).toEqual({
      type: "object",
      properties: { id: { type: "string" }, number: { type: "integer" } },
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
    });

    const filter = JSON.stringify(propertiesOf("query.issueCount")["filter"]);

    // Eight levels of `and`/`or`, each two branches, would not fit: a shallower cut does.
    expect(new TextEncoder().encode(filter).byteLength).toBeLessThanOrEqual(MAX_SCHEMA_BYTES);
    expect(filter).toContain('"and":{"type":"array","items":{"type":"object"');
  });

  it("keep what a call needs: the root, the field, each argument's type and the default selection", () => {
    expect(toolOf("query.issue").graphql).toEqual({
      root: "query",
      field: "issue",
      arguments: [{ name: "id", type: "ID!", required: true }],
      selection: ISSUE_SELECTION,
      selectionArgument: "selection",
    });
    expect(toolOf("query.issueCount").graphql).toEqual({
      root: "query",
      field: "issueCount",
      arguments: [{ name: "filter", type: "IssueFilter", required: false }],
    });
    expect(toolOf("query.issueCount").inputSchema?.["properties"]).not.toHaveProperty("selection");
  });

  it("name the selection's input property apart from an argument named selection", () => {
    const list = listOf({
      sdl: "type Query { pick(selection: String): Thing } type Thing { id: ID }",
    });

    expect(list.tools[0]?.graphql?.selectionArgument).toBe("selection_2");
    expect(Object.keys(list.tools[0]?.inputSchema?.["properties"] ?? {})).toEqual([
      "selection",
      "selection_2",
    ]);
  });
});

describe("a default selection", () => {
  const schema = buildSchema(tracker);

  const type = (name: string) => {
    const found = schema.getType(name);

    if (found === undefined) throw new Error(`no type ${name}`);

    return found;
  };

  it("takes a connection's page info, count and nodes through its edges, at its own level", () => {
    expect(toolOf("query.issues").graphql?.selection).toBe(
      `{ pageInfo { hasNextPage endCursor } totalCount edges { node ${ISSUE_SELECTION} } }`,
    );
  });

  it("names an interface's or a union's type, and each member of a union in a fragment", () => {
    expect(defaultSelection(type("Node"))).toBe("{ __typename id }");
    const search = defaultSelection(type("SearchResult"));

    expect(search).toMatch(
      /^\{ __typename \.\.\. on Issue \{ id number title body .* \} \.\.\. on User \{ /,
    );
    // Comment's body is `String!`, Issue's `String`: it takes another name.
    expect(search).toMatch(/ \.\.\. on Comment \{ id Comment_body: body .* \} \}$/);
  });

  it("aliases a union member's field another member selects under its name with another type", () => {
    const clash = buildSchema(
      "type Query { u: U } union U = A | B | C " +
        "type A { x: String y: Int B_x: Float } type B { x: String! y: Int } type C { x: Int C_x: Boolean }",
    );

    expect(defaultSelection(clash.getType("U") ?? type("Issue"))).toBe(
      "{ __typename ... on A { x y B_x } ... on B { B_x_2: x y } ... on C { C_x: x C_C_x: C_x } }",
    );
  });

  it("holds at most its number of fields, the result's own first", () => {
    const fields = Array.from({ length: 80 }, (_, index) => `f${index}: String`).join(" ");
    const wide = buildSchema(`type Query { wide: Wide } type Wide { ${fields} nested: Wide }`);
    const selection = defaultSelection(wide.getType("Wide") ?? type("Issue"));

    expect(selection).toBe(
      `{ ${Array.from({ length: MAX_SELECTION_FIELDS }, (_, index) => `f${index}`).join(" ")} }`,
    );
  });

  it("is the type's name when it finds no field to take", () => {
    const bare = buildSchema(
      "type Query { a: A } type A { b(x: Int!): String c: [B!]! } type B { d: Int }",
    );

    expect(defaultSelection(bare.getType("A") ?? type("Issue"))).toBe("{ __typename }");
  });
});

describe("a schema a toolkit cannot be built from", () => {
  it("is refused with a reason that quotes no part of it", () => {
    for (const [text, reason] of [
      [
        { sdl: "type Query { broken(: Int }" },
        "the schema is not valid GraphQL SDL (line 1, column 21)",
      ],
      [{ sdl: "type Query { a: Missing }" }, "the schema is not valid GraphQL SDL"],
      [{ introspection: "<html>" }, "the GraphQL endpoint's answer to introspection is not JSON"],
      [
        { introspection: JSON.stringify({ errors: [{ message: "introspection is disabled" }] }) },
        "the GraphQL endpoint did not answer introspection (it may not allow it): upload its schema (SDL) instead",
      ],
      [
        { introspection: JSON.stringify({ data: { __schema: { types: "nope" } } }) },
        "the GraphQL endpoint's answer to introspection is not a schema",
      ],
      [
        { sdl: `${tracker}\n${"#".repeat(MAX_SDL_BYTES)}` },
        `the schema is larger than ${MAX_SDL_BYTES} bytes`,
      ],
    ] as const)
      expect(graphQLToolList(text)).toEqual(Result.fail(reason));
  });
});
