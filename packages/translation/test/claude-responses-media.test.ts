// Responses -> Claude request: input_file media types, tool output media, tool output cache_control and same-response
// thinking blocks (Go: internal/translator/claude/openai/responses/claude_openai-responses_request_test.go,
// claude_openai-responses_user_turn_test.go, claude_openai-responses_reasoning_order_test.go; upstream f08cb931,
// 8cab158f, c71aa824).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import {
  convertOpenAIResponsesRequestToClaude,
  parseClaudeReasoningItemID,
} from "../src/translator/claude/openai/responses/request.ts";
import { convertClaudeResponseToOpenAIResponsesNonStream } from "../src/translator/claude/openai/responses/response.ts";
import { isArr, str } from "../src/translator/common/gjson.ts";
import { UnsupportedPartError } from "../src/translator/common/parts.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";
import { claudeSignature } from "./support/claude-signature.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const convert = (raw: string, model = "claude-sonnet-4-6"): Json =>
  convertOpenAIResponsesRequestToClaude(model, parse(raw), false);

const unsupportedType = (raw: string): string => {
  try {
    convert(raw);
  } catch (error) {
    if (error instanceof UnsupportedPartError && error.status === 400) return error.partType;
    throw error;
  }

  return "";
};

const contentOf = (out: Json, path: string): Json[] => {
  const content = get(out, path);

  return isArr(content) ? content : [];
};

const types = (blocks: Json[]): string[] => blocks.map((block) => str(get(block, "type")));

const findToolResult = (out: Json, callID: string): Json => {
  for (const msg of contentOf(out, "messages")) {
    for (const block of contentOf(msg, "content")) {
      if (get(block, "type") === "tool_result" && get(block, "tool_use_id") === callID)
        return block;
    }
  }

  throw new Error(`no tool_result for ${callID}: ${JSON.stringify(out)}`);
};

const expectNoInnerCacheControl = (toolResult: Json): void => {
  for (const part of contentOf(toolResult, "content"))
    expect(get(part, "cache_control")).toBeUndefined();
};

const signature = claudeSignature();

const reasoning = (id: string, text: string): string =>
  JSON.stringify({
    type: "reasoning",
    id,
    encrypted_content: signature,
    summary: [{ type: "summary_text", text }],
  });

const request = (...items: string[]): string =>
  `{"model":"claude-test","input":[${[
    ...items,
    `{"type":"function_call","call_id":"call_1","name":"tool","arguments":"{}"}`,
    `{"type":"function_call_output","call_id":"call_1","output":"done"}`,
  ].join(",")}]}`;

const assistant = (raw: string): Json[] =>
  contentOf(convert(raw, "claude-test"), "messages.0.content");

