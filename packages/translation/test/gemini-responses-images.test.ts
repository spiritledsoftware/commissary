// Gemini inline images -> Responses image_generation_call items (upstream 0f8c40e1). Expected values come from the Go
// tests of that commit (gemini_openai-responses_response_test.go, the *7569 cases).
import { describe, expect, it } from "vite-plus/test";
import { get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const context = (model: string) => ({
  model,
  originalRequest: undefined,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

interface SseEvent {
  readonly event: string;
  readonly data: Json;
}

/** Every SSE event of the chunks, with its parsed data. */
const events = (chunks: ReadonlyArray<string>): SseEvent[] =>
  chunks.flatMap((chunk) =>
    chunk
      .split("\n\n")
      .filter((block) => block.trim() !== "")
      .map((block) => {
        const lines = block.split("\n");
        const event = (lines.find((line) => line.startsWith("event: ")) ?? "").slice(7);
        const data = (lines.find((line) => line.startsWith("data: ")) ?? "").slice(6);

        return { event, data: tryParseJson(data) ?? null };
      }),
  );

const nonStream = (model: string, body: Json): Json =>
  tryParseJson(
    builtinTranslators.translateNonStream(
      "openai-response",
      "gemini",
      context(model),
      JSON.stringify(body),
    ) ?? "",
  ) ?? null;

const outputsOfType = (response: Json, type: string): Json[] => {
  const output = get(response, "output");

  return isJsonArray(output) ? output.filter((item) => get(item, "type") === type) : [];
};

const DRAFT = "RFJBRlQiW0FHRS1QUkQ=";

const FINAL = "RklOQUxfSU1BR0U=";

describe("Gemini inline images become image_generation_call items (0f8c40e1)", () => {
  it("streams the final image once and keeps the thinking draft out", () => {
    const model = "gemini-3.1-flash-image";
    const ctx = context(model);

    const lines = [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ thought: true, inlineData: { mimeType: "image/png", data: DRAFT } }],
            },
          },
        ],
        modelVersion: model,
        responseId: "resp_7569",
      })}`,
      `data: ${JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "image/png", data: FINAL } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1120, totalTokenCount: 1123 },
        modelVersion: model,
        responseId: "resp_7569",
      })}`,
      "[DONE]",
    ];

    const all = events(
      lines.flatMap((line) =>
        builtinTranslators.translateStream("openai-response", "gemini", ctx, line),
      ),
    );

    const imageEvents = (name: string): SseEvent[] =>
      all.filter(
        ({ event, data }) => event === name && get(data, "item.type") === "image_generation_call",
      );

    const added = imageEvents("response.output_item.added");
    const done = imageEvents("response.output_item.done");

    expect(added).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(get(added[0]?.data, "item.output_format")).toBe("png");
    expect(get(done[0]?.data, "item.output_format")).toBe("png");
    expect(get(done[0]?.data, "item.result")).toBe(FINAL);
    expect(JSON.stringify(all)).not.toContain(DRAFT);

    const completed = all.find(({ event }) => event === "response.completed");
    const images = outputsOfType(get(completed?.data, "response") ?? null, "image_generation_call");

    expect(images).toHaveLength(1);
    expect(get(images[0], "result")).toBe(FINAL);
  });

  it("returns the image in non-streamed output", () => {
    const out = nonStream("gemini-3.1-flash-image", {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "image/png", data: FINAL } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1120, totalTokenCount: 1123 },
      modelVersion: "gemini-3.1-flash-image",
      responseId: "resp_7569",
    });

    const images = outputsOfType(out, "image_generation_call");

    expect(images).toHaveLength(1);
    expect(get(images[0], "result")).toBe(FINAL);
    expect(get(images[0], "output_format")).toBe("png");
  });

  it("does not report non-image inline data as an image", () => {
    const out = nonStream("gemini-test", {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAA" } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 10, totalTokenCount: 13 },
      modelVersion: "gemini-test",
      responseId: "resp_7569b",
    });

    expect(outputsOfType(out, "image_generation_call")).toHaveLength(0);
  });

  it("keeps the thought signature of a signed image part", () => {
    const out = nonStream("gemini-3-pro-image", {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                inlineData: { mimeType: "image/jpeg", data: "Ymll" },
                thoughtSignature: "EjQKDg==",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 100, totalTokenCount: 103 },
      modelVersion: "gemini-3-pro-image",
      responseId: "resp_7569c",
    });

    const images = outputsOfType(out, "image_generation_call");

    expect(get(images[0], "output_format")).toBe("jpeg");
    expect(outputsOfType(out, "reasoning")).not.toHaveLength(0);
  });
});
