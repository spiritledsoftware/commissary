// Devin-only reasoning replay on the Responses <-> Interactions route: typed GPT reasoning lists (CLIProxyAPI cb5f62f7)
// and Gemini bare-Tink thought signatures (28b281d5).
import { describe, expect, it } from "vite-plus/test";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { isRecognizedReasoningSignature } from "../src/signature/grok.ts";
import { isDevinOpenAIReasoningSignature } from "../src/signature/gpt.ts";
import { convertOpenAIResponsesRequestToInteractions } from "../src/translator/openai/interactions/responses/request-responses-to-interactions.ts";
import { interactionsToOpenAIResponsesResponse } from "../src/translator/openai/interactions/responses/response-interactions-to-responses.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";
import { fernetReasoningSignature } from "./support/reasoning-signatures.ts";

const item = JSON.stringify({ type: "reasoning", encrypted_content: fernetReasoningSignature() });

const OPENAI_LIST = `[${item},${item}]`;

/** Go's test signature: the bare-Tink prefix byte and key id, then filler ciphertext. */
const BARE_TINK = btoa(String.fromCharCode(0x01, 0x8f, 0x3d, 0x6b, 0x5f, ...Array(64).fill(0x5a)));

describe("isDevinOpenAIReasoningSignature (Go TestDevinOpenAIReasoningSignature)", () => {
  it("accepts Devin's list of GPT reasoning items, which is not a native GPT signature", () => {
    expect(isDevinOpenAIReasoningSignature(OPENAI_LIST)).toBe(true);
    expect(isRecognizedReasoningSignature(OPENAI_LIST)).toBe(false);
  });

  it.each([
    "[]",
    item,
    `[${item},{}]`,
    `[${item},]`,
    `[{"type":"reasoning","encrypted_content":"not a signature"}]`,
    OPENAI_LIST.replace("reasoning", "message"),
  ])("rejects %s", (bad) => {
    expect(isDevinOpenAIReasoningSignature(bad)).toBe(false);
  });
});

describe("Responses reasoning items replayed to Devin", () => {
  const request = (encrypted: ReadonlyArray<string>): Json => ({
    model: "devin/gemini-4-neon",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      ...encrypted.map((content, index) => ({
        type: "reasoning",
        summary: index === 0 ? [{ type: "summary_text", text: "checked tool plan" }] : [],
        encrypted_content: content,
      })),
      { type: "function_call", name: "ping", call_id: "c1", arguments: "{}" },
    ],
  });

  it("keeps a bare-Tink Gemini signature on the Devin route only, and drops prefixed ones", () => {
    const body = request([BARE_TINK, `google#${BARE_TINK}`, `claude#${BARE_TINK}`]);

    const other = convertOpenAIResponsesRequestToInteractions("devin/gemini-4-neon", body, false);
    expect(get(other, "input.1.type")).toBe("function_call");

    const devin = convertOpenAIResponsesRequestToInteractions("devin/gemini-4-neon", body, false, {
      devinReasoningReplay: true,
    });

    expect(get(devin, "input.1.type")).toBe("thought");
    expect(get(devin, "input.1.signature")).toBe(BARE_TINK);
    expect(get(devin, "input.1.signature_type")).toBe("gemini");
    expect(get(devin, "input.1.content.0.text")).toBe("checked tool plan");
    expect(get(devin, "input.2.type")).toBe("function_call");
  });

  it("replays a typed GPT reasoning list verbatim on the Devin route only", () => {
    const body = request([` ${OPENAI_LIST}`]);

    const other = convertOpenAIResponsesRequestToInteractions("devin/gpt-6-1-sol", body, false);
    expect(get(other, "input.1.type")).toBe("function_call");

    const devin = convertOpenAIResponsesRequestToInteractions("devin/gpt-6-1-sol", body, false, {
      devinReasoningReplay: true,
    });

    expect(get(devin, "input.1.type")).toBe("thought");
    expect(get(devin, "input.1.signature")).toBe(` ${OPENAI_LIST}`);
    expect(get(devin, "input.1.signature_type")).toBe("openai");
  });

  it("keeps sealed items without a type on every route", () => {
    const devin = convertOpenAIResponsesRequestToInteractions(
      "swe-2",
      request(["sealed.v1.abc"]),
      false,
      { devinReasoningReplay: true },
    );

    expect(get(devin, "input.1.signature")).toBe("sealed.v1.abc");
    expect(get(devin, "input.1.signature_type")).toBeUndefined();
  });
});

describe("Interactions thought signatures typed openai, to Responses", () => {
  const context = (): ResponseContext => ({
    model: "devin/gpt-6-1-sol",
    originalRequest: undefined,
    translatedRequest: undefined,
    state: makeTranslationState(),
  });

  const completedReasoning = (signatureType: string): string => {
    const ctx = context();

    const chunks = [
      `{"event_type":"interaction.created","interaction":{"id":"interaction_1"}}`,
      `{"event_type":"step.start","index":0,"step":{"type":"thought"}}`,
      `{"event_type":"step.delta","index":0,"delta":{"type":"thought_summary","text":"plan"}}`,
      JSON.stringify({
        event_type: "step.delta",
        index: 0,
        delta: { type: "thought_signature", signature: OPENAI_LIST, signature_type: signatureType },
      }),
      `{"event_type":"step.stop","index":0}`,
      `{"event_type":"interaction.completed","interaction":{"status":"completed"}}`,
    ].flatMap((line) => [...(interactionsToOpenAIResponsesResponse.stream?.(ctx, line) ?? [])]);

    const done = chunks
      .map((chunk) => /^event: response\.completed\ndata: (.*)\n\n$/s.exec(chunk)?.[1])
      .find((data) => data !== undefined);

    return asString(get(tryParseJson(done ?? ""), "response.output.0.encrypted_content"));
  };

  it("carries the list through the stream unchanged", () => {
    expect(completedReasoning("openai")).toBe(OPENAI_LIST);
  });

  it("drops the list when it is not typed openai", () => {
    expect(completedReasoning("")).toBe("");
  });

  it("carries the list through a non-stream response unchanged", () => {
    const body = JSON.stringify({
      id: "interaction_1",
      status: "completed",
      steps: [
        {
          type: "thought",
          content: [{ type: "text", text: "plan" }],
          signature: OPENAI_LIST,
          signature_type: "openai",
        },
        { type: "model_output", content: [{ type: "text", text: "done" }] },
      ],
    });

    const out = interactionsToOpenAIResponsesResponse.nonStream?.(context(), body) ?? "";
    expect(get(tryParseJson(out), "output.0.encrypted_content")).toBe(OPENAI_LIST);
  });
});