describe("input_file and tool output media (f08cb931)", () => {
  it("infers pdf from the filename of a raw base64 input_file", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
      {"type":"input_text","text":"Read PDF"},
      {"type":"input_file","filename":"sample.pdf","file_data":"JVBERi0xLjQK"}]}]}`);

    expect(get(out, "messages.0.content.1")).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
    });
  });

  it("infers pdf from the magic prefix without a filename", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
      {"type":"input_file","file_data":"JVBERi0xLjQK"}]}]}`);

    expect(get(out, "messages.0.content.0.source.media_type")).toBe("application/pdf");
  });

  it("maps an http file_url to a Claude url document", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
      {"type":"input_file","file_url":"https://example.test/sample.pdf"}]}]}`);

    expect(get(out, "messages.0.content.0")).toEqual({
      type: "document",
      source: { type: "url", url: "https://example.test/sample.pdf" },
    });
  });

  it("refuses a user turn whose only file is a non-http file_url", () => {
    expect(
      unsupportedType(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
        {"type":"input_file","file_url":"gs://example.test/a.pdf"}]}]}`),
    ).toBe("input_file");
  });

  it("keeps single-object and array text tool outputs for paired and standalone calls", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[
      {"type":"message","role":"user","content":[{"type":"input_text","text":"Run"}]},
      {"type":"function_call","call_id":"call_txt","name":"echo","arguments":"{}"},
      {"type":"function_call_output","call_id":"call_txt","output":{"type":"text","text":"paired text"}},
      {"type":"function_call_output","call_id":"orphan_txt","output":{"type":"text","text":"standalone text"}}]}`);

    expect(get(out, "messages.2.content.0.content")).toBe("paired text");
    expect(get(out, "messages.2.content.1.text")).toBe("standalone text");
  });

  it("converts a single-object function_call_output image and pdf", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[
      {"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect"}]},
      {"type":"function_call","call_id":"call_img","name":"view_image","arguments":"{}"},
      {"type":"function_call","call_id":"call_pdf","name":"read_pdf","arguments":"{}"},
      {"type":"function_call_output","call_id":"call_img","output":{"type":"input_image","image_url":"data:image/png;base64,AA=="}},
      {"type":"function_call_output","call_id":"call_pdf","output":{"type":"input_file","filename":"doc.pdf","file_data":"JVBERi0xLjQK"}}]}`);

    expect(get(out, "messages.2.content.0.content.0")).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AA==" },
    });
    expect(get(out, "messages.2.content.1.content.0")).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
    });
  });

  it("decodes a raw base64 text/plain input_file and refuses other text subtypes", () => {
    const out = convert(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
      {"type":"input_file","filename":"notes.txt","file_data":"SGVsbG8gd29ybGQ="}]}]}`);

    expect(get(out, "messages.0.content.0")).toEqual({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "Hello world" },
    });
    expect(
      unsupportedType(`{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[
        {"type":"input_file","filename":"page.html","file_data":"PGgxPkhpPC9oMT4="}]}]}`),
    ).toBe("input_file");
  });

  const binaryCases: ReadonlyArray<{ name: string; raw: string; want: string }> = [
    {
      name: "unknown binary input_file in user turn",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_file","filename":"blob.bin","file_data":"AAAA"}]}]}`,
      want: "input_file",
    },
    {
      name: "array function_call_output audio",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"function_call","call_id":"call_1","name":"rec","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]}]}`,
      want: "input_audio",
    },
    {
      name: "mixed paired function_call_output text and audio",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"function_call","call_id":"call_1","name":"rec","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"Recorded audio"},{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]}]}`,
      want: "input_audio",
    },
    {
      name: "mixed standalone function_call_output text and audio",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"function_call_output","call_id":"orphan_1","output":[{"type":"input_text","text":"Recorded audio"},{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}]}]}`,
      want: "input_audio",
    },
    {
      name: "object function_call_output audio",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"function_call","call_id":"call_1","name":"rec","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}}]}`,
      want: "input_audio",
    },
    {
      name: "object function_call_output unknown binary file",
      raw: `{"model":"claude-sonnet-4-6","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"function_call","call_id":"call_1","name":"read","arguments":"{}"},{"type":"function_call_output","call_id":"call_1","output":{"type":"input_file","filename":"blob.bin","file_data":"AAAA"}}]}`,
      want: "input_file",
    },
  ];

  for (const tc of binaryCases) {
    it(`refuses unsupported binary modalities: ${tc.name}`, () => {
      expect(unsupportedType(tc.raw)).toBe(tc.want);
    });
  }
});

