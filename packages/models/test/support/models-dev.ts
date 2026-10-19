/** A synthetic models.dev document for catalog tests: every provider Commissary reads, a few models each. */

/** One models.dev model entry as models.dev sends it (with the fields Commissary drops). */
export const mdModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  release_date: "2026-01-01",
  knowledge: "2025-06",
  open_weights: false,
  temperature: true,
  reasoning: true,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 1, output: 2, cache_read: 0.1 },
  modalities: { input: ["text", "image"], output: ["text"] },
  ...extra,
});

const provider = (
  id: string,
  models: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({ id, name: id, env: ["KEY"], doc: "https://example.test", models, ...extra });

/** The models of the OpenCode gateways, by provider id; `models` adds to or replaces a gateway's entries. */
export const documentObject = (models: Partial<Record<string, Record<string, unknown>>> = {}) => ({
  anthropic: provider(
    "anthropic",
    { "claude-test": mdModel("claude-test"), ...models["anthropic"] },
    { npm: "@ai-sdk/anthropic" },
  ),
  google: provider(
    "google",
    { "gemini-test": mdModel("gemini-test"), ...models["google"] },
    { npm: "@ai-sdk/google" },
  ),
  "google-vertex": provider("google-vertex", {
    "gemini-vertex-test": mdModel("gemini-vertex-test"),
    ...models["google-vertex"],
  }),
  xai: provider("xai", { "grok-test": mdModel("grok-test"), ...models["xai"] }),
  meta: provider("meta", { "muse-test": mdModel("muse-test"), ...models["meta"] }),
  "kimi-code-plan-global": provider("kimi-code-plan-global", {
    "k-test": mdModel("k-test"),
    ...models["kimi-code-plan-global"],
  }),
  openai: provider(
    "openai",
    { "gpt-x": mdModel("gpt-x"), ...models["openai"] },
    { npm: "@ai-sdk/openai" },
  ),
  opencode: provider(
    "opencode",
    {
      "gpt-9": mdModel("gpt-9", { provider: { npm: "@ai-sdk/openai" } }),
      "claude-z": mdModel("claude-z", { provider: { npm: "@ai-sdk/anthropic" } }),
      "old-model": mdModel("old-model", { status: "deprecated" }),
      "free-model": mdModel("free-model", { cost: { input: 0, output: 0 } }),
      broken: { id: 42 },
      ...models["opencode"],
    },
    {
      name: "OpenCode Zen",
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/inference/v1",
    },
  ),
  "opencode-go": provider(
    "opencode-go",
    {
      "kimi-q": mdModel("kimi-q"),
      "go-free": mdModel("go-free", { cost: { input: 0, output: 0 } }),
      ...models["opencode-go"],
    },
    { npm: "@ai-sdk/openai-compatible", api: "https://opencode.ai/inference/go/v1" },
  ),
  // Providers Commissary does not read.
  mistral: provider("mistral", { "mistral-x": mdModel("mistral-x") }),
});

export const documentText = (models: Partial<Record<string, Record<string, unknown>>> = {}) =>
  JSON.stringify(documentObject(models));
