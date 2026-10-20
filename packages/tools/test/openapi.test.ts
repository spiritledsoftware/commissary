// OpenAPI toolkits in the Tools part of the ControlPlane (#203) over RPC, against fake HTTP servers served in workerd:
// toolkits built from a 3.0 YAML and a 3.1 JSON document's URL, their tools' names and classes (an override's class
// too), a deprecated operation hidden until an override shows it, calls against the base URL with the shared
// credential, a refresh that picks up an added and a removed operation, the outbound guard on the document, on the
// servers a document names and on calls, and documents of several MB, fetched and uploaded, JSON and YAML, within and
// above their limits.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { MAX_DOCUMENT_BYTES } from "../src/http/call.ts";
import { MAX_YAML_DOCUMENT_BYTES } from "../src/openapi/document.ts";
import petstore from "./fixtures/openapi/petstore-3.0.yaml?raw";
import widgets from "./fixtures/openapi/widgets-3.1.json?raw";
import { serveFakeServers } from "./support/fake-fetch.ts";
import { fakeHttpServer } from "./support/http-server.ts";

serveFakeServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const EVERYONE = { kind: "everyone" as const };

const plane = () => env.CONTROL_PLANE.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof plane>;

/** A unique origin per server, so tests never share one. */
const origin = () => `https://api-${crypto.randomUUID().slice(0, 8)}.example.com`;

const openApiToolkit = (extra: Partial<AddToolkitInput>): AddToolkitInput => ({
  kind: "openapi",
  source: "",
  name: undefined,
  private: false,
  accepts: "shared",
  credential: { kind: "none", subject: EVERYONE },
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

/** A minimal 3.1 document with one GET operation per name, served from `server`. */
const documentOf = (server: string, operations: ReadonlyArray<string>) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Ops", version: "1" },
    servers: [{ url: server }],
    paths: Object.fromEntries(
      operations.map((operation) => [`/${operation}`, { get: { operationId: operation } }]),
    ),
  });

/** Long descriptions, so a document of a few thousand operations is several MB. */
const PADDING = "Lorem ipsum dolor sit amet. ".repeat(140);

/** A 3.1 document in JSON with `count` GET operations served from `server`: about 4 KB each. */
const largeJson = (server: string, count: number) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Big API", version: "1" },
    servers: [{ url: server }],
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `/things/${index}`,
        { get: { operationId: `thing${index}`, description: `${index} ${PADDING}` } },
      ]),
    ),
  });

/** The same document in YAML (block style, as documents are written). */
const largeYaml = (server: string, count: number) =>
  [
    "openapi: 3.1.0",
    "info:",
    "  title: Big API",
    '  version: "1"',
    "servers:",
    `  - url: ${server}`,
    "paths:",
    ...Array.from({ length: count }, (_, index) => [
      `  /things/${index}:`,
      "    get:",
      `      operationId: thing${index}`,
      `      description: ${index} ${PADDING}`,
    ]).flat(),
  ].join("\n");

