// Assistant-prefill drop of the Responses -> Claude request translator (Go:
// internal/translator/claude/openai/responses/claude_openai-responses_request_test.go,
// TestConvertOpenAIResponsesRequestToClaude_{Unsupported,Supported}PrefillModels*).
import { describe, expect, it } from "vitest";
import type { Json } from "@commissary/json";
import { get } from "@commissary/json";
import { convertOpenAIResponsesRequestToClaude } from "../src/translator/claude/openai/responses/request.ts";

const messagesFor = (model: string): Json[] => {
  const out = convertOpenAIResponsesRequestToClaude(
    model,
    {
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "prefill" }] },
      ],
    },
    false,
  );

  const messages = get(out, "messages");

  return Array.isArray(messages) ? messages : [];
};

describe("assistant prefill models", () => {
  it.each([
    "claude-haiku-5-5",
    "claude-haiku-5",
    "claude-haiku-5.5",
    "haiku-5-5",
    "anthropic/claude-haiku-5-5",
  ])("%s drops the trailing assistant message", (model) => {
    const messages = messagesFor(model);

    expect(messages).toHaveLength(1);
    expect(get(messages[0], "role")).toBe("user");
  });

  it.each(["claude-haiku-4-5", "claude-haiku-5foo", "claude-haiku-20260217"])(
    "%s keeps the trailing assistant message",
    (model) => {
      const messages = messagesFor(model);

      expect(messages).toHaveLength(2);
      expect(get(messages[1], "role")).toBe("assistant");
    },
  );
});
