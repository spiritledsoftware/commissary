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
 * - **GraphQL** (#204): the schema comes from introspection of the endpoint with a credential, or from an uploaded SDL
 *   file without one (the cron rebuilds only an introspected list); a call is one `POST` to the endpoint, and checks a
 *   caller's selection against the schema the list was built from ({@link Listing.schema}). Introspection asks for
 *   `@oneOf` input objects, and again without when the endpoint refuses that ({@link introspect}).
 * - **Discovery** (#205): a Google Discovery document, read as an OpenAPI one is ({@link documentText}); its methods
 *   become OpenAPI operations (`discovery/tools.ts`), called as OpenAPI tools are. A `rootUrl` the outbound guard
 *   refuses fails the build, and a save with it is refused ({@link KindFailure.field}).
 */
import type { GraphQLSchema } from "graphql";
import { type Duration, Effect, Result, Schema } from "effect";
import { checkOutboundUrl, OUTBOUND_REFUSED_MESSAGE, type OutboundPolicy } from "@commissary/core";
import { discoveryToolList } from "../discovery/tools.ts";
import { graphQLAnswer, graphQLCall } from "../graphql/request.ts";
import {
  graphQLToolList,
  INTROSPECTION_QUERY,
  LEGACY_INTROSPECTION_QUERY,
  NO_INTROSPECTION,
} from "../graphql/schema.ts";
import {
  callHttp,
  fetchDocument,
  type HttpCallError,
  requestDocument,
  withOutboundGuard,
} from "../http/call.ts";
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
  /**
   * The field of the source whose URL the outbound guard refused (a Discovery document's `rootUrl`, #205): a save of
   * the source is refused with the guard's message and this path, as a URL typed in is.
   */
  field: Schema.optionalKey(Schema.String),
}) {}

/** What a build of a toolkit's list reads. */
export interface ListInput {
  readonly toolkit: Pick<StoredToolkit, "source" | "baseUrl">;
  /** The credential a build lists with, for a kind that needs one ({@link KindDriver.listsWithCredential}). */
  readonly secret: UpstreamSecret;
  /** The toolkit's uploaded document: an OpenAPI document, a GraphQL schema's SDL. */
  readonly document: string | undefined;
  readonly timeout: Duration.Input;
  readonly policy: OutboundPolicy;
}

/** What a driver reads of a toolkit to tell how its list is built: whether it is built from an uploaded document. */
export type ListSource = Pick<StoredToolkit, "uploaded">;

/** A built tool list. */
export interface Listing {
  readonly tools: ReadonlyArray<ListedTool>;
  /** A new toolkit's default name, from what the list was built from (an OpenAPI document's first server or title). */
  readonly name?: string;
  /** What keeps some of its tools from being called as they are, kept as the list's error. */
  readonly warning?: string;
  /** The schema the list was built from, as SDL, kept for calls (a GraphQL toolkit's). */
  readonly schema?: string;
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
  /** The schema kept with the list ({@link Listing.schema}), built, for a call that needs it. */
  readonly schema: () => Result.Result<GraphQLSchema, string>;
}

/** A call's tool result, and the session it ran in for a kind that keeps them. */
export interface Called {
  readonly result: Schema.JsonObject;
  readonly session?: UpstreamSession;
  /** The upstream answered `401` (the result says so), which a refreshed token may pass (#202). */
  readonly unauthorized?: boolean;
}

