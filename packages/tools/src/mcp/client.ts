/**
 * The Tools area's MCP client for a remote MCP server's tool list and its tool calls (ADR 0036, #197): Streamable HTTP
 * only, legacy SSE upstreams are not reached. It speaks both eras of the protocol (docs/ARCHITECTURE.md "Tools"):
 *
 * - the 2025 handshake: `initialize`, then `notifications/initialized` and `tools/list` in the session the server may
 *   open (`Mcp-Session-Id`), with the negotiated `MCP-Protocol-Version` on every request, and the session deleted
 *   afterwards;
 * - when the server refuses `initialize` the way a server of that revision does (`400`, `405` or a JSON-RPC error),
 *   the stateless 2026-07-28 revision: one `tools/list` POST per page carrying its protocol version in `_meta` and the
 *   `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. Any other refusal (a `404`, a `401`) is reported as
 *   it is.
 *
 * A call ({@link callUpstreamTool}) goes on in the session an earlier call opened, which the caller keeps: the 2025
 * session or, for a stateless server, its revision, so a call skips the handshake that would fail; both are opened
 * again, once, when the server answers `400` or `404` in them.
 *
 * Every request goes through the `HttpClient` the caller provides, which is the outbound guard's (ADR 0044). The
 * client follows only same-origin 307/308 redirects itself, so a credential in a named header or the query never
 * reaches another origin. Answers are JSON or a request-scoped SSE stream, read up to {@link MAX_BODY_BYTES}; a body
 * the client does not read (a redirect, a refusal, the session's end) is cancelled. Error messages never quote the URL
 * (a query parameter may carry the key) nor the server's body.
 */
import { Buffer } from "node:buffer";
import { type Duration, Effect, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { OUTBOUND_REFUSED_MESSAGE, outboundRefusalOf } from "@commissary/core";
import type { ToolkitSecret } from "@commissary/contract/tools";
import { encodeHeaderValue } from "./header-value.ts";
import { isJsonObject } from "./json.ts";

/** The 2025 revision the handshake asks for; the server may answer an older one. */
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/** The stateless revision (no handshake, no session). */
const STATELESS_PROTOCOL_VERSION = "2026-07-28";

/** The most one answer may hold. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Pages of `tools/list` read at most. */
const MAX_PAGES = 50;

const MAX_REDIRECTS = 5;

/** How long one listing (every request of it) may take unless the caller says otherwise: an interactive build's. */
export const LISTING_TIMEOUT: Duration.Input = "60 seconds";

/** The statuses a server of the stateless revision refuses `initialize` with (an unsupported version, no such method). */
const STATELESS_REFUSALS: ReadonlySet<number> = new Set([400, 405]);

const CLIENT_INFO = { name: "commissary", version: "1.0.0" };

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  /**
   * - `unauthorized`: the server refused the credential (401, 403);
   * - `refused`: the outbound guard refused an address;
   * - `unreachable`: the request failed or timed out;
   * - `http`: another status;
   * - `protocol`: an answer that is not the JSON-RPC result asked for, or a JSON-RPC error;
   * - `too_large`: an answer above {@link MAX_BODY_BYTES}, or more than {@link MAX_PAGES} pages.
   */
  reason: Schema.Literals([
    "unauthorized",
    "refused",
    "unreachable",
    "http",
    "protocol",
    "too_large",
  ]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

/** One tool as the server lists it. */
const UpstreamToolSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(JsonObjectSchema),
  annotations: Schema.optionalKey(JsonObjectSchema),
});

export type UpstreamTool = typeof UpstreamToolSchema.Type;

const RequestId = Schema.Union([Schema.String, Schema.Finite, Schema.Null]);

/** What every JSON-RPC message has that finds the reply to a request. */
const Envelope = Schema.Struct({ id: Schema.optionalKey(RequestId) });

const RpcError = Schema.Struct({ code: Schema.Finite, message: Schema.String });

/** A JSON-RPC reply whose result is `result`. */
const replyOf = <S extends Schema.Top>(result: S) =>
  Schema.Struct({
    result: Schema.optionalKey(result),
    error: Schema.optionalKey(RpcError),
  });

const InitializeReply = replyOf(Schema.Struct({ protocolVersion: Schema.String }));