describe("tool output cache_control (8cab158f)", () => {
  const sonnet = "claude-sonnet-5-5";

  const paired = (callID: string, output: string, extra = ""): string =>
    `{"model":"${sonnet}","input":[
      {"type":"message","role":"user","content":[{"type":"input_text","text":"Run"}]},
      {"type":"function_call","call_id":"${callID}","name":"run","arguments":"{}"},
      {"type":"function_call_output","call_id":"${callID}"${extra},"output":${output}}]}`;

  it("puts function_call_output item-level cache_control on the tool_result", () => {
    const tr = findToolResult(
      convert(
        paired("call_x", `"long tool output"`, `,"cache_control":{"type":"ephemeral"}`),
        sonnet,
      ),
      "call_x",
    );

    expect(get(tr, "content")).toBe("long tool output");
    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
  });

  it("puts custom_tool_call_output item-level cache_control with ttl on the tool_result", () => {
    const out = convert(
      `{"model":"${sonnet}","input":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"Patch file"}]},
        {"type":"custom_tool_call","call_id":"call_c1","name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"},
        {"type":"custom_tool_call_output","call_id":"call_c1","output":"patched","cache_control":{"type":"ephemeral","ttl":"1h"}}]}`,
      sonnet,
    );

    expect(get(findToolResult(out, "call_c1"), "cache_control")).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("hoists a single text part's cache_control", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_p1",
          `[{"type":"input_text","text":"part output","cache_control":{"type":"ephemeral"}}]`,
        ),
        sonnet,
      ),
      "call_p1",
    );

    expect(get(tr, "content")).toBe("part output");
    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
    expectNoInnerCacheControl(tr);
  });

  it("hoists the last valid cache_control of a multi-part output without inner markers", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_m1",
          `[{"type":"input_text","text":"part 1","cache_control":{"type":"ephemeral","ttl":"1h"}},
            {"type":"input_text","text":"part 2","cache_control":{"type":"ephemeral"}}]`,
        ),
        sonnet,
      ),
      "call_m1",
    );

    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
    expectNoInnerCacheControl(tr);
  });

  it("hoists an image part's cache_control", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_img",
          `[{"type":"input_text","text":"screenshot"},
            {"type":"input_image","image_url":"https://example.com/pic.png","cache_control":{"type":"ephemeral"}}]`,
        ),
        sonnet,
      ),
      "call_img",
    );

    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
    expectNoInnerCacheControl(tr);
  });

  it("hoists a single structured object's cache_control", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_obj",
          `{"type":"input_text","text":"obj output","cache_control":{"type":"ephemeral"}}`,
        ),
        sonnet,
      ),
      "call_obj",
    );

    expect(get(tr, "content")).toBe("obj output");
    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
  });

  it("prefers part-level cache_control over item-level", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_prec",
          `[{"type":"input_text","text":"result","cache_control":{"type":"ephemeral"}}]`,
          `,"cache_control":{"type":"ephemeral","ttl":"1h"}`,
        ),
        sonnet,
      ),
      "call_prec",
    );

    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral" });
  });

  it("falls back to a valid item-level cache_control when the part's is invalid", () => {
    const tr = findToolResult(
      convert(
        paired(
          "call_fb",
          `[{"type":"input_text","text":"result","cache_control":{"type":"invalid"}}]`,
          `,"cache_control":{"type":"ephemeral","ttl":"1h"}`,
        ),
        sonnet,
      ),
      "call_fb",
    );

    expect(get(tr, "cache_control")).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("ignores an invalid item-level cache_control", () => {
    const tr = findToolResult(
      convert(paired("call_inv", `"ok"`, `,"cache_control":{"type":"invalid"}`), sonnet),
      "call_inv",
    );

    expect(get(tr, "cache_control")).toBeUndefined();
  });

  it("keeps item and part cache_control on a standalone unpaired output", () => {
    const outItem = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_item","output":"seed context","cache_control":{"type":"ephemeral"}}]}`,
      sonnet,
    );

    expect(get(outItem, "messages.0.content.0.cache_control.type")).toBe("ephemeral");

    const outPart = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_part","output":[
        {"type":"input_text","text":"seed 1","cache_control":{"type":"ephemeral"}},
        {"type":"input_text","text":"seed 2"}]}]}`,
      sonnet,
    );

    expect(get(outPart, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
    expect(get(outPart, "messages.0.content.1.cache_control")).toBeUndefined();
  });

  it("keeps cache_control on a late orphan tool_result folded during repair", () => {
    const out = convert(
      `{"model":"${sonnet}","input":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"start"}]},
        {"type":"function_call","call_id":"call_late","name":"lookup","arguments":"{}"},
        {"type":"message","role":"user","content":[{"type":"input_text","text":"interrupted"}]},
        {"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]},
        {"type":"function_call_output","call_id":"call_late","output":"delayed output","cache_control":{"type":"ephemeral"}}]}`,
      sonnet,
    );

    const msgs = contentOf(out, "messages");
    const last = msgs[msgs.length - 1];

    expect(get(last, "role")).toBe("user");
    expect(get(last, "content.0.type")).toBe("text");
    expect(get(last, "content.0.cache_control.type")).toBe("ephemeral");
  });

  it("moves a standalone empty trailing part's cache_control to the preceding block", () => {
    const out = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_blank","output":[
        {"type":"input_text","text":"visible seed"},
        {"type":"input_text","text":"   ","cache_control":{"type":"ephemeral"}}]}]}`,
      sonnet,
    );

    expect(get(out, "messages.0.content.0.text")).toBe("visible seed");
    expect(get(out, "messages.0.content.0.cache_control.type")).toBe("ephemeral");
  });

  it("keeps the last valid part cache_control on the placeholder of an all-empty standalone output", () => {
    const onlyBlank = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_only_blank","output":[
        {"type":"input_text","text":"   ","cache_control":{"type":"ephemeral"}}]}]}`,
      sonnet,
    );

    expect(get(onlyBlank, "messages.0.content.0.text")).toBe("Tool result was empty.");
    expect(get(onlyBlank, "messages.0.content.0.cache_control.type")).toBe("ephemeral");

    const partWins = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_blank_prec","cache_control":{"type":"ephemeral","ttl":"1h"},"output":[
        {"type":"input_text","text":"","cache_control":{"type":"ephemeral","ttl":"1h"}},
        {"type":"input_text","text":"   ","cache_control":{"type":"ephemeral"}}]}]}`,
      sonnet,
    );

    expect(get(partWins, "messages.0.content.0.cache_control")).toEqual({ type: "ephemeral" });

    const fallback = convert(
      `{"model":"${sonnet}","input":[{"type":"function_call_output","call_id":"orphan_blank_fb","cache_control":{"type":"ephemeral","ttl":"1h"},"output":[
        {"type":"input_text","text":"   ","cache_control":{"type":"invalid"}}]}]}`,
      sonnet,
    );

    expect(get(fallback, "messages.0.content.0.cache_control.ttl")).toBe("1h");
  });

  const nonPartOutputs: ReadonlyArray<{ name: string; output: string }> = [
    {
      name: "untyped JSON array element",
      output: `[{"id":1,"cache_control":{"type":"ephemeral"}}]`,
    },
    {
      name: "case-mismatched TEXT array element",
      output: `[{"type":"TEXT","text":"record","cache_control":{"type":"ephemeral"}}]`,
    },
    {
      name: "case-mismatched TEXT object",
      output: `{"type":"TEXT","text":"record","cache_control":{"type":"ephemeral"}}`,
    },
  ];

  for (const tc of nonPartOutputs) {
    it(`does not hoist a domain cache_control field of non-part JSON output: ${tc.name}`, () => {
      const tr = findToolResult(convert(paired("call_raw", tc.output), sonnet), "call_raw");

      expect(get(tr, "cache_control")).toBeUndefined();
    });
  }
});

