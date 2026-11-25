// OpenAI Responses -> Chat Completions: files and media in tool outputs (Go:
// internal/translator/openai/openai/responses/openai_openai-responses_request_test.go,
// TestConvertOpenAIResponsesRequestToOpenAIChatCompletions_ToolOutputFilesAndMedia; upstream f08cb931).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { UnsupportedPartError } from "../src/translator/common/parts.ts";
import { convertOpenAIResponsesRequestToOpenAIChatCompletions } from "../src/translator/openai/openai/responses/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const convert = (text: string): Json =>
  convertOpenAIResponsesRequestToOpenAIChatCompletions("gpt-5", parse(text), false);

/** The translation's unsupported-part refusal, or undefined when it translates; other errors propagate. */
const rejection = (text: string): UnsupportedPartError | undefined => {
  try {
    convert(text);
  } catch (error) {
    if (error instanceof UnsupportedPartError) return error;
    throw error;
  }

  return undefined;
};

describe("Responses -> Chat tool output files and media (f08cb931)", () => {
  it("keeps an array function_call_output's tool message text-only and relays input_file to a user message", () => {
    const out = convert(`{
      "model": "gpt-5",
      "input": [
        {"type": "function_call", "call_id": "call_pdf", "name": "fetch_pdf", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_pdf", "output": [
          {"type": "input_text", "text": "Loaded PDF"},
          {"type": "input_file", "filename": "report.pdf", "file_data": "data:application/pdf;base64,JVBERi0xLjQK"}
        ]}
      ]
    }`);

    expect(get(out, "messages.1")).toEqual({
      role: "tool",
      tool_call_id: "call_pdf",
      content: "Loaded PDF",
    });
    expect(get(out, "messages.2")).toEqual({
      role: "user",
      content: [
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            filename: "report.pdf",
          },
        },
      ],
    });
  });

  it("keeps every parallel tool message paired before the relayed user file message", () => {
    const out = convert(`{
      "model": "gpt-5",
      "input": [
        {"type": "function_call", "call_id": "call_1", "name": "fetch_pdf", "arguments": "{}"},
        {"type": "function_call", "call_id": "call_2", "name": "ping", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_1", "output": {"type": "input_file", "file_id": "file-123", "filename": "report.pdf"}},
        {"type": "function_call_output", "call_id": "call_2", "output": "pong"}
      ]
    }`);

    const messages = get(out, "messages");

    expect(Array.isArray(messages) ? messages.length : 0).toBe(4);
    expect(get(out, "messages.1.role")).toBe("tool");
    expect(get(out, "messages.2.role")).toBe("tool");
    expect(get(out, "messages.3.role")).toBe("user");
    expect(get(out, "messages.3.content.0.type")).toBe("file");
    expect(get(out, "messages.3.content.0.file.file_id")).toBe("file-123");
  });

  it("relays single-object input_file and input_image outputs to user messages, keeping tool messages text-only", () => {
    const out = convert(`{
      "model": "gpt-5",
      "input": [
        {"type": "function_call", "call_id": "call_pdf", "name": "fetch_pdf", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_pdf", "output": {"type": "input_file", "file_id": "file-123", "filename": "report.pdf"}},
        {"type": "function_call", "call_id": "call_img", "name": "view_image", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_img", "output": {"type": "input_image", "image_url": "data:image/png;base64,AA=="}}
      ]
    }`);

    expect(get(out, "messages.1.role")).toBe("tool");
    expect(get(out, "messages.1.content")).toBeTypeOf("string");
    expect(get(out, "messages.2.role")).toBe("user");
    expect(get(out, "messages.2.content.0.type")).toBe("file");
    expect(get(out, "messages.2.content.0.file.file_id")).toBe("file-123");
    expect(get(out, "messages.4.role")).toBe("tool");
    expect(get(out, "messages.4.content")).toBeTypeOf("string");
    expect(get(out, "messages.5.role")).toBe("user");
    expect(get(out, "messages.5.content.0.type")).toBe("image_url");
    expect(get(out, "messages.5.content.0.image_url.url")).toBe("data:image/png;base64,AA==");
  });

  it("keeps a mixed file and image array's tool message text-only and relays both to a user message", () => {
    const out = convert(`{
      "model": "gpt-5",
      "input": [
        {"type": "function_call", "call_id": "call_mix", "name": "inspect", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_mix", "output": [
          {"type": "input_text", "text": "Attached PDF and image"},
          {"type": "input_file", "file_id": "file-123", "filename": "report.pdf"},
          {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
        ]}
      ]
    }`);

    expect(get(out, "messages.1.role")).toBe("tool");
    expect(get(out, "messages.1.content")).toBe("Attached PDF and image");
    expect(get(out, "messages.2.role")).toBe("user");
    expect(get(out, "messages.2.content.0.type")).toBe("file");
    expect(get(out, "messages.2.content.1.type")).toBe("image_url");
    expect(get(out, "messages.2.content.2")).toBeUndefined();
  });

  describe("rejects unsupported binary modalities in function_call_output", () => {
    const call = `{"type":"function_call","call_id":"c1","name":"f","arguments":"{}"}`;

    const cases: ReadonlyArray<{ name: string; output: string; wantType: string }> = [
      {
        name: "file_url-only input_file in array output",
        output: `[{"type":"input_file","file_url":"https://example.test/a.pdf"}]`,
        wantType: "input_file",
      },
      {
        name: "mixed valid file with unconvertible file_id image",
        output: `[{"type":"input_file","file_id":"file-document"},{"type":"input_image","file_id":"file-image","detail":"auto"}]`,
        wantType: "input_image",
      },
      {
        name: "input_audio object output",
        output: `{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}`,
        wantType: "input_audio",
      },
      {
        name: "malformed image before input_audio still rejects",
        output: `[{"type":"input_image","detail":"low"},{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]`,
        wantType: "input_audio",
      },
      {
        name: "input_audio before malformed image still rejects",
        output: `[{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}},{"type":"input_image","detail":"low"}]`,
        wantType: "input_audio",
      },
    ];

    for (const tc of cases) {
      it(tc.name, () => {
        const error = rejection(
          `{"model":"gpt-5","input":[${call},{"type":"function_call_output","call_id":"c1","output":${tc.output}}]}`,
        );

        expect(error?.partType).toBe(tc.wantType);
        expect(error?.status).toBe(400);
      });
    }
  });

  it("propagates an orphan output's unsupported part", () => {
    const error = rejection(
      `{"model":"gpt-5","input":[{"type":"function_call_output","call_id":"orphan","output":{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}}]}`,
    );

    expect(error?.partType).toBe("input_audio");
  });
});
