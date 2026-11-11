// Gemini ingress role normalisation (ticket C8; upstream c888ff72): omitted, unknown, `function` and `tool` roles, snake_case
// function parts, and no empty trailing message after a functionResponse-only turn.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";

const translate = (to: "openai" | "claude" | "codex", model: string, body: Json): Json =>
  builtinTranslators.translateRequest(
    "gemini",
    to,
    { format: "gemini", model, stream: false, body },
    undefined,
  ).body;

const roles = (out: Json, path: string): unknown[] => {
  const items = get(out, path);

  return Array.isArray(items) ? items.map((item) => get(item, "role")) : [];
};

describe("Gemini -> OpenAI Chat", () => {
  it("does not append an empty message after a functionResponse-only turn", () => {
    const out = translate("openai", "test-model", {
      contents: [
        { parts: [{ text: "What is the weather?" }] },
        { parts: [{ functionCall: { name: "get_weather", args: { city: "Tokyo" } } }] },
        {
          role: "function",
          parts: [{ functionResponse: { name: "get_weather", response: { result: "Sunny" } } }],
        },
      ],
    });

    expect(roles(out, "messages")).toEqual(["user", "assistant", "tool"]);
  });

  it("defaults omitted and unknown roles, inferring from function parts and alternating", () => {
    const out = translate("openai", "test-model", {
      contents: [
        { parts: [{ text: "Reply with exactly: OK" }] },
        { role: "invalid", parts: [{ text: "OK" }] },
        { parts: [{ function_call: { name: "ping", args: { x: 1 } } }] },
        { parts: [{ function_response: { name: "ping", response: { result: "pong" } } }] },
      ],
    });

    expect(roles(out, "messages")).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(get(out, "messages.2.tool_calls.0.function.name")).toBe("ping");
  });

  it("treats a tool role as user", () => {
    const out = translate("openai", "test-model", {
      contents: [{ role: "tool", parts: [{ text: "from a tool" }] }],
    });

    expect(roles(out, "messages")).toEqual(["user"]);
  });
});

describe("Gemini -> Claude", () => {
  it("defaults an omitted role to user", () => {
    const out = translate("claude", "claude-sonnet-4-5", {
      contents: [{ parts: [{ text: "Reply with exactly: OK" }] }],
    });

    expect(get(out, "messages.0.role")).toBe("user");
  });

  it("reads snake_case function parts of omitted-role turns", () => {
    const out = translate("claude", "claude-sonnet-4-5", {
      contents: [
        { parts: [{ text: "ping?" }] },
        { parts: [{ function_call: { name: "ping", args: { x: 1 } } }] },
        { parts: [{ function_response: { name: "ping", response: { result: "pong" } } }] },
      ],
    });

    expect(roles(out, "messages")).toEqual(["user", "assistant", "user"]);
    expect(get(out, "messages.1.content.0.type")).toBe("tool_use");
    expect(get(out, "messages.1.content.0.name")).toBe("ping");
    expect(get(out, "messages.2.content.0.type")).toBe("tool_result");
    expect(get(out, "messages.2.content.0.tool_use_id")).toBe(get(out, "messages.1.content.0.id"));
  });
});

describe("Gemini -> Codex", () => {
  it("defaults an omitted role to user", () => {
    const out = translate("codex", "gpt-5.1-codex", {
      contents: [{ parts: [{ text: "Reply with exactly: OK" }] }],
    });

    expect(get(out, "input.0.role")).toBe("user");
    expect(get(out, "input.0.content.0.type")).toBe("input_text");
    expect(get(out, "input.0.content.0.text")).toBe("Reply with exactly: OK");
  });

  it("reads snake_case function parts", () => {
    const out = translate("codex", "gpt-5.1-codex", {
      contents: [
        { parts: [{ function_call: { name: "ping", args: { x: 1 } } }] },
        { parts: [{ function_response: { name: "ping", response: { result: "pong" } } }] },
      ],
    });

    expect(get(out, "input.0.type")).toBe("function_call");
    expect(get(out, "input.0.name")).toBe("ping");
    expect(get(out, "input.1.type")).toBe("function_call_output");
    expect(get(out, "input.1.output")).toBe("pong");
    expect(get(out, "input.1.call_id")).toBe(get(out, "input.0.call_id"));
  });
});
