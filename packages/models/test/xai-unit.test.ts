// Unit tests of the xAI building blocks: credential routing, error rules, tool/input normalisation, response event
// processing, the replay store and local $ref inlining.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import type { Json, JsonObject } from "@commissary/json";
import { inlineLocalRefs } from "../src/executor/helps/inline-refs.ts";
import {
  isCliChatProxyBaseUrl,
  xaiChatBaseUrl,
  xaiCompactBaseUrl,
  xaiCreds,
  xaiSpeechUrl,
  xaiUsingAPI,
} from "../src/executor/xai/credentials.ts";
import {
  isBadCredentialsBody,
  speechModelUnavailable,
  xaiSpeechStatusError,
  xaiStatusError,
} from "../src/executor/xai/errors.ts";
import {
  mergeAdjacentReasoningSummaries,
  normalizeImageRefs,
  normalizeInputCustomToolCalls,
  normalizeInputReasoningItems,
  preserveOutputControls,
  sanitizeInputEncryptedContent,
} from "../src/executor/xai/input.ts";
import { OutputItemCollector } from "../src/executor/codex/output.ts";
import {
  applyReplayCache,
  cacheReplayFromCompleted,
  filterReplayItemsForInput,
  isolateSessionKey,
  makeInMemoryXaiReplayStore,
  normalizeReplayItems,
  replayScopeFromRequest,
} from "../src/executor/xai/replay.ts";
import {
  EventPipeline,
  InternalXSearchFilter,
  normalizeReasoningSummaryEvent,
  normalizeReasoningSummaryEvents,
  patchCompletedOutput,
  restoreClientWebSearchName,
} from "../src/executor/xai/response.ts";
import {
  aliasClientWebSearchFunction,
  clampToolsLimit,
  ensureNativeXSearchTool,
  normalizeForcedImageGenerationToolChoice,
  normalizeNamespaceToolChoice,
  normalizeToolChoiceForTools,
  pruneOrphanedToolChoice,
  resolveClientWebSearchAlias,
} from "../src/executor/xai/tool-choice.ts";
import {
  collectClientDeclaredToolKeys,
  collectNamespaceToolRefs,
  normalizeTools,
  promoteAdditionalTools,
  supportsNativeImageGeneration,
  totalFlattenedToolsCount,
} from "../src/executor/xai/tools.ts";
import { acceptableXaiClientVersion } from "../src/executor/xai/version.ts";
import { grokCiphertext } from "./support/xai.ts";

const credential = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
  id: "c",
  provider: "xai",
  kind: "oauth",
  attributes: {},
  metadata: {},
  ...overrides,
});

describe("credential routing", () => {
  it("reads the token from attributes first, then metadata", () => {
    expect(
      xaiCreds(credential({ attributes: { api_key: " k " }, metadata: { access_token: "m" } }))
        .token,
    ).toBe("k");
    expect(
      xaiCreds(credential({ metadata: { access_token: "m", base_url: "https://b.test" } })),
    ).toEqual({
      token: "m",
      baseURL: "https://b.test",
    });
  });

  it("resolves using_api by attribute, metadata, auth_kind attribute then metadata", () => {
    expect(xaiUsingAPI(credential({ attributes: { using_api: "true", auth_kind: "oauth" } }))).toBe(
      true,
    );
    expect(
      xaiUsingAPI(credential({ attributes: { using_api: "bogus", auth_kind: "oauth" } })),
    ).toBe(false);
    expect(xaiUsingAPI(credential({ metadata: { using_api: true, auth_kind: "oauth" } }))).toBe(
      true,
    );
    expect(xaiUsingAPI(credential({ metadata: { using_api: "F" } }))).toBe(false);
    expect(xaiUsingAPI(credential({ metadata: { auth_kind: "oauth" } }))).toBe(false);
    expect(xaiUsingAPI(credential({ attributes: { auth_kind: "api" } }))).toBe(true);
    expect(xaiUsingAPI(credential())).toBe(true);
  });

  it("keeps compaction and speech off the CLI chat proxy", () => {
    const oauth = credential({ attributes: { auth_kind: "oauth" } });
    expect(xaiChatBaseUrl(oauth)).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(xaiCompactBaseUrl(oauth)).toBe("https://api.x.ai/v1");
    expect(xaiSpeechUrl(oauth)).toBe("https://api.x.ai/v1/tts");

    const defaultApi = credential({
      attributes: { auth_kind: "oauth", base_url: "https://api.x.ai/v1/" },
    });

    expect(xaiChatBaseUrl(defaultApi)).toBe("https://cli-chat-proxy.grok.com/v1");

    const proxied = credential({
      attributes: { using_api: "true", base_url: "https://cli-chat-proxy.grok.com/v1" },
    });

    expect(xaiChatBaseUrl(proxied)).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(xaiCompactBaseUrl(proxied)).toBe("https://api.x.ai/v1");
    const custom = credential({ attributes: { api_key: "k", base_url: "https://x.test/v1" } });
    expect(xaiChatBaseUrl(custom)).toBe("https://x.test/v1");
    expect(xaiCompactBaseUrl(custom)).toBe("https://x.test/v1");
    expect(isCliChatProxyBaseUrl(" https://cli-chat-proxy.grok.com/v1/ ")).toBe(true);
  });

  it("only accepts strict numeric versions at or above the server floor", () => {
    for (const ok of ["1.0.13", "1.0.46", "2.0.0", "1.10.0"])
      expect(acceptableXaiClientVersion(ok)).toBe(true);

    for (const bad of ["1.0.12", "1.0", "1.0.46-beta", "v1.0.46", "", "1.0.x"])
      expect(acceptableXaiClientVersion(bad)).toBe(false);
  });
});

