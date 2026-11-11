// Devin executor against a mocked Connect-RPC upstream. The scenarios come from the real Go executor
// (`go run ./tools/fixturegen/devin`): the TypeScript executor must send the same request business fields and
// produce the same Interactions events / aggregate / errors from the same response frames.
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { resetSessionTurnIndex } from "../src/executor/devin/credentials.ts";
import { makeDevinExecutor } from "../src/executor/devin/executor.ts";
import { sealCompaction, unsealCompaction } from "../src/executor/helps/compaction.ts";
import { devinPayloadView } from "../src/executor/devin/payload.ts";
import { ProtoWriter, readFields } from "../src/executor/devin/protobuf.ts";
import type { ExecutorRequest } from "../src/executor/types.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  collectStream,
  credential,
  execute,
  harness,
  json,
  options,
  type Responder,
} from "./support/executor-run.ts";
import fixtures from "./fixtures/devin.json";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const envelope = (flag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);

  return out;
};

const framesResponse = (frames: ReadonlyArray<{ flag: number; hex: string }>): Response =>
  new Response(
    new Uint8Array(frames.flatMap((frame) => [...envelope(frame.flag, fromHex(frame.hex))])),
    {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
    },
  );

const devinCredential = (baseUrl = "https://devin.test") =>
  credential("devin", {
    attributes: { api_key: "devin-session-token$test", base_url: baseUrl, device_seed: "seed-1" },
  });

const request = (model: string, payload: string): ExecutorRequest => ({
  model,
  payload: json(JSON.parse(payload)),
});

const interactionsOptions = (stream: boolean) =>
  options({
    stream,
    sourceFormat: "interactions",
    metadata: { ...options().metadata, requestPath: "/v1beta/interactions" },
  });

/** Parses `data: {...}` chunks; the random interaction ids are normalised like in the fixtures. */
const normalizeChunks = (chunks: ReadonlyArray<string>): Json[] =>
  chunks.map((chunk) => {
    const data = chunk.replace(/^data: /, "").trim();

    return data === "[DONE]"
      ? "[DONE]"
      : (tryParseJson(data.replace(/interaction_[0-9a-f-]{12}/g, "interaction_ID")) as Json);
  });

const normalizeWire = (wire: Uint8Array): string => {
  const out = new ProtoWriter();

  for (const field of readFields(wire)) {
    if (field.num !== 3) {
      out.raw(field.encoded);
      continue;
    }

    const prompt = new ProtoWriter();

    for (const inner of readFields(field.bytes)) {
      if (inner.num === 1) prompt.string(1, "ID");
      else prompt.raw(inner.encoded);
    }

    out.bytes(3, prompt.toBytes());
  }

  return toHex(out.toBytes());
};

const executor = makeDevinExecutor();