/** A page of `tools/list`; its tools are decoded one by one, so a malformed tool is left out, not the page. */
const ListReply = replyOf(
  Schema.Struct({
    tools: Schema.Array(Schema.Json),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

/** Only the error of a reply: an `initialize` refused with a JSON-RPC error means another revision. */
const ErrorReply = Schema.Struct({ error: Schema.optionalKey(RpcError) });

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

const decodeTool = Schema.decodeUnknownOption(UpstreamToolSchema);

const protocolError = (message: string) => new McpError({ reason: "protocol", message });

const tooLarge = new McpError({
  reason: "too_large",
  message: "the MCP server's answer is too large",
});

/** `request` signed in with `secret`. */
const authorize = (
  request: HttpClientRequest.HttpClientRequest,
  secret: ToolkitSecret,
): HttpClientRequest.HttpClientRequest => {
  switch (secret.kind) {
    case "none":
      return request;
    case "bearer":
      return HttpClientRequest.setHeader(request, "authorization", `Bearer ${secret.token}`);
    case "header":
      return HttpClientRequest.setHeader(request, secret.name, secret.value);
    case "query":
      return HttpClientRequest.appendUrlParam(request, secret.name, secret.value);
    case "basic":
      return HttpClientRequest.setHeader(
        request,
        "authorization",
        `Basic ${Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64")}`,
      );
  }
};

/** Where the conversation with the server stands: the negotiated revision and the session, once known. */
interface Session {
  readonly protocolVersion?: string;
  readonly sessionId?: string;
}

/** One JSON-RPC message to send: a request when it has an `id`, else a notification. */
interface RpcMessage {
  readonly method: string;
  readonly id?: number;
  readonly params?: Schema.JsonObject;
}

const transportError = (error: HttpClientError.HttpClientError): McpError =>
  outboundRefusalOf(error) === undefined
    ? new McpError({ reason: "unreachable", message: "the MCP server could not be reached" })
    : new McpError({ reason: "refused", message: OUTBOUND_REFUSED_MESSAGE });

/** The answer's bytes, failing above {@link MAX_BODY_BYTES}. */
const boundedStream = (response: HttpClientResponse.HttpClientResponse) => {
  let read = 0;

  return response.stream.pipe(
    Stream.mapError(transportError),
    Stream.tap((chunk) => {
      read += chunk.byteLength;

      return read > MAX_BODY_BYTES ? Effect.fail(tooLarge) : Effect.void;
    }),
  );
};

/**
 * Lets go of a body the client does not read: opening the stream in a scope and closing the scope cancels its reader,
 * so the connection is let go (as the outbound guard does for a hop it does not follow).
 */
const releaseBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.scoped(Effect.asVoid(Stream.toPull(response.stream))).pipe(Effect.ignore);

/** Whether `message` is the reply to the request `id`. */
const repliesTo = (message: Schema.Json, id: number): boolean =>
  Option.exists(decodeEnvelope(message), (envelope) => envelope.id === id);

/** The reply to the request `id` in a JSON answer: one message or a batch. */
const jsonReply = (response: HttpClientResponse.HttpClientResponse, id: number) =>
  boundedStream(response).pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.map((text): Schema.Json | undefined => {
      const parsed = Option.getOrUndefined(parseJson(text));
      const messages = Array.isArray(parsed) ? parsed : [parsed ?? null];

      return messages.find((message) => repliesTo(message, id));
    }),
  );

/**
 * The reply to the request `id` in an SSE answer: events are read until one carries it, so a server that keeps the
 * stream open afterwards does not hold the build.
 */
const sseReply = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  id: number,
): Effect.fn.Return<Schema.Json | undefined, McpError> {
  let data: Array<string> = [];
  let found: Schema.Json | undefined;

  const dispatch = () => {
    if (data.length === 0) return;
    const message = Option.getOrUndefined(parseJson(data.join("\n")));

    data = [];

    if (message !== undefined && repliesTo(message, id)) found = message;
  };

  yield* boundedStream(response).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.takeUntil((line) => {
      if (line === "") dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));

      return found !== undefined;
    }),
    Stream.runDrain,
  );
  dispatch();

  return found;
});

/** What one POST answered. */
interface Answer {
  readonly sessionId: string | undefined;
  /** The JSON-RPC reply to the request, if it was a request and the server answered it. */
  readonly reply: Schema.Json | undefined;
}