describe("error rules", () => {
  it("recognises bad-credentials bodies in flat and nested shapes", () => {
    expect(isBadCredentialsBody('{"code":"bad-credentials"}')).toBe(true);
    expect(isBadCredentialsBody('{"error":{"code":"Bad-Credentials"}}')).toBe(true);
    expect(
      isBadCredentialsBody(
        '{"body":{"error":{"message":"The access token could not be validated"}}}',
      ),
    ).toBe(true);
    expect(isBadCredentialsBody("plain: bad-credentials")).toBe(true);
    expect(isBadCredentialsBody('{"error":"forbidden"}')).toBe(false);
  });

  it("remaps 403 bad credentials to 401 and flags free-usage exhaustion with a 24 h cooldown", () => {
    expect(xaiStatusError(403, '{"code":"bad-credentials"}').status).toBe(401);
    expect(xaiStatusError(403, "nope").status).toBe(403);
    expect(xaiStatusError(429, "slow").retryAfterMs).toBeUndefined();

    for (const body of [
      '{"code":"subscription:free-usage-exhausted"}',
      '{"error":"You hit the included free usage limit"}',
      "free-usage-exhausted",
    ]) {
      expect(xaiStatusError(429, body).retryAfterMs).toBe(86_400_000);
    }

    expect(xaiStatusError(500, "").status).toBe(500);
  });

  it("marks speech 404s request-scoped unless the model is unavailable", () => {
    expect(xaiSpeechStatusError(404, '{"error":"voice not found"}').requestScoped).toBe(true);
    expect(
      xaiSpeechStatusError(404, '{"error":{"message":"Model unavailable"}}').requestScoped,
    ).toBeUndefined();
    expect(xaiSpeechStatusError(400, "bad").requestScoped).toBeUndefined();
    expect(speechModelUnavailable("not json: unsupported model")).toBe(true);
  });
});

