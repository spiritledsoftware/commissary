/**
 * Commissary's MCP endpoint (#197, ADR 0036, ADR 0037, ADR 0038, ADR 0045): Streamable HTTP, both protocol eras
 * (`protocol.ts`), mounted at a path the Worker chooses ({@link mcpRoutesAt}). The API Worker mounts it at `/mcp` on
 * the API host, behind its client gate, so a request comes with the member of its API key (`AccessPrincipal`) and their
 * org (`CurrentOrg`), and counts against the org's request-rate ceiling on Commissary Cloud. A self-hosted Commissary's
 * app Worker also mounts it on the app host, at `/mcp` (the org `global`) and `/o/<slug>/mcp`, behind its Access gate,
 * so a request comes with the person (or service token) Access signed in and the org its address names (#251). The
 * member's tools and the calls are the org's ControlPlane's (`ToolsPart.clientTools`, `ToolsPart.callTool`), where the
 * credentials are; `?toolkits=a,b` narrows both to those toolkits, by the names the member sees.
 *
 * `GET` and `DELETE` answer `405`, as the 2026-07-28 revision's backward compatibility asks of a server that opens no
 * stream and keeps no session (and as the 2025 revisions allow).
 */
import { Clock, Effect, Layer, type Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AccessPrincipal, currentViewer, viewerOf } from "@commissary/auth";
import { boundedBodyText, CurrentOrg, CurrentOutboundPolicy, MCP_PATH } from "@commissary/core";
import { panelPageUrl } from "@commissary/state";
import { type Refusal, spendRefusalMessage } from "@commissary/state/spend";
import type { ClientTool, ToolCallOutcome } from "../control-plane-part.ts";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import { writeToolCallRecord } from "../usage/record.ts";
import {
  acceptedUnder,
  type Answer,
  discoverResult,
  elicitsUrls,
  type Era,
  eraOf,
  errorAnswer,
  framed,
  incoming,
  initializeResult,
  methodNotFound,
  RpcCode,
  type RpcRequest,
  resultAnswer,
} from "./protocol.ts";
import { isJsonObject } from "./json.ts";

/** The most one POST may carry: a tool call's arguments. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const JSON_CONTENT_TYPE = "application/json";

const respond = (answer: Answer): HttpServerResponse.HttpServerResponse =>
  answer.body === undefined
    ? HttpServerResponse.empty({ status: answer.status })
    : HttpServerResponse.text(JSON.stringify(answer.body), {
        status: answer.status,
        contentType: JSON_CONTENT_TYPE,
      });

/** The toolkits `?toolkits=a,b` names (lowercased), or undefined when it names none: every toolkit. */
const narrowedTo = (requestUrl: string): ReadonlySet<string> | undefined => {
  let names: ReadonlyArray<string>;

  try {
    names = (new URL(requestUrl, "http://invalid.invalid").searchParams.get("toolkits") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== "");
  } catch {
    return undefined;
  }

  return names.length === 0 ? undefined : new Set(names);
};

/** Read tools say so, for clients that skip their approval prompt for them (ADR 0038); write tools say nothing. */
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false };

const listed = (tool: ClientTool): Schema.JsonObject => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema ?? { type: "object" },
  ...(tool.toolClass === "read" ? { annotations: READ_ANNOTATIONS } : {}),
});

/** What one request needs beyond its message: its era and the toolkits it narrows to. */
interface Served {
  readonly era: Era;
  readonly toolkits: ReadonlySet<string> | undefined;
}

/** `tools/list`: every tool in one page; the list is the member's, so only their caches may keep it. */
const listTools = Effect.fnUntraced(function* (context: Served) {
  const viewer = yield* currentViewer;

  const tools = yield* toolsControlPlane("clientTools", (stub) => stub.tools().clientTools(viewer));

  return {
    tools: tools
      .filter((tool) => context.toolkits === undefined || context.toolkits.has(tool.toolkit))
      .map(listed),
    ...(context.era.modern ? { ttlMs: 0, cacheScope: "private" } : {}),
  };
});

/** Where to connect a credential when the panel's URL is not known (`panelPageUrl`). */
const CONNECT_PAGE = "the toolkit's page in the panel";