describe("an OpenAPI toolkit from a document's URL", () => {
  it("lists one tool per operation, read for GET and write otherwise", async () => {
    const docs = fakeHttpServer(origin(), () => new Response(petstore));
    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/openapi.yaml`, name: "petstore" }),
    );

    expect(toolkit).toMatchObject({ kind: "openapi", name: "petstore", tool_list: { tools: 5 } });
    expect(docs.requests.map((request) => request.headers.get("authorization"))).toEqual([null]);

    const tools = await toolsOf(stub, toolkit.id);

    expect(
      tools.map((tool) => ({
        name: tool.name,
        upstream: tool.upstream_name,
        class: tool.class,
        hidden: tool.flags.hidden,
      })),
    ).toEqual([
      { name: "petstore_listpets", upstream: "listPets", class: "read", hidden: false },
      { name: "petstore_createpet", upstream: "createPet", class: "write", hidden: false },
      { name: "petstore_showpetbyid", upstream: "showPetById", class: "read", hidden: false },
      {
        name: "petstore_delete__pets__petid_",
        upstream: "DELETE /pets/{petId}",
        class: "write",
        hidden: false,
      },
      { name: "petstore_updatepet", upstream: "updatePet", class: "write", hidden: true },
    ]);
    expect(tools[4]?.flags.deprecated).toBe(true);
    expect(tools[0]).toMatchObject({
      description: "List pets\n\nEvery pet in the store.",
      input_schema: { type: "object", properties: { limit: { type: "integer" } } },
    });
  });

  it("names and classes a 3.1 document's tools: HEAD reads, and an override's class wins", async () => {
    const docs = fakeHttpServer(origin(), () => new Response(widgets));
    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/openapi.json`, name: "widgets" }),
    );

    expect(toolkit.tool_list).toMatchObject({ tools: 8 });
    expect(toolkit.tool_list.error).toBeUndefined();

    const summary = async () =>
      (await toolsOf(stub, toolkit.id)).map((tool) => ({
        name: tool.name,
        upstream: tool.upstream_name,
        class: tool.class,
        hidden: tool.flags.hidden,
      }));

    expect(await summary()).toEqual([
      { name: "widgets_listwidgets", upstream: "listWidgets", class: "read", hidden: false },
      { name: "widgets_createwidget", upstream: "createWidget", class: "write", hidden: false },
      { name: "widgets_getwidget", upstream: "getWidget", class: "read", hidden: false },
      { name: "widgets_replacewidget", upstream: "replaceWidget", class: "write", hidden: false },
      { name: "widgets_archivewidget", upstream: "archiveWidget", class: "write", hidden: false },
      {
        name: "widgets_get__widgets__id__history",
        upstream: "GET /widgets/{id}/history",
        class: "read",
        hidden: false,
      },
      { name: "widgets_legacydelete", upstream: "legacyDelete", class: "write", hidden: true },
      { name: "widgets_status", upstream: "status", class: "read", hidden: false },
    ]);

    // A POST that only reads (a search, say) is classed read by an override.
    await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "archiveWidget", class: "read" }, "test");

    expect((await summary()).find((tool) => tool.upstream === "archiveWidget")?.class).toBe("read");
  });

  it("hides a deprecated operation until an override shows it", async () => {
    const docs = fakeHttpServer(origin(), () => new Response(petstore));
    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/openapi.yaml`, name: "petstore" }),
    );

    const served = async () =>
      (await stub.tools().servedTools({ member: undefined, admin: false })).map(
        (tool) => tool.name,
      );

    expect(await served()).not.toContain("petstore_updatepet");

    const shown = await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "updatePet", hidden: false }, "test");

    expect(shown).toMatchObject({
      ok: true,
      value: { flags: { hidden: false, deprecated: true } },
    });
    expect(await served()).toContain("petstore_updatepet");

    // `hidden: false` on a tool its source does not hide sets nothing: the override is cleared.
    const cleared = await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "listPets", hidden: false }, "test");

    expect(cleared).toMatchObject({ ok: true });
    expect(cleared.ok && "override" in cleared.value).toBe(false);
  });

  it("calls the base URL with the shared credential where the document's scheme puts it, and passes error statuses", async () => {
    const docs = fakeHttpServer(origin(), () => new Response(petstore));

    const api = fakeHttpServer(origin(), (request) =>
      request.url.pathname === "/v1/pets/3"
        ? Response.json({ id: 3, name: "Rex" })
        : new Response("no such pet", { status: 404 }),
    );

    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({
        source: `${docs.origin}/openapi.yaml`,
        name: "petstore",
        baseUrl: `${api.origin}/v1`,
        credential: { kind: "bearer", token: "pet-key", subject: EVERYONE },
      }),
    );

    expect(toolkit.base_url).toBe(`${api.origin}/v1`);

    const found = await stub
      .tools()
      .callTool(ALICE, { name: "petstore_showpetbyid", arguments: { petId: 3 } }, POLICY);

    expect(found).toMatchObject({
      outcome: "result",
      result: { content: [{ type: "text", text: '{\n  "id": 3,\n  "name": "Rex"\n}' }] },
      usage: { toolId: `${toolkit.id}:showPetById`, credential: "shared" },
    });
    expect(api.requests[0]?.headers.get("x-api-key")).toBe("pet-key");
    expect(api.requests[0]?.headers.get("authorization")).toBeNull();

    const missing = await stub
      .tools()
      .callTool(ALICE, { name: "petstore_showpetbyid", arguments: { petId: 9 } }, POLICY);

    expect(missing).toMatchObject({
      outcome: "result",
      result: { content: [{ type: "text", text: "HTTP 404\n\nno such pet" }], isError: true },
    });

    // A required argument left out fails the call before anything is sent.
    const before = api.requests.length;

    expect(
      await stub.tools().callTool(ALICE, { name: "petstore_showpetbyid", arguments: {} }, POLICY),
    ).toMatchObject({ outcome: "failed", message: "the argument petId is required" });
    expect(api.requests.length).toBe(before);
  });

  it("picks up an added and a removed operation on refresh, with the rules for renames and vanished tools", async () => {
    const api = origin();
    let operations = ["alpha", "beta"];
    const docs = fakeHttpServer(origin(), () => new Response(documentOf(api, operations)));
    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/openapi.json`, name: "ops" }),
    );

    await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "alpha", description: "Old" }, "test");
    await stub.tools().setOverride(ADMIN, toolkit.id, 0, { tool: "beta", name: "gamma" }, "test");

    operations = ["beta", "gamma"];

    const refreshed = await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY);

    expect(refreshed.ok).toBe(true);

    expect(
      (await toolsOf(stub, toolkit.id)).map((tool) => ({
        upstream: tool.upstream_name,
        name: tool.name,
        clash: tool.flags.clash,
        missing: tool.flags.missing,
      })),
    ).toEqual([
      // The admin's rename keeps its name against the operation the refresh brought.
      { upstream: "beta", name: "ops_gamma", clash: false, missing: false },
      { upstream: "gamma", name: "ops_gamma", clash: true, missing: false },
      { upstream: "alpha", name: "ops_alpha", clash: false, missing: true },
    ]);

    // The cron task fetches the document again too.
    operations = ["beta"];
    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 1,
      failed: 0,
      skipped: 0,
    });
    expect((await toolsOf(stub, toolkit.id)).map((tool) => tool.upstream_name)).toEqual([
      "beta",
      "alpha",
    ]);
  });
});

