// Responses -> OpenAI Chat: developer messages keep their role and position (ticket C8; upstream 00b76771).
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

const convert = (body: Json, stream: boolean): Json =>
  builtinTranslators.translateRequest(
    "openai-response",
    "openai",
    { format: "openai-response", model: "test-model", stream, body },
    undefined,
  ).body;

const textOf = (message: Json | undefined): Json | undefined => {
  const content = get(message, "content");

  return Array.isArray(content) ? get(content[0], "text") : content;
};

describe("Responses -> OpenAI Chat: instruction roles", () => {
  const wantRoles = [
    "system",
    "system",
    "developer",
    "user",
    "assistant",
    "developer",
    "user",
    "developer",
  ];

  const wantTexts = [
    "base instructions",
    "session instructions",
    "mode: plan",
    "mode: default is only user text",
    "acknowledged",
    "mode: default",
    "continue",
    "mode: plan",
  ];

  it.each([
    { stream: false, arrayContent: false },
    { stream: false, arrayContent: true },
    { stream: true, arrayContent: false },
    { stream: true, arrayContent: true },
  ])("stream=$stream array=$arrayContent", ({ stream, arrayContent }) => {
    const input = wantRoles.slice(1).map((role, offset) => {
      const text = wantTexts[offset + 1] as string;

      const content = arrayContent
        ? [{ type: role === "assistant" ? "output_text" : "input_text", text }]
        : text;

      return { type: "message", role, content };
    });

    const out = convert({ instructions: wantTexts[0] ?? "", input }, stream);
    const messages = get(out, "messages") as Json[];

    expect(get(out, "stream") === true).toBe(stream);
    expect(messages.map((message) => get(message, "role"))).toEqual(wantRoles);
    expect(messages.map(textOf)).toEqual(wantTexts);
  });

  it("keeps a developer message between tool calls and the next user turn", () => {
    const out = convert(
      {
        instructions: "base instructions",
        input: [
          { role: "developer", content: "mode: plan" },
          { role: "user", content: "mode: default is only user text" },
          { role: "developer", content: [{ type: "input_text", text: "mode: default" }] },
          { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "read-only result" },
          { role: "developer", content: "mode: plan" },
          { role: "user", content: "continue" },
        ],
        tools: [
          { type: "function", name: "inspect", parameters: { type: "object", properties: {} } },
        ],
      },
      false,
    );

    const messages = get(out, "messages") as Json[];

    expect(messages.map((message) => get(message, "role"))).toEqual([
      "system",
      "developer",
      "user",
      "developer",
      "assistant",
      "tool",
      "developer",
      "user",
    ]);
    expect(get(messages[4], "tool_calls.0.id")).toBe("call_1");
    expect(get(messages[5], "tool_call_id")).toBe("call_1");
  });
});