export interface KindDriver {
  /**
   * Whether a build lists `toolkit`'s tools with a credential (an MCP server's, a GraphQL endpoint's introspection),
   * else it reads its source without one.
   */
  readonly listsWithCredential: (toolkit: ListSource) => boolean;
  /** Whether the cron task rebuilds `toolkit`'s list (given a credential, for a kind that lists with one). */
  readonly refreshed: (toolkit: ListSource) => boolean;
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
  listsWithCredential: () => true,
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

/**
 * The text of the document a toolkit is built from without a credential (an OpenAPI or Discovery document): the
 * uploaded one, else the one its source serves, fetched through the outbound guard.
 */
const documentText = ({
  toolkit,
  document,
  timeout,
  policy,
}: Pick<ListInput, "toolkit" | "document" | "timeout" | "policy">): Effect.Effect<
  string,
  KindFailure
> => {
  if (document !== undefined) return Effect.succeed(document);

  if (toolkit.source === "") return Effect.fail(failed("the toolkit has no document"));

  return fetchDocument(toolkit.source, timeout).pipe(
    Effect.mapError((error) => failed(error.message)),
    withOutboundGuard(policy),
  );
};

const openapi: KindDriver = {
  listsWithCredential: () => false,
  // An uploaded document changes only when it is replaced.
  refreshed: ({ uploaded }) => !uploaded,
  keepsSessions: false,
  list: (input) =>
    Effect.gen(function* () {
      const { toolkit, policy } = input;
      const source = toolkit.source;
      const text = yield* documentText(input);
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

/**
 * A GraphQL endpoint's failure to answer introspection as a driver's: a `401` says it refused the credential's token
 * itself; another `4xx` (but `429`), that it may not allow introspection, as Apollo Server and Hasura answer then.
 */
const introspectionFailed = (error: HttpCallError) => {
  if (error.status === 401) return new KindFailure({ message: error.message, unauthorized: true });

  return error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
    ? failed(`${NO_INTROSPECTION} (HTTP ${error.status})`)
    : failed(error.message);
};

const GRAPHQL_ACCEPT = "application/graphql-response+json, application/json;q=0.9";

/** The endpoint's answer to the introspection query `query`, with the credential. */
const introspection = (
  input: ListInput,
  query: string,
): Effect.Effect<Result.Result<string, HttpCallError>> =>
  requestDocument(
    {
      method: "POST",
      url: input.toolkit.source,
      headers: { accept: GRAPHQL_ACCEPT },
      body: { kind: "text", contentType: "application/json", text: JSON.stringify({ query }) },
    },
    input.secret,
    input.timeout,
    "the GraphQL endpoint",
  ).pipe(withOutboundGuard(input.policy), Effect.result);

/**
 * The tool list of the endpoint's answer to {@link INTROSPECTION_QUERY}, or, when the endpoint answers it with an error
 * (`4xx` but `401` and `429`, or an answer without a schema: one older than `@oneOf` does not know `isOneOf`), of its
 * answer to {@link LEGACY_INTROSPECTION_QUERY}.
 */
const introspect = (input: ListInput) =>
  Effect.gen(function* () {
    const first = yield* introspection(input, INTROSPECTION_QUERY);

    if (Result.isSuccess(first)) {
      const list = graphQLToolList({ introspection: first.success });

      if (Result.isSuccess(list) || list.failure !== NO_INTROSPECTION) return list;
    } else {
      const status = first.failure.status;

      if (status === undefined || status < 400 || status >= 500 || status === 401 || status === 429)
        return yield* introspectionFailed(first.failure);
    }

    const second = yield* introspection(input, LEGACY_INTROSPECTION_QUERY);

    if (Result.isFailure(second)) return yield* introspectionFailed(second.failure);

    return graphQLToolList({ introspection: second.success });
  });

const graphql: KindDriver = {
  // An uploaded schema is read without a credential, and changes only when it is replaced.
  listsWithCredential: ({ uploaded }) => !uploaded,
  refreshed: ({ uploaded }) => !uploaded,
  keepsSessions: false,
  list: (input) =>
    Effect.gen(function* () {
      const list =
        input.document === undefined
          ? yield* introspect(input)
          : graphQLToolList({ sdl: input.document });

      if (Result.isFailure(list)) return yield* failed(list.failure);

      return { tools: list.success.tools, schema: list.success.schema };
    }),
  call: ({ toolkit, tool, secret, args, policy, schema }) =>
    Effect.gen(function* () {
      const operation = tool.tool?.graphql;

      if (operation === undefined) return yield* failed("the tool has no field to call");
      const request = graphQLCall(operation, toolkit.source, args, schema);

      if (Result.isFailure(request)) return yield* failed(request.failure);

      const { result, status } = yield* callHttp(request.success, secret, undefined, {
        reading: graphQLAnswer,
      }).pipe(
        Effect.tapError((error) => logFailure(toolkit.id, error.reason)),
        Effect.mapError((error) => failed(error.message)),
        withOutboundGuard(policy),
      );

      return status === 401 ? { result, unauthorized: true } : { result };
    }),
};

/** A Discovery toolkit's default name: its API's name (`gmail`), else its rootUrl's host's. */
const discoveryName = (name: string | undefined, rootUrl: string): string =>
  name === undefined ? defaultToolkitName(new URL(rootUrl)) : toolkitNameOf(name);

const discovery: KindDriver = {
  listsWithCredential: () => false,
  // An uploaded document changes only when it is replaced.
  refreshed: ({ uploaded }) => !uploaded,
  keepsSessions: false,
  list: (input) =>
    Effect.gen(function* () {
      const list = discoveryToolList(yield* documentText(input));

      if (Result.isFailure(list)) return yield* failed(list.failure);
      const rootUrl = list.success.rootUrl;

      if (Result.isFailure(checkOutboundUrl(rootUrl, input.policy)))
        return yield* new KindFailure({ message: OUTBOUND_REFUSED_MESSAGE, field: "rootUrl" });

      return { tools: list.success.tools, name: discoveryName(list.success.name, rootUrl) };
    }),
  // A Discovery tool's operation is an OpenAPI one, and a Discovery toolkit has no base URL.
  call: (input) => openapi.call(input),
};

/** The driver of each kind of stored toolkit. */
export const KIND_DRIVERS: Readonly<Record<StoredToolkit["kind"], KindDriver>> = {
  mcp,
  openapi,
  graphql,
  discovery,
};
