// GraphQL toolkits in the Tools part of the ControlPlane (#204) over RPC, against fake GraphQL endpoints served in
// workerd: a toolkit built by introspection with its shared credential (names, classes, a deprecated field hidden), its
// calls (a valid document with variables, a caller's selection checked against the schema it was built from, errors
// and partial data), a refresh that introspects again, an endpoint older than @oneOf (asked again without it), one
// built from an uploaded SDL file without introspection (kept, read back, replaced, skipped by the cron), an endpoint
// that refuses introspection and takes a first SDL upload then, and the outbound guard. The fake endpoints run the
// introspection query Commissary sends.
import { env, runInDurableObject } from "cloudflare:test";
import { buildSchema, graphqlSync } from "graphql";
import { describe, expect, it } from "vitest";
import type { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { MAX_SDL_BYTES, NO_INTROSPECTION } from "../src/graphql/schema.ts";
import { ToolkitStore } from "../src/toolkits/store.ts";
import tracker from "./fixtures/graphql/tracker.graphql?raw";
import { serveFakeServers } from "./support/fake-fetch.ts";
import { fakeHttpServer, type RecordedHttpRequest } from "./support/http-server.ts";

serveFakeServers();

const POLICY = { ownHosts: [], localDevelopment: false };

/** A store's sealer for a test that keeps no secrets. */
const NO_SECRETS = {
  seal: () => {
    throw new Error("no secrets in this test");
  },
  open: () => {
    throw new Error("no secrets in this test");
  },
};

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const EVERYONE = { kind: "everyone" as const };

const plane = () => env.CONTROL_PLANE.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof plane>;

/** A unique origin per endpoint, so tests never share one. */
const origin = () => `https://graphql-${crypto.randomUUID().slice(0, 8)}.example.com`;

/** `sdl`'s answer to the introspection query `query`, as a server of it runs it. */
const introspectionOf = (sdl: string, query: string) =>
  graphqlSync({ schema: buildSchema(sdl, { assumeValid: true }), source: query });

interface GraphQLRequest {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

const bodyOf = (request: RecordedHttpRequest): GraphQLRequest =>
  // SAFETY: Commissary sends GraphQL requests as the JSON of their query and variables.
  JSON.parse(request.body) as GraphQLRequest;

/** The GraphQL body of the endpoint's last request. */
const lastBody = (server: { readonly requests: ReadonlyArray<RecordedHttpRequest> }) => {
  const last = server.requests.at(-1);

  if (last === undefined) throw new Error("no request");

  return bodyOf(last);
};

const isIntrospection = (request: RecordedHttpRequest) =>
  bodyOf(request).query.includes("__schema");

/**
 * A fake endpoint of `schema()` (read on each introspection) that answers a call with `answer`, and only a request
 * signed in with `Bearer secret-token`. An endpoint older than `@oneOf` (`legacy`) refuses a query that asks for
 * `isOneOf` as such a server does (`400`, GraphQL over HTTP).
 */
const endpoint = (
  schema: () => string,
  answer: (request: GraphQLRequest) => Schema.JsonObject = () => ({
    data: { issue: { id: "i1" } },
  }),
  legacy = false,
) =>
  fakeHttpServer(origin(), (request) => {
    if (request.headers.get("authorization") !== "Bearer secret-token")
      return Response.json({ errors: [{ message: "Unauthorized" }] }, { status: 401 });
    const { query } = bodyOf(request);

    if (legacy && query.includes("isOneOf"))
      return Response.json(
        { errors: [{ message: 'Cannot query field "isOneOf" on type "__Type".' }] },
        { status: 400, headers: { "content-type": "application/graphql-response+json" } },
      );

    return Response.json(
      isIntrospection(request) ? introspectionOf(schema(), query) : answer(bodyOf(request)),
    );
  });

const graphQLToolkit = (extra: Partial<AddToolkitInput>): AddToolkitInput => ({
  kind: "graphql",
  source: "",
  name: "tracker",
  private: false,
  accepts: "shared",
  credential: { kind: "bearer", token: "secret-token", subject: EVERYONE },
  ...extra,
});

const add = async (stub: Stub, input: AddToolkitInput) => {
  const added = await stub.tools().addToolkit(ADMIN, input, "test", POLICY);

  if (!added.ok) throw new Error(`add failed: ${added.message}`);

  return added.value;
};

const toolsOf = async (stub: Stub, id: string) => {
  const listed = await stub.tools().listTools(ADMIN, id);

  if (!listed.ok) throw new Error(`list failed: ${listed.message}`);

  return listed.value.tools;
};

const call = (stub: Stub, name: string, args: Schema.JsonObject) =>
  stub.tools().callTool(ALICE, { name, arguments: args }, POLICY);

/** What the fake endpoint answers a call for an issue whose id is a key. */
const ANSWERS = new Map<string, Schema.JsonObject>([
  ["missing", { data: null, errors: [{ message: "Not found" }] }],
  [
    "partial",
    { data: { issue: { id: "partial", author: null } }, errors: [{ message: "Forbidden" }] },
  ],
]);

describe("a GraphQL toolkit built by introspection", () => {
  it("lists each root field as a tool: queries read, mutations write, deprecated ones hidden", async () => {
    const api = endpoint(() => tracker);
    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    expect(toolkit).toMatchObject({ kind: "graphql", name: "tracker", tool_list: { tools: 10 } });
    expect(toolkit.tool_list.error).toBeUndefined();
    expect(toolkit.uploaded).toBeUndefined();

    // The introspection went to the endpoint with the toolkit's credential.
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: new URL(`${api.origin}/graphql`),
    });

    expect(
      (await toolsOf(stub, toolkit.id)).map((tool) => [
        tool.name,
        tool.upstream_name,
        tool.class,
        tool.flags.hidden,
      ]),
    ).toEqual([
      ["tracker_query_issues", "query.issues", "read", false],
      ["tracker_query_issue", "query.issue", "read", false],
      ["tracker_query_issueby", "query.issueBy", "read", false],
      ["tracker_query_viewer", "query.viewer", "read", false],
      ["tracker_query_search", "query.search", "read", false],
      ["tracker_query_node", "query.node", "read", false],
      ["tracker_query_issuecount", "query.issueCount", "read", false],
      ["tracker_query_oldissues", "query.oldIssues", "read", true],
      ["tracker_mutation_createissue", "mutation.createIssue", "write", false],
      ["tracker_mutation_closeissue", "mutation.closeIssue", "write", false],
    ]);
  });

  it("calls a field with a valid document and its variables, and maps errors and partial data", async () => {
    const api = endpoint(
      () => tracker,
      ({ variables }) => {
        const id = String(variables?.["id"]);

        return (
          ANSWERS.get(id) ?? {
            data: { issue: { id } },
          }
        );
      },
    );

    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    expect(await call(stub, "tracker_query_issue", { id: "i1" })).toMatchObject({
      outcome: "result",
      result: {
        content: [
          { type: "text", text: '{\n  "data": {\n    "issue": {\n      "id": "i1"\n    }\n  }\n}' },
        ],
      },
      usage: { toolId: `${toolkit.id}:query.issue`, credential: "shared" },
    });

    const sent = api.requests.at(-1);

    expect(sent?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(lastBody(api)).toMatchObject({ variables: { id: "i1" } });
    expect(lastBody(api).query).toMatch(
      /^query\(\$id: ID!\) \{\n  issue\(id: \$id\) \{ id number /,
    );

    const missing = await call(stub, "tracker_query_issue", { id: "missing" });

    expect(missing).toMatchObject({ outcome: "result", result: { isError: true } });

    const partial = await call(stub, "tracker_query_issue", { id: "partial" });

    expect(partial).toMatchObject({ outcome: "result" });
    expect(partial.outcome === "result" && partial.result["isError"]).toBeUndefined();
    expect(JSON.stringify(partial)).toContain("Forbidden");
  });

  it("checks a caller's selection against the schema, and refuses a bad one before the call", async () => {
    const api = endpoint(() => tracker);
    const stub = plane();

    await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    expect(
      await call(stub, "tracker_query_issue", {
        id: "i1",
        selection: "{ title author { login } }",
      }),
    ).toMatchObject({ outcome: "result" });
    expect(lastBody(api).query).toBe(
      "query($id: ID!) {\n  issue(id: $id) { title author { login } }\n}",
    );

    const before = api.requests.length;

    expect(await call(stub, "tracker_query_issue", { id: "i1", selection: "{ secret }" })).toEqual({
      outcome: "failed",
      message: 'the selection is not valid: Cannot query field "secret" on type "Issue".',
      usage: expect.anything(),
    });
    expect(api.requests).toHaveLength(before);
  });

  it("introspects again on refresh, by hand and by the cron task", async () => {
    let schema = tracker;
    const api = endpoint(() => schema);
    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    schema = tracker.replace("  viewer: User!\n", "  viewer: User!\n  me: User!\n");
    expect((await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY)).ok).toBe(true);
    expect((await toolsOf(stub, toolkit.id)).map((tool) => tool.upstream_name)).toContain(
      "query.me",
    );

    schema = tracker;
    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 1,
      failed: 0,
      skipped: 0,
    });
    expect((await toolsOf(stub, toolkit.id)).map((tool) => tool.upstream_name)).not.toContain(
      "query.me",
    );
    expect(api.requests.filter(isIntrospection)).toHaveLength(3);
  });

  it("asks an endpoint older than @oneOf again without it", async () => {
    const api = endpoint(() => tracker, undefined, true);
    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    expect(toolkit.tool_list).toMatchObject({ tools: 10 });
    expect(toolkit.tool_list.error).toBeUndefined();
    expect(api.requests.map((request) => bodyOf(request).query.includes("isOneOf"))).toEqual([
      true,
      false,
    ]);
  });

  it("keeps the toolkit with the reason when the endpoint does not answer introspection", async () => {
    const stub = plane();

    const refusing = fakeHttpServer(origin(), () =>
      Response.json({ errors: [{ message: "GraphQL introspection is not allowed" }] }),
    );

    const toolkit = await add(stub, graphQLToolkit({ source: `${refusing.origin}/graphql` }));

    expect(toolkit.tool_list).toEqual({ tools: 0, error: NO_INTROSPECTION });
    // Asked once with isOneOf and once without.
    expect(refusing.requests).toHaveLength(2);

    // Apollo Server and Hasura refuse it with a 4xx.
    const apollo = fakeHttpServer(origin(), () =>
      Response.json(
        { errors: [{ message: "GraphQL introspection is not allowed by Apollo Server" }] },
        { status: 400 },
      ),
    );

    const refused = await add(
      stub,
      graphQLToolkit({ source: `${apollo.origin}/graphql`, name: "apollo" }),
    );

    expect(refused.tool_list).toEqual({ tools: 0, error: `${NO_INTROSPECTION} (HTTP 400)` });

    const unauthorized = endpoint(() => tracker);

    const signedOut = await add(
      stub,
      graphQLToolkit({
        source: `${unauthorized.origin}/graphql`,
        name: "signed_out",
        credential: { kind: "bearer", token: "wrong", subject: EVERYONE },
      }),
    );

    expect(signedOut.tool_list).toEqual({
      tools: 0,
      error: "the GraphQL endpoint answered HTTP 401",
    });
  });
});

