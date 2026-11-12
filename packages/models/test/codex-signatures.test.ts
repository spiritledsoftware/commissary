// C9 PR B (Go 7a0b7563, 674dbe8f, cc5682c5, a68c7d8e): the Codex executor's reasoning-signature policy end to end. The
// signature target is the upstream model (or the requested Meta, Grok or GPT model behind an unmapped alias), a router
// suffix survives on openrouter.ai only, and a cached signature meets the same policy as a client-sent one.
import { describe, expect, it } from "vite-plus/test";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import { makeInMemoryReplayStore } from "../src/executor/codex/replay.ts";
import type { ExecutorOptions } from "../src/executor/types.ts";
import type { Json } from "@commissary/json";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";
import { gptSignature, metaSignature, routerSuffixed } from "./support/signatures.ts";

const OFFICIAL = oauth();

const OPENROUTER = apiKey("https://openrouter.ai/api/v1");

function oauth() {
  return credential("codex", {
    kind: "oauth",
    attributes: { plan_type: "plus" },
    metadata: { access_token: "access-token-1", account_id: "acct_123" },
  });
}

function apiKey(baseUrl: string) {
  return credential("codex", {
    kind: "apikey",
    attributes: { api_key: "sk-1", base_url: baseUrl },
  });
}

const completed = (output: Json[]): Response =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output, usage: {} } })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const responsesOptions = (overrides: Partial<ExecutorOptions> = {}): ExecutorOptions =>
  options({
    sourceFormat: "openai-response",
    metadata: { ...options().metadata, requestPath: "/v1/responses", requestedModel: "" },
    ...overrides,
  });

const reasoning = (encrypted: string) => ({
  type: "reasoning",
  summary: [],
  encrypted_content: encrypted,
});

const user = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };

const sentSignatures = async (
  cred: ReturnType<typeof credential>,
  model: string,
  signatures: ReadonlyArray<string>,
  opts: ExecutorOptions = responsesOptions(),
  payloadModel = model,
) => {
  const h = await harness(cred, () => completed([]));
  const executor = makeCodexExecutor({ replayStore: makeInMemoryReplayStore(() => 0) });

  await execute(
    executor,
    h,
    {
      model,
      payload: json({ model: payloadModel, input: [user, ...signatures.map(reasoning)] }),
    },
    opts,
  );

  const body = JSON.parse(h.calls[0]?.text ?? "{}") as { input: Array<Record<string, unknown>> };

  return {
    url: h.calls[0]?.url ?? "",
    encrypted: body.input
      .filter((item) => item["type"] === "reasoning")
      .map((item) => item["encrypted_content"]),
  };
};

describe("Codex executor reasoning signatures by upstream host", () => {
  const routed = routerSuffixed(gptSignature(), 79);

  it("strips a GPT router suffix on the official Codex host", async () => {
    const sent = await sentSignatures(OFFICIAL, "gpt-5.4", [routed]);

    expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent.encrypted).toEqual([gptSignature()]);
  });

  it("keeps it on an openrouter.ai base URL", async () => {
    expect(await sentSignatures(OPENROUTER, "gpt-5.4", [routed])).toMatchObject({
      encrypted: [routed],
    });
  });

  it("strips it on another third-party base URL", async () => {
    expect(
      await sentSignatures(apiKey("https://proxy.test/v1"), "gpt-5.4", [routed]),
    ).toMatchObject({ encrypted: [gptSignature()] });
  });

  it("replays Meta envelopes to a Muse model behind a router and drops GPT and unknown ones", async () => {
    const sent = await sentSignatures(OPENROUTER, "meta/muse-wonder", [
      metaSignature(),
      routerSuffixed(metaSignature()),
      gptSignature(),
    ]);

    // A dropped signature leaves its reasoning item without `encrypted_content`.
    expect(sent.encrypted).toEqual([metaSignature(), routerSuffixed(metaSignature()), undefined]);
  });

  it("takes the family of an unmapped deployment alias from the requested model", async () => {
    // `deployment-123` names no family; the client asked for a Muse model, so a Meta envelope replays and a GPT one does not.
    const sent = await sentSignatures(
      OPENROUTER,
      "deployment-123",
      [metaSignature(), gptSignature()],
      responsesOptions({
        metadata: {
          ...options().metadata,
          requestPath: "/v1/responses",
          requestedModel: "muse-spark-1.3",
        },
      }),
      "muse-spark-1.3",
    );

    expect(sent.encrypted).toEqual([metaSignature(), undefined]);
  });

  it("drops a Meta envelope for a GPT model", async () => {
    expect((await sentSignatures(OFFICIAL, "gpt-5.4", [metaSignature()])).encrypted).toEqual([
      undefined,
    ]);
  });
});

// Go a68c7d8e (openai_responses_signature_test.go, "replay cache backfill + channel switch"): a routed GPT signature
// cached from an OpenRouter response replays to OpenRouter as issued and to the official host as its native envelope.
describe("Codex executor replay cache across upstream hosts", () => {
  const routed = routerSuffixed(gptSignature(), 79);

  const claudeOptions = (): ExecutorOptions =>
    options({
      sourceFormat: "claude",
      headers: new Headers({ "x-claude-code-session-id": "sess-switch" }),
      metadata: { ...options().metadata, requestPath: "/v1/messages", requestedModel: "gpt-5.4" },
    });

  const first = {
    model: "gpt-5.4",
    max_tokens: 10,
    messages: [{ role: "user", content: "read it" }],
  };

  const second = {
    model: "gpt-5.4",
    max_tokens: 10,
    messages: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: { p: 1 } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
    ],
  };

  const output: Json[] = [
    { id: "rs_1", type: "reasoning", summary: [], encrypted_content: routed },
    { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"p":1}' },
  ];

  const replayedTo = async (cred: ReturnType<typeof credential>) => {
    const store = makeInMemoryReplayStore(() => 0);
    const executor = makeCodexExecutor({ replayStore: store });
    const h = await harness(cred, () => completed(output));

    await execute(executor, h, { model: "gpt-5.4", payload: json(first) }, claudeOptions());
    await execute(executor, h, { model: "gpt-5.4", payload: json(second) }, claudeOptions());

    const body = JSON.parse(h.calls[1]?.text ?? "{}") as { input: Array<Record<string, unknown>> };

    return body.input.find((item) => item["type"] === "reasoning")?.["encrypted_content"];
  };

  it("replays the routed signature to OpenRouter as issued", async () => {
    expect(await replayedTo(OPENROUTER)).toBe(routed);
  });

  it("replays the native signature to the official host", async () => {
    expect(await replayedTo(OFFICIAL)).toBe(gptSignature());
  });
});
