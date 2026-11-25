// Go 1f76e479 (codex_claude_response_test.go): a Codex policy block in the stream reaches Claude clients as an
// `invalid_request_error` with the official copy when the upstream names only its code.
import { get, type Json, tryParseJson } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import { convertCodexResponseToClaude } from "../src/translator/codex/claude/response.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

const claudeError = (event: Json) => {
  const chunks = convertCodexResponseToClaude(
    {
      model: "gpt-5",
      originalRequest: { messages: [] },
      translatedRequest: undefined,
      state: makeTranslationState(),
    },
    `data: ${JSON.stringify(event)}`,
  );

  const data = chunks
    .join("")
    .split("\n")
    .find((line) => line.startsWith("data: "));

  return get(tryParseJson(data?.slice(6) ?? ""), "error");
};

describe("Codex policy errors in the Claude stream (Go 1f76e479)", () => {
  it("fills the message of a code-only policy block and marks it a request fault", () => {
    expect(claudeError({ type: "error", error: { code: "bio_policy" } })).toEqual({
      type: "invalid_request_error",
      message: "This content was flagged for possible biological risk.",
    });
    expect(
      claudeError({
        type: "error",
        error: { type: "server_error", code: "cyber_policy_violation" },
      }),
    ).toEqual({
      type: "invalid_request_error",
      message: "This request has been flagged for possible cybersecurity risk.",
    });
  });

  it("keeps an upstream message and other codes as they are", () => {
    expect(
      claudeError({ type: "error", error: { code: "content_policy_violation", message: "no" } }),
    ).toEqual({ type: "invalid_request_error", message: "no" });
    expect(claudeError({ type: "error", error: { code: "other_code" } })).toEqual({
      type: "api_error",
      message: "other_code",
    });
  });
});
