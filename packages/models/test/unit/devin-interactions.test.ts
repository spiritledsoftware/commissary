// Interactions request -> Devin prompts/tools (parseInteractionsPayload and friends).
import { describe, expect, it } from "vite-plus/test";
import {
  checkDevinUserTurns,
  normalizeDevinUuid,
  parseInteractionsPayload,
  parseSignatureBytes,
} from "../../src/executor/devin/interactions.ts";
import { json } from "../support/executor-run.ts";
import { metaSignature, routerSuffixed } from "../support/signatures.ts";
import type { Json } from "@commissary/json";

const parse = (payload: Json, original?: Json) =>
  parseInteractionsPayload(json(payload), original === undefined ? undefined : json(original));

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("parseInteractionsPayload", () => {
  it("reads generation settings, session ids and the system instruction", () => {
    const parsed = parse({
      system_instruction: "  be brief ",
      generation_config: {
        temperature: 0.2,
        max_output_tokens: 99,
        thinking_level: "high",
        thinking_config: { thinking_budget: 2048 },
      },
      conversation_id: "conv-1",
      input: [],
    });

    expect(parsed).toMatchObject({
      systemPrompt: "be brief",
      temperature: 0.2,
      maxTokens: 99,
      thinkingLevel: "high",
      budgetTokens: 2048,
      sessionId: "conv-1",
      cascadeId: "conv-1",
    });
    expect(parse({ input: [] }).maxTokens).toBe(128000);
    // Temperature falls back to the original request, then the payload.
    expect(parse({ input: [] }, { temperature: 0.7 }).temperature).toBe(0.7);
    expect(parse({ temperature: 0.4, input: [] }).temperature).toBe(0.4);
    expect(parse({ input: [] }, { session_id: "from-original" }).sessionId).toBe("from-original");
  });

  it("maps steps to prompts: thoughts and calls attach to the preceding assistant turn", () => {
    const { prompts } = parse({
      input: [
        { type: "user_input", content: "q" },
        { type: "thought", content: [{ type: "text", text: "hmm" }], signature: "sealed.v1.xyz" },
        { type: "model_output", content: "a1" },
        { type: "model_output", content: [{ type: "text", text: "a2" }] },
        { type: "function_call", id: "c1", name: "f", arguments: { a: 1 } },
        { type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
        { type: "function_result", call_id: "c1", result: "r1" },
        { type: "function_result", result: { ok: true } },
        { type: "function_result", call_id: "gone", output: "late" },
        { type: "function_result", call_id: "c2" },
      ],
    });

    expect(prompts.map((prompt) => prompt.source)).toEqual([1, 2, 4, 4, 1, 1]);
    const assistant = prompts[1];
    expect(assistant?.thinking).toBe("hmm");
    expect(assistant?.content).toBe("a1\na2");
    expect(text(assistant?.signature ?? new Uint8Array())).toBe("sealed.v1.xyz");
    expect(assistant?.signatureType).toBe("sealed");
    expect(assistant?.toolCalls).toEqual([
      { id: "c1", name: "f", arguments: '{"a":1}' },
      { id: "c2", name: "g", arguments: "{}" },
    ]);
    expect(prompts[2]).toMatchObject({ toolCallId: "c1", content: "r1" });
    // An id-less result takes the oldest pending call; an unknown id is downgraded to a user prompt.
    expect(prompts[3]).toMatchObject({ toolCallId: "c2", content: '{"ok":true}' });
    expect(prompts[4]).toMatchObject({
      isOrphanedTool: true,
      originalToolCallId: "gone",
      source: 1,
    });
    expect(prompts[5]).toMatchObject({ isOrphanedTool: true, content: "{}" });
  });

  it("extracts inline images (data URL, base64, source, inline_data) and placeholder headers", () => {
    const { prompts } = parse({
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: "look" },
            { type: "image", image_url: { url: "data:image/webp;base64,AAAA" } },
            { type: "input_image", source: { data: "BBBB", media_type: "image/gif" } },
            { type: "image", inline_data: { data: "CCCC" } },
          ],
        },
      ],
    });

    expect(prompts[0]?.images).toEqual([
      { base64Data: "AAAA", mimeType: "image/webp" },
      { base64Data: "BBBB", mimeType: "image/gif" },
      { base64Data: "CCCC", mimeType: "image/png" },
    ]);
    expect(prompts[0]?.content).toBe(
      "[Image 1: pasted_image_1.webp]\n[Image 2: pasted_image_2.gif]\n[Image 3: pasted_image_3.png]\n\nlook",
    );
  });

  it("supplements lost signatures and images from the original (Claude) request", () => {
    const { prompts } = parse(
      {
        input: [
          { type: "user_input", content: "see" },
          { type: "model_output", content: "ok" },
          { type: "function_call", id: "t1", name: "shot", arguments: {} },
          { type: "function_result", call_id: "t1", result: "done" },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image", source: { data: "IMG", media_type: "image/png" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "orig thought", signature: "gpt#abc" },
              { type: "text", text: "ok" },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "image", source: { data: "TOOLIMG" } }],
              },
            ],
          },
        ],
      },
    );

    expect(prompts[0]?.images).toEqual([{ base64Data: "IMG", mimeType: "image/png" }]);
    expect(prompts[1]).toMatchObject({ thinking: "orig thought", signatureType: "openai" });
    expect(text(prompts[1]?.signature ?? new Uint8Array())).toBe("abc");
    expect(prompts[2]?.images).toEqual([{ base64Data: "TOOLIMG", mimeType: "image/png" }]);
    expect(prompts[2]?.content).toContain("[Image 1: pasted_image_1.png]");
  });

  it("unwraps tool_result envelopes and keeps structured results", () => {
    const { prompts } = parse({
      input: [
        { type: "function_call", id: "a", name: "f", arguments: {} },
        {
          type: "function_result",
          call_id: "a",
          result: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
        { type: "function_call", id: "b", name: "f", arguments: {} },
        {
          type: "function_result",
          call_id: "b",
          output: { type: "tool_result", tool_use_id: "b", content: "wrapped" },
        },
        { type: "function_call", id: "c", name: "f", arguments: {} },
        { type: "function_result", call_id: "c", result: [{ n: 1 }, "str"] },
      ],
    });

    expect(prompts.filter((prompt) => prompt.source === 4).map((prompt) => prompt.content)).toEqual(
      ["line 1\nline 2", "wrapped", '[{"n":1},"str"]'],
    );
  });

  it("reads tools in every spelling and drops the Codex automation tool", () => {
    const { tools } = parse({
      tools: [
        { name: "plain", description: "d", parameters: { type: "object" } },
        { name: "camel", parametersJsonSchema: { type: "object", properties: {} } },
        { function_declarations: [{ name: "fd1" }, { name: "mcp__codex_app__automation_update" }] },
        { functionDeclarations: [{ name: "fd2" }] },
        {
          type: "namespace",
          name: "mcp__codex_app",
          tools: [{ name: "kept" }, { name: "automation_update" }],
        },
        { description: "no name" },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual(["plain", "camel", "fd1", "fd2", "kept"]);
    expect(tools[0]?.parameters).toBe('{"type":"object"}');
    expect(tools[1]?.parameters).toBe('{"type":"object","properties":{}}');
  });

  it("falls back to OpenAI messages when the body was not translated", () => {
    const parsed = parse({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "x", function: { name: "f", arguments: '{"a":1}' } }],
        },
        { role: "tool", tool_call_id: "x", content: "res" },
      ],
    });

    expect(parsed.systemPrompt).toBe("sys");
    expect(parsed.prompts.map((prompt) => prompt.source)).toEqual([1, 2, 4]);
    expect(parsed.prompts[1]?.toolCalls).toEqual([{ id: "x", name: "f", arguments: '{"a":1}' }]);
  });
});