const sameOriginTarget = (from: string, location: string): string | undefined => {
  try {
    const target = new URL(location, from);

    return target.origin === new URL(from).origin ? target.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** Requests of the client: no redirect followed by `fetch` (the client follows same-origin ones itself). */
const MANUAL_REDIRECTS: globalThis.RequestInit = { redirect: "manual" };

/** One JSON-RPC message POSTed to `source`, signed in with `secret`. */
const post = Effect.fnUntraced(function* (
  source: string,
  secret: ToolkitSecret,
  session: Session,
  message: RpcMessage,
  extraHeaders: Readonly<Record<string, string>> = {},
): Effect.fn.Return<Answer, McpError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;

  const headers = {
    accept: "application/json, text/event-stream",
    ...extraHeaders,
    ...(session.protocolVersion === undefined
      ? {}
      : { "mcp-protocol-version": session.protocolVersion }),
    ...(session.sessionId === undefined ? {} : { "mcp-session-id": session.sessionId }),
  };

  const body = { jsonrpc: "2.0", ...message };
  let url = source;

  for (let hop = 0; ; hop += 1) {
    const request = authorize(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      secret,
    );

    const response = yield* client
      .execute(request)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECTS),
        Effect.mapError(transportError),
      );

    const status = response.status;
    const location = response.headers["location"];

    const next =
      (status === 307 || status === 308) && location !== undefined && hop < MAX_REDIRECTS
        ? sameOriginTarget(url, location)
        : undefined;

    if (next !== undefined) {
      yield* releaseBody(response);
      url = next;
      continue;
    }

    if (status < 200 || status >= 300) yield* releaseBody(response);

    if (status === 401 || status === 403)
      return yield* new McpError({
        reason: "unauthorized",
        message: `the MCP server refused the credential (HTTP ${status})`,
        status,
      });

    if (status < 200 || status >= 300)
      return yield* new McpError({
        reason: "http",
        message: `the MCP server answered HTTP ${status}`,
        status,
      });

    const sessionId = response.headers["mcp-session-id"];

    if (message.id === undefined || status === 202 || status === 204) {
      yield* releaseBody(response);

      return { sessionId, reply: undefined };
    }

    const reply = (response.headers["content-type"] ?? "").includes("text/event-stream")
      ? yield* sseReply(response, message.id)
      : yield* jsonReply(response, message.id);

    return { sessionId, reply };
  }
});

/** The result of the reply to `method`, decoded by `decode`, or why there is none. */
const resultOf = <A>(
  decode: (
    reply: Schema.Json | undefined,
  ) => Option.Option<{ readonly result?: A; readonly error?: { readonly code: number } }>,
  reply: Schema.Json | undefined,
  method: string,
): Effect.Effect<A, McpError> =>
  Option.match(decode(reply), {
    onNone: () => Effect.fail(protocolError(`the MCP server did not answer ${method}`)),
    onSome: (decoded) => {
      if (decoded.error !== undefined)
        return Effect.fail(
          protocolError(`the MCP server refused ${method} (JSON-RPC error ${decoded.error.code})`),
        );

      return decoded.result === undefined
        ? Effect.fail(protocolError(`the MCP server did not answer ${method}`))
        : Effect.succeed(decoded.result);
    },
  });

const decodeInitialize = Schema.decodeUnknownOption(InitializeReply);

const decodeList = Schema.decodeUnknownOption(ListReply);

const decodeError = Schema.decodeUnknownOption(ErrorReply);

/** The tools of one page; a tool without a name or with a malformed schema is left out. */
const toolsOf = (tools: ReadonlyArray<Schema.Json>): ReadonlyArray<UpstreamTool> =>
  tools.flatMap((tool) => Option.toArray(decodeTool(tool)));

/** Every page of `tools/list`, each POSTed by `page` with the cursor and the request id. */
const allPages = Effect.fnUntraced(function* (
  page: (
    cursor: string | undefined,
    id: number,
  ) => Effect.Effect<Answer, McpError, HttpClient.HttpClient>,
): Effect.fn.Return<ReadonlyArray<UpstreamTool>, McpError, HttpClient.HttpClient> {
  const tools: Array<UpstreamTool> = [];
  let cursor: string | undefined;

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const answer = yield* page(cursor, index + 2);
    const result = yield* resultOf(decodeList, answer.reply, "tools/list");

    tools.push(...toolsOf(result.tools));
    const next = result.nextCursor ?? "";

    if (next === "") return tools;
    cursor = next;
  }

  return yield* tooLarge;
});

/** Deletes the server's session (`DELETE` with `Mcp-Session-Id`). */
const endSession = Effect.fnUntraced(function* (
  source: string,
  secret: ToolkitSecret,
  session: Session,
) {
  const client = yield* HttpClient.HttpClient;

  const request = authorize(
    HttpClientRequest.delete(source).pipe(
      HttpClientRequest.setHeaders({
        "mcp-session-id": session.sessionId ?? "",
        ...(session.protocolVersion === undefined
          ? {}
          : { "mcp-protocol-version": session.protocolVersion }),
      }),
    ),
    secret,
  );

  const response = yield* client
    .execute(request)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECTS));

  yield* releaseBody(response);
});

