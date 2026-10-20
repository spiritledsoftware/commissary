// Connecting a toolkit's credentials (src/lib/toolkit-credentials.ts, #208, ADR 0036, ADR 0038): which ways to sign in a
// slot offers, the forms of every credential type, the bodies they send, and who may use a shared credential.
import { describe, expect, it } from "vitest";
import type { GrantSubject, ToolGrant } from "@commissary/contract/grants";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  connectBody,
  connectedText,
  credentialFields,
  defaultSubject,
  defaultWay,
  grantNote,
  missingSettings,
  pickedSubject,
  settingsPatch,
  settingsValuesOf,
  signInBody,
  waysFor,
  withoutSecrets,
  withSettings,
} from "../src/lib/toolkit-credentials.ts";

const toolkit = (patch: Partial<ToolkitView> = {}): ToolkitView => ({
  id: "tk_1",
  kind: "mcp",
  name: "linear",
  source: "https://mcp.linear.app/mcp",
  private: false,
  accepts: "both",
  revision: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by: "user:admin@example.com",
  credentials: {},
  tool_list: { tools: 0 },
  ...patch,
});

describe("the ways to sign in", () => {
  it("offer every credential type the API takes, and a client credentials grant for the shared one only", () => {
    expect(waysFor(toolkit(), "shared")).toEqual([
      "oauth",
      "none",
      "bearer",
      "header",
      "query",
      "basic",
      "client_credentials",
      "oauth1",
      "tba",
      "jwt",
      "app",
      "token_exchange",
      "aws_sigv4",
      "compound",
    ]);
    expect(waysFor(toolkit(), "private")).not.toContain("client_credentials");
  });

  it("offer the OAuth sign-in on an MCP server, or where the toolkit has an OAuth app", () => {
    const openapi = toolkit({ kind: "openapi" });

    expect(waysFor(openapi, "shared")).not.toContain("oauth");
    expect(waysFor({ ...openapi, managed_oauth_app: true }, "shared")).toContain("oauth");
    expect(
      waysFor(
        {
          ...openapi,
          oauth_app: {
            client_id: "c",
            client_secret: true,
            authorize_url: "https://example.com/authorize",
            token_url: "https://example.com/token",
            scopes: [],
            updated_at: "2026-08-01T00:00:00.000Z",
            updated_by: "user:admin@example.com",
          },
        },
        "shared",
      ),
    ).toContain("oauth");
  });

  it("start from the credential being replaced, else the catalog's way, else the sign-in", () => {
    const connected = {
      kind: "bearer" as const,
      connected_at: "2026-08-01T00:00:00.000Z",
      connected_by: "user:admin@example.com",
      active: true,
    };

    expect(defaultWay(toolkit({ credentials: { shared: connected } }), "shared")).toBe("bearer");
    expect(defaultWay(toolkit({ credentials: { shared: connected } }), "private")).toBe("oauth");
    expect(
      defaultWay(
        toolkit({
          catalog: {
            service: "linear",
            source: "mcp",
            credential: { kind: "header", name: "X-Api-Key" },
          },
        }),
        "private",
      ),
    ).toBe("header");
    expect(defaultWay(toolkit({ kind: "openapi" }), "shared")).toBe("bearer");
  });
});

const EVERYONE = { kind: "everyone" } as const;