describe("Devin executor parity with the Go executor", () => {
  for (const scenario of fixtures.scenarios) {
    const responder: Responder = () => framesResponse(scenario.frames);
    const session = (JSON.parse(scenario.payload) as { session_id: string }).session_id;

    it(`${scenario.name}: request bytes`, async () => {
      resetSessionTurnIndex(session);
      const h = await harness(devinCredential(), responder, scenario.configYaml, true);
      const opts = interactionsOptions(true);

      for (let turn = 0; turn < (scenario.turns ?? 1); turn++) {
        await collectStream(executor, h, request(scenario.model, scenario.payload), opts);
      }

      // The Go run also sent a non-stream request for single-turn scenarios; compare the streamed ones.
      expect(h.calls).toHaveLength(scenario.turns ?? 1);
      h.calls.forEach((call, index) => {
        const sent = call.bytes;
        expect(sent[0]).toBe(0);
        expect(new DataView(sent.buffer, sent.byteOffset).getUint32(1, false)).toBe(
          sent.length - 5,
        );
        expect(normalizeWire(sent.subarray(5))).toBe(
          normalizeWire(fromHex(scenario.requests[index]?.bodyHex ?? "")),
        );
        expect(call.url).toBe(
          "https://devin.test/exa.api_server_pb.ApiServerService/GetChatMessage",
        );
        expect(call.headers["authorization"]).toBe(
          "Basic devin-session-token$test-devin-session-token$test",
        );
        expect(call.headers["content-type"]).toBe("application/connect+proto");
        expect(call.headers["connect-protocol-version"]).toBe("1");
        expect(call.headers["sentry-trace"]).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
      });
    });

    it(`${scenario.name}: streamed Interactions events`, async () => {
      resetSessionTurnIndex(session);
      const h = await harness(devinCredential(), responder, scenario.configYaml, true);

      const collected = await collectStream(
        executor,
        h,
        request(scenario.model, scenario.payload),
        interactionsOptions(true),
      );

      expect(normalizeChunks(collected.chunks)).toEqual(
        normalizeChunks(scenario.stream.chunks ?? []),
      );

      if (scenario.stream.error === undefined) {
        expect(collected.error).toBeUndefined();
      } else {
        expect(collected.error).toBeInstanceOf(ExecutionError);
        expect(collected.error?.message).toContain(
          scenario.stream.error.replace(/^devin upstream stream/, "devin stream"),
        );

        if (scenario.stream.status !== undefined)
          expect(collected.error?.status).toBe(scenario.stream.status);
      }
    });

    if ((scenario.turns ?? 1) > 1) continue;
    it(`${scenario.name}: non-stream aggregate`, async () => {
      resetSessionTurnIndex(session);
      const h = await harness(devinCredential(), responder, scenario.configYaml);

      if (scenario.nonStream.error !== undefined) {
        const result = await Effect.runPromise(
          Effect.result(
            executor
              .execute(
                h.context,
                request(scenario.model, scenario.payload),
                interactionsOptions(false),
              )
              .pipe(Effect.provide(h.layers)),
          ),
        );

        expect(result._tag).toBe("Failure");

        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(scenario.nonStream.error);

          if (scenario.nonStream.status !== undefined)
            expect(result.failure.status).toBe(scenario.nonStream.status);
        }

        return;
      }

      const response = await execute(
        executor,
        h,
        request(scenario.model, scenario.payload),
        interactionsOptions(false),
      );

      expect(
        tryParseJson(response.payload.replace(/interaction_[0-9a-f-]{12}/g, "interaction_ID")),
      ).toEqual(tryParseJson(scenario.nonStream.payload ?? ""));
    });
  }
});

