// Responses compaction capsules against the Go implementation: the helper functions of `executor/helps/compaction.ts`
// and end-to-end scenarios (route -> conductor -> Claude/Antigravity executor -> mocked upstream) compared with the
// real Go executors (`go run ./tools/fixturegen/compaction`, test/fixtures/compaction.json).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { resetMemoryAntigravityState } from "../src/executor/antigravity/state.ts";
import {
  buildCompactionResponse,
  buildCompactionStreamChunks,
  capsulePlaintext,
  expandCompactionCapsules,
  extractSummaryText,
  prepareCompactionSummaryPayload,
  sealCompaction,
  unsealCompaction,
} from "../src/executor/helps/compaction.ts";
import { type JsonObject, tryParseJson } from "@commissary/json";
import fixtures from "./fixtures/compaction.json";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamCall,
} from "./support/pipeline.ts";

const helpers = fixtures.helpers;

/** The same masking the fixture generator applies to the Go output. */
const normalize = (text: string): string =>
  text
    .replace(/cpa-ag-compact-v1:[A-Za-z0-9_-]+/g, "CAPSULE")
    .replace(/((?:resp|cmp)_ag_compact_)\d+/g, "$1N")
    .replace(/"(created_at|completed_at)":\d+/g, '"$1":0')
    .replace(/"requestId":"[^"]*"/g, '"requestId":"R"')
    .replace(/"sessionId":"[^"]*"/g, '"sessionId":"S"')
    .replace(/(resp|msg)_[0-9a-f]{8,}_\d+/g, "$1_X");

const capsulesIn = (text: string): string[] => [
  ...new Set(text.match(/cpa-ag-compact-v1:[A-Za-z0-9_-]+/g) ?? []),
];

describe("compaction capsule helpers (Go parity)", () => {
  it("opens the capsules sealed by Go and reproduces the plaintext", async () => {
    for (const entry of helpers.seals) {
      expect(await unsealCompaction(entry.capsule)).toBe(entry.summary);
      // Structural: Go HTML-escapes the plaintext, Commissary does not.
      expect(JSON.parse(capsulePlaintext(entry.summary, entry.model, 0))).toEqual(
        JSON.parse(entry.plaintext),
      );
    }
  });

  it("seals deterministically with a fixed nonce and time, and the capsule opens to the summary", async () => {
    for (const entry of helpers.fixedSeals) {
      const nonce = Uint8Array.from(entry.nonceHex.match(/../g) ?? [], (hex) =>
        Number.parseInt(hex, 16),
      );

      const options = { createdAtSec: entry.createdAt, nonce };
      const capsule = await sealCompaction(entry.summary, entry.model, options);
      expect(capsule).toBe(await sealCompaction(entry.summary, entry.model, options));
      expect(await unsealCompaction(capsule)).toBe(entry.summary);
    }
  });

  it("round-trips fresh capsules with random nonces", async () => {
    const a = await sealCompaction("same", "m");
    const b = await sealCompaction("same", "m");
    expect(a).not.toBe(b);
    expect(a.startsWith("cpa-ag-compact-v1:")).toBe(true);
    expect(await unsealCompaction(a)).toBe("same");
  });

  it("rejects malformed capsules with the Go messages", async () => {
    for (const entry of helpers.unsealErrors) {
      await expect(unsealCompaction(entry.name)).rejects.toThrow(entry.error);
    }
  });

  it("prepares the summary payload like PrepareAntigravityCompactionSummaryPayload", () => {
    for (const entry of helpers.prepare) {
      expect(JSON.stringify(prepareCompactionSummaryPayload(JSON.parse(entry.input)))).toBe(
        JSON.stringify(JSON.parse(entry.output)),
      );
    }
  });

  it("expands compaction items like ExpandAntigravityCompactionCapsules", async () => {
    const capsule = helpers.expandCapsule;

    for (const entry of helpers.expand) {
      const input = JSON.parse(entry.input.replaceAll("{{capsule}}", capsule));

      if (entry.error !== undefined) {
        await expect(expandCompactionCapsules(input)).rejects.toThrow(entry.error);
        continue;
      }

      const out = await expandCompactionCapsules(input);
      expect(JSON.stringify(out)).toBe(
        JSON.stringify(JSON.parse(entry.output.replaceAll("{{capsule}}", capsule))),
      );
    }
  });

  it("extracts summary text from Responses, Gemini, Claude and Chat bodies", () => {
    for (const entry of helpers.extract) {
      const input = JSON.parse(entry.input);

      if (entry.error !== undefined)
        expect(() => extractSummaryText(input), entry.name).toThrow(entry.error);
      else expect(extractSummaryText(input), entry.name).toBe(entry.output);
    }
  });

  it("builds the compaction response and the five stream frames", () => {
    const now = 1_700_000_000_123;
    const response = buildCompactionResponse("m", "cpa-ag-compact-v1:X", 11, 7, 18, now);
    expect(normalize(JSON.stringify(response))).toBe(helpers.response.output);

    const chunks = buildCompactionStreamChunks("m", "cpa-ag-compact-v1:X", 11, 7, 18, now).map(
      normalize,
    );

    expect(chunks).toEqual(helpers.stream.chunks);
  });
});

