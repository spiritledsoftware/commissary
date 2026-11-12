// `/v1/alpha/search` with provider-key credentials: the upstream model is the route the credential pool resolved for the
// pick (prefix stripping, provider-key aliases), not a second, config-only resolution (Go `ResolveExecutionModel` +
// `rewriteCodexAlphaSearchModel`).
import { afterAll, describe, expect, it } from "vite-plus/test";
import { jsonResponse, makePipeline, postJson } from "./support/pipeline.ts";
import { makePool, poolPickerLayer } from "./support/pool.ts";
import { codexModels } from "./support/codex.ts";

const YAML = `
routing:
  force-model-prefix: false
api-keys:
  codex:
    - base-url: https://s.test/v1
      prefix: team
      models:
        - name: gpt-5.4-search
          alias: search-alias
      keys:
        - api-key: sk-alpha
          alpha-search: true
`;

describe("POST /v1/alpha/search with provider keys", async () => {
  const harness = await makePool(YAML);

  const p = makePipeline({
    config: harness.config,
    respond: () => jsonResponse({ ok: true }),
    credentialPicker: poolPickerLayer(harness.pool),
    modelProviders: codexModels,
  });

  afterAll(p.dispose);

  it("forwards the pool's upstream model (prefix and Codex provider-key alias resolved)", async () => {
    const response = await p.call(
      "/v1/alpha/search",
      postJson({ model: "team/search-alias", query: "q" }),
    );

    expect(response.status).toBe(200);
    expect(p.calls.at(-1)?.url).toBe("https://s.test/v1/alpha/search");
    expect(JSON.parse(p.calls.at(-1)?.body ?? "{}")).toEqual({
      model: "gpt-5.4-search",
      query: "q",
    });
  });
});