describe("Devin executor behaviour", () => {
  const hi =
    '{"session_id":"55555555-5555-4555-8555-555555555555","input":[{"type":"user_input","content":"hi"}]}';

  it("applies payload rules to the protobuf business fields as the last mutation", async () => {
    const yaml = `payload:\n  override:\n    - models: [{ name: "swe-2*", protocol: devin }]\n      params:\n        system_prompt: OVERRIDDEN\n        completion_config.temperature: 0.25\n  default:\n    - models: [{ name: "swe-2*", protocol: devin }]\n      params:\n        completion_config.top_k: 7\n`;

    const h = await harness(
      devinCredential(),
      () => framesResponse([{ flag: 2, hex: "7b7d" }]),
      yaml,
    );

    await execute(executor, h, request("swe-2", hi), interactionsOptions(false));

    const view = devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)) as {
      system_prompt: string;
      completion_config: { temperature: number; top_k: number; max_tokens: number };
      model: string;
    };

    expect(view.system_prompt).toBe("OVERRIDDEN");
    expect(view.completion_config.temperature).toBe(0.25);
    expect(view.completion_config.top_k).toBe(7);
    expect(view.model).toBe("swe-2-high");
  });

  it("clamps max tokens to the catalog's completion limit", async () => {
    const payload =
      '{"generation_config":{"max_output_tokens":9999999},"input":[{"type":"user_input","content":"hi"}]}';

    const h = await harness(devinCredential(), () => framesResponse([{ flag: 2, hex: "7b7d" }]));
    await execute(executor, h, request("claude-opus-4-6", payload), interactionsOptions(false));

    const view = devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)) as {
      completion_config: { max_tokens: number };
    };

    expect(view.completion_config.max_tokens).toBeGreaterThan(0);
    expect(view.completion_config.max_tokens).toBeLessThan(9_999_999);

    const unclamped = await harness(devinCredential(), () =>
      framesResponse([{ flag: 2, hex: "7b7d" }]),
    );

    await execute(
      makeDevinExecutor(),
      unclamped,
      {
        ...request("claude-opus-4-6", payload),
        modelLookup: () => ({ id: "claude-opus-4-6", maxCompletionTokens: 1234 }),
      },
      interactionsOptions(false),
    );

    const registryView = devinPayloadView(
      (unclamped.calls[0] as { bytes: Uint8Array }).bytes.subarray(5),
    ) as {
      completion_config: { max_tokens: number };
    };

    expect(registryView.completion_config.max_tokens).toBe(1234);
  });

  it("returns a 429 with Retry-After seconds for upstream HTTP errors", async () => {
    const h = await harness(
      devinCredential(),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        executor
          .execute(h.context, request("swe-2", hi), interactionsOptions(false))
          .pipe(Effect.provide(h.layers)),
      ),
    );

    expect(error.status).toBe(429);
    expect(error.message).toBe("slow down");
    expect(error.retryAfterMs).toBe(7000);
    expect(h.usage.failed).toBe(true);
  });

  it("rejects credentials without a session token", async () => {
    const h = await harness(credential("devin"), () => new Response(""));

    const error = await Effect.runPromise(
      Effect.flip(
        executor
          .execute(h.context, request("swe-2", hi), interactionsOptions(false))
          .pipe(Effect.provide(h.layers)),
      ),
    );

    expect(error.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a user turn that only carried media Devin cannot send", async () => {
    const payload =
      '{"input":[{"type":"user_input","content":[{"type":"image","uri":"https://example.test/a.png"}]}]}';

    const h = await harness(devinCredential(), () => new Response(""));

    const error = await Effect.runPromise(
      Effect.flip(
        executor
          .execute(h.context, request("swe-2", payload), interactionsOptions(false))
          .pipe(Effect.provide(h.layers)),
      ),
    );

    expect(error.status).toBe(400);
    expect(error.requestScoped).toBe(true);
    expect(error.message).toContain("unsupported content part");
  });

  it("estimates token counts from the payload length", async () => {
    const h = await harness(devinCredential(), () => new Response(""));

    const response = await Effect.runPromise(
      executor
        .countTokens(h.context, request("swe-2", hi), interactionsOptions(false))
        .pipe(Effect.provide(h.layers)),
    );

    const count = Math.floor(JSON.stringify(JSON.parse(hi)).length / 4);
    expect(JSON.parse(response.payload)).toEqual({ total_tokens: count, input_tokens: count });
  });

  it("derives a stable session UUID from non-UUID session ids and reuses it as cascade id", async () => {
    const payload = '{"session_id":"conv:abc","input":[{"type":"user_input","content":"hi"}]}';
    const h = await harness(devinCredential(), () => framesResponse([{ flag: 2, hex: "7b7d" }]));
    await execute(executor, h, request("swe-2", payload), interactionsOptions(false));

    const view = devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)) as {
      cascade_id: string;
    };

    expect(view.cascade_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

const system = (effort: string) => ({ role: "system", content: [], output_config: { effort } });

const claudeChatModelUid = async (requestModel: string, payload: Json): Promise<string> => {
  const h = await harness(devinCredential(), () => framesResponse([{ flag: 2, hex: "7b7d" }]));

  await execute(
    executor,
    h,
    { model: requestModel, payload: json(payload) },
    options({
      sourceFormat: "claude",
      metadata: { ...options().metadata, requestPath: "/v1/messages" },
    }),
  );

  const view = devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)) as {
    model: string;
  };

  return view.model;
};