describe("the outbound guard", () => {
  it("refuses a document at a private address, and keeps the toolkit with the reason", async () => {
    const stub = plane();

    const toolkit = await add(
      stub,
      openApiToolkit({ source: "https://10.0.0.1/openapi.json", name: "internal" }),
    );

    expect(toolkit.tool_list).toEqual({ error: OUTBOUND_REFUSED_MESSAGE, tools: 0 });
  });

  it("refuses a call to an http: or private server the document names, and says so on the tool list", async () => {
    const stub = plane();

    for (const [server, name] of [
      ["http://plain.example.com", "plain"],
      ["https://192.168.1.10", "private"],
    ] as const) {
      const toolkit = await add(
        stub,
        openApiToolkit({ document: documentOf(server, ["ping"]), name }),
      );

      expect(toolkit.tool_list).toMatchObject({
        tools: 1,
        error: "1 operation names no server Commissary may reach: set the toolkit's base URL",
      });
      expect(
        await stub.tools().callTool(ALICE, { name: `${name}_ping`, arguments: {} }, POLICY),
      ).toMatchObject({ outcome: "failed", message: OUTBOUND_REFUSED_MESSAGE });
    }
  });

  it("clears the servers' warning when the toolkit gets a base URL, and brings it back when it loses it", async () => {
    const stub = plane();
    const api = fakeHttpServer(origin(), () => Response.json({ pong: true }));

    const toolkit = await add(
      stub,
      openApiToolkit({ document: documentOf("http://plain.example.com", ["ping"]), name: "plain" }),
    );

    const warning = "1 operation names no server Commissary may reach: set the toolkit's base URL";

    expect(toolkit.tool_list.error).toBe(warning);

    const based = await stub
      .tools()
      .updateToolkit(ADMIN, toolkit.id, toolkit.revision, { base_url: api.origin }, "test", POLICY);

    expect(based).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });
    expect(based.ok && based.value.tool_list.error).toBeUndefined();
    expect(
      await stub.tools().callTool(ALICE, { name: "plain_ping", arguments: {} }, POLICY),
    ).toMatchObject({ outcome: "result" });

    const unbased = await stub
      .tools()
      .updateToolkit(ADMIN, toolkit.id, toolkit.revision + 1, { base_url: null }, "test", POLICY);

    expect(unbased).toMatchObject({ ok: true, value: { tool_list: { tools: 1, error: warning } } });
  });
});