describe("same-response thinking blocks (c71aa824)", () => {
  it("keeps ascending blocks of the same response", () => {
    const content = assistant(
      request(
        reasoning("rs_msg_01Same_0", "primary reasoning"),
        reasoning("rs_msg_01Same_1", "progress update"),
      ),
    );

    expect(types(content)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(get(content[0], "thinking")).toBe("primary reasoning");
    expect(get(content[0], "signature")).toBe(signature);
    expect(get(content[1], "thinking")).toBe("progress update");
  });

  it("collapses thinking from different responses to the latest", () => {
    const content = assistant(
      request(
        reasoning("rs_msg_01First_0", "first reasoning"),
        reasoning("rs_msg_01First_1", "first update"),
        reasoning("rs_msg_01Later_0", "later reasoning"),
      ),
    );

    expect(types(content)).toEqual(["thinking", "tool_use"]);
    expect(get(content[0], "thinking")).toBe("later reasoning");
  });

  const edgeCases: ReadonlyArray<{ name: string; firstID: string; secondID: string }> = [
    { name: "duplicate block index", firstID: "rs_msg_01Dup_0", secondID: "rs_msg_01Dup_0" },
    { name: "descending block index", firstID: "rs_msg_01Order_2", secondID: "rs_msg_01Order_1" },
    { name: "negative block index", firstID: "rs_msg_01Neg_-1", secondID: "rs_msg_01Neg_0" },
    { name: "empty response id", firstID: "rs__0", secondID: "rs__1" },
    { name: "signed positive suffix", firstID: "rs_msg_01Plus_+0", secondID: "rs_msg_01Plus_+1" },
  ];

  for (const tc of edgeCases) {
    it(`collapses duplicate or invalid same-response thinking: ${tc.name}`, () => {
      const content = assistant(
        request(reasoning(tc.firstID, "first"), reasoning(tc.secondID, "second")),
      );

      expect(types(content)).toEqual(["thinking", "tool_use"]);
      expect(get(content[0], "thinking")).toBe("second");
    });
  }

  it("collapses a replayed same-response thinking pair to the replay", () => {
    const content = assistant(
      request(
        reasoning("rs_msg_01Same_0", "first reasoning"),
        reasoning("rs_msg_01Same_1", "first update"),
        reasoning("rs_msg_01Same_0", "replayed reasoning"),
        reasoning("rs_msg_01Same_1", "replayed update"),
      ),
    );

    expect(types(content)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(get(content[0], "thinking")).toBe("replayed reasoning");
    expect(get(content[1], "thinking")).toBe("replayed update");
  });

  it("replaces only a duplicate trailing block index and keeps the prefix", () => {
    const content = assistant(
      request(
        reasoning("rs_msg_01Same_0", "primary reasoning"),
        reasoning("rs_msg_01Same_1", "first progress update"),
        reasoning("rs_msg_01Same_1", "latest progress update"),
      ),
    );

    expect(types(content)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(get(content[0], "thinking")).toBe("primary reasoning");
    expect(get(content[1], "thinking")).toBe("latest progress update");
  });

  it("round-trips adjacent same-response thinking blocks through the non-stream response", () => {
    const body = JSON.stringify({
      id: "msg_01RoundTrip",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "Inspect the repository.", signature },
        { type: "thinking", thinking: "Running grep now.", signature },
        { type: "tool_use", id: "toolu_01RT", name: "exec_command", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const context: ResponseContext = {
      model: "claude-opus-5-5",
      originalRequest: undefined,
      translatedRequest: undefined,
      state: makeTranslationState(),
    };

    const response = parse(convertClaudeResponseToOpenAIResponsesNonStream(context, body));
    const items = contentOf(response, "output").map((item) => JSON.stringify(item));

    items.push(`{"type":"function_call_output","call_id":"toolu_01RT","output":"ok"}`);

    const content = contentOf(
      convert(`{"model":"claude-opus-5-5","input":[${items.join(",")}]}`, "claude-opus-5-5"),
      "messages.0.content",
    );

    expect(types(content)).toEqual(["thinking", "thinking", "tool_use"]);
    expect(get(content[0], "thinking")).toBe("Inspect the repository.");
    expect(get(content[1], "thinking")).toBe("Running grep now.");
  });

  const idCases: ReadonlyArray<[string, string, number, boolean]> = [
    ["rs_msg_011ChF1ocEToPEeFhKVmgRWx_0", "msg_011ChF1ocEToPEeFhKVmgRWx", 0, true],
    ["rs_resp_1_12", "resp_1", 12, true],
    ["rs_msg", "", -1, false],
    ["rs__1", "", -1, false],
    ["rs_   _1", "", -1, false],
    ["rs_msg_", "", -1, false],
    ["rs_msg_-1", "", -1, false],
    ["rs_msg_+1", "", -1, false],
    ["rs_msg_x", "", -1, false],
    ["msg_1_0", "", -1, false],
    ["", "", -1, false],
  ];

  it("parseClaudeReasoningItemID parses rs_<response id>_<block index>", () => {
    for (const [itemID, responseID, blockIndex, ok] of idCases) {
      expect(parseClaudeReasoningItemID(itemID), itemID).toEqual({ responseID, blockIndex, ok });
    }
  });
});