/**
 * Where a member connects their private credential for a toolkit: the panel's page `tools/<toolkit id>/connect` of the
 * org (#208 builds it) on the app host, or {@link CONNECT_PAGE} when the app host or the org's slug is not known.
 */
const connectLink = Effect.fnUntraced(function* (toolkitId: string) {
  const env = yield* ToolsEnv;
  const org = yield* CurrentOrg;

  return yield* panelPageUrl(
    env,
    org,
    `tools/${encodeURIComponent(toolkitId)}/connect`,
    CONNECT_PAGE,
  );
});

/** A tool result that reports a failure to the model. */
const toolError = (text: string): Schema.JsonObject => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Whether the client's retry says the member declined (or dismissed) the elicitation `key`. */
const declined = (params: Schema.JsonObject, key: string): boolean => {
  const responses = params["inputResponses"];
  const response = isJsonObject(responses) ? responses[key] : undefined;

  return isJsonObject(response) && response["action"] !== "accept";
};

/** A priced call a Spend limit without room refused (#199): the limit and when it starts over, as for a model. */
const refusedText = (name: string, refusal: Refusal): string =>
  `${spendRefusalMessage(refusal)}. ${name} was not called.`;

/** What a call came to, as its usage record says it (#199). */
const recordedOutcome = (outcome: Exclude<ToolCallOutcome, { outcome: "unknown" }>) => {
  switch (outcome.outcome) {
    case "connect":
      return "needs_credential";
    case "refused":
      return "refused";
    case "failed":
      return "upstream_failure";
    case "result":
      return outcome.result["isError"] === true ? "tool_error" : "success";
  }
};

/** The bytes of `value` as JSON (UTF-8), 0 for nothing: all a usage record keeps of a call's arguments and result. */
const jsonBytes = (value: Schema.JsonObject | undefined): number =>
  value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * The tool result a call that reached a tool answers: the upstream's result, a short tool error (an upstream failure, a
 * Spend limit without room), or, for a tool that needs the member's private credential, the link to connect it. A
 * stateless client that declares URL-mode elicitation is asked to open it (an `InputRequiredResult`, MRTR) until it
 * declines; any other client gets the link as a tool error, a 2025 client too, as its elicitation would need the
 * request's SSE stream (docs/ARCHITECTURE.md, "Tools"), and so does every client when there is no URL to open.
 */
const toolResult = Effect.fnUntraced(function* (
  outcome: Exclude<ToolCallOutcome, { outcome: "unknown" }>,
  name: string,
  request: RpcRequest,
  context: Served,
) {
  if (outcome.outcome === "result") return outcome.result;

  if (outcome.outcome === "failed") return toolError(outcome.message);

  if (outcome.outcome === "refused") return toolError(refusedText(name, outcome.refusal));

  const link = yield* connectLink(outcome.toolkit.id);
  const key = `connect_${outcome.toolkit.name}`;

  if (link !== CONNECT_PAGE && elicitsUrls(context.era) && !declined(request.params, key))
    return {
      resultType: "input_required",
      inputRequests: {
        [key]: {
          method: "elicitation/create",
          params: {
            mode: "url",
            url: link,
            message: `Connect your own credential for the toolkit ${outcome.toolkit.name} to use ${name}.`,
          },
        },
      },
    };

  return toolError(
    `${name} needs your own credential for the toolkit ${outcome.toolkit.name}, which you have not ` +
      `connected. Connect it at ${link}, then call the tool again.`,
  );
});

/**
 * `tools/call`: the call in the org's ControlPlane, answered with its tool result ({@link toolResult}); a tool the
 * member does not reach is an unknown tool. A call that reached a tool leaves a usage record (#199), written off the
 * response path: who called, the toolkit and the tool, the outcome, the latency, the sizes of the arguments and of the
 * result, and the cost; never their content. A call of an unknown tool leaves none: it names no toolkit or tool, only
 * what the client typed.
 */
