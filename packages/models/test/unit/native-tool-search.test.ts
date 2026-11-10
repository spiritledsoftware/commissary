// The per-attempt native tool search decision (Go: internal/runtime/executor/claude_executor.go `SupportsNativeToolSearch`,
// helps/claude_tool_search_model_test.go; upstream 52992659, 03a3cfec, 48ad3487).
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../../src/config/codec.ts";
import { claudeModelLacksToolSearch } from "../../src/executor/claude/classify.ts";
import { nativeToolSearchFor } from "../../src/executor/claude/tool-search.ts";
import type { CredentialSnapshot } from "../../src/executor/picker.ts";

const GATE = "upstream:\n  claude:\n    tool-search: true\n";

const config = (yaml = GATE) => Effect.runSync(parseConfigYaml(yaml));

const key = (attributes: Record<string, string> = {}): CredentialSnapshot => ({
  id: "claude-1",
  provider: "claude",
  kind: "apikey",
  label: "claude-1",
  attributes: { api_key: "sk-ant-api03-test", ...attributes },
  metadata: {},
});

const oauth = (): CredentialSnapshot => ({
  id: "claude-oauth",
  provider: "claude",
  kind: "oauth",
  label: "dev@example.com",
  attributes: {},
  metadata: { access_token: "sk-ant-oat01-secret" },
});

const decide = (overrides: Partial<Parameters<typeof nativeToolSearchFor>[0]> = {}): boolean =>
  nativeToolSearchFor({
    config: config(),
    credential: key(),
    profile: undefined,
    upstreamModel: "claude-sonnet-4-5",
    ...overrides,
  });

describe("claudeModelLacksToolSearch", () => {
  it.each([
    ["claude-3-5-sonnet-20241022", true],
    ["claude-3-opus", true],
    ["claude-2.1", true],
    ["claude-instant-1.2", true],
    ["claude-opus-4", true],
    ["claude-opus-4-0", true],
    ["claude-opus-4-1", true],
    ["claude-opus-4-1-20250805", true],
    ["claude-sonnet-4", true],
    ["claude-sonnet-4-20250514", true],
    ["Claude-Opus-4-1(high)", true],
    ["team/claude-opus-4-1", true],
    ["claude-opus-4-1[1m]", true],
    ["claude-sonnet-4-5", false],
    ["claude-sonnet-4-5-20250929", false],
    ["claude-opus-4-5", false],
    ["claude-haiku-4-5", false],
    ["claude-opus-5-5", false],
    ["claude-fable-5", false],
    ["some-gateway-model", false],
    ["", false],
  ])("%s -> %s", (model, lacks) => expect(claudeModelLacksToolSearch(model)).toBe(lacks));
});

describe("nativeToolSearchFor", () => {
  it("needs the org switch", () => {
    expect(decide()).toBe(true);
    expect(decide({ config: config("") })).toBe(false);
  });

  it("counts Anthropic's own origin: an api.anthropic.com key and OAuth", () => {
    expect(decide({ credential: key({ base_url: "https://api.anthropic.com" }) })).toBe(true);
    expect(decide({ credential: oauth() })).toBe(true);
  });

  it("needs the key's flag on a custom base URL (attribute or config entry)", () => {
    const gateway = { base_url: "https://gateway.test" };
    expect(decide({ credential: key(gateway) })).toBe(false);
    expect(decide({ credential: key({ ...gateway, native_tool_search: "true" }) })).toBe(true);
    expect(decide({ credential: key({ ...gateway, native_tool_search: "TRUE" }) })).toBe(true);

    const entry = config(`${GATE}api-keys:
  claude:
    - base-url: https://gateway.test
      keys: [{ api-key: sk-ant-api03-test, native-tool-search: true }]
`);

    expect(decide({ config: entry, credential: key(gateway) })).toBe(true);
  });

  it("is never native for a model that predates tool search", () => {
    expect(decide({ upstreamModel: "claude-opus-4-1" })).toBe(false);
    expect(decide({ upstreamModel: "claude-opus-4-1", credential: oauth() })).toBe(false);
  });

  it("is never native through a delegating profile (Kimi)", () => {
    expect(decide({ profile: {} })).toBe(false);
  });
});