describe("a GraphQL toolkit built from an uploaded schema", () => {
  it("lists without introspection, keeps the schema, reads it back, and is skipped by the cron", async () => {
    const api = endpoint(() => tracker);
    const stub = plane();

    const toolkit = await add(
      stub,
      graphQLToolkit({ source: `${api.origin}/graphql`, document: tracker }),
    );

    expect(toolkit).toMatchObject({ uploaded: true, tool_list: { tools: 10 } });
    expect(api.requests).toHaveLength(0);
    expect(await stub.tools().toolkitDocument(ADMIN, toolkit.id)).toEqual({
      ok: true,
      value: { document: tracker },
    });

    // Its calls go to the endpoint, and a selection is checked against the uploaded schema.
    expect(
      await call(stub, "tracker_query_issue", { id: "i1", selection: "{ number }" }),
    ).toMatchObject({ outcome: "result" });
    expect(api.requests).toHaveLength(1);
    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 0,
      failed: 0,
      skipped: 1,
    });

    const replaced = await stub
      .tools()
      .replaceDocument(
        ADMIN,
        toolkit.id,
        toolkit.revision,
        "type Query { ping: String } type Mutation { pong: String }",
        "test",
        POLICY,
      );

    expect(replaced).toMatchObject({
      ok: true,
      value: { uploaded: true, tool_list: { tools: 2 } },
    });
    expect(api.requests.filter(isIntrospection)).toHaveLength(0);
  });

  it("marks an OpenAPI toolkit from before the uploaded column uploaded when it has no source URL", async () => {
    const stub = plane();

    const uploaded = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;

      // The table as #203 left it, before a toolkit said whether it is built from an uploaded document.
      sql.exec(`DROP TABLE IF EXISTS toolkits`);
      sql.exec(
        `CREATE TABLE toolkits (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
           owner TEXT NOT NULL, accepts TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
           created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, list_built_at INTEGER,
           list_error TEXT, price_micros INTEGER, approval_rules TEXT, base_url TEXT)`,
      );

      for (const [id, kind, source] of [
        ["tk_upload", "openapi", ""],
        ["tk_url", "openapi", "https://x.example.com/openapi.json"],
        ["tk_mcp", "mcp", "https://x.example.com/mcp"],
      ])
        sql.exec(
          `INSERT INTO toolkits VALUES (?, ?, ?, ?, '', 'shared', 1, 0, 't', 0, 't', NULL, NULL, NULL, NULL, NULL)`,
          id,
          kind,
          id,
          source,
        );

      const store = new ToolkitStore(sql, NO_SECRETS, (body) => body());

      return store.toolkits().map((toolkit) => [toolkit.id, toolkit.uploaded]);
    });

    expect(uploaded).toEqual([
      ["tk_mcp", false],
      ["tk_upload", true],
      ["tk_url", false],
    ]);
  });

  it("keeps the toolkit with the reason when the schema is not valid SDL", async () => {
    const stub = plane();

    const toolkit = await add(
      stub,
      graphQLToolkit({ source: `${origin()}/graphql`, document: "type Query { broken(: Int }" }),
    );

    expect(toolkit.tool_list).toEqual({
      tools: 0,
      error: "the schema is not valid GraphQL SDL (line 1, column 21)",
    });
  });

  it("is kept in chunks when it is larger than one SQLite value, as is its schema", async () => {
    const fields = Array.from(
      { length: 6000 },
      (_, index) => `  "${"Lorem ipsum dolor sit amet. ".repeat(18)}"\n  field${index}: String`,
    );

    const large = `type Query {\n${fields.join("\n")}\n}`;

    expect(large.length).toBeGreaterThan(3_000_000);

    const stub = plane();

    const toolkit = await add(
      stub,
      graphQLToolkit({ source: `${origin()}/graphql`, document: large }),
    );

    expect(toolkit.tool_list).toMatchObject({ tools: 6000 });

    const chunks = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ documents: number; schemas: number }>(
          `SELECT (SELECT COUNT(*) FROM toolkit_documents WHERE toolkit_id = ?1) AS documents,
                  (SELECT COUNT(*) FROM toolkit_schemas WHERE toolkit_id = ?1) AS schemas`,
          toolkit.id,
        )
        .one(),
    );

    expect(chunks.documents).toBeGreaterThan(2);
    expect(chunks.schemas).toBeGreaterThan(2);
  });
});