describe("tool normalisation", () => {
  it("knows which Grok models support the native image_generation tool", () => {
    for (const model of [
      "grok-4.6",
      "grok-4.7-fast",
      "xai/grok-5",
      "grok-4.10",
      "GROK-4.6(high)",
    ]) {
      expect(supportsNativeImageGeneration(model)).toBe(true);
    }

    for (const model of [
      "grok-4.5",
      "grok-4.20",
      "grok-4.20-beta",
      "grok-3",
      "gpt-5",
      "",
      "grok-composer-2",
    ]) {
      expect(supportsNativeImageGeneration(model)).toBe(false);
    }
  });

  it("keeps image_generation for grok-4.6+ and rewrites a forced hosted choice to required", () => {
    const body = {
      model: "grok-4.6",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "f", parameters: { type: "object" } },
      ],
      tool_choice: { type: "image_generation" },
    };

    normalizeTools(body, false);
    normalizeForcedImageGenerationToolChoice(body);
    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toBe("required");
  });

  it("inlines local refs, types root union branches and simplifies unsupported schemas", () => {
    const body = {
      model: "grok-4.3",
      tools: [
        {
          type: "function",
          name: "ref",
          parameters: {
            type: "object",
            properties: { a: { $ref: "#/$defs/A" } },
            $defs: { A: { type: "string" } },
          },
        },
        {
          type: "function",
          name: "union",
          parameters: { type: "object", oneOf: [{ properties: { a: {} } }, { type: "object" }] },
        },
        {
          type: "function",
          name: "mixed",
          strict: true,
          parameters: { anyOf: [{ type: "string" }, { type: "object" }] },
        },
        { type: "custom", name: "auto", parameters: { oneOf: [{ $ref: "#/x" }] } },
        {
          type: "namespace",
          name: "codex_app",
          tools: [
            {
              type: "function",
              name: "automation_update",
              parameters: { type: "object", properties: { x: {} } },
            },
          ],
        },
      ],
    };

    normalizeTools(body, false);

    const byName = Object.fromEntries(
      body.tools.map((tool) => [(tool as { name: string }).name, tool as Record<string, unknown>]),
    );

    expect(byName["ref"]?.["parameters"]).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(byName["union"]?.["parameters"]).toEqual({
      type: "object",
      oneOf: [{ properties: { a: {} }, type: "object" }, { type: "object" }],
    });
    const safe = { type: "object", properties: {}, additionalProperties: true };
    expect(byName["mixed"]).toMatchObject({ parameters: safe, strict: false });
    expect(byName["auto"]).toMatchObject({ type: "function", parameters: safe });
    expect(byName["codex_app__automation_update"]?.["parameters"]).toEqual(safe);
  });

  it("counts flattened tools, folds namespaces and keeps dispatchers when clamping", () => {
    const children = Array.from({ length: 150 }, (_, index) => ({
      type: "function",
      name: `c${index}`,
    }));

    const body = {
      model: "grok-4.3",
      tools: [
        { type: "namespace", name: "ns1", tools: children },
        { type: "namespace", name: "ns2", tools: children },
        { type: "tool_search" },
        { type: "function", name: "plain" },
      ],
    };

    expect(totalFlattenedToolsCount(body, false, false)).toBe(301);
    expect(totalFlattenedToolsCount(body, true, false)).toBe(302);
    const refs = collectNamespaceToolRefs(body, true);
    expect(refs.get("ns1")).toMatchObject({ namespace: "ns1", name: "", isDispatcher: true });
    expect(refs.get("ns1")?.children?.size).toBe(150);
    expect(refs.get("ns1")?.children?.has("c149")).toBe(true);
    expect(refs.get("ns1__c3")).toEqual({ namespace: "ns1", name: "c3", isDispatcher: false });
    normalizeTools(body, true);
    expect(body.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "ns1",
      "ns2",
      "plain",
    ]);

    const many = {
      tools: [
        ...Array.from({ length: 5 }, (_, i) => ({ type: "function", name: `r${i}` })),
        { type: "function", name: "disp" },
      ],
      tool_choice: { type: "function", name: "r4" },
    };

    clampToolsLimit(
      many,
      3,
      new Map([["disp", { namespace: "disp", name: "", isDispatcher: true }]]),
    );
    expect(many.tools.map((tool) => tool.name)).toEqual(["disp", "r0", "r1"]);
    // The choice pointed at a clamped tool, so it is dropped.
    expect("tool_choice" in many).toBe(false);
  });

  it("promotes additional_tools and collects client declared tools before flattening", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: "x" },
        { type: "additional_tools", tools: [{ type: "function", name: "late" }] },
      ],
      tools: [
        { type: "custom", name: "shell" },
        { type: "namespace", name: "ns", tools: [{ type: "function", name: "a" }] },
      ],
    };

    const keys = collectClientDeclaredToolKeys(body);
    expect([...keys].map((key) => key.split("\u0000"))).toEqual(
      expect.arrayContaining([
        ["", "shell", "function"],
        ["ns", "a", "function"],
        ["", "late", "function"],
      ]),
    );
    promoteAdditionalTools(body);
    expect(body.input).toHaveLength(1);
    expect(body.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "shell",
      "ns",
      "late",
    ]);
  });

  it("normalises namespaced and orphaned tool choices", () => {
    const body: JsonObject = {
      tools: [{ type: "function", name: "ns__run" }, { type: "web_search" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [
          { type: "function", namespace: "ns", name: "run" },
          { type: "function", name: "gone" },
          { type: "web_search" },
        ],
      },
    };

    normalizeNamespaceToolChoice(body, false);
    pruneOrphanedToolChoice(body);
    expect(body["tool_choice"]).toEqual({
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "ns__run" }, { type: "web_search" }],
    });
    const empty: JsonObject = { tool_choice: "required", parallel_tool_calls: true, tools: [] };
    normalizeToolChoiceForTools(empty);
    expect(empty).toEqual({});
  });

  it("injects the native X Search tool once and allows it in allowed_tools", () => {
    const body: JsonObject = {
      tools: [{ type: "function", name: "f" }],
      tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: "f" }] },
    };

    ensureNativeXSearchTool(body);
    ensureNativeXSearchTool(body);
    expect(body["tools"]).toEqual([{ type: "function", name: "f" }, { type: "x_search" }]);
    expect((body["tool_choice"] as { tools: unknown[] }).tools).toEqual([
      { type: "function", name: "f" },
      { type: "x_search" },
    ]);
    const bare: JsonObject = {};
    ensureNativeXSearchTool(bare);
    expect(bare).toEqual({ tools: [{ type: "x_search" }] });
  });

  it("aliases the client web_search function everywhere except behind namespaces", () => {
    const body: JsonObject = {
      tools: [
        { type: "function", name: "web_search" },
        { type: "function", name: "clientfn_web_search" },
      ],
      tool_choice: { type: "function", name: "web_search" },
      input: [
        { type: "function_call", name: "web_search", call_id: "1" },
        { type: "function_call", name: "web_search", namespace: "x", call_id: "2" },
      ],
    };

    const alias = resolveClientWebSearchAlias(body);
    expect(alias).toBe("clientfn_web_search_1");
    aliasClientWebSearchFunction(body, alias, new Map());
    expect((body["tools"] as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      alias,
      "clientfn_web_search",
    ]);
    expect((body["tool_choice"] as { name: string }).name).toBe(alias);
    expect((body["input"] as Array<{ name: string }>).map((item) => item.name)).toEqual([
      alias,
      "web_search",
    ]);

    const event = {
      type: "response.completed",
      response: {
        output: [
          { type: "function_call", name: alias },
          { type: "function_call", name: alias, namespace: "x" },
        ],
      },
    };

    restoreClientWebSearchName(event, alias);
    expect(event.response.output.map((item) => item.name)).toEqual(["web_search", alias]);
  });
});

