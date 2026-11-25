/**
 * Claude `web_search` tool <-> Antigravity native Google Search.
 *
 * Go source: internal/translator/antigravity/claude/web_search.go.
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { lookupModelInfo } from "../../model-info.ts";
import { ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION } from "../common/web-search.ts";

/** `normalizeAntigravityCapabilityModelID`. */
const normalizeCapabilityModelId = (modelId: string): string => {
  let id = modelId.trim().toLowerCase();
  const open = id.lastIndexOf("(");

  if (open >= 0 && id.endsWith(")")) id = id.slice(0, open).trim();

  return id;
};

/** `antigravitySupportsNativeGoogleSearch`: the Antigravity registry record advertises web search. */
export const antigravitySupportsNativeGoogleSearch = (model: string): boolean => {
  const id = normalizeCapabilityModelId(model);

  if (id === "") return false;

  return lookupModelInfo(id, "antigravity")?.supportsWebSearch === true;
};

export const isClaudeTypedWebSearchToolType = (toolType: string): boolean =>
  toolType === "web_search_20250305" || toolType === "web_search_20260209";

const toolsOf = (payload: Json | undefined, path = "tools"): Json[] => {
  const tools = get(payload, path);

  return isJsonArray(tools) ? tools : [];
};

export const hasClaudeTypedWebSearchTool = (payload: Json | undefined): boolean =>
  toolsOf(payload).some((tool) => isClaudeTypedWebSearchToolType(asString(get(tool, "type"))));

const hasOnlyClaudeTypedWebSearchTools = (payload: Json): boolean => {
  const tools = toolsOf(payload);

  return (
    tools.length > 0 &&
    tools.every((tool) => isClaudeTypedWebSearchToolType(asString(get(tool, "type"))))
  );
};

const allowsClaudeWebSearchToolChoice = (payload: Json): boolean => {
  const toolChoice = get(payload, "tool_choice");

  if (toolChoice === undefined) return true;

  if (typeof toolChoice === "string")
    return toolChoice === "" || toolChoice === "auto" || toolChoice === "any";

  if (!isJsonObject(toolChoice)) return false;

  switch (asString(toolChoice["type"])) {
    case "":
    case "auto":
    case "any":
      return true;
    case "tool":
      return asString(toolChoice["name"]) === "web_search";
    default:
      return false;
  }
};

/** `shouldBuildAntigravityWebSearchRequest`. */
export const shouldBuildAntigravityWebSearchRequest = (model: string, payload: Json): boolean =>
  antigravitySupportsNativeGoogleSearch(model) &&
  hasOnlyClaudeTypedWebSearchTools(payload) &&
  allowsClaudeWebSearchToolChoice(payload);

const extractMaxUses = (payload: Json): number => {
  for (const tool of toolsOf(payload)) {
    if (!isClaudeTypedWebSearchToolType(asString(get(tool, "type")))) continue;
    const maxUses = asInt(get(tool, "max_uses"));

    if (maxUses > 0) return maxUses;
  }

  return 5;
};

const extractAllowedDomains = (payload: Json): string[] => {
  for (const tool of toolsOf(payload)) {
    if (!isClaudeTypedWebSearchToolType(asString(get(tool, "type")))) continue;
    const allowed = get(tool, "allowed_domains");

    if (!isJsonArray(allowed)) return [];

    return allowed
      .filter((domain): domain is string => typeof domain === "string")
      .map((d) => d.trim())
      .filter((d) => d !== "");
  }

  return [];
};

const extractTextContent = (content: Json | undefined): string => {
  if (typeof content === "string") return content.trim();

  if (!isJsonArray(content)) return "";
  const texts: string[] = [];

  for (const part of content) {
    const text = asString(get(part, "text")).trim();

    if (text !== "") texts.push(text);
  }

  return texts.join("\n").trim();
};

const extractQuery = (payload: Json): string => {
  const messages = get(payload, "messages");

  if (!isJsonArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const role = asString(get(message, "role"));

    if (role !== "" && role !== "user") continue;
    const query = extractTextContent(get(message, "content"));

    if (query !== "") return query;
  }

  return "";
};

/** `buildAntigravityWebSearchRequest`. */
export const buildAntigravityWebSearchRequest = (model: string, payload: Json): Json => {
  const out: Json = {
    model,
    requestType: "web_search",
    request: {
      contents: [{ role: "user", parts: [{ text: extractQuery(payload) }] }],
      systemInstruction: {
        role: "user",
        parts: [{ text: ANTIGRAVITY_WEB_SEARCH_SYSTEM_INSTRUCTION }],
      },
      tools: [
        {
          googleSearch: {
            enhancedContent: { imageSearch: { maxResultCount: extractMaxUses(payload) } },
          },
        },
      ],
      generationConfig: { candidateCount: 1 },
    },
  };

  const domains = extractAllowedDomains(payload);

  if (domains.length > 0) set(out, "request.tools.0.googleSearch.includedDomains", domains);

  return out;
};

