// `api-keys.opencode-zen` / `api-keys.opencode-go` through the management API: YAML import and key groups. The parser
// and round trip are tested in Models (`packages/models/test/unit/opencode-config.test.ts`).
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ProviderKeysList } from "@commissary/contract/provider-keys";
import { jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const YAML = `api-keys:
  opencode-zen:
    - prefix: zen
      priority: 2
      headers:
        X-Team: core
      excluded-models: ["*-mini"]
      models:
        - name: gpt-5
          alias: zen-gpt
          protocol: chat
      keys:
        - api-key: zen-key
        - api-key: zen-key-2
          models:
            - name: claude-haiku-4-5
              protocol: messages
    - base-url: https://zen.example/v1
      keys:
        - api-key: zen-key-3
  opencode-go:
    - keys:
        - api-key: go-key
`;

describe("management import and key groups", () => {
  const harness = makeHarness();

  afterAll(harness.dispose);

  beforeEach(resetControlPlane);

  const groups = async (family: "opencode-zen" | "opencode-go") =>
    ((await harness.json("/v9/management/provider-keys")).body as ProviderKeysList).families[
      family
    ];

  it("imports the sections from YAML and edits them as key groups", async () => {
    const stored = await harness.json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: YAML,
    });

    expect(stored.status).toBe(200);

    const [zen] = await groups("opencode-zen");

    expect(zen?.group.models).toEqual([{ name: "gpt-5", alias: "zen-gpt", protocol: "chat" }]);
    // Secrets are never served.
    expect(JSON.stringify(zen)).not.toContain("zen-key");

    const write = (protocol: string) =>
      harness.json(
        "/v9/management/provider-keys/groups",
        jsonInit("PUT", {
          family: "opencode-go",
          revision: 0,
          group: {
            keys: [{ "api-key": "go-key-new" }],
            models: [{ name: "minimax-m3", protocol }],
          },
        }),
      );

    expect((await write("messages")).status).toBe(200);
    const go = await groups("opencode-go");
    expect(go.at(-1)?.group).toMatchObject({
      models: [{ name: "minimax-m3", protocol: "messages" }],
    });

    expect((await write("carrier-pigeon")).status).toBe(422);
  });
});
