// Discovery toolkits in the Tools part of the ControlPlane (#205) over RPC, against fake HTTP servers served in
// workerd: a toolkit built from a trimmed Gmail Discovery document's URL (its default name, its tools' full names with
// a long one shortened, their classes, the OAuth 2 scopes it reports), a call with an API key and one with an OAuth
// bearer token, a refresh and the cron task fetching the document again; an uploaded document replaced, no base URL, a
// deprecated method hidden, a sign-in through an OAuth app without scopes asking for the toolkit's; and the outbound
// guard on the document's rootUrl, which refuses the save.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import gmail from "./fixtures/discovery/gmail-v1.json?raw";
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

const discoveryToolkit = (extra: Partial<AddToolkitInput>): AddToolkitInput => ({
  kind: "discovery",
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

/** The Gmail fixture with its calls made under `rootUrl`. */
const gmailAt = (rootUrl: string) => JSON.stringify({ ...JSON.parse(gmail), rootUrl });

describe("a Discovery toolkit from a document's URL", () => {
  it("names each method's tool after its id, shortens a long one, classes GET read, and reports the scopes", async () => {
    const docs = fakeHttpServer(origin(), () => Response.json(JSON.parse(gmail)));
    const stub = plane();

    const toolkit = await add(stub, discoveryToolkit({ source: `${docs.origin}/rest?version=v1` }));

    // Named after the API (`gmail`), not the document's host.
    expect(toolkit).toMatchObject({ kind: "discovery", name: "gmail", tool_list: { tools: 9 } });
    expect(toolkit.tool_list.error).toBeUndefined();
    expect(toolkit.uploaded).toBeUndefined();
    expect(docs.requests.map((request) => request.headers.get("authorization"))).toEqual([null]);

    expect(
      (await toolsOf(stub, toolkit.id)).map((tool) => ({
        name: tool.name,
        upstream: tool.upstream_name,
        class: tool.class,
        shortened: tool.flags.shortened,
      })),
    ).toEqual(
      [
        ["gmail_gmail_users_getprofile", "gmail.users.getProfile", "read"],
        ["gmail_gmail_users_messages_list", "gmail.users.messages.list", "read"],
        ["gmail_gmail_users_messages_get", "gmail.users.messages.get", "read"],
        ["gmail_gmail_users_messages_send", "gmail.users.messages.send", "write"],
        ["gmail_gmail_users_messages_delete", "gmail.users.messages.delete", "write"],
        [
          "gmail_gmail_users_messages_attachments_get",
          "gmail.users.messages.attachments.get",
          "read",
        ],
        ["gmail_gmail_users_labels_list", "gmail.users.labels.list", "read"],
        ["gmail_gmail_users_labels_create", "gmail.users.labels.create", "write"],
        [
          "gmail_gmail_users_settings_forwardingaddr_fe1d",
          "gmail.users.settings.forwardingAddresses.create",
          "write",
        ],
      ].map(([name, upstream, toolClass]) => ({
        name,
        upstream,
        class: toolClass,
        shortened: name === "gmail_gmail_users_settings_forwardingaddr_fe1d",
      })),
    );

    expect(toolkit.scopes).toEqual([
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
      "https://www.googleapis.com/auth/gmail.addons.current.message.action",
      "https://www.googleapis.com/auth/gmail.addons.current.message.metadata",
      "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.settings.sharing",
    ]);
  });

  it("calls the method's URL under rootUrl with an API key in key, or an OAuth bearer token", async () => {
    const api = fakeHttpServer(origin(), () => Response.json({ messages: [{ id: "m1" }] }));
    const docs = fakeHttpServer(origin(), () => new Response(gmailAt(`${api.origin}/`)));
    const stub = plane();

    const toolkit = await add(
      stub,
      discoveryToolkit({
        source: `${docs.origin}/rest`,
        credential: { kind: "query", name: "key", value: "api-key", subject: EVERYONE },
      }),
    );

    const listed = await stub
      .tools()
      .callTool(
        ALICE,
        { name: "gmail_gmail_users_messages_list", arguments: { userId: "me", maxResults: 5 } },
        POLICY,
      );

    expect(listed).toMatchObject({
      outcome: "result",
      result: {
        content: [
          { type: "text", text: '{\n  "messages": [\n    {\n      "id": "m1"\n    }\n  ]\n}' },
        ],
      },
      usage: { toolId: `${toolkit.id}:gmail.users.messages.list`, credential: "shared" },
    });
    expect(api.requests[0]?.url.toString()).toBe(
      `${api.origin}/gmail/v1/users/me/messages?maxResults=5&key=api-key`,
    );

    await stub
      .tools()
      .connectCredential(
        ADMIN,
        toolkit.id,
        "shared",
        { kind: "bearer", token: "ya29.token", subject: EVERYONE },
        "test",
        POLICY,
      );

    await stub.tools().callTool(
      ALICE,
      {
        name: "gmail_gmail_users_labels_create",
        arguments: { userId: "me", body: { name: "Receipts" } },
      },
      POLICY,
    );

    const created = api.requests[1];

    expect(created?.method).toBe("POST");
    expect(created?.url.toString()).toBe(`${api.origin}/gmail/v1/users/me/labels`);
    expect(created?.headers.get("authorization")).toBe("Bearer ya29.token");
    expect(JSON.parse(created?.body ?? "")).toEqual({ name: "Receipts" });
  });

  it("fetches its document again on refresh and from the cron task, rebuilding the list", async () => {
    let document = gmail;
    const docs = fakeHttpServer(origin(), () => new Response(document));
    const stub = plane();
    const toolkit = await add(stub, discoveryToolkit({ source: `${docs.origin}/rest` }));

    expect(toolkit.tool_list.tools).toBe(9);
    document = JSON.stringify({
      ...JSON.parse(gmail),
      resources: { users: { methods: JSON.parse(gmail).resources.users.methods } },
    });

    expect(await stub.tools().refreshToolList(ADMIN, toolkit.id, POLICY)).toMatchObject({
      ok: true,
      value: { tool_list: { tools: 1 } },
    });
    expect(docs.requests.length).toBe(2);

    document = gmail;

    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 1,
      failed: 0,
      skipped: 0,
    });
    expect(docs.requests.length).toBe(3);
    expect(await toolsOf(stub, toolkit.id)).toHaveLength(9);
  });
});