describe("the forms of the credential types", () => {
  it("send what each type is, trimmed where it names something and as typed where it is secret", () => {
    expect(connectBody("bearer", { token: " t0ken " }, toolkit(), undefined)).toEqual({
      ok: true,
      body: { kind: "bearer", token: " t0ken " },
    });
    expect(
      connectBody("basic", { username: " ann ", password: "pw" }, toolkit(), undefined),
    ).toEqual({ ok: true, body: { kind: "basic", username: "ann", password: "pw" } });
    expect(connectBody("none", {}, toolkit(), EVERYONE)).toEqual({
      ok: true,
      body: { kind: "none", subject: EVERYONE },
    });
  });

  it("leave optional fields out when they are empty, and name what a required one lacks", () => {
    expect(
      connectBody(
        "client_credentials",
        { client_id: "id", client_secret: "s", token_url: "", scope: " " },
        toolkit(),
        EVERYONE,
      ),
    ).toEqual({
      ok: true,
      body: { kind: "client_credentials", client_id: "id", client_secret: "s", subject: EVERYONE },
    });
    expect(connectBody("aws_sigv4", { access_key_id: "AKIA" }, toolkit(), undefined)).toEqual({
      ok: false,
      problems: { secret_access_key: "Enter the secret access key." },
    });
  });

  it("let a key leave out its header where the catalog source names it", () => {
    const fromCatalog = toolkit({
      catalog: {
        service: "linear",
        source: "mcp",
        credential: { kind: "header", name: "Authorization", prefix: "Bearer" },
      },
    });

    expect(credentialFields("header", fromCatalog).find((f) => f.key === "name")).toMatchObject({
      optional: true,
      hint: "Leave it empty to send the key in Authorization, after Bearer, as the catalog says.",
    });
    expect(connectBody("header", { name: "", value: "k" }, fromCatalog, undefined)).toEqual({
      ok: true,
      body: { kind: "header", value: "k" },
    });
    expect(connectBody("header", { name: "", value: "k" }, toolkit(), undefined)).toEqual({
      ok: false,
      problems: { name: "Enter the header the key goes in." },
    });
  });

  it("ask for a compound credential's fields by the names its template uses", () => {
    const compound = toolkit({
      credential_settings: {
        compound: {
          headers: { "DD-API-KEY": "{api_key}", "DD-APPLICATION-KEY": "{app_key}" },
          base_url: "https://{site}.example.com/api",
        },
      },
    });

    expect(credentialFields("compound", compound).map((field) => field.key)).toEqual([
      "fields.api_key",
      "fields.app_key",
      "fields.site",
    ]);
    expect(
      connectBody(
        "compound",
        { "fields.api_key": "a", "fields.app_key": "b", "fields.site": "eu1" },
        compound,
        undefined,
      ),
    ).toEqual({
      ok: true,
      body: { kind: "compound", fields: { api_key: "a", app_key: "b", site: "eu1" } },
    });
  });
});

describe("the credential settings", () => {
  it("are needed before AWS keys, a JWT, NetSuite, a token exchange or a compound credential connect", () => {
    expect(missingSettings("aws_sigv4", toolkit())).toBe(true);
    expect(
      missingSettings(
        "aws_sigv4",
        toolkit({ credential_settings: { aws_sigv4: { region: "us-east-1", service: "s3" } } }),
      ),
    ).toBe(false);
    // OAuth 1.0a's and a GitHub App's settings are optional.
    expect(missingSettings("oauth1", toolkit())).toBe(false);
    expect(missingSettings("app", toolkit())).toBe(false);
    expect(missingSettings("bearer", toolkit())).toBe(false);
  });

  it("read back into the form, and replace only their type's entry of the toolkit's settings", () => {
    const settings = {
      aws_sigv4: { region: "us-east-1", service: "s3" },
      tba: { account_id: "1" },
    };

    expect(settingsValuesOf("aws_sigv4", settings)).toEqual({ region: "us-east-1", service: "s3" });

    const patch = settingsPatch("aws_sigv4", { region: " eu-west-1 ", service: "execute-api" });

    expect(patch).toEqual({
      ok: true,
      settings: { aws_sigv4: { region: "eu-west-1", service: "execute-api" } },
    });
    expect(patch.ok ? withSettings(settings, patch.settings) : undefined).toEqual({
      aws_sigv4: { region: "eu-west-1", service: "execute-api" },
      tba: { account_id: "1" },
    });
  });

  it("read a compound template's headers and query parameters one a line, and a JWT's numbers and claims", () => {
    expect(
      settingsPatch("compound", {
        headers: "DD-API-KEY: {api_key}\n\nDD-APPLICATION-KEY:{app_key}",
        query: "site={site}",
        base_url: "",
      }),
    ).toEqual({
      ok: true,
      settings: {
        compound: {
          headers: { "DD-API-KEY": "{api_key}", "DD-APPLICATION-KEY": "{app_key}" },
          query: { site: "{site}" },
        },
      },
    });
    expect(
      settingsPatch("compound", { headers: "no colon here", query: "", base_url: "" }),
    ).toEqual({
      ok: false,
      problems: { headers: "Write each header as Name: template, one a line." },
    });
    expect(
      settingsPatch("jwt", {
        algorithm: "RS256",
        token_url: "https://oauth2.googleapis.com/token",
        lifetime_seconds: "600",
        claims: '{"target_audience":"x"}',
      }),
    ).toEqual({
      ok: true,
      settings: {
        jwt: {
          algorithm: "RS256",
          token_url: "https://oauth2.googleapis.com/token",
          lifetime_seconds: 600,
          claims: { target_audience: "x" },
        },
      },
    });
    expect(
      settingsPatch("jwt", { algorithm: "RS256", lifetime_seconds: "5", claims: "[1]" }),
    ).toEqual({
      ok: false,
      problems: {
        lifetime_seconds: "A lifetime is a whole number of seconds from 120 to 3600.",
        claims: "Claims are a JSON object.",
      },
    });
  });
});