describe("input normalisation", () => {
  it("preserves sampling controls for OpenAI and Responses clients only", () => {
    const chat = preserveOutputControls(
      {},
      { max_completion_tokens: 5, max_tokens: 9, temperature: 0, top_p: null, top_k: 3 },
      "openai",
    );

    expect(chat).toEqual({ max_output_tokens: 5, temperature: 0, top_k: 3 });
    expect(preserveOutputControls({}, { max_tokens: 9 }, "openai")).toEqual({
      max_output_tokens: 9,
    });
    expect(preserveOutputControls({}, { max_output_tokens: 7 }, "openai-response")).toEqual({
      max_output_tokens: 7,
    });
    expect(preserveOutputControls({}, { max_output_tokens: 7 }, "claude")).toEqual({});
  });

  it("turns custom tool calls into function calls with wrapped arguments", () => {
    const body = {
      input: [
        { type: "custom_tool_call", call_id: "a", name: "t", input: '{"x":1}' },
        { type: "custom_tool_call", call_id: "b", name: "t", input: "ls -la" },
        { type: "custom_tool_call", call_id: "c", name: "t", input: { y: 2 } },
        { type: "custom_tool_call", call_id: "d", name: "t" },
        { type: "custom_tool_call", call_id: "", name: "t", input: "x" },
        { type: "custom_tool_call_output", call_id: "a", output: { ok: true } },
        { type: "custom_tool_call_output", output: "orphan" },
      ],
    };

    normalizeInputCustomToolCalls(body);
    expect(body.input.map((item) => (item as { arguments?: string }).arguments)).toEqual([
      '{"x":1}',
      '{"input":"ls -la"}',
      '{"y":2}',
      "{}",
      undefined,
    ]);
    expect(body.input[4]).toEqual({
      type: "function_call_output",
      call_id: "a",
      output: '{"ok":true}',
    });
    expect(body.input).toHaveLength(5);
  });

  it("merges adjacent reasoning summaries and drops null reasoning fields", () => {
    const body = {
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "a" }],
          content: null,
          encrypted_content: null,
        },
        { type: "reasoning", summary: [{ type: "summary_text", text: "b" }] },
        { type: "reasoning", id: "keep", summary: [{ type: "summary_text", text: "c" }] },
        { type: "reasoning", summary: [] },
      ],
    };

    normalizeInputReasoningItems(body);
    expect(body.input).toEqual([
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "a" },
          { type: "summary_text", text: "b" },
        ],
      },
      { type: "reasoning", id: "keep", summary: [{ type: "summary_text", text: "c" }] },
      { type: "reasoning", summary: [] },
    ]);
    expect(mergeAdjacentReasoningSummaries({ input: "text" })).toEqual({ input: "text" });
  });

  it("sanitises encrypted content: invalid reasoning loses it, invalid compaction items are dropped", () => {
    const good = grokCiphertext(5);

    const body = {
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "a" }],
          encrypted_content: null,
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "b" }],
          encrypted_content: good,
        },
        { type: "compaction", encrypted_content: "padded==" },
        { type: "compaction", encrypted_content: good },
        { type: "compaction", encrypted_content: 42 },
      ],
    };

    sanitizeInputEncryptedContent(body);
    expect(body.input).toHaveLength(3);
    expect(body.input[0]).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "a" }],
    });
    expect(body.input[1]).toMatchObject({ type: "reasoning", encrypted_content: good });
    expect(body.input[2]).toMatchObject({ type: "compaction", encrypted_content: good });
  });

  it("rewrites image_url references of image, images and reference_images only", () => {
    const body = {
      image: { image_url: "https://a.test/1.png" },
      images: [
        { image_url: { url: "https://a.test/2.png" } },
        { url: " https://a.test/3.png ", image_url: "x" },
      ],
      nested: { reference_images: [{ image_url: "https://a.test/4.png" }] },
      messages: [{ content: [{ type: "image_url", image_url: { url: "https://a.test/5.png" } }] }],
    };

    normalizeImageRefs(body);
    expect(body).toEqual({
      image: { url: "https://a.test/1.png" },
      images: [{ url: "https://a.test/2.png" }, { url: "https://a.test/3.png" }],
      nested: { reference_images: [{ url: "https://a.test/4.png" }] },
      messages: [{ content: [{ type: "image_url", image_url: { url: "https://a.test/5.png" } }] }],
    });
  });
});

