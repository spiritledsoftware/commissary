// Sensitive words, `sensitive-words-replace` and `sensitive-patterns-replace` (CLIProxyAPI 9a7e1e6b, 905e70c4) as the
// three executors that apply them send them upstream: Claude (a cloaked key), Antigravity (the system instruction)
// and Devin (the system prompt). The matcher itself: test/unit/cloak-obfuscate.test.ts.
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import { resetMemoryAntigravityState } from "../src/executor/antigravity/state.ts";
import { makeDevinExecutor } from "../src/executor/devin/executor.ts";
import { credential as geminiCredential, makeGeminiHarness } from "./support/gemini.ts";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";
import { jsonResponse, loadConfig, makePipeline, postJson } from "./support/pipeline.ts";
import { oauthCredential, oauthPipeline } from "./support/claude-oauth.ts";
import { resolveWirePolicy } from "../src/executor/claude/credentials.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";

const RULES = `
              sensitive-words: ["proxy"]
              sensitive-words-replace: { "Acme Bot": "Assistant", "drop me": "" }
              sensitive-patterns-replace:
                - pattern: 'secret-(\\d+)'
                  replacement: "[redacted $1]"
                - pattern: '(?m)^RFC 2119[^\\n]*\\n?'
`;

/** The caller's instructions: a word, a literal replacement, a deletion and two pattern matches. */
const INSTRUCTIONS = "Acme Bot speaks via proxy.\nRFC 2119 applies.\ndrop me Keep secret-42.";

