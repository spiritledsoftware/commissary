// Gemini -> OpenAI Chat Completions: thinking draft images (`thought: true` inline data) stay out of `images`
// (upstream 6684f3b5). Expected values come from the Go tests of that commit as they stand at dd543d09, where a
// finishing chunk is followed by its own terminal chunk (8cd6817b).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

/** One translated stream: each `send` translates one upstream chunk and parses what it emits. */
const stream = (model: string): ((chunk: Json) => Json[]) => {
  const ctx = {
    model,
    originalRequest: undefined,
    translatedRequest: undefined,
    state: makeTranslationState(),
  };

  return (chunk) =>
    builtinTranslators
      .translateStream("openai", "gemini", ctx, JSON.stringify(chunk))
      .map((out) => tryParseJson(out) ?? null);
};

const DRAFT = "RFJBRlRfSU1BR0U=";

const FINAL = "RklOQUxfSU1BR0U=";

const FINAL_URL = `data:image/png;base64,${FINAL}`;

const frame = (parts: Json[], extra: Record<string, Json> = {}): Json => ({
  candidates: [{ index: 0, content: { role: "model", parts }, ...extra }],
  cpaUsageMetadata: { promptTokenCount: 12 },
  modelVersion: "gemini-3-pro-image",
  responseId: "resp_7566",
});

describe("thinking draft images are skipped (6684f3b5)", () => {
  it("non-streamed: only the final image, reasoning text intact", () => {
    const out = tryParseJson(
      builtinTranslators.translateNonStream(
        "openai",
        "gemini",
        {
          model: "gemini-3-pro-image",
          originalRequest: undefined,
          translatedRequest: undefined,
          state: makeTranslationState(),
        },
        JSON.stringify({
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "**Rendering objects realistically** I'm focusing on the apple.",
                  },
                  { thought: true, inlineData: { mimeType: "image/png", data: DRAFT } },
                  { thought: true, text: "**Refining Image Details** Adjusting highlights." },
                  {
                    inlineData: { mimeType: "image/png", data: FINAL },
                    thoughtSignature: "EjQKDg==",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 1120,
            thoughtsTokenCount: 584,
            totalTokenCount: 1716,
          },
        }),
      ) ?? "",
    );

    expect(get(out ?? null, "choices.0.message.content")).toBeNull();
    expect(get(out ?? null, "choices.0.message.reasoning_content")).toBe(
      "**Rendering objects realistically** I'm focusing on the apple.**Refining Image Details** Adjusting highlights.",
    );
    expect(get(out ?? null, "choices.0.message.images")).toEqual([
      { index: 0, type: "image_url", image_url: { url: FINAL_URL } },
    ]);
  });

  it("streamed over several frames: the draft frame emits nothing", () => {
    const send = stream("gemini-3-pro-image");

    const first = send(frame([{ thought: true, text: "**Rendering objects realistically** " }]));

    expect(first).toHaveLength(1);
    expect(get(first[0] ?? null, "choices.0.delta.images")).toBeUndefined();
    expect(
      send(frame([{ thought: true, inlineData: { mimeType: "image/png", data: DRAFT } }])),
    ).toEqual([]);
    expect(send(frame([{ thought: true, text: "**Refining Image Details**" }]))).toHaveLength(1);

    const last = send({
      ...(frame(
        [{ inlineData: { mimeType: "image/png", data: FINAL }, thoughtSignature: "EjQKDg==" }],
        { finishReason: "STOP" },
      ) as Record<string, Json>),
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 1120,
        thoughtsTokenCount: 584,
        totalTokenCount: 1716,
      },
    });

    expect(last).toHaveLength(2);
    expect(get(last[0] ?? null, "choices.0.delta.images")).toMatchObject([
      { index: 0, image_url: { url: FINAL_URL } },
    ]);
    expect(get(last[1] ?? null, "choices.0.finish_reason")).toBe("stop");
  });

  it("streamed in one frame: only the final image, at index 0", () => {
    const out = stream("gemini-nano-banana-2.1")({
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [
              { thought: true, text: "Drafting. " },
              { thought: true, inline_data: { mime_type: "image/png", data: DRAFT } },
              { thought: true, text: "Refining." },
              { inlineData: { mimeType: "image/png", data: FINAL } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 50,
        totalTokenCount: 160,
      },
    });

    expect(out).toHaveLength(2);
    expect(get(out[0] ?? null, "choices.0.delta.reasoning_content")).toBe("Drafting. Refining.");
    expect(get(out[0] ?? null, "choices.0.delta.images")).toMatchObject([
      { index: 0, image_url: { url: FINAL_URL } },
    ]);
  });

  it("a signature after a draft image does not attach to an earlier tool call", () => {
    const send = stream("gemini-3-pro-image");
    const outputs: Json[] = [];

    outputs.push(
      ...send({
        candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] } }],
      }),
    );

    const draft = send({
      candidates: [
        {
          content: {
            parts: [{ thought: true, inlineData: { mimeType: "image/png", data: "eA==" } }],
          },
        },
      ],
    });

    expect(draft).toEqual([]);
    outputs.push(
      ...send({ candidates: [{ content: { parts: [{ thoughtSignature: "EjQKDg==" }] } }] }),
    );

    for (const output of outputs)
      expect(get(output, "choices.0.delta.tool_calls.0.extra_content")).toBeUndefined();
  });
});
