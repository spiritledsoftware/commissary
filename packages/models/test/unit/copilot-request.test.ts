// GitHub Copilot routes and request shaping (Go: internal/auth/copilot/catalog.go `Model.route`,
// internal/runtime/executor/helps/copilot.go, copilot_turns.go, copilot_executor_response.go `copilotResponseError`;
// f911b453 and 9abeef8c flatten assistant text history).
import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import {
  copilotHeaders,
  copilotResponseError,
  copilotTurnIds,
  flattenPlainText,
  normalizeCopilotRequest,
  normalizeCopilotResponses,
  parseCopilotTurnInput,
  seedCopilotDefaults,
  visibleChatReasoning,
} from "../../src/executor/copilot/request.ts";
import { copilotNativeModel, resolveCopilotRoute } from "../../src/executor/copilot/routes.ts";

const route = (model: string) => {
  const resolved = resolveCopilotRoute(model, undefined);

  if (resolved === undefined) throw new Error(`no route for ${model}`);

  return resolved;
};

describe("resolveCopilotRoute", () => {
  it("routes each preset to the endpoint of its CLI profile", () => {
    expect(route("claude-sonnet-5.5")).toMatchObject({
      endpoint: "/v1/messages",
      format: Formats.Claude,
      defaultEffort: "medium",
      defaultMaxTokens: 64_000,
      nonStreamingOutput: 16_000,
    });
    expect(route("gemini-4-argon")).toMatchObject({
      endpoint: "/chat/completions",
      format: Formats.OpenAI,
      defaultToolChoice: "validated",
      disableSnippy: true,
    });
    expect(route("gpt-5.3-codex")).toMatchObject({
      endpoint: "/responses",
      format: Formats.OpenAIResponse,
      systemPrompt: "instructions",
      defaultVerbosity: "low",
    });
  });

  it("gives a budget-only model its default budget, clamped to the model's range", () => {
    expect(route("claude-haiku-4.5")).toMatchObject({ defaultBudget: 1024 });
    expect(
      resolveCopilotRoute("claude-haiku-4.5", { id: "x", thinking: { min: 2048, max: 4096 } }),
    ).toMatchObject({ defaultBudget: 2048, defaultEffort: undefined });
  });

  it("keeps a default effort only when the model offers that level", () => {
    expect(
      resolveCopilotRoute("grok-4.7", { id: "x", thinking: { levels: ["low", "medium"] } }),
    ).toMatchObject({ defaultEffort: undefined });
  });

  it("routes no model without a preset, and drops the copilot/ prefix", () => {
    expect(resolveCopilotRoute("gpt-4o", undefined)).toBeUndefined();
    expect(resolveCopilotRoute("auto", undefined)).toBeUndefined();
    expect(copilotNativeModel("copilot/kimi-k3")).toBe("kimi-k3");
  });
});

describe("seedCopilotDefaults", () => {
  it("caps a Messages max_tokens to the model and, without streaming, to the non-streaming limit", () => {
    const streamed: JsonObject = { max_tokens: 4096 };
    seedCopilotDefaults(streamed, {
      route: route("claude-sonnet-5.5"),
      source: { messages: [] },
      from: Formats.OpenAI,
      suffixed: false,
      upstreamStream: true,
    });
    expect(streamed).toMatchObject({
      max_tokens: 64_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });

    const flat: JsonObject = {};
    seedCopilotDefaults(flat, {
      route: route("claude-sonnet-5.5"),
      source: {},
      from: Formats.Claude,
      suffixed: false,
      upstreamStream: false,
    });
    expect(flat["max_tokens"]).toBe(16_000);
  });

  it("keeps the client's own output limit and effort, and a thinking suffix's intent", () => {
    const own: JsonObject = { max_tokens: 100, thinking: { type: "disabled" } };
    seedCopilotDefaults(own, {
      route: route("claude-sonnet-5.5"),
      source: { max_tokens: 100 },
      from: Formats.Claude,
      suffixed: false,
      upstreamStream: true,
    });
    expect(own).toEqual({ max_tokens: 100, thinking: { type: "disabled" } });

    const suffixed: JsonObject = {};
    seedCopilotDefaults(suffixed, {
      route: route("kimi-k3"),
      source: {},
      from: Formats.OpenAI,
      suffixed: true,
      upstreamStream: true,
    });
    expect(suffixed).toEqual({});
  });

  it("adds a budget only when max_tokens leaves room for it", () => {
    const body: JsonObject = {};
    seedCopilotDefaults(body, {
      route: route("claude-haiku-4.5"),
      source: {},
      from: Formats.Claude,
      suffixed: false,
      upstreamStream: true,
    });
    expect(body).toEqual({ max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 1024 } });
  });
});

