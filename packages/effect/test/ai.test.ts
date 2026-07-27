import {
  Agent,
  Content,
  Tool,
  Hook,
  type AgentFragment,
  type ArtifactId,
  type ArtifactStore,
  type FragmentMetadata,
  type ModelSchema,
  type ProviderOption,
} from "@commissary/core";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import {
  AiError,
  LanguageModel,
  Model as AiModel,
  Prompt,
  Response,
  Tool as AiTool,
  type Toolkit,
} from "effect/unstable/ai";
import { expect, it } from "vitest";

import { EffectAi, EffectAiBridgeDefect, type EffectAiProviderToolResolver } from "../src/ai.js";
import { EffectCommissary } from "../src/index.js";
import { MemoryThreadStore } from "./support.js";

const stringSchema: ModelSchema<string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate(value) {
      return typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] };
    },
    jsonSchema: {
      input: () => ({ type: "string" }),
      output: () => ({ type: "string" }),
    },
  },
};

const numberSchema: ModelSchema<number> = {
  "~standard": {
    version: 1,
    vendor: "commissary-effect-test",
    validate(value) {
      return typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] };
    },
    jsonSchema: {
      input: () => ({ type: "number" }),
      output: () => ({ type: "number" }),
    },
  },
};

const modelUsage = new Response.Usage({
  inputTokens: {
    total: 3,
    uncached: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 2,
    text: 1,
    reasoning: 1,
  },
});

type StreamPart = Response.StreamPart<Record<string, AiTool.Any>>;
type StreamOptions = {
  readonly prompt: Prompt.Prompt;
  readonly toolkit?: Toolkit.WithHandler<Record<string, AiTool.Any>>;
  readonly disableToolCallResolution?: boolean;
};

function service(
  streamText: (options: StreamOptions) => Stream.Stream<StreamPart, AiError.AiError>,
): LanguageModel.Service {
  return { streamText } as unknown as LanguageModel.Service;
}

async function run(
  languageModel: LanguageModel.Service,
  options: {
    readonly artifactStore?: ArtifactStore;
    readonly fragments?: readonly AgentFragment<
      FragmentMetadata<unknown, unknown, unknown, never>
    >[];
    readonly resolveProviderTool?: EffectAiProviderToolResolver;
  } = {},
) {
  let acquired = 0;
  let released = 0;
  let resolveAcquired!: () => void;
  const modelAcquired = new Promise<void>((resolve) => {
    resolveAcquired = resolve;
  });
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired += 1;
        resolveAcquired();
        return languageModel;
      }),
      () =>
        Effect.sync(() => {
          released += 1;
        }),
    ),
  );
  const aiModel = AiModel.make("example", "test-model", layer);
  const model =
    options.resolveProviderTool === undefined
      ? EffectAi.model(aiModel)
      : EffectAi.model(aiModel, { resolveProviderTool: options.resolveProviderTool });
  const agent = Agent.define({
    id: "effect-ai-test",
    fragments: Agent.combine(model, ...(options.fragments ?? [])),
  });
  const store = new MemoryThreadStore();
  const app = await Effect.runPromise(
    EffectCommissary.make({
      threadStore: store,
      ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
      agents: [agent] as const,
    }),
  );
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  return {
    store,
    branch,
    client,
    modelAcquired,
    acquired: () => acquired,
    released: () => released,
  };
}

