// Antigravity request translators at CLIProxyAPI dd543d09 (SPI-1420; upstream 38067a29, 08098d24, ae88b00c, 9ac1cd7d,
// 3307446a, 28134004, d3d2817d, 0e981b9f, bb8be964, e21cf8a5, e1384430, ac415c08, 62c419e0, 85225381, 65ba7863). Expected values
// follow the Go tests of those commits.
import { describe, expect, it } from "vite-plus/test";
import { asString, get, isJsonObject, type Json } from "@commissary/json";
import {
  cacheSignature,
  MemorySignatureCache,
  withSignatureContext,
} from "../src/signature/cache.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForAntigravityClaudeTool,
  cleanJsonSchemaForAntigravityResponse,
  cleanJsonSchemaForAntigravityTool,
} from "../src/translator/gemini/util/json-schema.ts";
import { claudeSignature } from "./support/claude-signature.ts";
import type { ThinkingModelInfo } from "../src/thinking/index.ts";

const translate = (
  from: string,
  model: string,
  body: Json,
  modelInfo?: ThinkingModelInfo,
): Json | undefined =>
  builtinTranslators.translateRequest(
    from,
    "antigravity",
    { format: from, model, stream: false, body, ...(modelInfo !== undefined ? { modelInfo } : {}) },
    undefined,
  ).body;

describe("native wire format (38067a29)", () => {
  it("joins a text-only system instruction into one user part and sends a lone string result as output", () => {
    const out = translate("gemini", "gemini-3-pro", {
      systemInstruction: { parts: [{ text: "a" }, { text: "" }, { text: "b" }] },
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ functionCall: { id: "c1", name: "f", args: {} } }] },
        {
          role: "user",
          parts: [{ functionResponse: { id: "c1", name: "f", response: { result: "ok" } } }],
        },
      ],
    });

    expect(get(out, "request.systemInstruction")).toEqual({
      role: "user",
      parts: [{ text: "a\n\nb" }],
    });
    expect(get(out, "request.contents.2.parts.0.functionResponse.response")).toEqual({
      output: "ok",
    });
  });

  it("drops a system instruction of blank texts and keeps a structured result", () => {
    const out = translate("gemini", "gemini-3-pro", {
      systemInstruction: { parts: [{ text: "" }] },
      contents: [
        { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "f", response: { result: { ok: true } } } }],
        },
      ],
    });

    expect(get(out, "request.systemInstruction")).toBeUndefined();
    expect(get(out, "request.contents.1.parts.0.functionResponse.response")).toEqual({
      result: { ok: true },
    });
  });
});

describe("Gemini -> Antigravity contents", () => {
  it("canonicalizes snake_case media fields (08098d24)", () => {
    const out = translate("gemini", "gemini-3-pro", {
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "audio/mpeg", data: "AAAA" } },
            { fileData: { mime_type: "application/pdf", file_uri: "gs://b/f.pdf" } },
          ],
        },
      ],
    });

    expect(get(out, "request.contents.0.parts")).toEqual([
      { inlineData: { mimeType: "audio/mpeg", data: "AAAA" } },
      { fileData: { mimeType: "application/pdf", fileUri: "gs://b/f.pdf" } },
    ]);
  });

  it("keeps user parts beside tool responses and holds follow-up turns until the responses are in (ae88b00c, 9ac1cd7d)", () => {
    const out = translate("gemini", "gemini-3-pro", {
      contents: [
        { role: "user", parts: [{ text: "go" }] },
        {
          role: "model",
          parts: [
            { functionCall: { id: "a", name: "f", args: {} } },
            { functionCall: { id: "b", name: "g", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "a", name: "f", response: {} } }, { text: "note" }],
        },
        { role: "user", parts: [{ text: "follow-up" }] },
        { role: "user", parts: [{ functionResponse: { id: "b", name: "g", response: {} } }] },
      ],
    });

    expect(get(out, "request.contents")).toHaveLength(5);
    expect([2, 3, 4].map((index) => get(out, `request.contents.${index}`))).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { id: "a", name: "f", response: {} } },
          { functionResponse: { id: "b", name: "g", response: {} } },
        ],
      },
      { role: "user", parts: [{ text: "note" }] },
      { role: "user", parts: [{ text: "follow-up" }] },
    ]);
  });
});