/** `hasAntigravityGoogleSearchTool` on a translated request. */
export const hasAntigravityGoogleSearchTool = (request: Json | undefined): boolean =>
  toolsOf(request, "request.tools").some((tool) => get(tool, "googleSearch") !== undefined);

/** `shouldTranslateWebSearchGrounding`. */
export const shouldTranslateWebSearchGrounding = (
  originalRequest: Json | undefined,
  translatedRequest: Json | undefined,
): boolean =>
  hasClaudeTypedWebSearchTool(originalRequest) && hasAntigravityGoogleSearchTool(translatedRequest);

export const antigravityGroundingMetadata = (root: Json | undefined): Json | undefined =>
  get(root, "response.candidates.0.groundingMetadata") ??
  get(root, "candidates.0.groundingMetadata");

export const antigravityTextContent = (root: Json | undefined): string => {
  let parts = get(root, "response.candidates.0.content.parts");

  if (!isJsonArray(parts)) parts = get(root, "candidates.0.content.parts");

  if (!isJsonArray(parts)) return "";
  let text = "";

  for (const part of parts) {
    const value = get(part, "text");

    if (value !== undefined) text += asString(value);
  }

  return text;
};

const webSearchQueryFromGrounding = (grounding: Json): string => {
  const queries = get(grounding, "webSearchQueries");

  return isJsonArray(queries) && queries.length > 0 ? asString(queries[0]) : "";
};

const webSearchResultsFromGrounding = (grounding: Json): Json[] => {
  const results: Json[] = [];
  const chunks = get(grounding, "groundingChunks");

  if (!isJsonArray(chunks)) return results;
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const web = get(chunk, "web");

    if (web === undefined) continue;
    const uri = asString(get(web, "uri")).trim();

    if (uri === "" || seen.has(uri)) continue;
    seen.add(uri);
    const result: JsonObject = { type: "web_search_result", page_age: null };
    const title = get(web, "title");

    if (title !== undefined) result["title"] = asString(title);
    result["url"] = uri;
    results.push(result);
  }

  return results;
};

interface GroundingSupport {
  startIndex: number;
  endIndex: number;
  text: string;
  chunkUrls: string[];
  chunkTitle: string;
}

interface CitedTextBlock {
  readonly text: string;
  readonly citations: JsonObject[];
}

const parseGroundingSupports = (grounding: Json): GroundingSupport[] | undefined => {
  const chunks = get(grounding, "groundingChunks");

  if (!isJsonArray(chunks)) return undefined;

  const chunkData = chunks.map((chunk) => {
    const web = get(chunk, "web");

    return web === undefined
      ? { url: "", title: "" }
      : { url: asString(get(web, "uri")), title: asString(get(web, "title")) };
  });

  const rawSupports = get(grounding, "groundingSupports");

  if (!isJsonArray(rawSupports)) return undefined;
  const supports: GroundingSupport[] = [];

  for (const support of rawSupports) {
    const segment = get(support, "segment");

    if (segment === undefined) continue;

    const parsed: GroundingSupport = {
      startIndex: asInt(get(segment, "startIndex")),
      endIndex: asInt(get(segment, "endIndex")),
      text: asString(get(segment, "text")),
      chunkUrls: [],
      chunkTitle: "",
    };

    const indices = get(support, "groundingChunkIndices");

    if (isJsonArray(indices)) {
      for (const index of indices) {
        const chunkIndex = asInt(index);

        if (chunkIndex < 0 || chunkIndex >= chunkData.length) continue;
        // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const data = chunkData[chunkIndex] as { url: string; title: string };
        parsed.chunkUrls.push(data.url);

        if (parsed.chunkTitle === "") parsed.chunkTitle = data.title;
      }
    }

    supports.push(parsed);
  }

  return supports;
};

const utf8 = new TextEncoder();

