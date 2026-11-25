// The Responses input token counter shared by Codex, Meta and OpenCode (Go codex_executor_tokens.go
// countCodexInputTokens at 1ef770d9): string inputs, untyped messages and string message content count too.
import { describe, expect, it } from "vite-plus/test";
import { getCodec } from "@commissary/translation/tokenizer";
import { countCodexInputTokens } from "../../src/executor/helps/token-count.ts";

const codec = getCodec("o200k_base");

const count = (body: Parameters<typeof countCodexInputTokens>[1]) =>
  countCodexInputTokens(codec, body);

describe("countCodexInputTokens", () => {
  it("counts a string input", () => {
    expect(count({ input: "plain string content" })).toBe(
      count({ instructions: "plain string content" }),
    );
    expect(count({ input: "   " })).toBe(0);
  });

  it("counts a message's string content", () => {
    expect(
      count({ input: [{ type: "message", role: "user", content: "plain string content" }] }),
    ).toBe(count({ input: "plain string content" }));
  });

  it("treats an untyped item with a role and content as a message", () => {
    expect(
      count({ input: [{ role: "user", content: [{ type: "input_text", text: "hello there" }] }] }),
    ).toBe(count({ input: "hello there" }));
    // Without a role it falls back to the item's own text.
    expect(count({ input: [{ content: "ignored", text: "loose text" }] })).toBe(
      count({ input: "loose text" }),
    );
  });
});
