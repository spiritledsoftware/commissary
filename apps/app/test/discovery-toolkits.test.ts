// Discovery toolkits through the management API (#205): the app Worker's router, the Access gate and the real
// ControlPlane with the Tools part. A Discovery document's URL, or a rootUrl in it, that the outbound guard refuses is
// refused on save; a toolkit takes its document's URL or the document, and no base URL; an uploaded document builds the
// toolkit, which reports the OAuth 2 scopes its methods name.
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { ToolkitsList, ToolkitView } from "@commissary/contract/tools";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

type Payload = Parameters<typeof jsonInit>[1];

interface Org {
  readonly slug: string;
  readonly admin: string;
}

const send = async (
  org: Pick<Org, "slug">,
  path: string,
  auth: string,
  method = "GET",
  body?: Payload,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

/** An org with an org admin. */
const newOrg = async (): Promise<Org> => {
  const slug = `discovery-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  expect(
    (await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }))).status,
  ).toBe(201);

  const email = `admin-${slug}@example.com`;

  expect(
    (await send({ slug }, "/members", platform, "POST", { email, role: "admin" })).status,
  ).toBe(201);

  return { slug, admin: await token(email) };
};

/** A Discovery document of one method, `example.things.list`, whose calls go under `rootUrl`. */
const documentOf = (rootUrl: string) =>
  JSON.stringify({
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    name: "example",
    rootUrl,
    servicePath: "v1/",
    resources: {
      things: {
        methods: {
          list: {
            id: "example.things.list",
            httpMethod: "GET",
            path: "things",
            scopes: [
              "https://www.googleapis.com/auth/example.readonly",
              "https://www.googleapis.com/auth/example",
            ],
          },
        },
      },
    },
  });

const REFUSED = [
  "http://example.googleapis.com/",
  "https://10.0.0.5/",
  "https://[fd00::1]/",
  "https://169.254.169.254/",
];

/** The org's own toolkits: every deployment also lists its built-in toolkits. */
const toolkitsOf = async (org: Org) =>
  Schema.decodeUnknownSync(ToolkitsList)(
    (await send(org, "/toolkits", org.admin)).body,
  ).toolkits.filter((toolkit) => toolkit.built_in !== true);

describe("a Discovery toolkit", () => {
  it("is refused on save when the outbound guard refuses its document's URL or the rootUrl in it", async () => {
    const org = await newOrg();

    for (const url of REFUSED) {
      expect(
        await send(org, "/toolkits", org.admin, "POST", {
          kind: "discovery",
          source: `${url}$discovery/rest?version=v1`,
        }),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "source" } });

      expect(
        await send(org, "/toolkits", org.admin, "POST", {
          kind: "discovery",
          document: documentOf(url),
        }),
      ).toMatchObject({ status: 422, body: { error: OUTBOUND_REFUSED_MESSAGE, path: "rootUrl" } });
    }

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("takes either its document's URL or the document, and no base URL", async () => {
    const org = await newOrg();
    const document = documentOf("https://example.googleapis.com/");

    for (const [body, path] of [
      [{ kind: "discovery" }, "source"],
      [{ kind: "discovery", source: "https://example.googleapis.com/rest", document }, "source"],
      [{ kind: "discovery", document, base_url: "https://api.example.com" }, "base_url"],
    ] as const)
      expect(await send(org, "/toolkits", org.admin, "POST", body)).toMatchObject({
        status: 422,
        body: { error: "invalid", path },
      });

    expect(await toolkitsOf(org)).toEqual([]);
  });

  it("is built from an uploaded document, named after its API, and reports the scopes its methods name", async () => {
    const org = await newOrg();

    const added = await send(org, "/toolkits", org.admin, "POST", {
      kind: "discovery",
      document: documentOf("https://example.googleapis.com/"),
    });

    expect(added.status).toBe(201);

    expect(Schema.decodeUnknownSync(ToolkitView)(added.body)).toMatchObject({
      kind: "discovery",
      name: "example",
      source: "",
      uploaded: true,
      tool_list: { tools: 1 },
      scopes: [
        "https://www.googleapis.com/auth/example",
        "https://www.googleapis.com/auth/example.readonly",
      ],
    });
  });
});