describe("OpenAI chat -> Antigravity", () => {
  const toolTurn: Json[] = [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "sunny" },
  ];

  it("merges a user follow-up into the tool response turn (9ac1cd7d)", () => {
    const out = translate("openai", "gemini-3-pro", {
      messages: [...toolTurn, { role: "user", content: "thanks" }],
    });

    expect(get(out, "request.contents.2")).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_1",
            name: "get_weather",
            response: { output: "sunny" },
          },
        },
        { text: "thanks" },
      ],
    });
    expect(get(out, "request.contents.3")).toBeUndefined();
  });

  it("normalizes assistant image data URLs like user ones (3307446a)", () => {
    const out = translate("openai", "gemini-3-pro", {
      messages: [
        { role: "user", content: "draw" },
        {
          role: "assistant",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;charset=x;base64,QUJD" } },
          ],
        },
      ],
    });

    expect(get(out, "request.contents.1.parts.0")).toEqual({
      inlineData: { mimeType: "image/png", data: "QUJD" },
    });
  });

  it("drops Google Search beside chat tools and keeps code execution and URL context (28134004, d3d2817d)", () => {
    const out = translate("openai", "gemini-3-pro", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "f", parameters: { type: "object" } } },
        { google_search: {} },
        { code_execution: {} },
        { url_context: {} },
      ],
    });

    const tools = get(out, "request.tools");
    expect(tools).toHaveLength(3);
    expect(get(out, "request.tools.0.functionDeclarations.0.name")).toBe("f");
    expect(get(out, "request.tools.1")).toEqual({ codeExecution: {} });
    expect(get(out, "request.tools.2")).toEqual({ urlContext: {} });
  });

  it("sends a search-only request on a model with native search as a web search request (28134004)", () => {
    const body: Json = {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "news" },
      ],
      tools: [{ google_search: { excludeDomains: ["x.com"] } }],
    };

    const out = translate("openai", "gemini-3-pro", body, {
      id: "gemini-3-pro",
      nativeCapabilities: { webSearch: true },
    });

    expect(get(out, "requestType")).toBe("web_search");
    expect(get(out, "request.generationConfig.candidateCount")).toBe(1);
    expect(get(out, "request.tools")).toEqual([
      {
        googleSearch: {
          enhancedContent: { imageSearch: { maxResultCount: 5 } },
          excludeDomains: ["x.com"],
        },
      },
    ]);
    expect(get(out, "request.systemInstruction.parts")).toHaveLength(1);
    expect(get(out, "request.systemInstruction.parts.0.text")).toMatch(
      /^be brief\n\nYou are a search engine bot/,
    );

    // A capability veto keeps the chat request (and drops the search tool).
    const vetoed = translate("openai", "gemini-3-pro", body, {
      id: "gemini-3-pro",
      nativeCapabilities: { webSearch: false },
    });

    expect(get(vetoed, "requestType")).toBeUndefined();
    expect(get(vetoed, "request.tools")).toBeUndefined();
  });
});

describe("Interactions -> Antigravity", () => {
  it("merges the steps of a multipart user turn (0e981b9f)", () => {
    const out = translate("interactions", "gemini-3-pro", {
      input: [
        { type: "user_input", content: [{ type: "text", text: "look" }] },
        {
          type: "user_input",
          content: [{ type: "image", data: "AAAA", mime_type: "image/png" }],
        },
      ],
    });

    expect(get(out, "request.contents")).toHaveLength(1);
    expect(get(out, "request.contents.0.role")).toBe("user");
  });
});

