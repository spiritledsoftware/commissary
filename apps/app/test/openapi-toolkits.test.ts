// OpenAPI toolkits through the management API (#203): the app Worker's router, the Access gate and the real ControlPlane
// with the Tools part. A document's URL or a base URL the outbound guard refuses is refused on save; a document is
// uploaded, served back to an org admin only, replaced, and left out of the org's export; a base URL is set and cleared.
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { ToolkitsList, ToolkitView, ToolsList } from "@commissary/contract/tools";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Org {
  readonly slug: string;
  readonly admin: string;
  readonly member: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  auth: string,
  method = "GET",
  body?: Payload,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const init = body === undefined ? { method } : jsonInit(method, body);
  // The extra headers go beside the body's content type.
  const merged = new Headers(init.headers);

  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    headers: merged,
    auth,
  });
};

/** An org with an org admin and a plain member. */
const newOrg = async (): Promise<Org> => {
  const slug = `openapi-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }))).status,
  ).toBe(201);

  const person = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;

    expect((await send({ slug }, "/members", platform, "POST", { email, role })).status).toBe(201);

    return await token(email);
  };

  return { slug, admin: await person("admin", "admin"), member: await person("member", "member") };
};

/** A 3.1 document with one GET operation, `ping`, served from `server`. */
const documentOf = (server: string, operation = "ping") =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Ping API", version: "1" },
    servers: [{ url: server }],
    paths: { [`/${operation}`]: { get: { operationId: operation } } },
  });

const REFUSED = [
  "http://api.example.com/openapi.json",
  "https://10.0.0.5/openapi.json",
  "https://[fd00::1]/openapi.json",
  "https://169.254.169.254/latest",
];

const toolkitsOf = async (org: Org) =>
  Schema.decodeUnknownSync(ToolkitsList)((await send(org, "/toolkits", org.admin)).body).toolkits;

describe("an OpenAPI toolkit", () => {
  it("is refused on save when the outbound guard refuses its document's URL or its base URL", async () => {
    const org = await newOrg();

    for (const url of REFUSED) {
      expect(
        await send(org, "/toolkits", org.admin, "POST", {
          kind: "openapi",
          source: url,
          name: "nope",
        }),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" } });

      expect(
        await send(org, "/toolkits", org.admin, "POST", {
          kind: "openapi",
          document: documentOf("https://api.example.com"),
          base_url: url,
          name: "nope",
        }),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "base_url" } });
    }

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("takes either a document's URL or the document, and an MCP toolkit neither a document nor a base URL", async () => {
    const org = await newOrg();

    for (const body of [
      { kind: "openapi", name: "neither" },
      {
        kind: "openapi",
        source: "https://api.example.com/openapi.json",
        document: documentOf("https://api.example.com"),
      },
      { source: "https://mcp.example.com/mcp", document: documentOf("https://api.example.com") },
      { source: "https://mcp.example.com/mcp", base_url: "https://api.example.com" },
    ])
      expect(await send(org, "/toolkits", org.admin, "POST", body)).toMatchObject({
        status: 422,
        body: { error: "invalid" },
      });

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("is built from an uploaded document, which an org admin reads back and replaces, and the export leaves out", async () => {
    const org = await newOrg();

    const added = await send(org, "/toolkits", org.admin, "POST", {
      kind: "openapi",
      document: documentOf("https://api.example.com"),
    });

    expect(added.status).toBe(201);
    const toolkit = Schema.decodeUnknownSync(ToolkitView)(added.body);

    // Named after the document's server.
    expect(toolkit).toMatchObject({
      kind: "openapi",
      name: "example",
      source: "",
      uploaded: true,
      tool_list: { tools: 1 },
    });

    expect(await send(org, `/toolkits/${toolkit.id}/document`, org.admin)).toMatchObject({
      status: 200,
      body: { document: documentOf("https://api.example.com") },
    });
    // A member who reads the toolkit sees its tools, not its document.
    expect(await send(org, `/toolkits/${toolkit.id}/document`, org.member)).toMatchObject({
      status: 403,
      body: { error: "forbidden" },
    });

    const revision = { "if-match": String(toolkit.revision) };

    expect(
      (
        await send(
          org,
          `/toolkits/${toolkit.id}/document`,
          org.member,
          "PUT",
          { document: documentOf("https://api.example.com", "pong") },
          revision,
        )
      ).status,
    ).toBe(403);

    const replaced = await send(
      org,
      `/toolkits/${toolkit.id}/document`,
      org.admin,
      "PUT",
      { document: documentOf("https://api.example.com", "pong") },
      revision,
    );

    expect(replaced.status).toBe(200);

    const tools = Schema.decodeUnknownSync(ToolsList)(
      (await send(org, `/toolkits/${toolkit.id}/tools`, org.admin)).body,
    );

    expect(tools.tools.map((tool) => [tool.name, tool.class])).toEqual([["example_pong", "read"]]);

    // The export says the toolkit is built from an uploaded document, without the document.
    const exported = await send(org, "/export", org.admin);

    expect(exported).toMatchObject({
      status: 200,
      body: { toolkits: [{ name: "example", source: "", uploaded: true }] },
    });
    expect(JSON.stringify(exported.body)).not.toContain("Ping API");
  });

  it("takes a base URL the guard allows, refuses one it does not, and clears it", async () => {
    const org = await newOrg();

    const toolkit = Schema.decodeUnknownSync(ToolkitView)(
      (
        await send(org, "/toolkits", org.admin, "POST", {
          kind: "openapi",
          document: documentOf("https://api.example.com"),
          name: "ping",
        })
      ).body,
    );

    const patch = (base_url: string | null, revision: number) =>
      send(
        org,
        `/toolkits/${toolkit.id}`,
        org.admin,
        "PATCH",
        { base_url },
        {
          "if-match": String(revision),
        },
      );

    expect(await patch("https://10.1.2.3/v1", toolkit.revision)).toMatchObject({
      status: 422,
      body: { error: OUTBOUND_REFUSED_MESSAGE, path: "base_url" },
    });

    const set = await patch("https://staging.example.com/v1", toolkit.revision);

    expect(set).toMatchObject({
      status: 200,
      body: { base_url: "https://staging.example.com/v1" },
    });

    const cleared = Schema.decodeUnknownSync(ToolkitView)(
      (await patch(null, toolkit.revision + 1)).body,
    );

    expect(cleared.base_url).toBeUndefined();
  });
});
