/**
 * Commissary's MCP endpoint (#197, ADR 0036, ADR 0037, ADR 0038): `/mcp` on the API host, Streamable HTTP, both
 * protocol eras (`protocol.ts`). The API Worker mounts it behind its client gate, so a request comes with the member of
 * its API key (`AccessPrincipal`) and their org (`CurrentOrg`), and counts against the org's request-rate ceiling on
 * Commissary Cloud. The member's tools and the calls are the org's ControlPlane's (`ToolsPart.clientTools`,
 * `ToolsPart.callTool`), where the credentials are; `?toolkits=a,b` narrows both to those toolkits, by the names the
 * member sees.
 *
 * `GET` and `DELETE` answer `405`, as the 2026-07-28 revision's backward compatibility asks of a server that opens no
 * stream and keeps no session (and as the 2025 revisions allow).
 */
import { Effect, Layer, type Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { type AccessPrincipal, currentViewer } from "@commissary/auth";
import { boundedBodyText, CurrentOrg, CurrentOutboundPolicy, MCP_PATH } from "@commissary/core";
import { panelPageUrl } from "@commissary/state";
import type { ClientTool } from "../control-plane-part.ts";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import {
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

/**
 * `tools/call`: the tool's result, a short tool error, or, for a tool that needs the member's private credential, the
 * link to connect it. A stateless client that declares URL-mode elicitation is asked to open it (an
 * `InputRequiredResult`, MRTR) until it declines; any other client gets the link as a tool error, a 2025 client too, as
 * its elicitation would need the request's SSE stream (docs/ARCHITECTURE.md, "Tools"), and so does every client when
 * there is no URL to open.
 */
const callTool = Effect.fnUntraced(function* (request: RpcRequest, context: Served) {
  const name = request.params["name"];
  const args = request.params["arguments"];

  if (typeof name !== "string" || (args !== undefined && !isJsonObject(args)))
    return errorAnswer(200, request.id, RpcCode.invalidParams, "Invalid params");

  const viewer = yield* currentViewer;
  const policy = yield* CurrentOutboundPolicy;

  const call = {
    name,
    arguments: args,
    toolkits: context.toolkits === undefined ? undefined : [...context.toolkits],
  };

  const outcome = yield* toolsControlPlane("callTool", (stub) =>
    stub.tools().callTool(viewer, call, policy),
  );

  const result = (value: Schema.JsonObject) => resultAnswer(request.id, framed(context.era, value));

  if (outcome.outcome === "unknown")
    return errorAnswer(200, request.id, RpcCode.invalidParams, `Unknown tool: ${name}`);

  if (outcome.outcome === "result") return result(outcome.result);

  if (outcome.outcome === "failed") return result(toolError(outcome.message));

  const link = yield* connectLink(outcome.toolkit.id);
  const key = `connect_${outcome.toolkit.name}`;

  if (link !== CONNECT_PAGE && elicitsUrls(context.era) && !declined(request.params, key))
    return result({
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
    });

  return result(
    toolError(
      `${name} needs your own credential for the toolkit ${outcome.toolkit.name}, which you have not ` +
        `connected. Connect it at ${link}, then call the tool again.`,
    ),
  );
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

/** The endpoint's routes; the API Worker puts them behind its client gate. */
export const McpRoutes = Layer.mergeAll(
  HttpRouter.add("POST", MCP_PATH, serve),
  HttpRouter.add("GET", MCP_PATH, methodNotAllowed),
  HttpRouter.add("DELETE", MCP_PATH, methodNotAllowed),
);