describe("flattenPlainText", () => {
  it("joins plain text parts, several only where allowed", () => {
    const parts = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ];

    expect(flattenPlainText(parts, true)).toBe("ab");
    expect(flattenPlainText(parts, false)).toBeUndefined();
    expect(flattenPlainText([{ type: "text", text: "a" }], false)).toBe("a");
  });

  it("leaves annotated, multimodal and empty content alone", () => {
    expect(
      flattenPlainText([{ type: "text", text: "a", cache_control: { type: "ephemeral" } }], true),
    ).toBeUndefined();
    expect(
      flattenPlainText([{ type: "image_url", image_url: { url: "data:," } }], true),
    ).toBeUndefined();
    expect(flattenPlainText([], true)).toBeUndefined();
    expect(flattenPlainText("a", true)).toBeUndefined();
  });
});

describe("normalizeCopilotRequest", () => {
  it("flattens history and drops Chat fields a Claude tool result never had", () => {
    const body: JsonObject = {
      messages: [
        { role: "developer", content: [{ type: "text", text: "rules" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", name: "f", content: "ok" },
      ],
    };

    normalizeCopilotRequest(body, route("kimi-k3"), Formats.Claude, {}, true);

    expect(body["messages"]).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      snippy: { enabled: false },
      temperature: 1,
    });
  });

  it("keeps a native Chat client's user content and the stream field it left out", () => {
    const content = [{ type: "text", text: "hi" }];
    const body: JsonObject = { messages: [{ role: "user", content }], stream: false };

    normalizeCopilotRequest(body, route("gemini-4-argon"), Formats.OpenAI, {}, false);

    expect(body["messages"]).toEqual([{ role: "user", content }]);
    expect(body["stream"]).toBeUndefined();
  });
});

describe("normalizeCopilotResponses", () => {
  it("moves a translated leading system prompt to instructions for an instructions model", () => {
    const body: JsonObject = {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      reasoning: { effort: "medium" },
    };

    normalizeCopilotResponses(body, route("grok-4.7"), Formats.OpenAI, {
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hi" },
      ],
    });

    expect(body).toMatchObject({
      instructions: "rules",
      input: [{ role: "user" }],
      tools: [],
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });
});

describe("turns and headers", () => {
  it("tells a tool-result follow-up from a user turn and keeps its turn ids", () => {
    const user = parseCopilotTurnInput({ messages: [{ role: "user", content: "hi" }] }, "claude");

    const followUp = parseCopilotTurnInput(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        ],
      },
      "claude",
    );

    expect(user.initiator).toBe("user");
    expect(followUp.initiator).toBe("agent");

    const ids = (history: string) =>
      copilotTurnIds({ credentialId: "a", callerScope: "c", sessionId: "s", history });

    expect(ids(followUp.history)).toEqual(ids(user.history));
    expect(ids(followUp.history).interaction).not.toBe(ids("other").interaction);
  });

  it("sends the CLI identity, vision and the Messages betas only with block binding", () => {
    const headers = copilotHeaders({
      route: route("claude-opus-5.5"),
      body: {
        stream: true,
        thinking: { type: "adaptive", block_binding: {} },
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      },
      initiator: "user",
      ids: { session: "s", interaction: "i", task: "t" },
      token: "tok",
    });

    expect(Object.fromEntries(headers)).toMatchObject({
      authorization: "Bearer tok",
      "copilot-vision-request": "true",
      "x-stainless-helper-method": "stream",
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "thinking-binding-controls-2026-08-01,mid-conversation-output-config-2026-07-01",
    });
    expect(headers.get("openai-intent")).toBeNull();
  });
});

describe("copilotResponseError", () => {
  it("maps rate limits to 429 and other reported failures to 502", () => {
    expect(copilotResponseError('{"error":{"code":"rate_limit_exceeded"}}')?.status).toBe(429);
    expect(copilotResponseError('{"type":"response.failed","response":{}}')?.status).toBe(502);
    expect(copilotResponseError('{"choices":[]}')).toBeUndefined();
  });

  it("shows Chat's reasoning_text to the translators as reasoning_content", () => {
    expect(
      JSON.parse(
        visibleChatReasoning('{"choices":[{"delta":{"reasoning_text":"think"}}]}', "delta"),
      ),
    ).toEqual({ choices: [{ delta: { reasoning_text: "think", reasoning_content: "think" } }] });
  });
});