describe("a GraphQL toolkit built by introspection that takes a first uploaded schema", () => {
  it("is built from it without introspection from then on, and refuses one above the SDL limit", async () => {
    let introspection = true;

    const api = fakeHttpServer(origin(), (request) => {
      if (request.headers.get("authorization") !== "Bearer secret-token")
        return Response.json({ errors: [{ message: "Unauthorized" }] }, { status: 401 });
      const { query } = bodyOf(request);

      if (!isIntrospection(request)) return Response.json({ data: { issueCount: 3 } });

      return introspection
        ? Response.json(introspectionOf(tracker, query))
        : Response.json({ errors: [{ message: "introspection is disabled" }] }, { status: 403 });
    });

    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: `${api.origin}/graphql` }));

    expect(toolkit).toMatchObject({ tool_list: { tools: 10 } });
    expect(toolkit.uploaded).toBeUndefined();

    // The endpoint stops answering introspection: a refresh says to upload the schema.
    introspection = false;
    expect(await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY)).toEqual({
      ok: false,
      error: "tool_list_failed",
      message: `${NO_INTROSPECTION} (HTTP 403)`,
    });

    const tooLarge = await stub
      .tools()
      .replaceDocument(
        ADMIN,
        toolkit.id,
        toolkit.revision,
        `${tracker}\n${"#".repeat(MAX_SDL_BYTES)}`,
        "test",
        POLICY,
      );

    expect(tooLarge).toEqual({
      ok: false,
      error: "body_too_large",
      message: `the schema is larger than ${MAX_SDL_BYTES} bytes`,
      path: "document",
    });

    const uploaded = await stub
      .tools()
      .replaceDocument(ADMIN, toolkit.id, toolkit.revision, tracker, "test", POLICY);

    expect(uploaded).toMatchObject({
      ok: true,
      value: { uploaded: true, revision: toolkit.revision + 1, tool_list: { tools: 10 } },
    });
    expect(uploaded.ok && uploaded.value.tool_list.error).toBeUndefined();

    // The cron task leaves it alone; its calls still go to the endpoint with the credential.
    const introspections = api.requests.filter(isIntrospection).length;

    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 0,
      failed: 0,
      skipped: 1,
    });
    expect(await call(stub, "tracker_query_issuecount", {})).toMatchObject({
      outcome: "result",
    });
    expect(api.requests.at(-1)?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(api.requests.filter(isIntrospection)).toHaveLength(introspections);
  });
});

describe("the outbound guard", () => {
  it("refuses an endpoint at a private address, and keeps the toolkit with the reason", async () => {
    const stub = plane();
    const toolkit = await add(stub, graphQLToolkit({ source: "https://10.0.0.1/graphql" }));

    expect(toolkit.tool_list).toEqual({ error: OUTBOUND_REFUSED_MESSAGE, tools: 0 });
  });

  it("refuses a call to an endpoint at a private address", async () => {
    const stub = plane();

    await add(stub, graphQLToolkit({ source: "https://192.168.1.10/graphql", document: tracker }));

    expect(await call(stub, "tracker_query_issuecount", {})).toMatchObject({
      outcome: "failed",
      message: OUTBOUND_REFUSED_MESSAGE,
    });
  });
});