it("translates canonical requests and responses while scoping one model service per Attempt", async () => {
  const requests: StreamOptions[] = [];
  let invocation = 0;
  const fake = service((options) => {
    requests.push(options);
    invocation += 1;
    if (invocation === 1) {
      return Stream.make(
        Response.makePart("text-start", { id: "pause-text" }),
        Response.makePart("text-delta", { id: "pause-text", delta: "working" }),
        Response.makePart("text-end", { id: "pause-text" }),
        Response.makePart("finish", { reason: "pause", usage: modelUsage, response: undefined }),
      );
    }
    return Stream.make(
      Response.makePart("text-start", {
        id: "answer",
        metadata: { example: { signature: "obsolete" } },
      }),
      Response.makePart("text-delta", {
        id: "answer",
        delta: "done",
        metadata: { example: { signature: "signed" } },
      }),
      Response.makePart("text-end", { id: "answer" }),
      Response.makePart("reasoning-start", { id: "reason" }),
      Response.makePart("reasoning-delta", { id: "reason", delta: "checked" }),
      Response.makePart("reasoning-end", { id: "reason" }),
      Response.makePart("source", {
        sourceType: "url",
        id: "source-1",
        url: new URL("https://example.com/reference"),
        title: "Reference",
      } as never),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const echo = Tool.define({
    name: "echo",
    description: "Echo text",
    input: stringSchema,
    output: stringSchema,
    handler: (input) => input,
  });
  const providerOptions: readonly ProviderOption[] = [
    {
      namespace: "example",
      value: { temperature: 0.2, cacheKey: "request-default" },
    },
    { namespace: "other", value: { ignored: true } },
  ];
  const requestOptions = Hook.beforeModelRequest(({ request }) => ({
    request: {
      ...request,
      providerOptions,
    },
  }));
  const fixture = await run(fake, { fragments: [echo, requestOptions] });
  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: {
      role: "user",
      content: [
        {
          ...Content.text("hello"),
          providerData: [
            { namespace: "example", version: 1, value: { cacheKey: "key-1" } },
            { namespace: "other", version: 1, value: { ignored: true } },
          ],
        },
      ],
    },
  });

  expect(outcome).toMatchObject({
    type: "completed",
    response: {
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "done",
            providerData: [{ namespace: "example", version: 1, value: { signature: "signed" } }],
          },
          { type: "reasoning", text: "checked" },
          {
            type: "source",
            sourceType: "url",
            id: "source-1",
            url: "https://example.com/reference",
            title: "Reference",
          },
        ],
      },
    },
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.disableToolCallResolution).toBe(true);
  expect(Object.keys(requests[0]?.toolkit?.tools ?? {})).toEqual(["echo"]);
  const firstUser = requests[0]?.prompt.content.find((message) => message.role === "user");
  expect(Array.isArray(firstUser?.content) ? firstUser.content[0]?.options : undefined).toEqual({
    example: { temperature: 0.2, cacheKey: "key-1" },
  });
  expect(requests[1]?.prompt.content.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(fixture.acquired()).toBe(1);
  expect(fixture.released()).toBe(1);
});

it("streams canonical reasoning deltas as Model Events", async () => {
  const fake = service(() =>
    Stream.make(
      Response.makePart("reasoning-start", { id: "reason" }),
      Response.makePart("reasoning-delta", { id: "reason", delta: "checking" }),
      Response.makePart("reasoning-end", { id: "reason" }),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    ),
  );
  const fixture = await run(fake);
  const attempt = await fixture.client.stream({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("reason")] },
  });
  if ("type" in attempt) {
    throw new Error(`Unexpected admission failure: ${attempt.type}`);
  }
  const reasoning = (async () => {
    const deltas: string[] = [];
    for await (const signal of attempt.signals) {
      if (signal.type === "model-event" && signal.event.type === "reasoning-delta") {
        deltas.push(signal.event.delta);
      }
    }
    return deltas;
  })();

  await expect(attempt.outcome).resolves.toMatchObject({ type: "completed" });
  await expect(reasoning).resolves.toEqual(["checking"]);
});

it("interrupts rather than dropping canonical Source Parts during replay", async () => {
  let invocations = 0;
  const fake = service(() => {
    invocations += 1;
    return Stream.make(
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: {
      role: "user",
      content: [
        Content.source({
          sourceType: "url",
          id: "source-1",
          url: "https://example.com/reference",
          title: "Reference",
        }),
      ],
    },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "provider-compatibility",
      provider: "example",
    },
  });
  expect(invocations).toBe(0);
});

it("interrupts unsupported Effect AI Tool approval requests", async () => {
  const fake = service(() =>
    Stream.make(
      Response.makePart("tool-approval-request", {
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
      }),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    ),
  );
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("approve")] },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "provider-compatibility",
      provider: "example",
      detail: expect.stringContaining("approval"),
    },
  });
});

