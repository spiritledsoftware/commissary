// The Antigravity executor's use of the reasoning-replay ledger beyond what antigravity-replay.test.ts pins (Go cc95661c):
// the ledger is committed before any client-visible terminal event, and token counting only peeks.
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeAntigravityExecutor } from "../src/executor/antigravity/executor.ts";
import {
  ANTIGRAVITY_REPLAY_STORE,
  makeSessionStateReplayLedger,
} from "../src/executor/helps/reasoning-replay-ledger.ts";
import { fixedBackend } from "@commissary/state";
import { countingBackend } from "./support/counting-backend.ts";
import { nativeGeminiSignature } from "./support/gemini-signatures.ts";
import { credential, harness, json, options } from "./support/executor-run.ts";

const MODEL = "gemini-2.5-flash";

const cred = credential("antigravity", {
  kind: "oauth",
  metadata: { access_token: "ya29.token", project_id: "proj-1" },
});

const rig = () => {
  const backend = countingBackend();

  const executor = makeAntigravityExecutor({
    replayLedger: makeSessionStateReplayLedger(fixedBackend(backend), ANTIGRAVITY_REPLAY_STORE),
  });

  return { backend, executor };
};

const chatOptions = (stream: boolean) =>
  options({
    sourceFormat: "openai",
    stream,
    headers: new Headers({ "Session-Id": "chat-1" }),
    metadata: { ...options().metadata, requestedModel: MODEL },
  });

const request = (stream: boolean) => ({
  model: MODEL,
  payload: json({ model: MODEL, stream, messages: [{ role: "user", content: "weather?" }] }),
});

const toolCallEvent = `data: ${JSON.stringify({
  response: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { name: "get_weather", args: { city: "Paris" } },
              thoughtSignature: nativeGeminiSignature(),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
  },
})}\n\n`;

describe("an OpenAI chat stream on Antigravity", () => {
  it("commits the ledger before the finish_reason chunk reaches the client", async () => {
    const { backend, executor } = rig();

    const h = await harness(
      cred,
      () =>
        new Response(toolCallEvent, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      undefined,
      true,
    );

    const started = await Effect.runPromise(
      executor
        .executeStream(h.context, request(true), chatOptions(true))
        .pipe(Effect.provide(h.layers)),
    );

    await Effect.runPromise(
      Stream.runForEach(started.chunks, (chunk) =>
        Effect.sync(() => {
          if (/"finish_reason":"(?:stop|tool_calls)"/.test(chunk))
            backend.events.push("client:finish");
        }),
      ),
    );

    const commit = backend.events.indexOf(`state:${ANTIGRAVITY_REPLAY_STORE}:put`);

    expect(commit).toBeGreaterThan(-1);
    expect(backend.events.indexOf("client:finish")).toBeGreaterThan(commit);
  });
});

describe("token counting on Antigravity", () => {
  it("peeks the ledger once and writes nothing, not even a reservation", async () => {
    const { backend, executor } = rig();

    const h = await harness(
      cred,
      () => new Response(JSON.stringify({ totalTokens: 7 }), { status: 200 }),
    );

    await Effect.runPromise(
      executor
        .countTokens(h.context, request(false), chatOptions(false))
        .pipe(Effect.provide(h.layers)),
    );

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.ops).toEqual(["get"]);
    expect(backend.calls[0]?.writes).toBe(0);
  });
});
