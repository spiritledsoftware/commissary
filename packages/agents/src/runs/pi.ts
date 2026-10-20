/**
 * The adapter over pi-durable and the pi packages it needs (#227, ADR 0040 "Pinning"): the only module that imports
 * `@earendil-works/*`, so they can be replaced without touching the rest of the area. Their versions are pinned exactly
 * (packages/agents/package.json), as their APIs are experimental. The run's Durable Object imports it statically, and
 * it imports pi-ai's provider module statically too: no lazy `import()` is shared by the run objects of one isolate,
 * whose waits on one pending import would resume in another object's I/O context (docs/ARCHITECTURE.md, "Agents").
 *
 * What it does with them: a pi-durable `Harness` on the object's SQLite (`openDurableObjectSqliteStorage`), whose root
 * conversation is the run; one pi-ai provider (`commissary`) whose OpenAI-compatible requests go to the client API
 * through the run's `fetch`; and the tools the MCP endpoint lists for the run, reached with `@earendil-works/pi-mcp`
 * over the same `fetch`, installed as one pi extension (`commissary`). Every model and tool call is therefore a client
 * API request of the run's principal, under every gate (the API Worker's run gateway).
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  type JsonObject,
  type Message,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import {
  AssistantEntry,
  ConversationBusy,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  type CallToolResult,
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { Option, Schema } from "effect";
import { SPEND_REFUSAL_META } from "@commissary/core";

/** Where the run's requests say they go: never resolved, the run's `fetch` takes every request to the client API. */
export const CLIENT_API_ORIGIN = "https://client-api.agent-run.invalid";

/** The key pi-ai's client is given: a placeholder, as the run is its own principal (no request carries a key). */
const RUN_KEY = "agent-run";

/** The pi-ai provider the runs' models belong to. */
const PROVIDER = "commissary";

/** The pi extension that holds the run's MCP tools. */
const TOOLS_EXTENSION = "commissary";

/**
 * What a model is assumed to take, as the client API does not say: a context window for pi-durable's compaction and
 * an output cap. Commissary's own limits apply upstream.
 */
const CONTEXT_WINDOW = 200_000;

const MAX_TOKENS = 32_000;

/** How long one tool call may take before the run gives up on it. */
const TOOL_CALL_TIMEOUT_MS = 15 * 60_000;

/** What a turn's model is: its definition's model, with its thinking level as Commissary's suffix (`model(high)`). */
export interface TurnAgent {
  readonly model: string;
  readonly thinking?: string | undefined;
  readonly instructions: string;
}

/** How a submitted input settled. */
export type Settled =
  | { readonly status: "done"; readonly answer: string }
  | { readonly status: "unanswered"; readonly reason: string; readonly detail: string };

/** One transcript entry, as the run shows it. */
export interface PiEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly arguments: string }>;
  readonly tool?: string;
  readonly isError?: boolean;
  readonly at: number;
}

/** A submitted input: a new turn (`turn`) or steering of the running one (`steering`). */
export interface Submitted {
  readonly submission: string;
  readonly delivery: "turn" | "steering";
}

/** The run's harness, as the run's object uses it. */
export interface PiRun {
  /** Lists the tools the MCP endpoint gives the run now and installs them; call before a turn and before resuming. */
  refreshTools(): Promise<number>;
  /** Continues what the last process left unfinished. */
  resume(): void;
  /**
   * Submits `content`: as a new turn when the run is idle and `agent` is given (the turn's model and instructions),
   * else as steering of the running turn. `requestId` makes a retried submission find the first.
   */
  submit(content: string, requestId: string, agent: TurnAgent | undefined): Promise<Submitted>;
  /** Waits for a submission to settle, for at most `timeoutMs` when given (`undefined` once it passed). */
  settle(submission: string, timeoutMs?: number): Promise<Settled | undefined>;
  /** Aborts the running turn; resolves once the run is idle. */
  abort(): Promise<void>;
  /** The newest `limit` entries of the transcript, oldest first. */
  entries(limit: number): Promise<ReadonlyArray<PiEntry>>;
  /** Settles once the harness closed: `failed` after a storage failure, which a reopen recovers from. */
  readonly closed: Promise<"closed" | "failed">;
  close(): Promise<void>;
}

/** What opening a run's harness needs. */
export interface PiRunOptions {
  /** The object's storage (`ctx.storage`). */
  readonly storage: DurableObjectStorage;
  /** Every request of the run: to the client API, as the run's principal. */
  readonly fetch: typeof fetch;
  /** Failures that do not fail an operation (a throwing hook, the error that closed the harness), as text. */
  readonly report: (message: string) => void;
  /**
   * A tool call a spend limit refused (the MCP endpoint's `_meta`, `SPEND_REFUSAL_META`), with the refusal's text: the
   * run ends its turn with it as the answer.
   */
  readonly refused: (message: string) => void;
}