it("maps provider availability errors to nonterminal Interruptions", async () => {
  const fake = service(() =>
    Stream.fail(
      new AiError.AiError({
        module: "Example",
        method: "streamText",
        reason: new AiError.RateLimitError({ retryAfter: Duration.millis(250) }),
      }),
    ),
  );
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("hello")] },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "provider-unavailable",
      provider: "example",
      reason: "rate-limit",
      retryAfterMs: 250,
    },
  });
  if (!("runId" in outcome)) {
    throw new Error(`Unexpected admission failure: ${outcome.type}`);
  }
  await expect(fixture.client.readResult(outcome.runId)).resolves.toBeUndefined();
  expect(fixture.released()).toBe(1);
});

it("maps pre-response policy rejection to a terminal Model Failure", async () => {
  const fake = service(() =>
    Stream.fail(
      new AiError.AiError({
        module: "Example",
        method: "streamText",
        reason: new AiError.ContentPolicyError({ description: "blocked input" }),
      }),
    ),
  );
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("hello")] },
  });

  expect(outcome).toMatchObject({
    type: "failed",
    failure: {
      type: "model-failure",
      reason: "content-policy",
      provider: "example",
      message: "blocked input",
    },
  });
});

it("maps declared invalid output to a recoverable interruption with usage", async () => {
  const fake = service(() =>
    Stream.fail(
      new AiError.AiError({
        module: "Example",
        method: "streamText",
        reason: new AiError.InvalidOutputError({
          description: "malformed response",
          usage: {
            promptTokens: 4,
            completionTokens: 2,
            totalTokens: 6,
          },
        }),
      }),
    ),
  );
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("hello")] },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "model-output",
      provider: "example",
      detail: "malformed response",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    },
  });
});

it("rejects unclassified Effect AI errors as Defects", async () => {
  const fake = service(() =>
    Stream.fail(
      new AiError.AiError({
        module: "Example",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "unclassified" }),
      }),
    ),
  );
  const fixture = await run(fake);

  await expect(
    fixture.client.run({
      threadId: fixture.branch.threadId,
      branchId: fixture.branch.id,
      message: { role: "user", content: [Content.text("hello")] },
    }),
  ).rejects.toBeInstanceOf(EffectAiBridgeDefect);
  expect(fixture.released()).toBe(1);
});

it("interrupts after metered file output when no Artifact Store is available", async () => {
  const fake = service(() =>
    Stream.make(
      Response.makePart("file", {
        data: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
      }),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    ),
  );
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("make an image")] },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "artifact-storage-required",
      operation: "write",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  });
  expect(
    await fixture.store.readBranchPath({
      threadId: fixture.branch.threadId,
      branchId: fixture.branch.id,
    }),
  ).toHaveLength(1);
});

it("interrupts an in-flight Effect stream when the Attempt aborts", async () => {
  const fake = service(() => Stream.never);
  const fixture = await run(fake);
  const attempt = await fixture.client.stream({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("wait")] },
  });
  if ("type" in attempt) {
    throw new Error(`Unexpected admission failure: ${attempt.type}`);
  }

  await fixture.modelAcquired;
  attempt.abort("cancelled");
  const outcome = await attempt.outcome;

  expect(outcome).toMatchObject({ type: "aborted", reason: "cancelled" });
  expect(fixture.released()).toBe(1);
});

it("persists generated bytes before returning a canonical File Part", async () => {
  const writes: Uint8Array[] = [];
  const artifactStore: ArtifactStore = {
    read: () => Promise.reject(new Error("Unexpected read")),
    write(content) {
      writes.push(content.data);
      return Promise.resolve({
        id: "artifact-1" as ArtifactId,
        mediaType: content.mediaType,
      });
    },
  };
  const fake = service(() =>
    Stream.make(
      Response.makePart("file", {
        data: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
      }),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    ),
  );
  const fixture = await run(fake, { artifactStore });

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("make an image")] },
  });

  expect(writes).toEqual([new Uint8Array([1, 2, 3])]);
  expect(outcome).toMatchObject({
    type: "completed",
    response: {
      message: {
        content: [
          {
            type: "file",
            artifact: { id: "artifact-1", mediaType: "image/png" },
          },
        ],
      },
    },
  });
});

