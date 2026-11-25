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
