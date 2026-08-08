import type { FieldSchema } from "@commissary/store";

import { Agent, type AgentDefinition } from "./agent.js";
import { Codec } from "./codec.js";
import { commissary } from "./commissary.js";
import { Hook } from "./hook.js";
import { Content } from "./protocol.js";
import { Model } from "./render.js";
import type { ModelSchema } from "./schema.js";
import type { EffectiveRecordDefinitions, ThreadStoreFactoryConfig } from "./store-records.js";
import type { ThreadStore } from "./store.js";
import { Tool } from "./tool.js";
import { ExecutionId, RunId, ThreadId, ToolCallId } from "./types.js";

/** One Thread Store adapter factory for Core Runtime conformance. */
export interface CoreRuntimeConformanceAdapter {
  /** Stable adapter name used in conformance failures. */
  readonly adapter: string;
  /** Make a new, empty Thread Store for one isolated conformance scenario. */
  readonly makeThreadStore: () => ThreadStore | Promise<ThreadStore>;
  /** Make a Thread Store with the host Record overrides used by conformance. */
  readonly makeConfiguredThreadStore: (
    configuration: ThreadStoreFactoryConfig<{}, typeof conformanceHostRecordOverrides>,
  ) =>
    | ThreadStore<EffectiveRecordDefinitions<{}, typeof conformanceHostRecordOverrides>>
    | Promise<ThreadStore<EffectiveRecordDefinitions<{}, typeof conformanceHostRecordOverrides>>>;
}

/** One independently executable Core Runtime conformance scenario. */
export interface CoreRuntimeConformanceScenario {
  /** Stable scenario name for the host test runner. */
  readonly name: string;
  /** Run the scenario against a new adapter instance. */
  readonly run: () => Promise<void>;
}

const conformanceModel = Model.define({
  id: "core-runtime-conformance-model",
  async *invoke() {
    yield {
      type: "finish" as const,
      response: {
        message: {
          role: "assistant" as const,
          content: [Content.text("completed")],
        },
        finishReason: "stop" as const,
      },
    };
  },
});

const conformanceAgent = Agent.define({
  id: "core-runtime-conformance-agent",
  fragments: conformanceModel,
});

const conformanceStringSchema: ModelSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-core-conformance",
    validate(value) {
      return typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] };
    },
    jsonSchema: {
      input: () => ({ type: "string" }),
      output: () => ({ type: "string" }),
    },
  },
};
declare const conformanceThreadIdType: unique symbol;
type ConformanceThreadId = ThreadId & { readonly [conformanceThreadIdType]: true };

const conformanceThreadIdSchema: FieldSchema<ThreadId, ConformanceThreadId> = {
  "~standard": {
    version: 1,
    vendor: "commissary-core-conformance",
    validate(value) {
      return typeof value === "string" && value.length > 0
        ? { value: value as ConformanceThreadId }
        : { issues: [{ message: "Expected a Thread ID" }] };
    },
  },
};

const conformanceHostRecordOverrides = {
  thread: {
    fields: {
      id: conformanceThreadIdSchema,
      owner: conformanceStringSchema,
    },
  },
  branch: {
    fields: {
      label: conformanceStringSchema,
    },
  },
  message: {
    fields: {
      source: conformanceStringSchema,
    },
  },
  run: {
    fields: {
      category: conformanceStringSchema,
    },
  },
} as const;

const conformanceContinuationCodec = Codec.define({
  encode: (value: string) => value,
  decode(value) {
    if (typeof value !== "string") {
      throw new Error("Expected a string continuation");
    }
    return value;
  },
});

function assertCoreConformance(
  condition: unknown,
  adapter: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`Core Runtime conformance failure for '${adapter}': ${message}`);
  }
}

async function makeFixture<Definition extends AgentDefinition>(
  adapter: CoreRuntimeConformanceAdapter,
  agent: Definition,
) {
  const threadStore = await adapter.makeThreadStore();
  const app = commissary({ threadStore });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  return { app, branch, client, threadStore };
}