const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** `buildWebSearchCitedTextBlocks`: indices are UTF-8 byte offsets, like Go. */
const buildCitedTextBlocks = (
  textContent: string,
  supports: GroundingSupport[] | undefined,
): CitedTextBlock[] => {
  if (supports === undefined || supports.length === 0) {
    return textContent === "" ? [] : [{ text: textContent, citations: [] }];
  }

  const bytes = utf8.encode(textContent);
  const blocks: CitedTextBlock[] = [];
  let lastEnd = 0;

  for (const support of supports) {
    if (support.endIndex <= lastEnd) continue;

    if (support.startIndex > lastEnd) {
      const start = lastEnd;
      const end = Math.min(support.startIndex, bytes.length);

      if (start < end) blocks.push({ text: utf8Decode(bytes.subarray(start, end)), citations: [] });
    }

    const citedStart = Math.max(support.startIndex, lastEnd);
    let citedText = "";

    if (citedStart < support.endIndex) {
      const start = Math.min(citedStart, bytes.length);
      const end = Math.min(support.endIndex, bytes.length);

      if (start < end) citedText = utf8Decode(bytes.subarray(start, end));
    }

    if (citedText !== "" && support.chunkUrls.length > 0) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      blocks.push({
        text: citedText,
        citations: [
          {
            cited_text: citedText,
            title: support.chunkTitle,
            type: "web_search_result_location",
            url: support.chunkUrls[0] as string,
          },
        ],
      });
    } else if (citedText !== "") {
      // A support without a resolvable citation URL keeps its text, uncited (Go 1b730a1d).
      blocks.push({ text: citedText, citations: [] });
    }

    if (support.endIndex > lastEnd) lastEnd = support.endIndex;
  }

  if (lastEnd < bytes.length)
    blocks.push({ text: utf8Decode(bytes.subarray(lastEnd)), citations: [] });

  return blocks;
};

/** `buildClaudeWebSearchContent`. */
export const buildClaudeWebSearchContent = (
  toolUseId: string,
  textContent: string,
  grounding: Json,
): Json[] => {
  const content: Json[] = [];

  const serverToolUse: JsonObject = {
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: {},
  };

  const query = webSearchQueryFromGrounding(grounding);

  if (query !== "") serverToolUse["input"] = { query };
  content.push(serverToolUse);
  content.push({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: webSearchResultsFromGrounding(grounding),
  });

  for (const block of buildCitedTextBlocks(textContent, parseGroundingSupports(grounding))) {
    if (block.text === "") continue;
    const textBlock: JsonObject = { type: "text", text: block.text };

    if (block.citations.length > 0) textBlock["citations"] = block.citations;
    content.push(textBlock);
  }

  return content;
};

/** `splitRunesForWebSearch`. */
const splitRunes = (text: string, chunkSize: number): string[] => {
  if (text === "") return [];
  const runes = Array.from(text);
  const chunks: string[] = [];

  for (let start = 0; start < runes.length; start += chunkSize)
    chunks.push(runes.slice(start, start + chunkSize).join(""));

  return chunks;
};

/** `appendClaudeWebSearchStreamBlocks`: returns the next content index. */
export const appendClaudeWebSearchStreamBlocks = (
  appendEvent: (event: string, payload: string) => void,
  startIndex: number,
  toolUseId: string,
  textContent: string,
  grounding: Json,
): number => {
  let index = startIndex;
  appendEvent(
    "content_block_start",
    `{"type":"content_block_start","index":${index},"content_block":{"type":"server_tool_use","id":"${toolUseId}","name":"web_search","input":{}}}`,
  );
  const query = webSearchQueryFromGrounding(grounding);

  if (query !== "") {
    appendEvent(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
      }),
    );
  }

  appendEvent("content_block_stop", `{"type":"content_block_stop","index":${index}}`);
  index++;

  appendEvent(
    "content_block_start",
    JSON.stringify({
      type: "content_block_start",
      index,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: webSearchResultsFromGrounding(grounding),
      },
    }),
  );
  appendEvent("content_block_stop", `{"type":"content_block_stop","index":${index}}`);
  index++;

  for (const block of buildCitedTextBlocks(textContent, parseGroundingSupports(grounding))) {
    if (block.text === "") continue;
    appendEvent(
      "content_block_start",
      block.citations.length > 0
        ? `{"type":"content_block_start","index":${index},"content_block":{"citations":[],"type":"text","text":""}}`
        : `{"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`,
    );

    for (const citation of block.citations) {
      appendEvent(
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "citations_delta", citation },
        }),
      );
    }

    for (const chunk of splitRunes(block.text, 50)) {
      appendEvent(
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: chunk },
        }),
      );
    }

    appendEvent("content_block_stop", `{"type":"content_block_stop","index":${index}}`);
    index++;
  }

  return index;
};

let toolUseCounter = 0;

/** `newClaudeWebSearchToolUseID` (`srvtoolu_<unix nano>`). */
export const newClaudeWebSearchToolUseId = (): string =>
  `srvtoolu_${Date.now()}${String(++toolUseCounter % 1000000).padStart(6, "0")}`;

/** `appendWebSearchBufferedText`. */
export const appendWebSearchBufferedText = (parts: Json[]): string => {
  let text = "";

  for (const part of parts) {
    if (get(part, "thought") === true || get(part, "functionCall") !== undefined) continue;
    const value = get(part, "text");

    if (value !== undefined) text += asString(value);
  }

  return text;
};
