/**
 * What each kind of stored toolkit does its own way (ADR 0036): how its tool list is built and how a call of one of its
 * tools reaches the upstream. The Tools part dispatches on {@link KIND_DRIVERS} and keeps the rest (credentials,
 * grants, Spend limits, usage, the sessions a kind keeps) the same for every kind. A built-in toolkit (`built-in.ts`)
 * is not stored and has no driver: its provider lists and calls its tools.
 *
 * - **MCP** (#196, #197): the server lists its tools to a signed-in client, so a build needs a credential; a call runs
 *   in an upstream session the part keeps per caller and credential.
 * - **OpenAPI** (#203): the document is read without a credential (fetched from the source, or the uploaded one); a
 *   call is one HTTP request built from the tool's operation. A build warns when operations name no server the outbound
 *   guard lets a call reach and the toolkit has no base URL ({@link serverWarning}).
 */
import { type Duration, Effect, Result, Schema } from "effect";
import { checkOutboundUrl, type OutboundPolicy } from "@commissary/core";
import { callHttp, fetchDocument, withOutboundGuard } from "../http/call.ts";
import {
  callUpstreamTool,
  listUpstreamTools,
  type McpError,
  type UpstreamSession,
} from "../mcp/client.ts";
import { operationCall } from "../openapi/request.ts";
import { type OpenApiOperation, type OpenApiToolList, openApiToolList } from "../openapi/tools.ts";
import { defaultToolkitName, toolkitNameOf } from "./names.ts";
import type { ResolvedTool } from "./resolve.ts";
import type { UpstreamSecret } from "./secret.ts";
import type { ListedTool } from "./store.ts";
import type { StoredToolkit } from "./toolkit.ts";

/** Why a build or a call failed: a short message that quotes no URL, secret or upstream body. */
export class KindFailure extends Schema.TaggedError<KindFailure>()("KindFailure", {
  message: Schema.String,
  /** The upstream refused the credential's token itself (`401`), which a refreshed one may pass (#202). */
  unauthorized: Schema.optionalKey(Schema.Boolean),
}) {}

/** What a build of a toolkit's list reads. */
export interface ListInput {
  readonly toolkit: Pick<StoredToolkit, "source" | "baseUrl">;
  /** The credential a build lists with, for a kind that needs one ({@link KindDriver.listsWithCredential}). */
  readonly secret: UpstreamSecret;
  /** An OpenAPI toolkit's uploaded document. */
  readonly document: string | undefined;
  readonly timeout: Duration.Input;
  readonly policy: OutboundPolicy;
}

/** A built tool list. */
export interface Listing {
  readonly tools: ReadonlyArray<ListedTool>;
  /** A new toolkit's default name, from what the list was built from (an OpenAPI document's first server or title). */
  readonly name?: string;
  /** What keeps some of its tools from being called as they are, kept as the list's error. */
  readonly warning?: string;
}

/** What a call of a tool reads. */
export interface CallInput {
  readonly toolkit: StoredToolkit;
  readonly tool: ResolvedTool;
  readonly secret: UpstreamSecret;
  readonly args: Schema.JsonObject | undefined;
  readonly policy: OutboundPolicy;
  /** The upstream session kept for the caller on the credential, for a kind that keeps them. */
  readonly session: UpstreamSession | undefined;
}

/** A call's tool result, and the session it ran in for a kind that keeps them. */
export interface Called {
  readonly result: Schema.JsonObject;
  readonly session?: UpstreamSession;
  /** The upstream answered `401` (the result says so), which a refreshed token may pass (#202). */
  readonly unauthorized?: boolean;
}

export interface KindDriver {
  /** Whether a build lists the tools with a credential (an MCP server's), else it reads its source without one. */
  readonly listsWithCredential: boolean;
  /** Whether the cron task rebuilds `toolkit`'s list (given a credential, for a kind that lists with one). */
  readonly refreshed: (toolkit: Pick<StoredToolkit, "source">) => boolean;
  /** Whether calls run in an upstream session the part keeps per caller and credential. */
  readonly keepsSessions: boolean;
  readonly list: (input: ListInput) => Effect.Effect<Listing, KindFailure>;
  readonly call: (input: CallInput) => Effect.Effect<Called, KindFailure>;
  /**
   * The list's warning for `tools` as `toolkit` is now (its base URL changed), with `policy`; undefined for a kind that
   * has none.
   */
  readonly warning?: (
    toolkit: Pick<StoredToolkit, "baseUrl">,
    tools: ReadonlyArray<ToolOperation>,
    policy: OutboundPolicy,
  ) => string | undefined;
}

/** What a tool list's warning reads of a tool: its OpenAPI operation, if it has one. */
export interface ToolOperation {
  readonly operation?: OpenApiOperation | undefined;
}