describe("signatures and ids", () => {
  it("classifies prefixed, sealed and heuristic signatures", () => {
    expect(parseSignatureBytes("claude#EAA")).toMatchObject({ type: "anthropic" });
    expect(text(parseSignatureBytes("gemini#zzz").bytes)).toBe("zzz");
    expect(parseSignatureBytes("sealed.v1.a").type).toBe("sealed");
    expect(parseSignatureBytes("AYabc").type).toBe("gemini");
    expect(parseSignatureBytes(btoa("sealed.v1.inner")).type).toBe("sealed");
    expect(parseSignatureBytes("  ").bytes).toHaveLength(0);
  });

  // Go 7a0b7563, a68c7d8e: a Meta Muse envelope is positively foreign to the Devin backend and never supplemented as a
  // sealed signature; the Gemini Codex carrier (cpa-codex-gemini-carrier-v1:) is unwrapped to its inner signature.
  describe("Meta envelopes and the Gemini Codex carrier", () => {
    const meta = metaSignature();
    const carrier = (inner: string) => btoa(`cpa-codex-gemini-carrier-v1:${inner}`);
    const empty = { type: "", bytes: new Uint8Array(0) };

    it("never supplements a Meta envelope, bare or inside the carrier", () => {
      expect(parseSignatureBytes(meta)).toEqual(empty);
      expect(parseSignatureBytes(routerSuffixed(meta))).toEqual(empty);
      expect(parseSignatureBytes(carrier(meta))).toEqual(empty);
      // The last resort of an unrecognised blob would have called it sealed.
      expect(parseSignatureBytes("opaque-blob").type).toBe("sealed");
    });

    it("unwraps a carrier around a sealed signature", () => {
      const parsed = parseSignatureBytes(carrier("  sealed.v1.inner "));

      expect(parsed.type).toBe("sealed");
      expect(text(parsed.bytes)).toBe("sealed.v1.inner");
    });

    it("drops a carrier around something no Devin family owns", () => {
      expect(parseSignatureBytes(carrier("opaque-blob"))).toEqual(empty);
    });
  });

  it("maps non-UUID session strings to a deterministic UUID v5", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(normalizeDevinUuid(id)).toBe(id);
    expect(normalizeDevinUuid("lcp:abc")).toBe(normalizeDevinUuid("lcp:abc"));
    expect(normalizeDevinUuid("lcp:abc")).not.toBe(normalizeDevinUuid("lcp:abd"));
    expect(normalizeDevinUuid("")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("checkDevinUserTurns", () => {
  it("refuses a turn whose only content was media Devin cannot send and drops emptied prompts otherwise", () => {
    const refused = checkDevinUserTurns(
      parse({ input: [{ type: "user_input", content: [{ type: "audio", uri: "x" }] }] }).prompts,
    );

    expect(refused.error?.message).toContain("unsupported content part: audio");

    const mixed = checkDevinUserTurns(
      parse({
        input: [
          { type: "user_input", content: [{ type: "video", uri: "v" }] },
          { type: "user_input", content: "still here" },
        ],
      }).prompts,
    );

    expect(mixed.error).toBeUndefined();
    expect(mixed.prompts.map((prompt) => prompt.content)).toEqual(["still here"]);
  });
});