describe("Devin account-wide quota exhaustion (CLIProxyAPI b946d54e)", () => {
  const hi =
    '{"session_id":"77777777-7777-4777-8777-777777777777","input":[{"type":"user_input","content":"hi"}]}';

  const HOUR = 3_600_000;
  const weeklyReset = () => new Date(Date.now() + 72 * HOUR).toISOString().replace(/\.\d+Z$/, "Z");

  const credentialWithSignals = () =>
    credential("devin", {
      attributes: { api_key: "devin-session-token$test", base_url: "https://devin.test" },
      quotaSignals: { weekly_quota_reset_at: weeklyReset() },
    });

  const weekly = "Your weekly usage quota has been exhausted.";

  const trailerBody = (message: string, code = "failed_precondition") =>
    framesResponse([
      {
        flag: 2,
        hex: toHex(new TextEncoder().encode(JSON.stringify({ error: { code, message } }))),
      },
    ]);

  const failure = async (stream: boolean, respond: () => Response) => {
    const h = await harness(credentialWithSignals(), respond, undefined, stream);
    const opts = interactionsOptions(stream);

    if (!stream) {
      return Effect.runPromise(
        Effect.flip(
          executor.execute(h.context, request("swe-2", hi), opts).pipe(Effect.provide(h.layers)),
        ),
      );
    }

    const collected = await collectStream(executor, h, request("swe-2", hi), opts);

    return collected.error as ExecutionError;
  };

  const expectScopedUntilReset = (error: ExecutionError) => {
    expect(error.status).toBe(429);
    expect(error.credentialScoped).toBe(true);
    // 72 hours from the observation, a little less by now.
    expect(error.retryAfterMs).toBeGreaterThan(72 * HOUR - 60_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(72 * HOUR);
  };

  it("makes an HTTP 429 about the weekly quota credential-scoped, retrying at the observed reset", async () => {
    for (const stream of [false, true])
      expectScopedUntilReset(await failure(stream, () => new Response(weekly, { status: 429 })));
  });

  it("does the same for the trailer error of a non-stream and a streamed response", async () => {
    for (const stream of [false, true])
      expectScopedUntilReset(await failure(stream, () => trailerBody(weekly)));
  });

  it("keeps an explicit Retry-After header", async () => {
    const error = await failure(
      false,
      () => new Response(weekly, { status: 429, headers: { "retry-after": "7" } }),
    );

    expect(error.credentialScoped).toBe(true);
    expect(error.retryAfterMs).toBe(7000);
  });

  it("leaves generic rate limits and monthly quota messages model-scoped", async () => {
    for (const message of [
      "Rate limit exceeded. Please slow down.",
      "User monthly ACU quota exhausted (trace ID: 12345)",
    ]) {
      const error = await failure(false, () => new Response(message, { status: 429 }));
      expect(error.status).toBe(429);
      expect(error.credentialScoped).toBeUndefined();
      expect(error.retryAfterMs).toBeUndefined();
    }
  });
});

describe("Devin Claude effort directives (CLIProxyAPI 061ffe6f)", () => {
  const model = "devin/claude-opus-5-5";

  const topLevelOnly = {
    model,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "hi" }],
  };

  const withDirectives = {
    ...topLevelOnly,
    messages: [
      system("medium"),
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      system("high"),
      { role: "user", content: "hi" },
    ],
  };

  const disabledWithDirective = {
    model,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    messages: [system("high"), { role: "user", content: "hi" }],
  };

  it("selects the variant of the top-level effort when there is no directive", async () => {
    expect(await claudeChatModelUid(model, topLevelOnly)).toBe("claude-opus-5-5-low");
  });

  it("lets the last directive win over the top-level placeholder", async () => {
    expect(await claudeChatModelUid(model, withDirectives)).toBe("claude-opus-5-5-high");
  });

  it("keeps the model suffix above a directive", async () => {
    expect(await claudeChatModelUid(`${model}(medium)`, withDirectives)).toBe(
      "claude-opus-5-5-medium",
    );
  });

  it("does not let a historical directive pick a variant when thinking is disabled", async () => {
    // `none` is not a level of the model: the default effort stands, never the directive's `high`.
    expect(await claudeChatModelUid(model, disabledWithDirective)).toBe("claude-opus-5-5-medium");
  });
});

describe("Devin tool descriptions (CLIProxyAPI e25b7daf)", () => {
  it("rewrites the exec_command and write_stdin phrases embedded in the Codex code-mode exec tool", async () => {
    const description =
      "Run JavaScript code to orchestrate/compose tool calls\n" +
      "### exec_command\nRuns a command in a PTY, returning output or a session ID for ongoing interaction.\n" +
      "### write_stdin\nWrites characters to an existing unified exec session and returns recent output.\n";

    const payload = {
      model: "devin/claude-opus-5-5",
      tools: [{ type: "custom", name: "exec", description }],
      input: "Reply with exactly: OK",
    };

    const h = await harness(devinCredential(), () => framesResponse([{ flag: 2, hex: "7b7d" }]));

    await execute(
      executor,
      h,
      { model: "devin/claude-opus-5-5", payload: json(payload) },
      options({
        sourceFormat: "openai-response",
        originalRequest: json(payload),
        metadata: { ...options().metadata, requestPath: "/v1/responses" },
      }),
    );

    const wire = new TextDecoder().decode((h.calls[0] as { bytes: Uint8Array }).bytes);
    expect(wire).not.toContain("a session ID");
    expect(wire).not.toContain("to an existing unified");
    expect(wire).toContain("an session ID");
    expect(wire).toContain("to a existing unified");
  });
});