describe("Claude -> Antigravity", () => {
  it("sends a tool_use without input as a parameterless call (bb8be964)", () => {
    const out = translate("claude", "claude-sonnet-4-5", {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ping" }] },
      ],
    });

    expect(get(out, "request.contents.1.parts.0.functionCall")).toEqual({
      id: "t1",
      name: "ping",
      args: {},
    });
  });

  it("turns text documents into text and base64 tool_result documents into parts (e21cf8a5, e1384430)", () => {
    const out = translate("claude", "gemini-3-pro", {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "T",
              source: { type: "text", media_type: "text/plain", data: "body" },
            },
          ],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: "UERG" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(get(out, "request.contents.0.parts.0.text")).toBe("Document: T\nbody");
    expect(get(out, "request.contents.2.parts.0.functionResponse.parts")).toEqual([
      { inlineData: { mimeType: "application/pdf", data: "UERG" } },
    ]);
  });

  it("carries stop sequences and the output JSON schema (ac415c08, 62c419e0)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };

    const out = translate("claude", "claude-sonnet-4-5", {
      max_tokens: 0,
      stop_sequences: ["END", ""],
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(get(out, "request.generationConfig.maxOutputTokens")).toBe(0);
    expect(get(out, "request.generationConfig.stopSequences")).toEqual(["END"]);
    expect(get(out, "request.generationConfig.responseMimeType")).toBe("application/json");
    expect(get(out, "request.generationConfig.responseSchema")).toEqual(schema);
  });

  it("recovers a cached thinking signature only with the attempt's own cache (85225381)", () => {
    const signature = claudeSignature();
    const cache = new MemorySignatureCache();

    const body: Json = {
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "cached thought" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "more" },
      ],
    };

    withSignatureContext({ cache }, () =>
      cacheSignature("claude-sonnet-4-5", "cached thought", signature),
    );

    const thoughtOf = (out: Json | undefined): Json | undefined =>
      get(out, "request.contents.1.parts.0.thought");

    expect(thoughtOf(translate("claude", "claude-sonnet-4-5", body))).toBeUndefined();
    expect(
      thoughtOf(
        withSignatureContext({ cache }, () => translate("claude", "claude-sonnet-4-5", body)),
      ),
    ).toBe(true);
  });
});

describe("Antigravity schema cleaners strip unsupported keywords (65ba7863)", () => {
  const cleaners: ReadonlyArray<readonly [string, (schema: Json) => Json]> = [
    ["Antigravity", cleanJsonSchemaForAntigravity],
    ["AntigravityTool", (schema) => cleanJsonSchemaForAntigravityTool(schema, false)],
    ["AntigravityClaudeTool", (schema) => cleanJsonSchemaForAntigravityClaudeTool(schema, true)],
    ["AntigravityResponse", cleanJsonSchemaForAntigravityResponse],
  ];

  it.each(cleaners)("%s drops object size and tuple keywords, keeping size hints", (_, clean) => {
    const out = clean({
      type: "object",
      minProperties: 1,
      maxProperties: 5,
      properties: { tags: { type: "array", prefixItems: [{ type: "string" }] } },
    });

    expect(get(out, "minProperties")).toBeUndefined();
    expect(get(out, "maxProperties")).toBeUndefined();
    expect(get(out, "properties.tags.prefixItems")).toBeUndefined();
    expect(asString(get(out, "description"))).toContain("minProperties: 1");
    expect(asString(get(out, "description"))).toContain("maxProperties: 5");
  });

  it.each(cleaners)("%s keeps a property name with a backslash", (_, clean) => {
    const out = clean({
      type: "object",
      properties: {
        "a\\b": {
          type: "array",
          prefixItems: [{ type: "object", minProperties: 1, maxProperties: 2 }],
        },
      },
    });

    const properties = get(out, "properties");
    const property = isJsonObject(properties) ? properties["a\\b"] : undefined;
    expect(property).toBeDefined();
    expect(get(property, "prefixItems")).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/"(min|max)Properties"/);
  });
});