/** The text parts of a message's content, joined. */
const textOf = (content: Exclude<Message, { readonly role: "system" }>["content"]): string =>
  typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** A record's entries as the run shows them: user inputs, assistant messages (answers and tool calls), tool results. */
const visibleEntries = (entry: EntryRecord): ReadonlyArray<PiEntry> =>
  (entry.model ?? []).flatMap((message): ReadonlyArray<PiEntry> => {
    const at = message.timestamp;

    switch (message.role) {
      case "user":
        return [{ role: "user", text: textOf(message.content), at }];
      case "assistant": {
        const calls = message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ name: part.name, arguments: JSON.stringify(part.arguments ?? {}) }]
            : [],
        );

        return [
          {
            role: "assistant",
            text: textOf(message.content),
            ...(calls.length === 0 ? {} : { toolCalls: calls }),
            at,
          },
        ];
      }

      case "toolResult":
        return [
          {
            role: "tool",
            text: textOf(message.content),
            tool: message.toolName,
            isError: message.isError,
            at,
          },
        ];
      default:
        return [];
    }
  });

/** The model of a turn, as the client API is asked for it. */
const modelId = (agent: TurnAgent): string =>
  agent.thinking === undefined ? agent.model : `${agent.model}(${agent.thinking})`;

const modelOf = (id: string): Model<"openai-completions"> => ({
  id,
  name: id,
  api: "openai-completions",
  provider: PROVIDER,
  baseUrl: `${CLIENT_API_ORIGIN}/v1`,
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_TOKENS,
});

