// Devin GPT reasoning across Responses tool calls (CLIProxyAPI cb5f62f7): the signature type reaches the client, a
// signature-only thought may follow an open message, and a typed GPT reasoning list goes back upstream verbatim.
import { describe, expect, it } from "vite-plus/test";
import { Formats } from "@commissary/translation/formats";
import { tryParseJson, type Json } from "@commissary/json";
import { parseInteractionsPayload } from "../../src/executor/devin/interactions.ts";
import { DevinAggregator, DevinStreamAssembler } from "../../src/executor/devin/stream.ts";
import type { DevinFrame } from "../../src/executor/devin/wire.ts";
import { json } from "../support/executor-run.ts";
import { gptSignature } from "../support/signatures.ts";

const utf8 = new TextEncoder();

const frame = (fields: Partial<DevinFrame>): DevinFrame => ({
  outputId: "",
  timestamp: 0,
  content: new Uint8Array(0),
  thinking: new Uint8Array(0),
  deltaTokens: 0,
  stopReason: 0,
  toolCalls: [],
  deltaSignature: new Uint8Array(0),
  deltaSignatureType: "",
  latency: 0,
  messageId: "",
  usage: undefined,
  dimensionGroups: [],
  unknownFields: [],
  ...fields,
});

const events = (chunks: ReadonlyArray<string>): Json[] =>
  chunks.map((chunk) => tryParseJson(chunk.replace(/^data: /, "").trim()) ?? chunk);

const item = JSON.stringify({ type: "reasoning", encrypted_content: gptSignature() });

const OPENAI_LIST = `[${item}]`;

describe("Devin signature type (cb5f62f7)", () => {
  it("joins fragmented Responses signatures and sends a type that arrives in a later frame", () => {
    const assembler = new DevinStreamAssembler(
      "gpt-6-1-sol",
      Formats.OpenAIResponse,
      "interaction_1",
    );

    const out = events([
      ...assembler.push(frame({ thinking: utf8.encode("plan") })),
      ...assembler.push(frame({ deltaSignature: utf8.encode(OPENAI_LIST.slice(0, 10)) })),
      ...assembler.push(frame({ deltaSignature: utf8.encode(OPENAI_LIST.slice(10)) })),
      ...assembler.push(frame({ deltaSignatureType: "openai" })),
    ]);

    const signatures = out.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event) &&
        JSON.stringify(event).includes('"thought_signature"'),
    );

    expect(signatures.at(-1)).toMatchObject({
      event_type: "step.delta",
      index: 0,
      delta: { type: "thought_signature", signature: OPENAI_LIST, signature_type: "openai" },
    });
  });

  it("opens a thought for a signature that follows an open Responses message", () => {
    const assembler = new DevinStreamAssembler(
      "gpt-6-1-sol",
      Formats.OpenAIResponse,
      "interaction_1",
    );

    const out = events([
      ...assembler.push(frame({ content: utf8.encode("hello") })),
      ...assembler.push(
        frame({ deltaSignature: utf8.encode(OPENAI_LIST), deltaSignatureType: "openai" }),
      ),
    ]);

    expect(out).toContainEqual({ event_type: "step.stop", index: 0 });
    expect(out).toContainEqual({ event_type: "step.start", index: 1, step: { type: "thought" } });
    expect(out).toContainEqual({
      event_type: "step.delta",
      index: 1,
      delta: { type: "thought_signature", signature: OPENAI_LIST, signature_type: "openai" },
    });
  });

  it("keeps the signature type on the thought step of a non-stream response", () => {
    const aggregator = new DevinAggregator();
    aggregator.push(
      frame({ thinking: utf8.encode("plan"), deltaSignature: utf8.encode("sealed.v1.") }),
    );
    aggregator.push(frame({ deltaSignature: utf8.encode("abc"), deltaSignatureType: "sealed" }));

    const thought = (aggregator.finish("swe-2", "interaction_1").interaction as { steps: Json[] })
      .steps[0];

    expect(thought).toMatchObject({
      signature: "sealed.v1.abc",
      thought_signature: "sealed.v1.abc",
      signature_type: "sealed",
    });
  });
});

describe("parseInteractionsPayload: typed GPT reasoning (cb5f62f7)", () => {
  const thought = (signature: string, signatureType?: string): Json => ({
    type: "thought",
    content: [{ type: "text", text: "plan" }],
    signature,
    ...(signatureType === undefined ? {} : { signature_type: signatureType }),
  });

  it("sends the list verbatim, typed openai, as its own turn after a signed one", () => {
    const { prompts } = parseInteractionsPayload(
      json({
        input: [
          { type: "user_input", content: "q" },
          thought(OPENAI_LIST, "openai"),
          { type: "function_call", id: "c1", name: "f", arguments: {} },
          { type: "function_result", call_id: "c1", result: "r" },
          thought(OPENAI_LIST, "openai"),
          thought(OPENAI_LIST, "openai"),
        ],
      }),
      undefined,
    );

    const assistants = prompts.filter((prompt) => prompt.source === 2);

    expect(assistants.map((prompt) => new TextDecoder().decode(prompt.signature))).toEqual([
      OPENAI_LIST,
      OPENAI_LIST,
      OPENAI_LIST,
    ]);
    expect(assistants.every((prompt) => prompt.signatureType === "openai")).toBe(true);
  });

  it("parses an untyped list like any other signature", () => {
    const { prompts } = parseInteractionsPayload(
      json({ input: [{ type: "user_input", content: "q" }, thought(OPENAI_LIST)] }),
      undefined,
    );

    expect(prompts[1]?.signatureType).not.toBe("openai");
  });
});