const grant = (subject: GrantSubject, toolkitId = "tk_1"): ToolGrant => ({
  id: `tg_${subject.kind}`,
  subject,
  toolkit: toolkitId,
  tools: { kind: "all" },
  revision: 1,
  updated_at: 0,
  updated_by: "user:admin@example.com",
});

describe("who may use a shared credential", () => {
  const shared = {
    kind: "bearer" as const,
    connected_at: "2026-08-01T00:00:00.000Z",
    connected_by: "user:admin@example.com",
    active: true,
  };

  it("defaults to everyone when a shared credential is first connected", () => {
    expect(defaultSubject(toolkit(), [grant({ kind: "team", id: "t1" })])).toEqual(EVERYONE);
  });

  it("is a subject already granted on the toolkit when its credential is replaced, so reach stays as it is", () => {
    const replacing = toolkit({ credentials: { shared } });

    expect(
      defaultSubject(replacing, [
        grant({ kind: "team", id: "t9" }, "tk_other"),
        grant({ kind: "member", id: "m1" }),
        grant({ kind: "team", id: "t1" }),
      ]),
    ).toEqual({ kind: "member", id: "m1" });
    // Everyone first, when it holds a grant.
    expect(
      defaultSubject(replacing, [grant({ kind: "member", id: "m1" }), grant(EVERYONE)]),
    ).toEqual(EVERYONE);
    // Replacing a credential nobody was granted: everyone, as for a first one.
    expect(defaultSubject(replacing, [])).toEqual(EVERYONE);
  });

  it("says whether connecting adds a grant or keeps the one the subject holds", () => {
    expect(grantNote(EVERYONE, "tk_1", [], "Everyone")).toBe(
      "Connecting gives Everyone every tool of this toolkit, with a new tool grant.",
    );
    expect(grantNote(EVERYONE, "tk_1", [grant(EVERYONE)], "Everyone")).toBe(
      "Everyone holds a tool grant on this toolkit already, which stays as it is.",
    );
    expect(connectedText({ id: "tg_1", created: true }, "Everyone")).toBe(
      "Connected. Everyone may use every tool of it, through a new tool grant.",
    );
    expect(connectedText({ id: "tg_1", created: false }, "ops")).toBe(
      "Connected. The tool grant ops holds on it stays as it is.",
    );
    expect(connectedText(undefined, undefined)).toBe("Connected.");
  });
});

describe("a signed JWT", () => {
  it("sends its sub claim beside the shared credential's subject, which no longer shadows it", () => {
    expect(connectBody("jwt", { private_key: "k", sub: " user-42 " }, toolkit(), EVERYONE)).toEqual(
      {
        ok: true,
        body: { kind: "jwt", private_key: "k", sub: "user-42", subject: EVERYONE },
      },
    );
  });

  it("shows its stored claims as JSON and its lifetime in figures", () => {
    expect(
      settingsValuesOf("jwt", {
        jwt: { algorithm: "ES256", lifetime_seconds: 900, claims: { tenant: "t1" } },
      }),
    ).toEqual({
      algorithm: "ES256",
      token_url: "",
      audience: "",
      scope: "",
      lifetime_seconds: "900",
      claims: '{\n  "tenant": "t1"\n}',
    });
  });
});

describe("a shared credential's sign-in and picker", () => {
  const shared = {
    kind: "oauth" as const,
    connected_at: "2026-08-01T00:00:00.000Z",
    connected_by: "user:admin@example.com",
    active: true,
  };

  it("starts a shared sign-in naming who may use it, and a private one naming nobody", () => {
    const team: GrantSubject = { kind: "team", id: "t1" };

    expect(signInBody("shared", team)).toEqual({ subject: team });
    expect(signInBody("private", team)).toEqual({});
  });

  it("follows the grants as they load until the admin picks, then keeps the pick", () => {
    const replacing = toolkit({ credentials: { shared } });
    const member: GrantSubject = { kind: "member", id: "m1" };
    const team: GrantSubject = { kind: "team", id: "t1" };

    // Before the grants load: everyone; once they do, the subject already granted.
    expect(pickedSubject(undefined, replacing, [])).toEqual(EVERYONE);
    expect(pickedSubject(undefined, replacing, [grant(member)])).toEqual(member);
    // A pick made before (or after) they load stays.
    expect(pickedSubject(team, replacing, [])).toEqual(team);
    expect(pickedSubject(team, replacing, [grant(member)])).toEqual(team);
  });
});

describe("a cancelled form", () => {
  it("keeps nothing secret that was typed", () => {
    expect(
      withoutSecrets(credentialFields("basic", toolkit()), { username: "ann", password: "pw" }),
    ).toEqual({ username: "ann" });
  });
});
