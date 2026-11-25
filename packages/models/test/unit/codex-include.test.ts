// Responses include values by upstream backend (Go helps/codex_include_test.go, 7f22743a).
import { describe, expect, it } from "vite-plus/test";
import {
  CODEX_ONLY_INCLUDES,
  isChatGPTCodexBackendBaseUrl,
  preserveCodexOpenAIResponsesInclude,
  stripResponsesIncludeValues,
} from "../../src/executor/helps/codex-include.ts";

describe("isChatGPTCodexBackendBaseUrl", () => {
  it("recognises the ChatGPT Codex backend and fails closed", () => {
    expect(isChatGPTCodexBackendBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isChatGPTCodexBackendBaseUrl("https://ChatGPT.com./backend-api/codex/")).toBe(true);
    expect(isChatGPTCodexBackendBaseUrl("")).toBe(true);
    expect(isChatGPTCodexBackendBaseUrl("::not a url")).toBe(true);
    expect(isChatGPTCodexBackendBaseUrl("https://chatgpt.com/backend-api/codexy")).toBe(false);
    expect(isChatGPTCodexBackendBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});

describe("preserveCodexOpenAIResponsesInclude", () => {
  it("restores the requested official values only when a platform-only one is asked for", () => {
    const body = { include: ["reasoning.encrypted_content"] };

    expect(
      preserveCodexOpenAIResponsesInclude(
        body,
        { include: ["output.encrypted_content", 3, "code_interpreter_call.outputs", "x"] },
        "openai-response",
      ),
    ).toEqual({
      include: [
        "reasoning.encrypted_content",
        "code_interpreter_call.outputs",
        "output.encrypted_content",
      ],
    });
    // Nothing platform-only, or another source format: unchanged.
    expect(
      preserveCodexOpenAIResponsesInclude(
        { include: ["reasoning.encrypted_content"] },
        { include: ["web_search_call.results"] },
        "openai-response",
      ),
    ).toEqual({ include: ["reasoning.encrypted_content"] });
    expect(
      preserveCodexOpenAIResponsesInclude(
        { include: [] },
        { include: ["file_search_call.results"] },
        "claude",
      ),
    ).toEqual({ include: [] });
  });
});

describe("stripResponsesIncludeValues", () => {
  it("drops the Codex-only values, keeping order, and the field once empty", () => {
    expect(
      stripResponsesIncludeValues(
        {
          include: [
            "reasoning.encrypted_content",
            "web_search_call.results",
            "web_search_call.action.sources",
            "output.encrypted_content",
          ],
        },
        CODEX_ONLY_INCLUDES,
      ),
    ).toEqual({ include: ["reasoning.encrypted_content", "web_search_call.action.sources"] });
    expect(
      stripResponsesIncludeValues(
        { include: ["output.encrypted_content"], a: 1 },
        CODEX_ONLY_INCLUDES,
      ),
    ).toEqual({ a: 1 });
  });
});