describe("Claude: a cloaked key", () => {
  it("replaces and obfuscates in the system blocks and the messages", async () => {
    const config = await loadConfig(`
api-keys:
  claude:
    - keys:
        - api-key: sk-ant-api03-test
          cloak:
            mode: always
${RULES.replaceAll("\n              ", "\n            ")}
      models:
        - name: claude-opus-4-8
`);

    const p = makePipeline({
      config,
      respond: () =>
        jsonResponse({
          id: "msg_01",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({
        model: "claude-opus-4-8",
        max_tokens: 32,
        system: [{ type: "text", text: INSTRUCTIONS }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Ask Acme Bot about secret-7" }] },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.stringify(JSON.parse(p.calls[0]?.body ?? "{}") as JsonObject);

    expect(sent).toContain(
      JSON.stringify("Assistant speaks via p\u200Broxy.\n Keep [redacted 42].").slice(1, -1),
    );
    expect(sent).toContain("Ask Assistant about [redacted 7]");
    expect(sent).not.toContain("Acme Bot");
    expect(sent).not.toContain("RFC 2119");
    expect(sent).not.toContain("secret-");
  });
});

describe("Claude: the credential's cloak_sensitive_*_replace", () => {
  const API_KEY = "sk-ant-api03-credential";

  /** A Claude API key credential (not Claude Code CLI-profiled, so not cloaked by default). */
  const apiKey = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
    id: "claude-key-1",
    provider: "claude",
    kind: "apikey",
    label: "key",
    attributes: { api_key: API_KEY },
    metadata: {},
    ...overrides,
  });

  const resolve = async (credential: CredentialSnapshot, yaml = "requests: {}") =>
    resolveWirePolicy(await loadConfig(yaml), credential, API_KEY, false);

  it("turns cloaking on alone, read from an attribute, metadata or metadata JSON text", async () => {
    expect((await resolve(apiKey())).policy.cloak).toBe(false);

    const fromAttribute = await resolve(
      apiKey({
        attributes: {
          api_key: API_KEY,
          cloak_sensitive_words_replace: '{" Acme Bot ": "Assistant", "n": 1}',
        },
      }),
    );

    expect(fromAttribute.policy.cloak).toBe(true);
    expect(fromAttribute.settings.sensitive.replacements).toEqual({ "Acme Bot": "Assistant" });

    const fromMetadata = await resolve(
      apiKey({
        metadata: {
          cloak_sensitive_patterns_replace: [
            { pattern: "secret-(\\d+)", replacement: "[$1]" },
            { pattern: " " },
            { replacement: "no pattern" },
          ],
        },
      }),
    );

    expect(fromMetadata.policy.cloak).toBe(true);
    expect(fromMetadata.settings.sensitive.patterns).toEqual([
      { pattern: "secret-(\\d+)", replacement: "[$1]" },
    ]);

    const fromMetadataText = await resolve(
      apiKey({ metadata: { cloak_sensitive_patterns_replace: '[{"pattern": "RFC"}]' } }),
    );

    expect(fromMetadataText.policy.cloak).toBe(true);
    expect(fromMetadataText.settings.sensitive.patterns).toEqual([
      { pattern: "RFC", replacement: "" },
    ]);
  });

  it("gives way to the key's own non-empty values", async () => {
    const credential = apiKey({
      attributes: {
        api_key: API_KEY,
        cloak_sensitive_words_replace: '{"Acme Bot": "Credential"}',
        cloak_sensitive_patterns_replace: '[{"pattern": "a+", "replacement": "b"}]',
      },
    });

    const resolved = await resolve(
      credential,
      `
api-keys:
  claude:
    - keys:
        - api-key: ${API_KEY}
          cloak:
            sensitive-words-replace: { "Acme Bot": "Key" }
            sensitive-patterns-replace: []
`,
    );

    expect(resolved.settings.sensitive.replacements).toEqual({ "Acme Bot": "Key" });
    // An empty list on the key keeps the credential's rules.
    expect(resolved.settings.sensitive.patterns).toEqual([{ pattern: "a+", replacement: "b" }]);
  });

  const message = () =>
    jsonResponse({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

  const ask = postJson({
    model: "claude-opus-4-8",
    max_tokens: 32,
    system: [{ type: "text", text: "Acme Bot keeps secret-42" }],
    messages: [{ role: "user", content: "Hello Acme Bot" }],
  });

  const ruled = oauthCredential({
    attributes: {
      cloak_sensitive_words_replace: '{"Acme Bot": "Assistant"}',
      cloak_sensitive_patterns_replace:
        '[{"pattern": "secret-\\\\d+", "replacement": "[redacted]"}]',
    },
  });

  it("applies them to a cloaked request at the full level", async () => {
    const h = oauthPipeline(message, await loadConfig("requests: {}"), ruled);

    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", ask);
    const sent = h.pipeline.calls[0]?.body ?? "";

    expect(sent).toContain("Assistant keeps [redacted]");
    expect(sent).toContain("Hello Assistant");
    expect(sent).not.toContain("Acme Bot");
  });

  it("skips them at the minimal level, like the sensitive words", async () => {
    const h = oauthPipeline(
      message,
      await loadConfig("upstream: { claude: { cloak-level: minimal } }"),
      ruled,
    );

    afterAll(h.pipeline.dispose);
    await h.pipeline.call("/v1/messages", ask);
    const sent = h.pipeline.calls[0]?.body ?? "";

    expect(sent).toContain("Acme Bot keeps secret-42");
    expect(sent).toContain("Hello Acme Bot");
  });
});

describe("Antigravity: the system instruction", () => {
  it("replaces, and obfuscates with U+034F, only in the system instruction", async () => {
    resetMemoryAntigravityState();

    const config = await loadConfig(`
oauth:
  providers:
    antigravity:
${RULES.replaceAll("\n              ", "\n      ")}
`);

    const h = makeGeminiHarness({
      config,
      credential: geminiCredential("antigravity", `antigravity-${crypto.randomUUID()}.json`, {
        kind: "oauth",
        metadata: { access_token: "ya29.token", project_id: "proj-1" },
      }),
      models: { "gemini-2.5-flash": ["antigravity"] },
      respond: () =>
        jsonResponse({
          response: {
            candidates: [
              { content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
          },
        }),
    });

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: "Ask Acme Bot about secret-7 via proxy" },
        ],
      }),
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(h.calls[0]?.body ?? "{}");

    expect(sent.request.systemInstruction.parts[0].text).toBe(
      "Assistant speaks via p\u034Froxy.\n Keep [redacted 42].",
    );
    // The conversation is sent as the caller wrote it.
    expect(JSON.stringify(sent.request.contents)).toContain(
      "Ask Acme Bot about secret-7 via proxy",
    );
  });
});

/** A short answer ("ok", content field 3) and the EOS trailer. */
const okResponse = (): Response => {
  const frame = (flag: number, payload: Uint8Array) => {
    const out = new Uint8Array(5 + payload.length);
    out[0] = flag;
    new DataView(out.buffer).setUint32(1, payload.length, false);
    out.set(payload, 5);

    return [...out];
  };

  return new Response(
    new Uint8Array([
      ...frame(0, Uint8Array.from([0x1a, 0x02, 0x6f, 0x6b])),
      ...frame(2, new TextEncoder().encode("{}")),
    ]),
    { status: 200, headers: { "content-type": "application/connect+proto" } },
  );
};

describe("Devin: the system prompt", () => {
  const executor = makeDevinExecutor();

  it("replaces, and drops the lines that keep a sensitive word", async () => {
    const h = await harness(
      credential("devin", {
        attributes: {
          api_key: "devin-session-token$test",
          base_url: "https://devin.test",
          device_seed: "seed-1",
        },
      }),
      () => okResponse(),
      `
oauth:
  providers:
    devin:
${RULES.replaceAll("\n              ", "\n      ")}
`,
    );

    const payload = {
      model: "devin/claude-opus-5-5",
      instructions: `${INSTRUCTIONS}\nAcme Bot stays.`,
      input: "hi",
    };

    await execute(
      executor,
      h,
      { model: "devin/claude-opus-5-5", payload: json(payload) },
      options({
        sourceFormat: "openai-response",
        originalRequest: json(payload),
        metadata: { ...options().metadata, requestPath: "/v1/responses" },
      }),
    );

    const wire = new TextDecoder().decode((h.calls[0] as { bytes: Uint8Array }).bytes);

    // The line with the sensitive word is dropped; the replacements of the other lines stay.
    expect(wire).toContain("Keep [redacted 42].\nAssistant stays.");
    expect(wire).not.toContain("proxy");
    expect(wire).not.toContain("speaks via");
    expect(wire).not.toContain("RFC 2119");
    expect(wire).not.toContain("drop me");
    expect(wire).not.toContain("secret-42");
  });
});