it("preflights Artifact reads before invoking the provider", async () => {
  let invocations = 0;
  const fake = service(() => {
    invocations += 1;
    return Stream.make(
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: {
      role: "user",
      content: [Content.file({ id: "missing-artifact" as ArtifactId, mediaType: "image/png" })],
    },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "artifact-storage-required",
      operation: "read",
    },
  });
  expect(invocations).toBe(0);
});

it("interrupts before invocation when matching Provider Data has an unsupported version", async () => {
  let invocations = 0;
  const fake = service(() => {
    invocations += 1;
    return Stream.make(
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake);

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: {
      role: "user",
      content: [
        {
          ...Content.text("hello"),
          providerData: [
            { namespace: "example", version: 2, value: { signature: "old" } },
            { namespace: "other", version: 99, value: { ignored: true } },
          ],
        },
      ],
    },
  });

  expect(outcome).toMatchObject({
    type: "interrupted",
    interruption: {
      type: "provider-compatibility",
      provider: "example",
      providerDataNamespace: "example",
      providerDataVersion: 2,
    },
  });
  expect(invocations).toBe(0);
});

it("passes Provider Tools through Effect AI without creating durable Tool Attempts", async () => {
  const nativeSearch = AiTool.providerDefined({
    id: "example.search",
    customName: "provider-search",
    providerName: "search",
    args: Schema.Struct({ depth: Schema.Number }),
    parameters: Schema.String,
    success: Schema.String,
  })({ depth: 1 });
  const providerSearch = Tool.provider({
    name: "provider-search",
    provider: {
      namespace: "example",
      id: "example.search",
      args: { depth: 1 },
    },
    input: stringSchema,
    output: stringSchema,
  });
  const requests: StreamOptions[] = [];
  const fake = service((options) => {
    requests.push(options);
    return Stream.make(
      Response.makePart("tool-call", {
        id: "provider-call",
        name: "provider-search",
        params: "query",
        providerExecuted: true,
      }),
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake, {
    fragments: [providerSearch],
    resolveProviderTool: (descriptor) =>
      descriptor.id === nativeSearch.id ? nativeSearch : undefined,
  });

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("search")] },
  });

  expect(outcome).toMatchObject({
    type: "completed",
    response: {
      message: {
        content: [
          {
            type: "tool-call",
            toolName: "provider-search",
            providerExecuted: true,
          },
        ],
      },
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.toolkit?.tools["provider-search"]).toBe(nativeSearch);
});

it("round-trips Provider Callback Tool data through a durable Tool Attempt", async () => {
  const nativeCallback = AiTool.providerDefined({
    id: "example.callback",
    customName: "provider-callback",
    providerName: "callback",
    args: Schema.Struct({}),
    requiresHandler: true,
    parameters: Schema.String,
    success: Schema.Number,
  })({});
  let executions = 0;
  const callback = Tool.providerCallback({
    name: "provider-callback",
    provider: {
      namespace: "example",
      id: "example.callback",
      args: {},
    },
    input: stringSchema,
    output: numberSchema,
    handler(input) {
      executions += 1;
      return input.length;
    },
  });
  const requests: StreamOptions[] = [];
  const fake = service((options) => {
    requests.push(options);
    if (requests.length === 1) {
      return Stream.make(
        Response.makePart("tool-call", {
          id: "callback-call",
          name: "provider-callback",
          params: "hello",
          providerExecuted: false,
          metadata: { example: { callbackToken: "token-1" } },
        }),
        Response.makePart("finish", {
          reason: "tool-calls",
          usage: modelUsage,
          response: undefined,
        }),
      );
    }
    return Stream.make(
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake, {
    fragments: [callback],
    resolveProviderTool: (descriptor) =>
      descriptor.id === nativeCallback.id ? nativeCallback : undefined,
  });

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("call back")] },
  });

  expect(outcome.type).toBe("completed");
  expect(executions).toBe(1);
  expect(requests).toHaveLength(2);
  const toolMessage = requests[1]?.prompt.content.find((message) => message.role === "tool");
  expect(Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined).toMatchObject({
    type: "tool-result",
    name: "provider-callback",
    result: 5,
    options: { example: { callbackToken: "token-1" } },
  });
});
