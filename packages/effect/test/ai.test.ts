import {
  Agent,
  Content,
  Tool,
  Hook,
  type AgentFragment,
  type ArtifactId,
  ArtifactStoreError,
  type ArtifactStore,
  Model,
  type FragmentMetadata,
  type ModelSchema,
  type ProviderOption,
  type StartRunCommand,
} from "@commissary/core";
import { Duration, Effect, Layer, Schema, Scope, Stream } from "effect";
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

import { MemoryThreadStore } from "@commissary/store-memory";

import { EffectAi, EffectAiBridgeDefect, type EffectAiToolTranslator } from "../src/ai.js";
import { EffectCommissary } from "../src/index.js";

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

function artifactId(value: string): ArtifactId {
  // SAFETY: Tests use deterministic unique strings at the Artifact ID boundary.
  return value as ArtifactId;
}

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
    readonly providerCapabilities?: readonly AiTool.AnyProviderDefined[];
    readonly translateTool?: EffectAiToolTranslator;
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
  const model = EffectAi.model(aiModel, {
    ...(options.providerCapabilities === undefined
      ? {}
      : { providerCapabilities: options.providerCapabilities }),
    ...(options.translateTool === undefined ? {} : { translateTool: options.translateTool }),
  });
  const agent = Agent.define({
    id: "effect-ai-test",
    fragments: Agent.combine(model, ...(options.fragments ?? [])),
  });
  const store = new MemoryThreadStore();
  const app = await Effect.runPromise(
    EffectCommissary.make({
      threadStore: store,
      ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    }),
  );
  const thread = await Effect.runPromise(app.createThread());
  const branch = await Effect.runPromise(app.createBranch({ threadId: thread.id, name: "main" }));
  const effectClient = await Effect.runPromise(app.agent(agent));
  const coreClient = effectClient.core;
  const client = {
    ...coreClient,
    async run(input: Omit<StartRunCommand, "type">) {
      const submission = await coreClient.submit({ type: "start", ...input });
      if (submission.type !== "submitted") {
        return submission;
      }
      return (await coreClient.execute(submission.runId)).result;
    },
    async stream(input: Omit<StartRunCommand, "type">) {
      const submission = await coreClient.submit({ type: "start", ...input });
      if (submission.type !== "submitted") {
        return submission;
      }
      return coreClient.execute(submission.runId);
    },
  };
  return {
    store,
    branch,
    client,
    effectClient,
    modelAcquired,
    acquired: () => acquired,
    released: () => released,
  };
}

it("exposes Agent operations as native Effects", async () => {
  const fake = service(() =>
    Stream.make(
      Response.makePart("finish", {
        reason: "stop",
        usage: modelUsage,
        response: undefined,
      }),
    ),
  );
  const fixture = await run(fake);
  const submission = await Effect.runPromise(
    fixture.effectClient.submit({
      type: "start",
      threadId: fixture.branch.threadId,
      branchId: fixture.branch.id,
      message: { role: "user", content: [Content.text("native")] },
    }),
  );
  if (submission.type !== "submitted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }
  const execution = await Effect.runPromise(fixture.effectClient.execute(submission.runId));

  await expect(Effect.runPromise(execution.result)).resolves.toMatchObject({
    type: "completed",
  });
});

it("releases every selected Model scope when one Execution ends", async () => {
  const scopes: Scope.Scope[] = [];
  const modelLayer = () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.gen(function* () {
        scopes.push(yield* Effect.scope);
        return service(() =>
          Stream.make(
            Response.makePart("finish", {
              reason: "stop",
              usage: modelUsage,
              response: undefined,
            }),
          ),
        );
      }),
    );
  const first = EffectAi.model(AiModel.make("first", "first-model", modelLayer()), {
    id: "first-effect-model",
  });
  const second = EffectAi.model(AiModel.make("second", "second-model", modelLayer()), {
    id: "second-effect-model",
  });
  const composite = Model.composite({
    id: "effect-scope-composite",
    children: [first, second],
    async invoke(request, context) {
      await context.invoke(first, request, { key: "first" });
      return context.forward(second, request, { key: "second" });
    },
  });
  const agent = Agent.define({ id: "effect-scope-agent", fragments: composite });
  const app = await Effect.runPromise(
    EffectCommissary.make({ threadStore: new MemoryThreadStore() }),
  );
  const thread = await Effect.runPromise(app.createThread());
  const branch = await Effect.runPromise(app.createBranch({ threadId: thread.id, name: "main" }));
  const client = await Effect.runPromise(app.agent(agent));
  const submission = await Effect.runPromise(
    client.submit({
      type: "start",
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("scope")] },
    }),
  );
  if (submission.type !== "submitted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }

  const execution = await Effect.runPromise(client.execute(submission.runId));
  await expect(Effect.runPromise(execution.result)).resolves.toMatchObject({
    type: "completed",
  });
  expect(scopes).toHaveLength(2);
  expect(scopes.every((scope) => scope.state._tag === "Closed")).toBe(true);
});

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
      usage: {
        input: { total: 3 },
        output: { total: 2, text: 1, reasoning: 1 },
      },
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
  const deltas: string[] = [];
  const unsubscribe = fixture.client.subscribe(
    Hook.onExecutionEvent(({ event }) => {
      if (event.type === "model-event" && event.event.type === "reasoning-delta") {
        deltas.push(event.event.delta);
      }
      return undefined;
    }),
  );
  const attempt = await fixture.client.stream({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("reason")] },
  });
  if ("type" in attempt) {
    throw new Error(`Unexpected admission failure: ${attempt.type}`);
  }
  await expect(attempt.result).resolves.toMatchObject({ type: "completed" });
  unsubscribe();
  expect(deltas).toEqual(["checking"]);
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
      usage: { input: { total: 4 }, output: { total: 2 }, totalTokens: 6 },
    },
  });
});