describe("response events", () => {
  it("converts reasoning text events and splits reasoning_text.done", () => {
    expect(
      normalizeReasoningSummaryEvent({
        type: "response.reasoning_text.delta",
        content_index: 2,
        delta: "x",
      }),
    ).toEqual({
      type: "response.reasoning_summary_text.delta",
      summary_index: 2,
      delta: "x",
    });

    const [textDone, partDone] = normalizeReasoningSummaryEvents({
      type: "response.reasoning_text.done",
      content_index: 1,
      text: "full",
    });

    expect(textDone).toEqual({
      type: "response.reasoning_summary_text.done",
      summary_index: 1,
      text: "full",
    });
    expect(partDone).toEqual({
      type: "response.reasoning_summary_part.done",
      summary_index: 1,
      part: { type: "summary_text", text: "full" },
    });
    expect(
      normalizeReasoningSummaryEvent({
        type: "response.content_part.done",
        part: { type: "output_text" },
      }),
    ).toEqual({
      type: "response.content_part.done",
      part: { type: "output_text" },
    });

    const item = normalizeReasoningSummaryEvent({
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        summary: [{ type: "reasoning_text", text: "a" }],
        content: [{ type: "reasoning_text", text: "b" }],
      },
    });

    expect(item).toEqual({
      type: "response.output_item.done",
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "b" }] },
    });
  });

  it("rebuilds an empty completed output from output_item.done items in index order", () => {
    const collector = new OutputItemCollector();
    collector.collect({ type: "response.output_item.done", output_index: 1, item: { id: "b" } });
    collector.collect({ type: "response.output_item.done", output_index: 0, item: { id: "a" } });
    collector.collect({ type: "response.output_item.done", item: { id: "c" } });

    const event = {
      type: "response.completed",
      response: { output: [], usage: { input_tokens: 1 } },
    };

    patchCompletedOutput(event, collector);
    expect(event.response.output).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(event.response.usage).toMatchObject({ output_tokens_details: { reasoning_tokens: 0 } });
    const kept = { type: "response.completed", response: { output: [{ id: "x" }] } };
    patchCompletedOutput(kept, collector);
    expect(kept.response.output).toEqual([{ id: "x" }]);
  });

  it("restores namespaced calls and unwraps dispatcher arguments across events", () => {
    const refs = new Map([
      ["disp", { namespace: "disp", name: "", isDispatcher: true }],
      ["ns__run", { namespace: "ns", name: "run", isDispatcher: false }],
    ]);

    const pipeline = new EventPipeline({
      namespaceTools: refs,
      webSearchAlias: "",
      filterInternalXSearch: false,
      clientDeclaredTools: new Set(),
    });

    const added = pipeline.process({
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc", name: "disp" },
    }) as {
      item: Record<string, unknown>;
    };

    expect(added.item["namespace"]).toBe("disp");

    const done = pipeline.process({
      type: "response.function_call_arguments.done",
      item_id: "fc",
      arguments: '{"name":"child","arguments":{"a":1}}',
    });

    expect(done).toMatchObject({ arguments: '{"a":1}' });

    const item = pipeline.process({
      type: "response.output_item.done",
      item: { type: "function_call", name: "disp", arguments: '{"name":"child","arguments":"{}"}' },
    });

    expect(item).toMatchObject({ item: { name: "child", namespace: "disp", arguments: "{}" } });

    const flat = pipeline.process({
      type: "response.completed",
      response: { output: [{ type: "function_call", name: "ns__run" }] },
    });

    expect(flat).toMatchObject({ response: { output: [{ name: "run", namespace: "ns" }] } });
  });

  it("filters internal X Search traces but keeps same-name client tools", () => {
    const filter = new InternalXSearchFilter(
      true,
      new Set(["\u0000x_keyword_search\u0000function"]),
    );

    const trace = { type: "custom_tool_call", name: "x_keyword_search", call_id: "k" };
    expect(
      filter.apply({ type: "response.output_item.added", output_index: 0, item: trace }),
    ).toBeUndefined();
    expect(
      filter.apply({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "message" },
      }),
    ).toMatchObject({ output_index: 0 });
    const client = { type: "function_call", name: "x_keyword_search", call_id: "c1" };
    expect(
      filter.apply({ type: "response.output_item.done", output_index: 2, item: client }),
    ).toMatchObject({
      output_index: 1,
    });
    // The internal call id prefix wins over a client declaration.
    const traced = { type: "function_call", name: "x_keyword_search", call_id: "xs_call_9" };
    expect(
      filter.apply({ type: "response.output_item.done", output_index: 3, item: traced }),
    ).toBeUndefined();
    expect(new InternalXSearchFilter(false, new Set()).apply({ item: trace })).toEqual({
      item: trace,
    });
  });
});

