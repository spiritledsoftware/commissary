// Claude client -> OpenAI-compatible executor: placeholder reasoning_content on tool-call turns, reconciled after
// thinking resolution so suffixes and payload rules govern it (Go: internal/runtime/executor/
// openai_compat_executor_reasoning_test.go; upstream 0e0cab0d).
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";

const MODEL = "deepseek-v4-flash";

const rules = (kind: "override" | "filter", params: string): string => `
requests:
  payload:
    ${kind}:
      - models: [{ name: "${MODEL}", protocol: openai }]
        params:${params}
`;

const claudeBody = (thinking: Json): Json =>
  json({
    model: MODEL,
    thinking,
    messages: [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_time", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "12:00" }] },
    ],
  });

const ENABLED = claudeBody({ type: "enabled", budget_tokens: 1024 });

const DISABLED = claudeBody({ type: "disabled" });

const completion = () =>
  new Response(
    JSON.stringify({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const sentReasoning = async (
  model: string,
  payload: Json,
  yaml?: string,
): Promise<string | undefined> => {
  const executor = makeOpenAICompatExecutor("openai-compatible-mock");

  const h = await harness(
    credential("openai-compatible-mock", {
      kind: "apikey",
      attributes: { base_url: "https://upstream.test/v1", api_key: "sk-test-1" },
    }),
    completion,
    yaml,
  );

  await execute(
    executor,
    h,
    {
      model,
      payload,
      modelInfo: {
        id: MODEL,
        isCompat: true,
        thinking: { levels: ["none", "low", "medium", "high"], zeroAllowed: true },
      },
    },
    options({ sourceFormat: "claude" }),
  );

  const sent = JSON.parse(h.calls[0]!.text) as Json;
  expect(get(sent, "messages.1.tool_calls")).toBeDefined();
  const reasoning = get(sent, "messages.1.reasoning_content");

  return typeof reasoning === "string" ? reasoning : undefined;
};

describe("OpenAI-compatible executor: Claude tool-call reasoning placeholder", () => {
  it("injects the placeholder when thinking is enabled", async () => {
    expect(await sentReasoning(MODEL, ENABLED)).toBe(" ");
  });

  it("omits it when thinking is disabled", async () => {
    expect(await sentReasoning(MODEL, DISABLED)).toBeUndefined();
  });

  it("lets a model suffix high override a disabled body", async () => {
    expect(await sentReasoning(`${MODEL}(high)`, DISABLED)).toBe(" ");
  });

  it("lets a model suffix none override an enabled body", async () => {
    expect(await sentReasoning(`${MODEL}(none)`, ENABLED)).toBeUndefined();
  });

  it("lets a final payload override win", async () => {
    expect(
      await sentReasoning(
        MODEL,
        ENABLED,
        rules("override", '\n          "messages.1.reasoning_content": "custom-override"'),
      ),
    ).toBe("custom-override");
  });

  it("does not restore a reasoning_content the final payload filter removed", async () => {
    expect(
      await sentReasoning(
        MODEL,
        ENABLED,
        rules("filter", '\n          - "messages.1.reasoning_content"'),
      ),
    ).toBeUndefined();
  });
});