describe("an uploaded Discovery document", () => {
  it("builds the toolkit, and is replaced only by one Commissary can build from", async () => {
    const stub = plane();
    const toolkit = await add(stub, discoveryToolkit({ document: gmail }));

    expect(toolkit).toMatchObject({ uploaded: true, source: "", name: "gmail" });
    expect(toolkit.tool_list.tools).toBe(9);

    // The cron task leaves an uploaded document alone: it has nothing to fetch.
    expect(await stub.tools().refreshToolLists(POLICY)).toEqual({
      built: 0,
      failed: 0,
      skipped: 1,
    });

    const trimmed = JSON.stringify({
      ...JSON.parse(gmail),
      resources: { users: { methods: JSON.parse(gmail).resources.users.methods } },
    });

    expect(
      await stub
        .tools()
        .replaceDocument(ADMIN, toolkit.id, toolkit.revision, trimmed, "test", POLICY),
    ).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });

    expect(
      await stub
        .tools()
        .replaceDocument(
          ADMIN,
          toolkit.id,
          toolkit.revision + 1,
          gmailAt("https://10.0.0.1/"),
          "test",
          POLICY,
        ),
    ).toEqual({
      ok: false,
      error: "outbound_refused",
      message: OUTBOUND_REFUSED_MESSAGE,
      path: "rootUrl",
    });
    expect((await toolsOf(stub, toolkit.id)).map((tool) => tool.upstream_name)).toEqual([
      "gmail.users.getProfile",
    ]);
  });

  it("takes no base URL, and hides a deprecated method until an override shows it", async () => {
    const stub = plane();

    const deprecated = JSON.parse(gmail);

    deprecated.resources.users.methods.getProfile.deprecated = true;

    const toolkit = await add(
      stub,
      discoveryToolkit({ document: JSON.stringify(deprecated), name: "gmail" }),
    );

    expect(
      await stub
        .tools()
        .updateToolkit(
          ADMIN,
          toolkit.id,
          toolkit.revision,
          { base_url: "https://gmail.example.com" },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid" });

    const profile = (await toolsOf(stub, toolkit.id)).find(
      (tool) => tool.upstream_name === "gmail.users.getProfile",
    );

    expect(profile?.flags).toMatchObject({ hidden: true, deprecated: true });

    const served = async () =>
      (await stub.tools().servedTools({ member: undefined, admin: false })).map(
        (tool) => tool.name,
      );

    expect(await served()).not.toContain("gmail_gmail_users_getprofile");

    await stub
      .tools()
      .setOverride(ADMIN, toolkit.id, 0, { tool: "gmail.users.getProfile", hidden: false }, "test");

    expect(await served()).toContain("gmail_gmail_users_getprofile");
  });

  it("signs in through an OAuth app that sets no scopes asking for the scopes its methods name", async () => {
    const stub = plane();
    const document = JSON.parse(gmail);

    document.resources = { users: { methods: document.resources.users.methods } };

    const toolkit = await add(stub, discoveryToolkit({ document: JSON.stringify(document) }));

    // users.getProfile's.
    expect(toolkit.scopes).toEqual([
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);

    const app = {
      client_id: "google-app",
      client_secret: "google-secret",
      authorize_url: "https://accounts.example.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.example.com/token",
    };

    const scopeOf = async () => {
      const started = await stub
        .tools()
        .startSignIn(ADMIN, toolkit.id, "shared", { subject: EVERYONE }, "test", POLICY, {
          callback: "https://app.example.com/oauth/toolkits/callback",
          clientId: undefined,
        });

      if (!started.ok) throw new Error(`sign-in failed: ${started.message}`);

      return new URL(started.value.url).searchParams.get("scope");
    };

    expect((await stub.tools().setOAuthApp(ADMIN, toolkit.id, app, "test")).ok).toBe(true);
    expect(await scopeOf()).toBe(toolkit.scopes?.join(" "));

    // An app's own scopes win.
    await stub
      .tools()
      .setOAuthApp(
        ADMIN,
        toolkit.id,
        { ...app, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
        "test",
      );

    expect(await scopeOf()).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("the outbound guard", () => {
  it("refuses to save a document whose rootUrl it refuses, fetched or uploaded", async () => {
    const stub = plane();

    for (const rootUrl of ["http://gmail.example.com/", "https://192.168.1.10/"]) {
      const docs = fakeHttpServer(origin(), () => new Response(gmailAt(rootUrl)));

      for (const input of [
        discoveryToolkit({ source: `${docs.origin}/rest`, name: "fetched" }),
        discoveryToolkit({ document: gmailAt(rootUrl), name: "uploaded" }),
      ])
        expect(await stub.tools().addToolkit(ADMIN, input, "test", POLICY)).toEqual({
          ok: false,
          error: "outbound_refused",
          message: OUTBOUND_REFUSED_MESSAGE,
          path: "rootUrl",
        });
    }

    expect((await stub.tools().listToolkits(ADMIN)).toolkits).toEqual([]);
  });
});