describe("an uploaded document", () => {
  it("of several MB is stored in chunks, served back whole, and rebuilt only when it is replaced", async () => {
    const api = origin();
    // 1,500 operations with long descriptions: about 6 MB, three times SQLite's limit on one value.
    const large = largeJson(api, 1500);

    expect(large.length).toBeGreaterThan(5_000_000);

    const stub = plane();
    const toolkit = await add(stub, openApiToolkit({ document: large }));

    expect(toolkit).toMatchObject({ uploaded: true, source: "", tool_list: { tools: 1500 } });
    // Named after its document's server (`api-….example.com`).
    expect(toolkit.name).toBe("example");

    const chunks = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ chunks: number }>(
          `SELECT COUNT(*) AS chunks FROM toolkit_documents WHERE toolkit_id = ?`,
          toolkit.id,
        )
        .one(),
    );

    expect(chunks.chunks).toBeGreaterThan(4);
    expect(await stub.tools().toolkitDocument(ADMIN, toolkit.id)).toEqual({
      ok: true,
      value: { document: large },
    });
    // A member who only reads the toolkit sees its tools, not its document.
    expect(await stub.tools().toolkitDocument(ALICE, toolkit.id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });

    // The cron task leaves an uploaded document alone.
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
        documentOf(api, ["one"]),
        "test",
        POLICY,
      );

    expect(replaced).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });
    expect(await stub.tools().toolkitDocument(ADMIN, toolkit.id)).toEqual({
      ok: true,
      value: { document: documentOf(api, ["one"]) },
    });

    // A document that cannot be read replaces nothing.
    expect(
      await stub
        .tools()
        .replaceDocument(ADMIN, toolkit.id, toolkit.revision + 1, "{ nope", "test", POLICY),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect((await toolsOf(stub, toolkit.id)).map((tool) => tool.upstream_name)).toEqual(["one"]);
  });
});

describe("documents of several MB", () => {
  it("builds from a fetched JSON document of about 6 MB, and refuses one above the limit", async () => {
    const api = origin();
    const large = largeJson(api, 1500);

    expect(large.length).toBeGreaterThan(5_000_000);

    const docs = fakeHttpServer(origin(), (request) =>
      request.url.pathname === "/large.json"
        ? new Response(large)
        : new Response(largeJson(api, 2200), { headers: { "content-type": "application/json" } }),
    );

    const stub = plane();

    const built = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/large.json`, name: "big" }),
    );

    expect(built.tool_list).toMatchObject({ tools: 1500 });
    expect(built.tool_list.error).toBeUndefined();

    // About 9 MB: kept with the reason, as a document that cannot be fetched is.
    const tooLarge = await add(
      stub,
      openApiToolkit({ source: `${docs.origin}/larger.json`, name: "bigger" }),
    );

    expect(tooLarge.tool_list).toEqual({
      tools: 0,
      error: `the document is larger than ${MAX_DOCUMENT_BYTES} bytes`,
    });
  });

  it("builds from an uploaded YAML document of about 3.5 MB, and refuses one above the YAML limit", async () => {
    const api = origin();
    const yaml = largeYaml(api, 900);

    expect(yaml.length).toBeGreaterThan(3_500_000);
    expect(yaml.length).toBeLessThan(MAX_YAML_DOCUMENT_BYTES);

    const stub = plane();
    const built = await add(stub, openApiToolkit({ document: yaml, name: "yaml" }));

    expect(built.tool_list).toMatchObject({ tools: 900 });
    expect(built.tool_list.error).toBeUndefined();

    // Within the JSON limit, the same document in YAML is refused, and the toolkit kept with the reason.
    const larger = largeYaml(api, 1200);

    expect(larger.length).toBeGreaterThan(MAX_YAML_DOCUMENT_BYTES);

    const refused = await add(stub, openApiToolkit({ document: larger, name: "larger" }));

    expect(refused.tool_list).toEqual({
      tools: 0,
      error: `the YAML document is larger than ${MAX_YAML_DOCUMENT_BYTES} bytes: upload it as JSON instead`,
    });
  });
});