const completed = (items: Json[]) => ({ type: "response.completed", response: { output: items } });

const reasoning = (seed: number) => ({
  type: "reasoning",
  id: "rs",
  summary: [{ type: "summary_text", text: "t" }],
  encrypted_content: grokCiphertext(seed),
});

describe("reasoning replay store", () => {
  it("only keeps replayable turns and expires them after an hour (injected clock)", async () => {
    let now = 1_000_000;
    const store = makeInMemoryXaiReplayStore(() => now);
    expect(
      normalizeReplayItems([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ]),
    ).toBeUndefined();
    expect(normalizeReplayItems([{ type: "reasoning", encrypted_content: "bad" }])).toBeUndefined();

    const normalized = normalizeReplayItems([
      reasoning(1),
      { type: "function_call", call_id: "c", name: "f", arguments: "{}", extra: 1 },
    ]);

    expect(normalized).toEqual([
      { type: "reasoning", summary: [], content: null, encrypted_content: grokCiphertext(1) },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
    ]);
    const scope = { modelName: "grok-4.3", sessionKey: "s" };
    await Effect.runPromise(cacheReplayFromCompleted(store, scope, completed([reasoning(1)])));
    expect(await Effect.runPromise(store.get("grok-4.3", "s"))).toHaveLength(1);
    now += 59 * 60 * 1000;
    expect(await Effect.runPromise(store.get("grok-4.3", "s"))).toHaveLength(1);
    // A read refreshes the entry; it expires an hour after the last access.
    now += 61 * 60 * 1000;
    expect(await Effect.runPromise(store.get("grok-4.3", "s"))).toBeUndefined();
  });

  it("clears the previous entry when a completed turn has no replayable state", async () => {
    const store = makeInMemoryXaiReplayStore(() => 1);
    const scope = { modelName: "m", sessionKey: "s" };
    await Effect.runPromise(cacheReplayFromCompleted(store, scope, completed([reasoning(2)])));
    await Effect.runPromise(
      cacheReplayFromCompleted(
        store,
        scope,
        completed([{ type: "message", role: "assistant", content: [] }]),
      ),
    );
    expect(await Effect.runPromise(store.get("m", "s"))).toBeUndefined();
  });

  it("isolates session keys per caller and disables replay without one", () => {
    expect(isolateSessionKey("prompt-cache:x", "alice")).toMatch(
      /^caller:[0-9a-f]{16}:prompt-cache:x$/,
    );
    expect(isolateSessionKey("prompt-cache:x", "alice")).not.toBe(
      isolateSessionKey("prompt-cache:x", "bob"),
    );
    expect(isolateSessionKey("execution:1", "")).toBe("execution:1");
    expect(isolateSessionKey("prompt-cache:x", "")).toBe("");

    const input = {
      from: "openai-response",
      model: "grok-4.3(high)",
      requestPayload: { prompt_cache_key: "k" },
      body: {},
      headers: new Headers(),
      callerScope: "alice",
    };

    expect(replayScopeFromRequest(input).modelName).toBe("grok-4.3");
    expect(replayScopeFromRequest(input).sessionKey).toContain("prompt-cache:k");
    expect(replayScopeFromRequest({ ...input, from: "openai" }).sessionKey).toBe("");
    expect(replayScopeFromRequest({ ...input, callerScope: "" }).sessionKey).toBe("");
  });

  it("skips replay when the client's history diverged from the cached assistant message", async () => {
    const cachedMessage = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "cached" }],
    };

    const items = [
      { type: "reasoning", summary: [], content: null, encrypted_content: grokCiphertext(3) },
      cachedMessage,
    ];

    const diverged = { input: [{ type: "message", role: "assistant", content: "other" }] };
    expect(filterReplayItemsForInput(diverged, items)).toEqual([]);

    const matching = {
      input: [
        { type: "message", role: "user", content: "q" },
        { type: "message", role: "assistant", content: "cached" },
      ],
    };

    expect(filterReplayItemsForInput(matching, items)).toEqual([items[0]]);
    const store = makeInMemoryXaiReplayStore(() => 1);
    const scope = { modelName: "m", sessionKey: "s" };
    await Effect.runPromise(store.store("m", "s", items));
    await Effect.runPromise(applyReplayCache(store, scope, matching));
    // Without tool calls the cached reasoning goes right before the client's last assistant message.
    expect(matching.input.map((item) => item.type)).toEqual(["message", "reasoning", "message"]);
  });
});