/** A response frame (field 7) with the usage counters: 2 uncached prompt, 3 completion, 4 cache write, 5 cache read. */
const usageFrame = (usage: {
  prompt: number;
  completion: number;
  cacheWrite?: number;
  cacheRead?: number;
}): Uint8Array => {
  const counters = new ProtoWriter().varint(2, usage.prompt).varint(3, usage.completion);

  if (usage.cacheWrite !== undefined) counters.varint(4, usage.cacheWrite);

  if (usage.cacheRead !== undefined) counters.varint(5, usage.cacheRead);

  return envelope(0, new ProtoWriter().bytes(7, counters.toBytes()).toBytes());
};

const eosTrailer = (): Uint8Array => envelope(2, new TextEncoder().encode("{}"));

const frames = (...parts: Uint8Array[]): Response =>
  new Response(new Uint8Array(parts.flatMap((part) => [...part])), {
    status: 200,
    headers: { "content-type": "application/connect+proto" },
  });

describe("Devin usage (CLIProxyAPI eb6e25ab, cad1b503)", () => {
  const hi =
    '{"session_id":"66666666-6666-4666-8666-666666666666","input":[{"type":"user_input","content":"hi"}]}';

  // Devin reports the prompt in three disjoint parts: uncached, cache write and cache read.
  const counters = { prompt: 3, completion: 4, cacheWrite: 14361, cacheRead: 50 };

  it("counts cache-write tokens in the total input of a non-stream response", async () => {
    const h = await harness(devinCredential(), () => frames(usageFrame(counters), eosTrailer()));
    const response = await execute(executor, h, request("swe-2", hi), interactionsOptions(false));
    const usage = (tryParseJson(response.payload) as { usage: Record<string, number> }).usage;
    expect(h.usage.finish(0)?.detail.inputTokens).toBe(14414);

    // 3 uncached + 50 read + 14361 written.
    expect(usage["total_input_tokens"]).toBe(14414);
    expect(usage["cache_write_tokens"]).toBe(14361);
    expect(usage["total_tokens"]).toBe(14418);
  });

  it("counts cache-write tokens in the total input of a streamed response and its usage record", async () => {
    const h = await harness(
      devinCredential(),
      () => frames(usageFrame(counters), eosTrailer()),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      request("swe-2", hi),
      interactionsOptions(true),
    );

    const completed = normalizeChunks(collected.chunks).find(
      (event) => (event as { event_type?: string }).event_type === "interaction.completed",
    ) as { interaction: { usage: Record<string, number> } };

    expect(completed.interaction.usage["total_input_tokens"]).toBe(14414);
    expect(h.usage.finish(0)?.detail).toMatchObject({
      inputTokens: 14414,
      cacheReadTokens: 50,
      cacheCreationTokens: 14361,
    });
  });

  it("does not seed message_start input tokens for a Claude stream", async () => {
    const claudeRequest = request(
      "claude-opus-5-5",
      '{"model":"claude-opus-5-5","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hello cache test prompt with enough words to produce non-zero tokens"}]}',
    );

    const h = await harness(
      devinCredential(),
      () =>
        frames(
          usageFrame({ prompt: 0, completion: 4, cacheWrite: 7, cacheRead: 50000 }),
          eosTrailer(),
        ),
      undefined,
      true,
    );

    const collected = await collectStream(
      executor,
      h,
      claudeRequest,
      options({
        stream: true,
        sourceFormat: "claude",
        metadata: { ...options().metadata, requestPath: "/v1/messages" },
      }),
    );

    expect(collected.error).toBeUndefined();

    const events = collected.chunks.flatMap((chunk) =>
      chunk
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => tryParseJson(line.slice(6))),
    );

    const start = events.find((event) => get(event, "type") === "message_start");
    const delta = events.find((event) => get(event, "type") === "message_delta");
    expect(get(start, "message.usage.input_tokens")).toBe(0);
    expect(get(delta, "usage")).toMatchObject({
      input_tokens: 0,
      cache_read_input_tokens: 50000,
      cache_creation_input_tokens: 7,
      output_tokens: 4,
    });
  });
});