/** A provider-safe tool name: at most 64 of `[A-Za-z0-9_-]`. */
const toolName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** The `_meta` of a tool result a spend limit refused (the MCP endpoint's, for a run). */
const RefusalMeta = Schema.Struct({ [SPEND_REFUSAL_META]: Schema.String });

const decodeRefusalMeta = Schema.decodeUnknownOption(RefusalMeta);

/** The text of a spend limit's refusal `result` carries, if it is one. */
const spendRefusal = (result: CallToolResult): string | undefined =>
  Option.getOrUndefined(decodeRefusalMeta(result._meta))?.[SPEND_REFUSAL_META];

/** Opens the run's harness on the object's storage. */
export const openPiRun = async (options: PiRunOptions): Promise<PiRun> => {
  const context = BACKGROUND_CONTEXT;
  // Every request of pi-ai's provider goes through the run's `fetch`, which pi-durable does not pass itself. The
  // provider's module is imported statically, not through pi-ai's lazy `import()` (`openai-completions.lazy`): run
  // objects of one isolate starting at once would await one pending import, and all but one would resume in another
  // object's I/O context, which workerd refuses.
  const completions = openAICompletions;

  const throughRun = {
    stream: (model, transcript, streamOptions) =>
      completions.stream(model, transcript, { ...streamOptions, fetch: options.fetch }),
    streamSimple: (model, transcript, streamOptions) =>
      completions.streamSimple(model, transcript, { ...streamOptions, fetch: options.fetch }),
  } satisfies Pick<typeof completions, "stream" | "streamSimple">;

  // Models are named per turn (the definition's, as it stands): the provider's list is the models named so far.
  const known = new Map<string, Model<"openai-completions">>();
  const models = createModels();

  const install = (id: string): void => {
    if (known.has(id)) return;
    known.set(id, modelOf(id));

    models.setProvider(
      createProvider({
        id: PROVIDER,
        name: "Commissary",
        baseUrl: `${CLIENT_API_ORIGIN}/v1`,
        // The run's `fetch` carries its principal, not a key: pi-ai's client wants one, so it gets a placeholder,
        // which the run's `fetch` drops (`RUN_KEY`).
        auth: {
          apiKey: { name: "Commissary", resolve: async () => ({ auth: { apiKey: RUN_KEY } }) },
        },
        models: [...known.values()],
        api: throughRun,
      }),
    );
  };

  const registry = createRegistry();
  const storage = await openDurableObjectSqliteStorage(options.storage);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      onReport: (error) => options.report(error instanceof Error ? error.message : String(error)),
      // The definition's thinking level is the model's suffix: pi-ai asks for none of its own.
      settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000 } },
    },
    context,
  );

  const closed = harness.closed.then((end) => (end.reason === "failed" ? "failed" : "closed"));

  // A turn the last process left running resumes with the model it was configured with.
  const resumed = await harness.root(context);
  const configured = (await resumed.agent(context)).model;

  if (configured?.provider === PROVIDER) install(configured.modelId);

  let client: McpClient | undefined;

  const connected = async (): Promise<McpClient> => {
    if (client !== undefined) return client;
    const created = new McpClient({ name: "commissary-agent-run", version: "1.0.0" });

    await created.connect(
      new StreamableHttpTransport({
        url: `${CLIENT_API_ORIGIN}/mcp`,
        fetch: options.fetch,
        openGetStream: false,
      }),
    );
    created.onClose(() => {
      if (client === created) client = undefined;
    });
    client = created;

    return created;
  };

  const mcpTool = (tool: {
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: { readonly properties?: unknown };
  }): ToolRegistration =>
    defineTool({
      name: toolName(tool.name),
      description: tool.description ?? tool.name,
      // Providers want an object schema with `properties`; the MCP endpoint validates the arguments itself.
      parameters: Type.Unsafe<JsonObject>({
        ...tool.inputSchema,
        type: "object",
        properties: tool.inputSchema.properties ?? {},
      }),
      // A call cut off by a restart is not made again: the model gets it as interrupted (pi-durable's default).
      replay: "unsafe",
      execute: async (args, _api, callContext) => {
        const result = await (
          await connected()
        ).callTool(tool.name, args, {
          ...(callContext.abortSignal === undefined ? {} : { signal: callContext.abortSignal }),
          timeoutMs: TOOL_CALL_TIMEOUT_MS,
        });

        const refusal = spendRefusal(result);

        if (refusal !== undefined) options.refused(refusal);

        return { output: toLlmContent(result), isError: result.isError === true };
      },
    });

  const root = async () => await harness.root(context);

  return {
    refreshTools: async () => {
      const listed = await (await connected()).listTools();

      registry.install(defineExtension({ name: TOOLS_EXTENSION, tools: listed.map(mcpTool) }));

      return listed.length;
    },
    resume: () => harness.resume(),
    submit: async (content, requestId, agent) => {
      const conversation = await root();
      const inspection = await harness.inspect(context);

      // A new turn reads the definition as it stands: its model and instructions apply from its first request. A
      // running turn keeps its own, and the message joins it as steering.
      if (
        agent !== undefined &&
        inspection.tasks.length === 0 &&
        inspection.submissions.length === 0
      ) {
        const id = modelId(agent);

        install(id);
        await conversation.configure(
          { model: { provider: PROVIDER, modelId: id }, instructions: agent.instructions },
          context,
        );

        try {
          const submission = await conversation.submit(
            { type: "input", content, requestId, whenBusy: "reject" },
            context,
          );

          return { submission: String(submission.id), delivery: "turn" };
        } catch (error) {
          if (!(error instanceof ConversationBusy)) throw error;
        }
      }

      const steering = await conversation.submit(
        { type: "input", content, requestId: `steer:${requestId}`, whenBusy: "steer" },
        context,
      );

      return { submission: String(steering.id), delivery: "steering" };
    },
    settle: async (id, timeoutMs) => {
      // SAFETY: submission ids are pi-durable's own, handed out by `submit` and kept by the run as they were.
      const submission = await harness.submission(id as never, context);

      if (submission === undefined)
        return { status: "unanswered", reason: "unknown", detail: "the turn was lost" };

      const deadline =
        timeoutMs === undefined ? undefined : AbortSignal.timeout(Math.max(0, timeoutMs));

      let settled;

      try {
        settled = await submission.wait(
          deadline === undefined
            ? BACKGROUND_CONTEXT
            : withAbortSignal(deadline, BACKGROUND_CONTEXT),
        );
      } catch (error) {
        // The wait ran out (`undefined`); any other failure (a closed harness, storage) is the caller's.
        if (deadline?.aborted === true) return undefined;
        throw error;
      }

      if (settled.type !== "input" || settled.status !== "done")
        return {
          status: "unanswered",
          reason: settled.reason ?? "unanswered",
          detail:
            typeof settled.detail === "string"
              ? settled.detail
              : settled.detail === undefined
                ? ""
                : JSON.stringify(settled.detail),
        };

      const conversation = await root();

      const answer = await conversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        context,
      );

      return {
        status: "done",
        answer: (answer === undefined ? [] : visibleEntries(answer))
          .map((entry) => entry.text)
          .join(""),
      };
    },
    abort: async () => {
      await (await root()).abort(context);
    },
    entries: async (limit) => {
      const page = await (await root()).entries({}, limit, undefined, context);

      return page.items.toReversed().flatMap(visibleEntries);
    },
    closed,
    close: async () => {
      await client?.close();
      await harness.close(context);
    },
  };
};