const callTool = Effect.fnUntraced(function* (request: RpcRequest, context: Served) {
  const name = request.params["name"];
  const args = request.params["arguments"];

  if (typeof name !== "string" || (args !== undefined && !isJsonObject(args)))
    return errorAnswer(200, request.id, RpcCode.invalidParams, "Invalid params");

  const identity = yield* AccessPrincipal;
  const viewer = viewerOf(identity);
  const policy = yield* CurrentOutboundPolicy;
  const org = yield* CurrentOrg;
  const requestedAt = yield* Clock.currentTimeMillis;

  const call = {
    name,
    arguments: args,
    toolkits: context.toolkits === undefined ? undefined : [...context.toolkits],
    apiKeyId: identity.principal.kind === "key" ? identity.principal.keyId : undefined,
  };

  const outcome = yield* toolsControlPlane("callTool", (stub) =>
    stub.tools().callTool(viewer, call, policy),
  );

  if (outcome.outcome === "unknown")
    return errorAnswer(200, request.id, RpcCode.invalidParams, `Unknown tool: ${name}`);

  const value = yield* toolResult(outcome, name, request, context);
  const answeredAt = yield* Clock.currentTimeMillis;
  const { usage } = outcome;

  yield* writeToolCallRecord({
    requestId: crypto.randomUUID(),
    orgId: org,
    principalId: identity.principalId,
    memberId: identity.memberId,
    toolkitId: usage.toolkitId,
    toolId: usage.toolId,
    credential: usage.credential,
    private: usage.private,
    outcome: recordedOutcome(outcome),
    requestedAt,
    latencyMs: Math.max(0, answeredAt - requestedAt),
    requestBytes: jsonBytes(args),
    responseBytes: jsonBytes(value),
    costMicros: usage.costMicros,
  });

  return resultAnswer(request.id, framed(context.era, value));
});

/** The answer to one request. */
const answer = (
  request: RpcRequest,
  context: Served,
): Effect.Effect<Answer, never, AccessPrincipal | ToolsEnv | CurrentOrg> => {
  const result = (value: Schema.JsonObject) => resultAnswer(request.id, framed(context.era, value));

  switch (request.method) {
    case "initialize":
      return Effect.succeed(resultAnswer(request.id, initializeResult(request.params)));
    case "server/discover":
      return Effect.succeed(result(discoverResult()));
    case "ping":
      return Effect.succeed(result({}));
    case "tools/list":
      return listTools(context).pipe(
        Effect.map(result),
        Effect.catchTag("Reply", () => Effect.succeed(unavailable(request.id))),
      );
    case "tools/call":
      return callTool(request, context).pipe(
        Effect.catchTag("Reply", () => Effect.succeed(unavailable(request.id))),
      );
    default:
      return Effect.succeed(methodNotFound(context.era, request.id, request.method));
  }
};

/** The org's ControlPlane could not be reached (`toolsControlPlane` logged why). */
const unavailable = (id: RpcRequest["id"]): Answer =>
  errorAnswer(500, id, RpcCode.internalError, "Commissary could not reach the org's tools");

/** One POST: a body of at most {@link MAX_BODY_BYTES}, its message, its era, and the answer. */
const serve = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const message = incoming(yield* boundedBodyText(MAX_BODY_BYTES));

  if (message.kind === "answered") return respond(message.answer);

  if (message.kind === "accepted") return respond(acceptedUnder(request.headers));
  const era = eraOf(message.request, request.headers);

  if ("refused" in era) return respond(era.refused);

  return respond(
    yield* answer(message.request, {
      era: era.era,
      toolkits: narrowedTo(request.originalUrl),
    }),
  );
}).pipe(Effect.catchTag("Reply", (reply) => Effect.succeed(reply.response)));

const methodNotAllowed = Effect.succeed(
  respond(errorAnswer(405, null, RpcCode.invalidRequest, "Method Not Allowed")).pipe(
    HttpServerResponse.setHeader("allow", "POST"),
  ),
);

/**
 * The endpoint's routes at `path` (a router path, which may name parameters, such as `/o/:slug/mcp`). The Worker that
 * mounts them puts them behind its gate, which provides the principal and the org: the API Worker's client gate at
 * `/mcp` ({@link McpRoutes}), a self-hosted Commissary's app Worker's Access gate at `/mcp` and `/o/:slug/mcp`.
 */
export const mcpRoutesAt = (path: HttpRouter.PathInput) =>
  Layer.mergeAll(
    HttpRouter.add("POST", path, serve),
    HttpRouter.add("GET", path, methodNotAllowed),
    HttpRouter.add("DELETE", path, methodNotAllowed),
  );

/** The endpoint at `/mcp`, the API Worker's client API path. */
export const McpRoutes = mcpRoutesAt(MCP_PATH);