const failed = (message: string) => new KindFailure({ message });

/** An MCP client's failure as a driver's, saying when the server refused the token itself (`401`). */
const mcpFailed = (error: McpError) =>
  error.reason === "unauthorized" && error.status === 401
    ? new KindFailure({ message: error.message, unauthorized: true })
    : failed(error.message);

/** Logs an upstream call's failure with the toolkit and the reason only. */
const logFailure = (toolkit: string, reason: string, status?: number) =>
  Effect.logWarning("upstream tool call failed").pipe(
    Effect.annotateLogs({ toolkit, reason, ...(status === undefined ? {} : { status }) }),
  );

const mcp: KindDriver = {
  listsWithCredential: true,
  refreshed: () => true,
  keepsSessions: true,
  list: ({ toolkit, secret, timeout, policy }) =>
    listUpstreamTools(toolkit.source, secret, timeout).pipe(
      Effect.map((tools) => ({ tools })),
      Effect.mapError(mcpFailed),
      withOutboundGuard(policy),
    ),
  call: ({ toolkit, tool, secret, args, policy, session }) =>
    callUpstreamTool(toolkit.source, secret, session, {
      name: tool.upstreamName,
      arguments: args,
      inputSchema: tool.tool?.inputSchema,
    }).pipe(
      Effect.tapError((error) => logFailure(toolkit.id, error.reason, error.status)),
      Effect.mapError(mcpFailed),
      withOutboundGuard(policy),
    ),
};

/**
 * Why some of an OpenAPI toolkit's operations cannot be called: they name no server, or one the outbound guard refuses,
 * and the toolkit has no base URL in their place. Each distinct server is checked once.
 */
export const serverWarning = (
  toolkit: Pick<StoredToolkit, "baseUrl">,
  tools: ReadonlyArray<ToolOperation>,
  policy: OutboundPolicy,
): string | undefined => {
  if (toolkit.baseUrl !== undefined) return undefined;
  const reachable = new Map<string, boolean>();
  let unreachable = 0;

  for (const { operation } of tools) {
    if (operation === undefined) continue;
    const server = operation.server;

    if (server !== undefined && !reachable.has(server))
      reachable.set(server, Result.isSuccess(checkOutboundUrl(server, policy)));

    if (server === undefined || reachable.get(server) !== true) unreachable += 1;
  }

  if (unreachable === 0) return undefined;

  const operations = unreachable === 1 ? "1 operation names" : `${unreachable} operations name`;

  return `${operations} no server Commissary may reach: set the toolkit's base URL`;
};

/**
 * An OpenAPI toolkit's default name: the slug of its document's first server's host, else of its title, else of the
 * document's host.
 */
const openApiName = (list: OpenApiToolList, source: string): string => {
  if (list.server !== undefined) return defaultToolkitName(new URL(list.server));

  if (list.title !== undefined) return toolkitNameOf(list.title);

  return source === "" ? "toolkit" : defaultToolkitName(new URL(source));
};

const openapi: KindDriver = {
  listsWithCredential: false,
  // An uploaded document changes only when it is replaced.
  refreshed: (toolkit) => toolkit.source !== "",
  keepsSessions: false,
  list: ({ toolkit, document, timeout, policy }) =>
    Effect.gen(function* () {
      const source = toolkit.source;
      let text = document;

      if (text === undefined) {
        if (source === "") return yield* failed("the toolkit has no document");

        text = yield* fetchDocument(source, timeout).pipe(
          Effect.mapError((error) => failed(error.message)),
          withOutboundGuard(policy),
        );
      }

      const list = openApiToolList(text, source === "" ? undefined : source);

      if (Result.isFailure(list)) return yield* failed(list.failure);
      const warning = serverWarning(toolkit, list.success.tools, policy);

      return {
        tools: list.success.tools,
        name: openApiName(list.success, source),
        ...(warning === undefined ? {} : { warning }),
      };
    }),
  call: ({ toolkit, tool, secret, args, policy }) =>
    Effect.gen(function* () {
      const operation = tool.tool?.operation;

      if (operation === undefined) return yield* failed("the tool has no operation to call");
      const request = operationCall(operation, toolkit.baseUrl, args);

      if (Result.isFailure(request)) return yield* failed(request.failure);

      const { result, status } = yield* callHttp(request.success, secret, operation.security).pipe(
        Effect.tapError((error) => logFailure(toolkit.id, error.reason)),
        Effect.mapError((error) => failed(error.message)),
        withOutboundGuard(policy),
      );

      return status === 401 ? { result, unauthorized: true } : { result };
    }),
  warning: serverWarning,
};

/** The driver of each kind of stored toolkit. */
export const KIND_DRIVERS: Readonly<Record<StoredToolkit["kind"], KindDriver>> = { mcp, openapi };
