// The Access configuration a deploy applies (infra/access-config.ts): the client API paths of a stage with one host,
// which the zone routes send to the API Worker and Access lets through, and the Managed OAuth of the Access
// application (ADR 0045).
import { assert, describe, it } from "vitest";
import {
  CLIENT_API_PATHS,
  clientApiBypassPaths,
  managedOAuth,
  zoneRoutedPrefixes,
} from "../../../infra/access-config.ts";

describe("client API paths of a stage with one host", () => {
  it("route /mcp to the API Worker on Commissary Cloud only: a self-hosted app host serves it", () => {
    assert.include(zoneRoutedPrefixes({ hosted: true }), "/mcp");
    assert.notInclude(zoneRoutedPrefixes({ hosted: false }), "/mcp");
    assert.include(zoneRoutedPrefixes({ hosted: false }), "/v1");
    assert.include(zoneRoutedPrefixes({ hosted: false }), "/oauth/toolkits/client.json");
    assert.include(zoneRoutedPrefixes({ hosted: true }), "/oauth/toolkits/client.json");
  });

  it("let the self-hosted client API through Access, but not /mcp, which stays behind it", () => {
    assert.deepStrictEqual(CLIENT_API_PATHS, clientApiBypassPaths());
    assert.notInclude(CLIENT_API_PATHS, "/mcp");

    assert.deepStrictEqual(CLIENT_API_PATHS, [
      "/v1",
      "/v1beta",
      "/v1internal",
      "/openai/v1",
      "/backend-api/codex",
      "/chat/completions",
      "/completions",
      "/responses",
      // Commissary's CIMD document of toolkits' OAuth sign-ins (#202), which authorization servers fetch unsigned.
      "/oauth/toolkits/client.json",
    ]);
  });
});

describe("Managed OAuth of the Access application", () => {
  const redirectUris = ["https://claude.ai/api/mcp/auth_callback", "myclient://callback"];

  it("is left out while ACCESS_MANAGED_OAUTH is off", () => {
    assert.isUndefined(
      managedOAuth({ managedOAuth: { enabled: false, redirectUris, loopbackClients: true } }),
    );
  });

  it("registers clients for the redirect URIs, and loopback clients when they are allowed", () => {
    for (const loopbackClients of [true, false])
      assert.deepStrictEqual(
        managedOAuth({ managedOAuth: { enabled: true, redirectUris, loopbackClients } }),
        {
          enabled: true,
          dynamicClientRegistration: {
            enabled: true,
            allowedUris: redirectUris,
            allowAnyOnLocalhost: loopbackClients,
            allowAnyOnLoopback: loopbackClients,
          },
        },
      );
  });
});