/**
 * Whether the server refused `initialize` the way a server of the stateless revision does ({@link STATELESS_REFUSALS};
 * a JSON-RPC error is read from the reply).
 */
const isRefusedHandshake = (error: McpError): boolean =>
  error.reason === "http" && error.status !== undefined && STATELESS_REFUSALS.has(error.status);

/** Opens the 2025 handshake (`initialize`, `notifications/initialized`); `undefined` when the server refuses it. */
const openLegacy = Effect.fnUntraced(function* (
  source: string,
  secret: ToolkitSecret,
): Effect.fn.Return<UpstreamSession | undefined, McpError, HttpClient.HttpClient> {
  const opened = yield* post(
    source,
    secret,
    {},
    {
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
  ).pipe(
    Effect.asSome,
    Effect.catchIf(isRefusedHandshake, () => Effect.succeed(Option.none<Answer>())),
  );

  if (Option.isNone(opened)) return undefined;
  const answer = opened.value;

  if (Option.exists(decodeError(answer.reply), (reply) => reply.error !== undefined))
    return undefined;

  const initialized = yield* resultOf(decodeInitialize, answer.reply, "initialize");

  const session: UpstreamSession = {
    protocolVersion: initialized.protocolVersion,
    ...(answer.sessionId === undefined ? {} : { sessionId: answer.sessionId }),
  };

  yield* post(source, secret, session, { method: "notifications/initialized" });

  return session;
});

/** The tool list over the 2025 handshake; `undefined` when the server refuses `initialize`. */
const legacyList = Effect.fnUntraced(function* (
  source: string,
  secret: ToolkitSecret,
): Effect.fn.Return<ReadonlyArray<UpstreamTool> | undefined, McpError, HttpClient.HttpClient> {
  const session = yield* openLegacy(source, secret);

  if (session === undefined) return undefined;

  const tools = yield* allPages((cursor, id) =>
    post(source, secret, session, {
      method: "tools/list",
      id,
      ...(cursor === undefined ? {} : { params: { cursor } }),
    }),
  );

  // The session is the server's to keep otherwise; ending it is a courtesy, and its failure changes nothing.
  if (session.sessionId !== undefined)
    yield* endSession(source, secret, session).pipe(Effect.ignore);

  return tools;
});

/** The `_meta` every request of the stateless revision carries: its revision, and no client capabilities. */
const STATELESS_META = {
  "io.modelcontextprotocol/protocolVersion": STATELESS_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** The tool list over the stateless revision. */
const statelessList = (source: string, secret: ToolkitSecret) =>
  allPages((cursor, id) =>
    post(
      source,
      secret,
      { protocolVersion: STATELESS_PROTOCOL_VERSION },
      {
        method: "tools/list",
        id,
        params: {
          ...(cursor === undefined ? {} : { cursor }),
          _meta: STATELESS_META,
        },
      },
      { "mcp-method": "tools/list", "mcp-name": "" },
    ),
  );

/**
 * The tools the MCP server at `source` lists for `secret`, every page of them, within `timeout` (default
 * {@link LISTING_TIMEOUT}).
 */
export const listUpstreamTools = (
  source: string,
  secret: ToolkitSecret,
  timeout: Duration.Input = LISTING_TIMEOUT,
): Effect.Effect<ReadonlyArray<UpstreamTool>, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const legacy = yield* legacyList(source, secret);

    return legacy ?? (yield* statelessList(source, secret));
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new McpError({ reason: "unreachable", message: "the MCP server did not answer in time" }),
        ),
    }),
  );

// --- tool calls ------------------------------------------------------------------------------------------------------

/** How long one call of an upstream tool (every request of it) may take: as long as Claude's clients wait for one. */
export const TOOL_CALL_TIMEOUT: Duration.Input = "240 seconds";

/**
 * What the part keeps of an upstream between calls (ADR 0038, at most seven days): the revision it speaks and, for a
 * 2025 server that opened one, its session. A stateless server's is its revision only, so a call skips the handshake.
 */
export interface UpstreamSession {
  readonly protocolVersion: string;
  readonly sessionId?: string;
}

/** One call of an upstream tool, by its upstream name. */
export interface UpstreamCall {
  readonly name: string;
  readonly arguments?: Schema.JsonObject | undefined;
  /** The tool's input schema, whose `x-mcp-header` properties a stateless call mirrors into headers. */
  readonly inputSchema?: Schema.JsonObject | undefined;
}