/** Build the Core Runtime scenarios that every concrete Thread Store adapter must run. */
export function createCoreRuntimeConformanceSuite(
  adapter: CoreRuntimeConformanceAdapter,
): readonly CoreRuntimeConformanceScenario[] {
  return Object.freeze([
    {
      name: "executes and persists one completed Run",
      async run() {
        const { branch, client, threadStore } = await makeFixture(adapter, conformanceAgent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("start")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "Run submission was not accepted",
        );
        const execution = await client.execute(submission.runId);
        const result = await execution.result;
        assertCoreConformance(result.type === "completed", adapter.adapter, "Run did not complete");
        const persisted = await client.readResult(submission.runId);
        assertCoreConformance(
          persisted?.type === "completed",
          adapter.adapter,
          "completed result was not persisted",
        );
        const snapshot = await client.readRunSnapshot(submission.runId);
        assertCoreConformance(
          snapshot?.run.status === "completed",
          adapter.adapter,
          "Run Snapshot is not completed",
        );
        assertCoreConformance(
          snapshot.toolCalls.length === 0,
          adapter.adapter,
          "Run Snapshot contains unexpected Tool Calls",
        );
        assertCoreConformance(
          (await threadStore.collections.toolCallSequence.count()) === 0,
          adapter.adapter,
          "Run without Tool Calls persisted an empty Tool Call sequence",
        );
      },
    },
    {
      name: "keeps Run submission idempotent and detects conflicts",
      async run() {
        const { branch, client } = await makeFixture(adapter, conformanceAgent);
        const runId = RunId.decode("core-runtime-conformance-idempotency");
        const input = {
          runId,
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user" as const, content: [Content.text("same")] },
        };
        const first = await client.createRun(input);
        const repeated = await client.createRun(input);
        const conflict = await client.createRun({
          ...input,
          message: { role: "user", content: [Content.text("different")] },
        });
        assertCoreConformance(
          first.type === "accepted" && first.admitted,
          adapter.adapter,
          "first idempotent submission was not admitted",
        );
        assertCoreConformance(
          repeated.type === "accepted" && !repeated.admitted,
          adapter.adapter,
          "repeated idempotent submission was admitted again",
        );
        assertCoreConformance(
          conflict.type === "run-conflict",
          adapter.adapter,
          "conflicting Run submission was not rejected",
        );
      },
    },
    {
      name: "acquires, renews, fences, and releases Execution Claims",
      async run() {
        const { branch, client, threadStore } = await makeFixture(adapter, conformanceAgent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("claim")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "claim scenario submission was not accepted",
        );
        const first = await threadStore.acquireExecutionClaim({
          agent: client.reference,
          runId: submission.runId,
          executionId: ExecutionId.decode("core-runtime-conformance-execution-one"),
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          first.type === "acquired",
          adapter.adapter,
          "first Execution Claim was not acquired",
        );
        const blocked = await threadStore.acquireExecutionClaim({
          agent: client.reference,
          runId: submission.runId,
          executionId: ExecutionId.decode("core-runtime-conformance-execution-two"),
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          blocked.type === "already-claimed",
          adapter.adapter,
          "concurrent Execution Claim was not fenced",
        );
        const renewed = await threadStore.renewExecutionClaim({
          claim: first.claim,
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          renewed.type === "renewed",
          adapter.adapter,
          "Execution Claim was not renewed",
        );
        const released = await threadStore.releaseExecutionClaim(renewed.claim);
        assertCoreConformance(released, adapter.adapter, "Execution Claim was not released");
        const reacquired = await threadStore.acquireExecutionClaim({
          agent: client.reference,
          runId: submission.runId,
          executionId: ExecutionId.decode("core-runtime-conformance-execution-three"),
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          reacquired.type === "acquired" && reacquired.claim.fence > first.claim.fence,
          adapter.adapter,
          "Execution Claim fence did not advance after release",
        );
        assertCoreConformance(
          await threadStore.releaseExecutionClaim(reacquired.claim),
          adapter.adapter,
          "reacquired Execution Claim was not released",
        );
      },
    },
    {
      name: "replaces an expired Execution Claim and fences the prior claim",
      async run() {
        const { branch, client, threadStore } = await makeFixture(adapter, conformanceAgent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("claim takeover")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "claim takeover submission was not accepted",
        );
        const first = await threadStore.acquireExecutionClaim({
          agent: client.reference,
          runId: submission.runId,
          executionId: ExecutionId.decode("core-runtime-conformance-expiring-execution"),
          leaseDurationMs: 25,
        });
        assertCoreConformance(
          first.type === "acquired",
          adapter.adapter,
          "expiring Execution Claim was not acquired",
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        const replacement = await threadStore.acquireExecutionClaim({
          agent: client.reference,
          runId: submission.runId,
          executionId: ExecutionId.decode("core-runtime-conformance-replacement-execution"),
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          replacement.type === "acquired" && replacement.claim.fence > first.claim.fence,
          adapter.adapter,
          "expired Execution Claim was not replaced with a higher fence",
        );
        const staleRenewal = await threadStore.renewExecutionClaim({
          claim: first.claim,
          leaseDurationMs: 60_000,
        });
        assertCoreConformance(
          staleRenewal.type === "claim-lost",
          adapter.adapter,
          "replaced Execution Claim retained its fence",
        );
        assertCoreConformance(
          await threadStore.releaseExecutionClaim(replacement.claim),
          adapter.adapter,
          "replacement Execution Claim was not released",
        );
      },
    },
    {
      name: "preserves host Records and compatible Core field overrides",
      async run() {
        let messageHookCalls = 0;
        const threadStore = await adapter.makeConfiguredThreadStore({
          records: {},
          overrides: conformanceHostRecordOverrides,
          hooks: {
            message: {
              beforeCreate: ({ draft }) => {
                messageHookCalls += 1;
                return { ...draft, source: "core-runtime-conformance" };
              },
            },
          },
        });
        const app = commissary({ threadStore });
        const thread = await app.createThread({
          fields: { owner: "conformance-owner" },
        });
        const branch = await app.createBranch({
          threadId: thread.id,
          name: "main",
          fields: { label: "conformance-branch" },
        });
        const client = app.agent(conformanceAgent);
        const submission = await client.createRun({
          threadId: thread.id,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("host records")] },
          fields: { category: "conformance-run" },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "host Record submission was not accepted",
        );
        const result = await (await client.execute(submission.runId)).result;
        assertCoreConformance(
          result.type === "completed",
          adapter.adapter,
          "host Record Run did not complete",
        );
        const snapshot = await client.readRunSnapshot(submission.runId);
        assertCoreConformance(
          thread.owner === "conformance-owner" &&
            branch.label === "conformance-branch" &&
            snapshot?.run.category === "conformance-run",
          adapter.adapter,
          "host Record fields were not preserved",
        );
        const history = await app.readBranchHistory({
          threadId: thread.id,
          branchId: branch.id,
        });
        assertCoreConformance(
          messageHookCalls > 0 &&
            history.length > 0 &&
            history.every((entry) => entry.source === "core-runtime-conformance"),
          adapter.adapter,
          "required host Message hook output was not preserved",
        );
      },
    },
    {
      name: "persists Steering for the next Model invocation",
      async run() {
        let sawSteering = false;
        const model = Model.define({
          id: "core-runtime-conformance-steering-model",
          async *invoke(request) {
            sawSteering = request.messages.some((message) =>
              message.content.some((part) => part.type === "text" && part.text === "steer"),
            );
            yield {
              type: "finish" as const,
              response: {
                message: { role: "assistant" as const, content: [Content.text("steered")] },
                finishReason: "stop" as const,
              },
            };
          },
        });
        const agent = Agent.define({
          id: "core-runtime-conformance-steering-agent",
          fragments: model,
        });
        const { branch, client } = await makeFixture(adapter, agent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("start")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "Steering scenario submission was not accepted",
        );
        const steering = await client.steer({
          runId: submission.runId,
          steeringRequestId: "core-runtime-conformance-steering",
          message: { role: "user", content: [Content.text("steer")] },
        });
        assertCoreConformance(
          steering.type === "accepted" && steering.admitted,
          adapter.adapter,
          "Steering was not admitted",
        );
        const result = await (await client.execute(submission.runId)).result;
        assertCoreConformance(
          result.type === "completed" && sawSteering,
          adapter.adapter,
          "Steering did not reach the next Model invocation",
        );
      },
    },
    {
      name: "persists Redirects for restarted Model work",
      async run() {
        let sawRedirect = false;
        const model = Model.define({
          id: "core-runtime-conformance-redirect-model",
          async *invoke(request) {
            sawRedirect = request.messages.some((message) =>
              message.content.some((part) => part.type === "text" && part.text === "redirect"),
            );
            yield {
              type: "finish" as const,
              response: {
                message: { role: "assistant" as const, content: [Content.text("redirected")] },
                finishReason: "stop" as const,
              },
            };
          },
        });
        const agent = Agent.define({
          id: "core-runtime-conformance-redirect-agent",
          fragments: model,
        });
        const { branch, client } = await makeFixture(adapter, agent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("start")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "Redirect scenario submission was not accepted",
        );
        const redirect = await client.redirect({
          runId: submission.runId,
          redirectRequestId: "core-runtime-conformance-redirect",
          message: { role: "user", content: [Content.text("redirect")] },
        });
        assertCoreConformance(
          redirect.type === "accepted" && redirect.admitted,
          adapter.adapter,
          "Redirect was not admitted",
        );
        const result = await (await client.execute(submission.runId)).result;
        assertCoreConformance(
          result.type === "completed" && sawRedirect,
          adapter.adapter,
          "Redirect did not reach restarted Model work",
        );
      },
    },
    {
      name: "suspends and resumes one Tool Call",
      async run() {
        const toolCallId = ToolCallId.decode("core-runtime-conformance-tool-call");
        let modelInvocations = 0;
        const approval = Tool.define({
          name: "approval",
          input: conformanceStringSchema,
          output: conformanceStringSchema,
          handler: () => Tool.suspend("state"),
          suspension: {
            resumeInput: conformanceStringSchema,
            continuation: conformanceContinuationCodec,
            resume: ({ input, continuation }) => `${continuation}:${input}`,
          },
        });
        const model = Model.define({
          id: "core-runtime-conformance-tool-model",
          async *invoke() {
            modelInvocations += 1;
            yield {
              type: "finish" as const,
              response:
                modelInvocations === 1
                  ? {
                      message: {
                        role: "assistant" as const,
                        content: [Content.toolCall(toolCallId, "approval", "start")],
                      },
                      finishReason: "tool-calls" as const,
                    }
                  : {
                      message: {
                        role: "assistant" as const,
                        content: [Content.text("completed")],
                      },
                      finishReason: "stop" as const,
                    },
            };
          },
        });
        const agent = Agent.define({
          id: "core-runtime-conformance-tool-agent",
          fragments: Agent.combine(model, approval),
        });
        const { branch, client } = await makeFixture(adapter, agent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("start")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "Tool scenario submission was not accepted",
        );
        const suspended = await (await client.execute(submission.runId)).result;
        assertCoreConformance(
          suspended.type === "suspended",
          adapter.adapter,
          "Tool Call did not suspend its Run",
        );
        const resumed = await client.resumeRun({
          runId: submission.runId,
          items: [{ toolName: "approval", toolCallId, input: "approved" }],
        });
        assertCoreConformance(
          resumed.type === "accepted",
          adapter.adapter,
          "Tool resume input was not accepted",
        );
        const completed = await (await client.execute(submission.runId)).result;
        assertCoreConformance(
          completed.type === "completed",
          adapter.adapter,
          "resumed Tool Call did not complete its Run",
        );
        const snapshot = await client.readRunSnapshot(submission.runId);
        assertCoreConformance(
          snapshot?.toolCalls[0]?.result?.type === "success" &&
            snapshot.toolCalls[0].result.output === "state:approved",
          adapter.adapter,
          "resumed Tool result was not persisted",
        );
      },
    },
    {
      name: "runs settlement Hooks after durable finalization",
      async run() {
        let settledType: string | undefined;
        const agent = Agent.define({
          id: "core-runtime-conformance-settlement-agent",
          fragments: Agent.combine(
            conformanceModel,
            Hook.onSettlement(({ result }) => {
              settledType = result.type;
              return undefined;
            }),
          ),
        });
        const { branch, client } = await makeFixture(adapter, agent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("settle")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "settlement scenario submission was not accepted",
        );
        const result = await (await client.execute(submission.runId)).result;
        const persisted = await client.readResult(submission.runId);
        assertCoreConformance(
          result.type === "completed" &&
            persisted?.type === "completed" &&
            settledType === "completed",
          adapter.adapter,
          "settlement Hook did not observe the durable final result",
        );
      },
    },
    {
      name: "persists an abort request before execution",
      async run() {
        const { branch, client } = await makeFixture(adapter, conformanceAgent);
        const submission = await client.createRun({
          threadId: branch.threadId,
          branchId: branch.id,
          message: { role: "user", content: [Content.text("abort")] },
        });
        assertCoreConformance(
          submission.type === "accepted",
          adapter.adapter,
          "abort scenario submission was not accepted",
        );
        const abort = await client.abort(submission.runId, "stop");
        assertCoreConformance(
          abort.type === "accepted",
          adapter.adapter,
          "abort request was not accepted",
        );
        const execution = await client.execute(submission.runId);
        const result = await execution.result;
        assertCoreConformance(
          result.type === "aborted" && result.reason === "stop",
          adapter.adapter,
          "Run did not preserve the abort result",
        );
      },
    },
  ]);
}
