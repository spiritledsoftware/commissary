// Gemini client -> OpenAI Chat, Codex, Claude and Interactions: media nested in a functionResponse is relayed, not
// dropped (upstream 34d8fe0f). Expected values come from the Go tests of that commit (the *_FunctionResponsePartsMedia
// tests of openai_gemini_request_test.go, codex_gemini_request_test.go, claude_gemini_request_test.go and
// interactions_gemini_common_test.go).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, type JsonObject } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

const translate = (to: string, model: string, body: Json): Json =>
  builtinTranslators.translateRequest("gemini", to, {
    format: "gemini",
    model,
    stream: false,
    body,
  }).body ?? null;

const PNG = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } };

const PDF = { inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } };

/** A tool call whose response carries an image and a PDF beside its result; `id` is the call id, if any. */
const imageAndPdf = (id?: string): Json => {
  const functionCall: JsonObject = { name: "read_files", args: {} };

  const functionResponse: JsonObject = {
    name: "read_files",
    response: { result: "Loaded files" },
    parts: [PNG, PDF],
  };

  if (id !== undefined) {
    functionCall["id"] = id;
    functionResponse["id"] = id;
  }

  return {
    contents: [
      { role: "user", parts: [{ text: "Read red.png and doc.pdf" }] },
      { role: "model", parts: [{ functionCall }] },
      { role: "user", parts: [{ functionResponse }] },
    ],
  };
};

/** A tool call whose empty response carries only a remote file. */
const mediaOnly = (name: string, mimeType: string, fileUri: string, extra: Json[] = []): Json => ({
  contents: [
    { role: "model", parts: [{ functionCall: { name, id: "call_2", args: {} } }] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name,
            id: "call_2",
            response: {},
            parts: [{ fileData: { mimeType, fileUri } }],
          },
        },
        ...extra,
      ],
    },
  ],
});

describe("OpenAI Chat: media goes in a user message after the tool batch", () => {
  it("relays an image and a PDF after the tool message", () => {
    const messages = get(translate("openai", "gpt-5", imageAndPdf()), "messages");

    expect(messages).toHaveLength(4);
    expect(get(messages, "2.role")).toBe("tool");
    expect(get(messages, "3.role")).toBe("user");
    const parts = get(messages, "3.content");

    expect(parts).toHaveLength(3);
    expect(get(parts, "0.type")).toBe("text");
    expect(get(parts, "0.text")).not.toBe("");
    expect(get(parts, "1")).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
    expect(get(parts, "2.type")).toBe("file");
    expect(get(parts, "2.file.file_data")).toBe("data:application/pdf;base64,JVBERi0xLjQK");
    expect(get(parts, "2.file.filename")).toBe("document.pdf");
  });

  it("gives a media-only tool message a placeholder and merges the relay with the user's text", () => {
    const messages = get(
      translate(
        "openai",
        "gpt-5",
        mediaOnly("read_image", "image/jpeg", "https://example.com/a.jpg", [
          { text: "What color is it?" },
        ]),
      ),
      "messages",
    );

    expect(messages).toHaveLength(3);
    expect(get(messages, "1.role")).toBe("tool");
    expect(get(messages, "1.content")).not.toBe("");
    expect(get(messages, "1.content")).not.toBe("{}");
    const parts = get(messages, "2.content");

    expect(parts).toHaveLength(3);
    expect(get(parts, "1.image_url.url")).toBe("https://example.com/a.jpg");
    expect(get(parts, "2")).toEqual({ type: "text", text: "What color is it?" });
  });

  it("keeps parallel tool messages contiguous across adjacent turns", () => {
    const messages = get(
      translate("openai", "gpt-5", {
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { name: "read_a", id: "call_a", args: {} } },
              { functionCall: { name: "read_b", id: "call_b", args: {} } },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "read_a",
                  id: "call_a",
                  response: { result: "a" },
                  parts: [{ inlineData: { mimeType: "image/png", data: "QUFB" } }],
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { name: "read_b", id: "call_b", response: { result: "b" } } },
            ],
          },
        ],
      }),
      "messages",
    );

    expect(messages).toHaveLength(4);
    expect([get(messages, "1.tool_call_id"), get(messages, "2.tool_call_id")]).toEqual([
      "call_a",
      "call_b",
    ]);
    expect(get(messages, "3.role")).toBe("user");
    expect(get(messages, "3.content.1.image_url.url")).toBe("data:image/png;base64,QUFB");
  });
});

describe("Codex: media goes in the function_call_output content list", () => {
  it("lists the result text, the image and the PDF", () => {
    const output = get(translate("codex", "gpt-5.1-codex", imageAndPdf()), "input.2");

    expect(get(output, "type")).toBe("function_call_output");
    expect(get(output, "output")).toEqual([
      { type: "input_text", text: "Loaded files" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBERi0xLjQK",
        filename: "document.pdf",
      },
    ]);
  });

  it("lists a remote image alone for an empty response", () => {
    expect(
      get(
        translate(
          "codex",
          "gpt-5.1-codex",
          mediaOnly("fetch_image", "image/jpeg", "https://example.com/a.jpg"),
        ),
        "input.1.output",
      ),
    ).toEqual([{ type: "input_image", image_url: "https://example.com/a.jpg" }]);
  });
});

describe("Claude: media goes in the tool_result content blocks", () => {
  it("lists the result text, the image and the PDF", () => {
    const toolResult = get(
      translate("claude", "claude-sonnet-4-6", imageAndPdf()),
      "messages.2.content.0",
    );

    expect(get(toolResult, "type")).toBe("tool_result");
    expect(get(toolResult, "content")).toEqual([
      { type: "text", text: "Loaded files" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
      },
    ]);
  });

  it("lists a remote image alone for an empty response", () => {
    expect(
      get(
        translate(
          "claude",
          "claude-sonnet-4-6",
          mediaOnly("fetch_image", "image/jpeg", "https://example.com/a.jpg"),
        ),
        "messages.1.content.0.content",
      ),
    ).toEqual([{ type: "image", source: { type: "url", url: "https://example.com/a.jpg" } }]);
  });
});

describe("Interactions: media goes in the function_result content list", () => {
  it("lists the result text, the image and the PDF", () => {
    const step = get(
      translate("interactions", "gemini-3.5-flash", {
        model: "gemini-3.5-flash",
        ...(imageAndPdf("call_1") as Record<string, Json>),
      }),
      "input.2",
    );

    expect(get(step, "type")).toBe("function_result");
    expect(get(step, "result")).toEqual([
      { type: "text", text: "Loaded files" },
      { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
      { type: "document", mime_type: "application/pdf", data: "JVBERi0xLjQK" },
    ]);
  });

  it("lists a remote audio file alone for an empty response", () => {
    const result = get(
      translate("interactions", "gemini-3.5-flash", {
        model: "gemini-3.5-flash",
        ...(mediaOnly("fetch_audio", "audio/wav", "https://example.com/a.wav") as Record<
          string,
          Json
        >),
      }),
      "input.1.result",
    );

    expect(result).toHaveLength(1);
    expect(get(result, "0.type")).toBe("audio");
    expect(get(result, "0.uri")).toBe("https://example.com/a.wav");
  });
});