describe("inlineLocalRefs", () => {
  it("returns schemas without refs untouched and breaks cycles with a hint", () => {
    const plain = { type: "object" };
    expect(inlineLocalRefs(plain)).toBe(plain);

    const cyclic = {
      type: "object",
      properties: { next: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          description: "a node",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    };

    const out = inlineLocalRefs(cyclic) as {
      properties: { next: { properties: { next: Record<string, unknown> } } };
    };

    expect(out.properties.next.properties.next).toEqual({
      type: "object",
      description: "a node (See: Node)",
    });
  });

  it("lets sibling keywords override the referenced definition and keeps unresolvable refs", () => {
    const schema = {
      $defs: { A: { type: "string", description: "base" } },
      a: { $ref: "#/$defs/A", description: "mine" },
      b: { $ref: "#/$defs/Missing" },
      c: { $ref: "https://x.test/s" },
    };

    const out = inlineLocalRefs(schema) as Record<string, unknown>;
    expect(out["a"]).toEqual({ type: "string", description: "mine" });
    expect(out["b"]).toEqual({ $ref: "#/$defs/Missing" });
    expect(out["c"]).toEqual({ $ref: "https://x.test/s" });
  });
});

describe("web_search options (bbfd7886)", () => {
  it("drops external_web_access and search_context_size, keeps the options xAI accepts", () => {
    const body = {
      model: "grok-4.3",
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "high",
          search_content_types: ["text", "image"],
          user_location: { type: "approximate", country: "NL" },
          filters: { allowed_domains: ["github.com"] },
        },
        {
          type: "namespace",
          name: "research",
          tools: [{ type: "web_search", search_context_size: "low" }],
        },
      ],
    };

    normalizeTools(body, false);
    expect(body.tools).toEqual([
      {
        type: "web_search",
        search_content_types: ["text", "image"],
        user_location: { type: "approximate", country: "NL" },
        filters: { allowed_domains: ["github.com"] },
      },
      { type: "web_search" },
    ]);
  });
});

