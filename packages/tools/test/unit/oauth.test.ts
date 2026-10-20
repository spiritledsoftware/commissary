// The pure parts of toolkits' OAuth 2 sign-ins (#202): where Commissary lives as a client (its callback, and its CIMD
// document's URL where an authorization server can fetch it), the `Bearer` challenge's auth-params (RFC 6750 §3), the
// order of the well-known URIs discovery tries (RFC 8414 §3.1, RFC 9728 §3.1, the MCP spec's order), which resource
// a server's metadata may name (RFC 8707, RFC 9728 §3.3), and when a credential's token gets its refresh.
import { describe, expect, it } from "vitest";
import {
  bearerChallenge,
  namesSource,
  resourceMetadataUrls,
  serverMetadataUrls,
} from "../../src/oauth/discovery.ts";
import { signInCallbackOrg, signInUrls } from "../../src/oauth/urls.ts";
import type { OAuthSecret } from "../../src/toolkits/secret.ts";
import { REFRESH_LEAD_MS, refreshAtOf } from "../../src/toolkits/store.ts";

describe("signInUrls", () => {
  it("names the callback on the request's host, and the CIMD document on the API host", () => {
    expect(signInUrls("https://app.example.com/v9/management/x", "api.example.com")).toEqual({
      callback: "https://app.example.com/oauth/toolkits/callback",
      clientId: "https://api.example.com/oauth/toolkits/client.json",
    });
  });

  it("names the CIMD document on the request's host without an API host", () => {
    for (const apiDomain of [undefined, "", "  "])
      expect(signInUrls("https://app.example.com/v9/management/x", apiDomain).clientId).toBe(
        "https://app.example.com/oauth/toolkits/client.json",
      );
  });

  it.each([
    ["a loopback host", "https://localhost:8787/v9/management/x"],
    ["a loopback address", "https://127.0.0.1/v9/management/x"],
    ["a workers.dev host", "https://commissary-app-pr-12.someone.workers.dev/v9/management/x"],
    ["plain http", "http://app.example.com/v9/management/x"],
  ])("offers no CIMD document on %s", (_case, url) => {
    const urls = signInUrls(url, "api.example.com");

    expect(urls.clientId).toBeUndefined();
    expect(urls.callback).toBe(`${new URL(url).origin}/oauth/toolkits/callback`);
  });
});

describe("signInCallbackOrg", () => {
  it("is the org the state names, global for a bare one, and none without a state of a sign-in", () => {
    const callback = "https://app.example.com/oauth/toolkits/callback";

    expect(signInCallbackOrg(`${callback}?state=org.acme.0123abcd&code=c`)).toBe("acme");
    expect(signInCallbackOrg(`${callback}?state=0123abcd&code=c`)).toBe("global");
    expect(signInCallbackOrg(`${callback}?code=c`)).toBeUndefined();
    expect(signInCallbackOrg(`${callback}?state=not%20a%20state`)).toBeUndefined();
  });
});

describe("bearerChallenge", () => {
  it("reads a Bearer challenge's auth-params, quoted or not, names lowercased", () => {
    expect(
      Object.fromEntries(
        bearerChallenge(
          'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", Scope="a b", error=invalid_token',
        ),
      ),
    ).toEqual({
      resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "a b",
      error: "invalid_token",
    });
  });

  it("reads the Bearer one of several challenges, and unescapes a quoted value", () => {
    expect(
      Object.fromEntries(bearerChallenge('Basic realm="x", bearer error_description="a \\"b\\""')),
    ).toEqual({ error_description: 'a "b"' });
  });

  it("is empty without a Bearer challenge", () => {
    expect(bearerChallenge(undefined).size).toBe(0);
    expect(bearerChallenge('Basic realm="x"').size).toBe(0);
    expect(bearerChallenge("Bearerish realm=x").size).toBe(0);
  });
});

describe("the well-known URIs discovery tries", () => {
  it("asks for a resource's metadata at the path-inserted URI, then the root one", () => {
    expect(resourceMetadataUrls("https://mcp.example.com/v1/mcp/")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(resourceMetadataUrls("https://mcp.example.com")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("asks for an issuer's metadata in the MCP spec's order", () => {
    expect(serverMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
    expect(serverMetadataUrls("https://auth.example.com/")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });
});

describe("namesSource", () => {
  const source = "https://mcp.example.com/v1/mcp";

  it.each([
    ["the source itself", source],
    ["its origin", "https://mcp.example.com"],
    ["a path prefix at a segment boundary", "https://mcp.example.com/v1/"],
  ])("takes %s", (_case, resource) => {
    expect(namesSource(resource, source)).toBe(true);
  });

  it.each([
    ["another origin", "https://other.example.com/v1/mcp"],
    ["another scheme", "http://mcp.example.com/v1/mcp"],
    ["a prefix inside a segment", "https://mcp.example.com/v"],
    ["another path", "https://mcp.example.com/v2"],
    ["a query", "https://mcp.example.com/v1/mcp?x=1"],
    ["no URL", "not a url"],
  ])("refuses %s", (_case, resource) => {
    expect(namesSource(resource, source)).toBe(false);
  });
});

describe("refreshAtOf", () => {
  const NOW = 1_800_000_000_000;

  const oauth = (fields: Partial<OAuthSecret>): OAuthSecret => ({
    kind: "oauth",
    access_token: "a",
    refresh_token: "r",
    via: "cimd",
    client_id: "https://api.example.com/oauth/toolkits/client.json",
    token_endpoint: "https://auth.example.com/token",
    auth: "none",
    ...fields,
  });

  it("is the lead before expiry for a long-lived token", () => {
    expect(refreshAtOf(oauth({ expires_at: NOW + 3_600_000 }), NOW)).toBe(
      NOW + 3_600_000 - REFRESH_LEAD_MS,
    );
  });

  it("is halfway through the life of a token shorter than twice the lead", () => {
    expect(refreshAtOf(oauth({ expires_at: NOW + 120_000 }), NOW)).toBe(NOW + 60_000);
  });

  it("is the expiry of a token without a refresh token, to mark it as needing sign-in then", () => {
    const { refresh_token: _none, ...withoutRefresh } = oauth({ expires_at: NOW + 3_600_000 });

    expect(refreshAtOf(withoutRefresh, NOW)).toBe(NOW + 3_600_000);
  });

  it("is never for a token that does not expire, a client credentials grant or a static secret", () => {
    expect(refreshAtOf(oauth({}), NOW)).toBeUndefined();
    expect(
      refreshAtOf(
        {
          kind: "client_credentials",
          client_id: "c",
          client_secret: "s",
          access_token: "a",
          expires_at: NOW + 60_000,
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(refreshAtOf({ kind: "bearer", token: "t" }, NOW)).toBeUndefined();
  });
});