// Go e9c8769a: Devin may emit ids Anthropic would reject, so non-portable ones leave as `cpa_tid_v1_<base64url>` and are
// decoded again before the next prompt is built, without any stored mapping.
describe("Devin tool call ids (CLIProxyAPI e9c8769a)", () => {
  const NATIVE = ["Write:1#abc", "cpa_tid_v1_Y2FsbF8x", "call_1"];

  // Expected wire ids: the encoding of an illegal id, of a native id that already carries the reserved prefix, and an
  // ordinary legal id that stays as it is.
  const ENCODED = ["cpa_tid_v1_V3JpdGU6MSNhYmM", "cpa_tid_v1_Y3BhX3RpZF92MV9ZMkZzYkY4eA", "call_1"];

  const toolCallFrames = (): Response =>
    frames(
      ...NATIVE.map((id) =>
        envelope(
          0,
          new ProtoWriter()
            .bytes(
              6,
              new ProtoWriter().string(1, id).string(2, "Write").string(3, '{"a":1}').toBytes(),
            )
            .toBytes(),
        ),
      ),
      eosTrailer(),
    );

  const SESSION = "88888888-8888-4888-8888-888888888888";

  const asked = `{"session_id":"${SESSION}","input":[{"type":"user_input","content":"tools"}]}`;

  it("encodes non-portable ids in a non-stream aggregate", async () => {
    const h = await harness(devinCredential(), toolCallFrames);

    const response = await execute(
      executor,
      h,
      request("swe-2", asked),
      interactionsOptions(false),
    );

    const steps = (
      tryParseJson(response.payload) as {
        steps: Array<{ type: string; id: string; call_id: string }>;
      }
    ).steps.filter((step) => step.type === "function_call");

    expect(steps.map((step) => step.id)).toEqual(ENCODED);
    expect(steps.map((step) => step.call_id)).toEqual(ENCODED);
  });

  it("encodes non-portable ids in streamed events", async () => {
    const h = await harness(devinCredential(), toolCallFrames, undefined, true);

    const collected = await collectStream(
      executor,
      h,
      request("swe-2", asked),
      interactionsOptions(true),
    );

    const starts = normalizeChunks(collected.chunks).filter(
      (event) =>
        (event as { event_type?: string }).event_type === "step.start" &&
        (event as { step?: { type?: string } }).step?.type === "function_call",
    ) as Array<{ step: { id: string; call_id: string } }>;

    expect(starts.map((event) => event.step.id)).toEqual(ENCODED);
    expect(starts.map((event) => event.step.call_id)).toEqual(ENCODED);
  });

  it("decodes them in the next prompt, with no state from the response that minted them", async () => {
    const history = JSON.stringify({
      session_id: SESSION,
      input: [
        { type: "user_input", content: "tools" },
        ...ENCODED.map((id) => ({ type: "function_call", id, name: "Write", arguments: {} })),
        ...ENCODED.map((id) => ({ type: "function_result", call_id: id, result: "ok" })),
        { type: "user_input", content: "next" },
      ],
    });

    const h = await harness(devinCredential(), () => framesResponse([{ flag: 2, hex: "7b7d" }]));
    await execute(executor, h, request("swe-2", history), interactionsOptions(false));

    const sent = JSON.stringify(
      devinPayloadView((h.calls[0] as { bytes: Uint8Array }).bytes.subarray(5)),
    );

    for (const id of NATIVE) expect(sent).toContain(`"${id}"`);
    expect(sent).not.toContain("cpa_tid_v1_V3JpdGU6MSNhYmM");
    expect(sent).not.toContain("cpa_tid_v1_Y3BhX3RpZF92MV9ZMkZzYkY4eA");
  });
});