describe("additional_tools deduplication (0c61b12c)", () => {
  const clock = (description: string, param: string) => ({
    type: "namespace",
    name: "clock",
    tools: [
      {
        type: "function",
        name: "sleep",
        description,
        parameters: { type: "object", properties: { [param]: { type: "string" } } },
      },
    ],
  });

  const names = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({
      type: "function",
      name: `tool_${from + i}`,
      parameters: { type: "object" },
    }));

  it("keeps the top-level declaration when history repeats it", () => {
    const body = {
      tools: [clock("top declaration", "duration_ms")],
      input: [
        { type: "additional_tools", tools: [clock("history declaration", "seconds")] },
        { role: "user", content: "hi" },
      ],
    };

    promoteAdditionalTools(normalizeTools(body, false));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ name: "clock__sleep", description: "top declaration" });
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("lets a flat top-level function win over a namespaced history copy", () => {
    const body = {
      tools: [{ type: "function", name: "clock__sleep", description: "flat top" }],
      input: [{ type: "additional_tools", tools: [clock("namespaced history", "x")] }],
    };

    const refs = collectNamespaceToolRefs(body, false);
    promoteAdditionalTools(normalizeTools(body, false));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ description: "flat top" });
    expect(refs.has("clock__sleep")).toBe(false);
  });

  it("counts overlapping history tools once, so they do not trigger folding", () => {
    const ns = { type: "namespace", name: "mcp__app", tools: names(120) };

    const body = {
      tools: [ns],
      input: [{ type: "additional_tools", tools: [ns] }],
    };

    expect(totalFlattenedToolsCount(body, false, false)).toBe(120);
    promoteAdditionalTools(normalizeTools(body, false));
    expect(body.tools).toHaveLength(120);
  });

  it("merges a repeated namespace into one dispatcher, top-level children first", () => {
    const history = {
      type: "namespace",
      name: "clock",
      tools: [
        {
          type: "function",
          name: "sleep",
          description: "history sleep",
          parameters: { type: "object" },
        },
        {
          type: "function",
          name: "alarm",
          description: "history alarm",
          parameters: { type: "object" },
        },
      ],
    };

    const body = {
      tools: [
        clock("top sleep", "duration_ms"),
        { type: "namespace", name: "mcp__app", tools: names(120) },
      ],
      input: [
        {
          type: "additional_tools",
          tools: [history, { type: "namespace", name: "mcp__extra", tools: names(90, 120) }],
        },
      ],
    };

    expect(totalFlattenedToolsCount(body, false, false)).toBe(212);
    normalizeTools(body, true);
    promoteAdditionalTools(body);
    const tools = body.tools as unknown as Array<{ name: string; description: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["clock", "mcp__app", "mcp__extra"]);
    expect(tools[0]?.description).toContain("top sleep");
    expect(tools[0]?.description).not.toContain("history sleep");
    expect(tools[0]?.description).toContain("history alarm");
  });

  it("registers dispatcher refs with their children and unwraps only those children", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "clock",
          tools: [{ type: "function", name: "sleep", parameters: { type: "object" } }],
        },
        { type: "namespace", name: "mcp__app", tools: names(210) },
      ],
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "clock__sleep",
              tools: [{ type: "function", name: "alarm", parameters: { type: "object" } }],
            },
          ],
        },
      ],
    };

    const refs = collectNamespaceToolRefs(body, true);
    expect(refs.get("clock__sleep")).toMatchObject({
      namespace: "clock__sleep",
      isDispatcher: true,
    });
    expect(refs.get("clock")?.children).toEqual(new Set(["sleep"]));

    const pipeline = new EventPipeline({
      namespaceTools: refs,
      webSearchAlias: "",
      filterInternalXSearch: false,
      clientDeclaredTools: new Set(),
    });

    const call = (name: string, arguments_: string) =>
      pipeline.process({
        type: "response.output_item.done",
        item: { type: "function_call", name, arguments: arguments_ },
      });

    expect(call("clock", '{"name":"sleep","arguments":{"duration_ms":5}}')).toMatchObject({
      item: { namespace: "clock", name: "sleep", arguments: '{"duration_ms":5}' },
    });

    expect(call("clock__sleep", '{"name":"alarm","arguments":{"ring":true}}')).toMatchObject({
      item: { namespace: "clock__sleep", name: "alarm", arguments: '{"ring":true}' },
    });
  });

  it("does not restore a flat function as a folded namespace child", () => {
    const flat = { type: "function", name: "clock__sleep", parameters: { type: "object" } };

    const clockNs = {
      type: "namespace",
      name: "clock",
      tools: [{ type: "function", name: "sleep", parameters: { type: "object" } }],
    };

    const big = { type: "namespace", name: "mcp__app", tools: names(210) };

    for (const tools of [
      [flat, clockNs, big],
      [clockNs, flat, big],
    ]) {
      const refs = collectNamespaceToolRefs({ tools }, true);
      expect(refs.has("clock__sleep")).toBe(false);
    }
  });
});