const CallReply = replyOf(Schema.JsonObject);

const decodeCall = Schema.decodeUnknownOption(CallReply);

/** An HTTP token (RFC 9110), what an `x-mcp-header` name must be. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The `Mcp-Param-*` headers of a stateless call: each property of the input schema marked `x-mcp-header`, reached
 * through `properties` only, whose argument is a string, a number or a boolean.
 */
const paramHeaders = (
  schema: Schema.JsonObject | undefined,
  args: Schema.JsonObject | undefined,
) => {
  const headers = new Map<string, string>();

  const visit = (node: Schema.Json | undefined, value: Schema.Json | undefined) => {
    const properties = isJsonObject(node) ? node["properties"] : undefined;

    if (!isJsonObject(properties)) return;

    for (const [key, property] of Object.entries(properties)) {
      if (!isJsonObject(property)) continue;
      const argument = isJsonObject(value) ? value[key] : undefined;
      const header = property["x-mcp-header"];

      if (
        typeof header === "string" &&
        TOKEN.test(header) &&
        (typeof argument === "string" ||
          typeof argument === "number" ||
          typeof argument === "boolean")
      )
        headers.set(`mcp-param-${header.toLowerCase()}`, encodeHeaderValue(String(argument)));

      visit(property, argument);
    }
  };

  visit(schema, args);

  return Object.fromEntries(headers);
};

/** One `tools/call` in `session`: the result as the server answered it. */
const callIn = Effect.fnUntraced(function* (
  source: string,
  secret: ToolkitSecret,
  session: UpstreamSession,
  call: UpstreamCall,
): Effect.fn.Return<Schema.JsonObject, McpError, HttpClient.HttpClient> {
  const stateless = session.protocolVersion === STATELESS_PROTOCOL_VERSION;

  const answer = yield* post(
    source,
    secret,
    session,
    {
      method: "tools/call",
      id: 1,
      params: {
        name: call.name,
        ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
        ...(stateless ? { _meta: STATELESS_META } : {}),
      },
    },
    stateless
      ? {
          "mcp-method": "tools/call",
          "mcp-name": encodeHeaderValue(call.name),
          ...paramHeaders(call.inputSchema, call.arguments),
        }
      : {},
  );

  const result = yield* resultOf(decodeCall, answer.reply, "tools/call");

  // Commissary asked for no input capability; a server that asks anyway is not passed on (#201 relays approvals).
  if (result["resultType"] === "input_required")
    return yield* protocolError("the MCP server asked for input Commissary does not pass on");

  return result;
});

/**
 * Calls the upstream tool `call.name` at `source` with `secret`, within `timeout` (default {@link TOOL_CALL_TIMEOUT}):
 * in `known`, the session kept from an earlier call, or else in a new one (the 2025 handshake, or the stateless
 * revision when the server refuses it), which the answer names for the part to keep. A server that refuses the call in
 * a kept session with `400` or `404` lost it (a 2025 session it ended, or a server that changed eras since): it gets a
 * new handshake and the call once again. The result is the server's, an `isError` one included; a failure is an
 * {@link McpError}, whose message quotes neither the URL nor the server's body.
 */
export const callUpstreamTool = (
  source: string,
  secret: ToolkitSecret,
  known: UpstreamSession | undefined,
  call: UpstreamCall,
  timeout: Duration.Input = TOOL_CALL_TIMEOUT,
): Effect.Effect<
  { readonly result: Schema.JsonObject; readonly session: UpstreamSession },
  McpError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (known !== undefined) {
      // Only an HTTP-level `400` or `404` is retried: the transport refuses the request so before it dispatches the
      // call (an unknown session, a revision it does not speak), so the tool never ran and a tool that is not
      // idempotent cannot run twice. A JSON-RPC error, a tool's `isError` result or any other failure is not retried.
      const lost = (error: McpError) =>
        error.reason === "http" && (error.status === 400 || error.status === 404);

      const reused = yield* callIn(source, secret, known, call).pipe(
        Effect.asSome,
        Effect.catchIf(lost, () => Effect.succeedNone),
      );

      if (Option.isSome(reused)) return { result: reused.value, session: known };
    }

    const session: UpstreamSession = (yield* openLegacy(source, secret)) ?? {
      protocolVersion: STATELESS_PROTOCOL_VERSION,
    };

    return { result: yield* callIn(source, secret, session, call), session };
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new McpError({ reason: "unreachable", message: "the MCP server did not answer in time" }),
        ),
    }),
  );