describe("Devin Responses compaction (CLIProxyAPI fb77445f)", () => {
  const SESSION = "99999999-9999-4999-8999-999999999999";
  const model = "swe-2";

  const responsesOptions = (stream = false) =>
    options({
      stream,
      sourceFormat: "openai-response",
      metadata: { ...options().metadata, requestPath: "/v1/responses" },
    });

  const textFrame = (text: string): Uint8Array =>
    envelope(0, new ProtoWriter().bytes(3, new TextEncoder().encode(text)).toBytes());

  const summaryResponse = (text = "the summary"): Response =>
    frames(textFrame(text), usageFrame({ prompt: 9, completion: 3 }), eosTrailer());

  const wire = (call: { readonly bytes: Uint8Array } | undefined): string =>
    new TextDecoder().decode(call?.bytes);

  const userMessage = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });

  const capsule = async () => ({
    type: "compaction",
    id: "cmp_ag_compact_1",
    encrypted_content: await sealCompaction("earlier work", model),
  });

  const foreign = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAA-native" };

  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "hmm" }],
    encrypted_content: "sealed.v1.xyz",
  };

  const payloadOf = async (extra: Record<string, Json> = {}): Promise<Json> => ({
    model,
    session_id: SESSION,
    input: [
      await capsule(),
      foreign,
      reasoning,
      userMessage("continue"),
      { type: "compaction_trigger" },
    ],
    ...extra,
  });

  const run = async (
    options: ReturnType<typeof responsesOptions>,
    payload: Json,
    respond: Responder = () => summaryResponse(),
  ) => {
    resetSessionTurnIndex(SESSION);
    const h = await harness(devinCredential(), respond, undefined, options.stream);

    return { h, run: () => execute(executor, h, { model, payload: json(payload) }, options) };
  };

  it("answers a compaction_trigger with a sealed response from one summary request on the same model", async () => {
    const { h, run: go } = await run(responsesOptions(), await payloadOf());
    const response = await go();
    expect(h.calls).toHaveLength(1);
    const sent = wire(h.calls[0]);
    expect(sent).toContain("Context summary from previous turns:");
    expect(sent).toContain("earlier work");
    expect(sent).not.toContain("gAAAA-native");
    expect(sent).not.toContain("cpa-ag-compact-v1:");
    expect(sent).not.toContain("compaction_trigger");
    // The D3 sealed reasoning item is not a compaction item: its thought step survives.
    expect(sent).toContain("sealed.v1.xyz");
    const body = tryParseJson(response.payload);
    expect(get(body, "object")).toBe("response.compaction");
    expect(await unsealCompaction(asString(get(body, "output.0.encrypted_content")))).toBe(
      "the summary",
    );
    expect(get(body, "usage.input_tokens")).toBe(9);
    expect(get(body, "usage.total_tokens")).toBe(12);
  });

  it("answers a streaming compaction_trigger with the synthetic Responses stream", async () => {
    resetSessionTurnIndex(SESSION);
    const h = await harness(devinCredential(), () => summaryResponse(), undefined, true);

    const collected = await collectStream(
      executor,
      h,
      { model, payload: json(await payloadOf({ stream: true })) },
      responsesOptions(true),
    );

    expect(collected.error).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    const text = collected.chunks.join("");
    expect(text).toContain("event: response.completed");
    expect(await unsealCompaction(text.match(/cpa-ag-compact-v1:[A-Za-z0-9_-]+/)?.[0] ?? "")).toBe(
      "the summary",
    );
  });

  it("serves /responses/compact locally instead of answering an ordinary generation", async () => {
    const payload: Json = {
      model,
      session_id: SESSION,
      input: [await capsule(), foreign, userMessage("continue")],
    };

    const { h, run: go } = await run({ ...responsesOptions(), alt: "responses/compact" }, payload);
    const response = await go();
    expect(h.calls).toHaveLength(1);
    expect(get(tryParseJson(response.payload), "object")).toBe("response.compaction");
    expect(wire(h.calls[0])).toContain("earlier work");
  });

  it("refuses a compaction source that continues a previous response", async () => {
    const { h, run: go } = await run(
      responsesOptions(),
      await payloadOf({ previous_response_id: "resp_1" }),
    );

    await expect(go()).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
  });

  it("drops foreign compaction items from an ordinary request and expands the capsules", async () => {
    const payload = await payloadOf();

    const input = (get(payload, "input") as Json[]).filter(
      (item) => get(item, "type") !== "compaction_trigger",
    );

    const { h, run: go } = await run(responsesOptions(), {
      ...(payload as Record<string, Json>),
      input,
    });

    await go();
    const sent = wire(h.calls[0]);
    expect(sent).not.toContain("gAAAA-native");
    expect(sent).toContain("earlier work");
    expect(sent).toContain("sealed.v1.xyz");
  });

  it("counts the expanded payload, not the capsule's ciphertext", async () => {
    const h = await harness(devinCredential(), () => summaryResponse());

    const count = async (input: Json[]) => {
      const response = await Effect.runPromise(
        executor
          .countTokens(h.context, { model, payload: json({ model, input }) }, responsesOptions())
          .pipe(Effect.provide(h.layers)),
      );

      return (tryParseJson(response.payload) as { input_tokens: number }).input_tokens;
    };

    const written = [
      {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "Context summary from previous turns:\nearlier work" },
        ],
      },
      userMessage("hi"),
    ];

    expect(await count([await capsule(), foreign, userMessage("hi")])).toBe(await count(written));
    expect(h.calls).toHaveLength(0);
  });
});