const CLAUDE = credential("claude", "claude-compaction-key", {
  attributes: { api_key: "key-compaction", base_url: "https://claude.test" },
});

const ANTIGRAVITY = credential("antigravity", "antigravity-compaction.json", {
  kind: "oauth",
  metadata: { access_token: "test-token", project_id: "test-proj", email: "dev@example.com" },
});

const models = {
  "claude-haiku-4-5-20251001": ["claude"],
  "claude-sonnet-4-6": ["antigravity"],
  "gemini-3.7-flash": ["antigravity"],
};

let baseConfig: Config;

let ruleConfig: Config;

beforeAll(async () => {
  baseConfig = await loadConfig("");
  ruleConfig = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "claude-haiku-4-5-20251001", protocol: claude }]
        params:
          max_tokens: 1234
          tool_choice: { type: auto }
`);
});

type Scenario = (typeof fixtures.scenarios)[number];

const respond = (scenario: Scenario) => (call: UpstreamCall) => {
  const body = tryParseJson(call.body) as Record<string, unknown> | undefined;

  if (scenario.provider === "claude") {
    if (body?.["stream"] === true) {
      return sseResponse([
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_compact","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me examine the current build status."}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
      ]);
    }

    return jsonResponse(
      scenario.upstreamJson ??
        '{"id":"msg_compact","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Sealed summary of the build."}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":7}}',
    );
  }

  const contents = ((body?.["request"] as { contents?: Array<{ role?: string }> } | undefined)
    ?.contents ?? []) as Array<{
    role?: string;
  }>;

  const last = contents.at(-1)?.role;

  if (last === "model" || last === "assistant") {
    return new Response(
      '{"error":{"code":400,"message":"Requests ending with a model turn are not supported."}}',
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }

  if (scenario.upstreamSse === true) {
    return sseResponse([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Claude summary of previous conversation"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":10,"totalTokenCount":30}}}\n\n',
    ]);
  }

  return jsonResponse(
    '{"response":{"candidates":[{"content":{"parts":[{"text":"Summary of previous conversation"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}}',
  );
};

/** Frames of an SSE text as `[event, data]` with the JSON data parsed. */
const frames = (text: string): Array<[string, unknown]> =>
  text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";

      return [event, tryParseJson(data)];
    });

describe("compaction scenarios against the Go executors", () => {
  for (const scenario of fixtures.scenarios) {
    it(scenario.name, async () => {
      resetMemoryAntigravityState();

      const h = makeGeminiHarness({
        config: scenario.rule === true ? ruleConfig : baseConfig,
        respond: respond(scenario),
        credential: scenario.provider === "claude" ? CLAUDE : ANTIGRAVITY,
        models,
      });

      afterAll(h.dispose);
      const payload = JSON.parse(scenario.payload) as JsonObject;
      const compact = scenario.alt === "responses/compact";

      if (compact && scenario.stream !== true) delete payload["stream"];

      if (compact && scenario.stream === true) payload["stream"] = true;

      const response = await h.call(
        compact ? "/v1/responses/compact" : "/v1/responses",
        postJson(payload),
      );

      const text = await response.text();

      if (scenario.status !== undefined) {
        expect(response.status).toBe(scenario.status);

        if (
          scenario.errMessage !== undefined &&
          scenario.errMessage.startsWith("invalid compaction capsule")
        ) {
          expect(text).toContain("invalid compaction capsule");
        }

        expect(h.calls).toHaveLength(0);

        return;
      }

      expect(response.status).toBe(200);
      expect(h.calls).toHaveLength(scenario.seen.length);
      h.calls.forEach((call, index) => {
        expect(JSON.parse(normalize(call.body)), `upstream body ${index}`).toEqual(
          JSON.parse(scenario.seen[index] ?? ""),
        );
      });

      const summaries = await Promise.all(capsulesIn(text).map(unsealCompaction));
      expect(summaries).toEqual(scenario.summaries ?? []);
      const got = normalize(text);

      if (scenario.stream === true && scenario.capsules === undefined) {
        expect(frames(got)).toEqual(frames(normalize(scenario.output)));
      } else {
        expect(JSON.parse(got)).toEqual(JSON.parse(normalize(scenario.output)));
      }
    });
  }
});
