// Gemini requests that mix built-in tools with function declarations (CLIProxyAPI 45501610): Gemini 400s unless
// toolConfig.includeServerSideToolInvocations is true; Antigravity does not support the parameter and never carries it.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { withModelInfoLookup } from "../src/translator/model-info.ts";

const translate = (
  from: "openai" | "openai-response",
  to: "gemini" | "antigravity",
  body: Json,
  model: string,
) =>
  builtinTranslators.translateRequest(
    from,
    to,
    { format: from, model, stream: false, body },
    undefined,
  ).body;

const onSearchModel = <T>(id: string, fn: () => T): T =>
  withModelInfoLookup((model) => (model === id ? { id, supportsWebSearch: true } : undefined), fn);

const fnTool = {
  type: "function",
  function: {
    name: "get_weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

describe("OpenAI chat -> Gemini", () => {
  const chat = (tools: Json[], extra: Json = {}) =>
    translate(
      "openai",
      "gemini",
      {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
        tools,
        ...(extra as object),
      },
      "gemini-3.8-flash",
    );

  it.each([
    ["google_search", "googleSearch"],
    ["code_execution", "codeExecution"],
    ["url_context", "urlContext"],
  ])("sets includeServerSideToolInvocations when %s is mixed with functions", (input, output) => {
    const out = chat([fnTool, { [input]: {} }], { tool_choice: "auto" });

    expect(get(out, "toolConfig.includeServerSideToolInvocations")).toBe(true);
    expect(get(out, "toolConfig.functionCallingConfig.mode")).toBe("AUTO");
    expect(get(out, "tools.0.functionDeclarations.0.name")).toBe("get_weather");
    expect(get(out, `tools.1.${output}`)).toBeDefined();
  });

  it("leaves it out for built-in tools alone and for functions alone", () => {
    expect(
      get(chat([{ google_search: {} }]), "toolConfig.includeServerSideToolInvocations"),
    ).toBeUndefined();
    expect(get(chat([fnTool]), "toolConfig.includeServerSideToolInvocations")).toBeUndefined();
  });
});

describe("OpenAI Responses -> Gemini", () => {
  const MODEL = "gemini-search-mixed";

  const weather = {
    type: "function",
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };

  const responses = (tools: Json[], extra: Json = {}) =>
    onSearchModel(MODEL, () =>
      translate(
        "openai-response",
        "gemini",
        { model: MODEL, input: "weather in Paris", tools, ...(extra as object) },
        MODEL,
      ),
    );

  it("sets includeServerSideToolInvocations when web_search is mixed with functions", () => {
    const out = responses([{ type: "web_search" }, weather], { tool_choice: "auto" });

    expect(get(out, "toolConfig.includeServerSideToolInvocations")).toBe(true);
    expect(get(out, "toolConfig.functionCallingConfig.mode")).toBe("AUTO");
    expect(get(out, "tools.0.googleSearch")).toBeDefined();
    expect(get(out, "tools.1.functionDeclarations.0.name")).toBe("get_weather");
  });

  it("leaves it out for web_search alone and for functions alone", () => {
    expect(
      get(responses([{ type: "web_search" }]), "toolConfig.includeServerSideToolInvocations"),
    ).toBeUndefined();
    expect(
      get(responses([weather]), "toolConfig.includeServerSideToolInvocations"),
    ).toBeUndefined();
  });

  it("leaves it out when tool_choice none suppresses googleSearch", () => {
    const out = responses([{ type: "web_search" }, weather], { tool_choice: "none" });

    expect(get(out, "toolConfig.includeServerSideToolInvocations")).toBeUndefined();
  });
});

describe("OpenAI Responses -> Antigravity", () => {
  const MODEL = "gemini-search-mixed";

  const weather = {
    type: "function",
    name: "lookup_data",
    description: "Lookup data",
    parameters: { type: "object", properties: { k: { type: "string" } } },
  };

  const antigravity = (body: Json) =>
    builtinTranslators.translateRequest(
      "openai-response",
      "antigravity",
      {
        format: "openai-response",
        model: MODEL,
        stream: false,
        body,
        modelInfo: {
          id: MODEL,
          supportsWebSearch: true,
          nativeCapabilities: { webSearch: true },
        },
      },
      undefined,
    ).body;

  const carriesFlag = (out: Json): boolean =>
    get(out, "request.toolConfig.includeServerSideToolInvocations") !== undefined ||
    get(out, "toolConfig.includeServerSideToolInvocations") !== undefined;

  it("strips the flag and the empty toolConfig when googleSearch is mixed with a function", () => {
    const out = onSearchModel(MODEL, () =>
      antigravity({
        model: MODEL,
        input: "Search weather and lookup local data",
        tools: [{ type: "web_search" }, weather],
      }),
    );

    expect(carriesFlag(out)).toBe(false);
    expect(get(out, "request.toolConfig")).toBeUndefined();
    expect(get(out, "request.tools.0.functionDeclarations.0.name")).toBe("lookup_data");
  });

  it("keeps the function calling mode of tool_choice auto while stripping the flag", () => {
    const out = onSearchModel(MODEL, () =>
      antigravity({
        model: MODEL,
        input: "Search weather and lookup local data",
        tools: [{ type: "web_search" }, weather],
        tool_choice: "auto",
      }),
    );

    expect(carriesFlag(out)).toBe(false);
    expect(get(out, "request.toolConfig.functionCallingConfig.mode")).toBe("AUTO");
  });

  it("strips the flag from a web_search envelope that gets its functions from additional_tools", () => {
    const out = onSearchModel(MODEL, () =>
      antigravity({
        model: MODEL,
        input: [
          { type: "additional_tools", tools: [weather] },
          { role: "user", content: "Search weather" },
        ],
        tools: [{ type: "web_search" }],
      }),
    );

    expect(get(out, "requestType")).toBe("web_search");
    expect(get(out, "request.tools.1.functionDeclarations.0.name")).toBe("lookup_data");
    expect(carriesFlag(out)).toBe(false);
  });
});