it("wraps unclassified Effect AI errors as unexpected Execution errors", async () => {
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
  ).rejects.toMatchObject({
    name: "UnexpectedExecutionError",
    phase: "model",
    cause: expect.any(EffectAiBridgeDefect),
  });
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
      usage: {
        input: { total: 3 },
        output: { total: 2, text: 1, reasoning: 1 },
      },
    },
  });
  expect(
    await fixture.store.readBranchHistory({
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
  await attempt.abort("cancelled");
  const outcome = await attempt.result;

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

it("reports Artifact Store write failures as specific store errors", async () => {
  const artifactStore: ArtifactStore = {
    read: () => Promise.reject(new Error("Unexpected read")),
    write: () => Promise.reject(new Error("write failed")),
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

  const execution = fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("make an image")] },
  });

  await expect(execution).rejects.toBeInstanceOf(ArtifactStoreError);
  await expect(execution).rejects.toMatchObject({ operation: "write" });
});

it("reports Artifact Store read failures as specific store errors", async () => {
  let invocations = 0;
  const artifactStore: ArtifactStore = {
    read: () => Promise.reject(new Error("read failed")),
    write: () => Promise.reject(new Error("Unexpected write")),
  };
  const fake = service(() => {
    invocations += 1;
    return Stream.empty;
  });
  const fixture = await run(fake, { artifactStore });

  const execution = fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: {
      role: "user",
      content: [Content.file({ id: "missing-artifact" as ArtifactId, mediaType: "image/png" })],
    },
  });

  await expect(execution).rejects.toBeInstanceOf(ArtifactStoreError);
  await expect(execution).rejects.toMatchObject({ operation: "read" });
  expect(invocations).toBe(0);
});

it("reads request Artifacts concurrently and preserves Prompt order", async () => {
  let firstReadActive = false;
  let secondReadOverlapped = false;
  const artifactStore: ArtifactStore = {
    async read(reference) {
      if (reference.id === "artifact-first") {
        firstReadActive = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        firstReadActive = false;
        return { data: new Uint8Array([1]), mediaType: "image/png" };
      }
      secondReadOverlapped = firstReadActive;
      return { data: new Uint8Array([2]), mediaType: "image/png" };
    },
    write: () => Promise.reject(new Error("Unexpected write")),
  };
  const requests: StreamOptions[] = [];
  const fake = service((options) => {
    requests.push(options);
    return Stream.make(
      Response.makePart("finish", { reason: "stop", usage: modelUsage, response: undefined }),
    );
  });
  const fixture = await run(fake, { artifactStore });

  await expect(
    fixture.client.run({
      threadId: fixture.branch.threadId,
      branchId: fixture.branch.id,
      message: {
        role: "user",
        content: [
          Content.file({ id: artifactId("artifact-first"), mediaType: "image/png" }),
          Content.file({ id: artifactId("artifact-second"), mediaType: "image/png" }),
        ],
      },
    }),
  ).resolves.toMatchObject({ type: "completed" });
  const userMessage = requests[0]?.prompt.content.find((message) => message.role === "user");
  expect(secondReadOverlapped).toBe(true);
  expect(userMessage?.content).toMatchObject([
    { type: "file", data: new Uint8Array([1]) },
    { type: "file", data: new Uint8Array([2]) },
  ]);
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

it("keeps provider-executed capabilities in Model configuration", async () => {
  const nativeSearch = AiTool.providerDefined({
    id: "example.search",
    customName: "provider-search",
    providerName: "search",
    args: Schema.Struct({ depth: Schema.Number }),
    parameters: Schema.String,
    success: Schema.String,
  })({ depth: 1 });
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
      Response.makePart("finish", {
        reason: "stop",
        usage: modelUsage,
        response: undefined,
      }),
    );
  });
  const fixture = await run(fake, {
    providerCapabilities: [nativeSearch],
  });

  const outcome = await fixture.client.run({
    threadId: fixture.branch.threadId,
    branchId: fixture.branch.id,
    message: { role: "user", content: [Content.text("search")] },
  });

  expect(outcome).toMatchObject({
    type: "completed",
    response: { message: { content: [] } },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.toolkit?.tools["provider-search"]).toBe(nativeSearch);
  if (!("runId" in outcome)) {
    throw new Error(`Unexpected submission result '${outcome.type}'`);
  }
  await expect(fixture.client.readRunSnapshot(outcome.runId)).resolves.toMatchObject({
    toolCalls: [],
  });
});

it("maps an ordinary durable Tool through a provider callback definition", async () => {
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
  const callback = Tool.define({
    name: "provider-callback",
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
    translateTool: (tool) => (tool.name === nativeCallback.name ? nativeCallback : undefined),
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

it("rejects non-JSON provider Tool input at the bridge boundary", async () => {
  const callback = Tool.define({
    name: "invalid-json",
    input: stringSchema,
    output: numberSchema,
    handler: () => 0,
  });
  const fake = service(() =>
    Stream.make(
      Response.makePart("tool-call", {
        id: "invalid-call",
        name: "invalid-json",
        params: { value: undefined } as never,
        providerExecuted: false,
      }),
      Response.makePart("finish", {
        reason: "tool-calls",
        usage: modelUsage,
        response: undefined,
      }),
    ),
  );
  const fixture = await run(fake, { fragments: [callback] });

  await expect(
    fixture.client.run({
      threadId: fixture.branch.threadId,
      branchId: fixture.branch.id,
      message: { role: "user", content: [Content.text("call")] },
    }),
  ).rejects.toMatchObject({
    name: "UnexpectedExecutionError",
    phase: "model",
    cause: expect.any(EffectAiBridgeDefect),
  });
});
