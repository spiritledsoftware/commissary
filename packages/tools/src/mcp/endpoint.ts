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
import { AccessPrincipal, viewerOf } from "@commissary/auth";
import type { Approver } from "@commissary/contract/approvals";
import { boundedBodyText, CurrentOrg, CurrentOutboundPolicy, MCP_PATH } from "@commissary/core";
import { panelPageUrl } from "@commissary/state";
import { type Refusal, spendRefusalMessage } from "@commissary/state/spend";
import type {
  ClientTool,
  FormAction,
  NotApprovedReason,
  ToolCall,
  ToolCallOutcome,
} from "../control-plane-part.ts";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import { writeToolCallRecord } from "../usage/record.ts";
import {
  acceptedUnder,
  type Answer,
  discoverResult,
  elicitsForms,
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
import { isJsonObject } from "../http/shared.ts";

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

/**
 * `tools/list`: every tool in one page, narrowed by the API key's tool scope (#200); the list is the member's, so only
 * their caches may keep it.
 */
const listTools = Effect.fnUntraced(function* (context: Served) {
  const identity = yield* AccessPrincipal;
  const viewer = viewerOf(identity);
  const apiKeyId = identity.principal.kind === "key" ? identity.principal.keyId : undefined;

  const tools = yield* toolsControlPlane("clientTools", (stub) =>
    stub.tools().clientTools(viewer, apiKeyId),
  );

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

/** Where an approval is decided when the panel's URL is not known (`panelPageUrl`). */
const APPROVAL_PAGE = "the approvals page in the panel";

/** The panel's page of the pending approval `id` (#201), or {@link APPROVAL_PAGE}. */
const approvalLink = Effect.fnUntraced(function* (id: string) {
  const env = yield* ToolsEnv;
  const org = yield* CurrentOrg;

  return yield* panelPageUrl(env, org, `approvals/${encodeURIComponent(id)}`, APPROVAL_PAGE);
});

/** The key of the approve-or-deny form among a call's input requests (#201). */
const APPROVAL_KEY = "approval";

/**
 * The caller's answer to the approve-or-deny form, when the call is made again with one, and the `requestState` the
 * client sent back with it: the part counts the answer only with the state it sent the form with.
 */
const approvalFormOf = (params: Schema.JsonObject): NonNullable<ToolCall["approvalForm"]> => {
  const responses = params["inputResponses"];
  const response = isJsonObject(responses) ? responses[APPROVAL_KEY] : undefined;
  const state = params["requestState"];
  const requestState = typeof state === "string" ? state : undefined;

  if (!isJsonObject(response)) return { requestState };
  const action = response["action"];
  const answer: FormAction = action === "accept" || action === "decline" ? action : "cancel";

  return { answer, requestState };
};

/** Who approves a pending call, in the words of its tool result. */
const approvedBy = (approver: Approver): string =>
  approver.kind === "caller" ? "you" : "one of its approvers other than you";

/** A tool result that tells the model something in words, not a failure. */
const toolText = (text: string): Schema.JsonObject => ({
  content: [{ type: "text", text }],
  isError: false,
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

/** A call that ended: every outcome but an unknown tool and a form the caller is asked to answer first. */
type EndedCall = Exclude<ToolCallOutcome, { outcome: "unknown" } | { outcome: "approve" }>;

/** What a call came to, as its usage record says it (#199, #201). */
const recordedOutcome = (outcome: EndedCall) => {
  switch (outcome.outcome) {
    case "connect":
      return "needs_credential";
    case "refused":
      return "refused";
    case "pending":
      return "approval_pending";
    case "not_approved":
      return "not_approved";
    case "failed":
      return "upstream_failure";
    case "result":
      return outcome.result["isError"] === true ? "tool_error" : "success";
  }
};

/** The bytes of `value` as JSON (UTF-8), 0 for nothing: all a usage record keeps of a call's arguments and result. */
const jsonBytes = (value: Schema.JsonObject | undefined): number =>
  value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Why a call an approval rule held was not made (#201). */
const notApprovedText = (name: string, reason: NotApprovedReason): string => {
  switch (reason) {
    case "denied":
      return `${name} was not called: the call was denied.`;
    case "no_approver":
      return (
        `${name} was not called: its calls wait for their caller's approval, which a caller without a member of ` +
        `the org gives only on a form their client shows.`
      );
  }
};

/**
 * The approve-or-deny form a caller who is their call's approver answers (#201): an `InputRequiredResult` (MRTR) whose
 * `approval` input request is a form-mode `elicitation/create` showing the tool and its arguments, with no field to
 * fill: accepting approves, declining or dismissing denies. The client makes the call again with the answer and the
 * `requestState`, which binds the answer to this call: an answer sent without it, or with the arguments changed, does
 * not count, and the caller is asked again.
 */
const approvalForm = (
  name: string,
  outcome: Extract<ToolCallOutcome, { outcome: "approve" }>,
): Schema.JsonObject => ({
  resultType: "input_required",
  inputRequests: {
    [APPROVAL_KEY]: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message:
          `Approve the call of ${name} (toolkit ${outcome.toolkit.name}) with these arguments? ` +
          `Accept to approve it, decline to deny it.\n\n${JSON.stringify(outcome.arguments, null, 2)}`,
        requestedSchema: { type: "object", properties: {} },
      },
    },
  },
  requestState: outcome.requestState,
});

/**
 * The tool result a call that reached a tool answers: the upstream's result, a short tool error (an upstream failure, a
 * Spend limit without room, a call not approved), for a call that waits for approval a result (not an error: the call
 * is not refused) that says so with the link to its approval page, or,
 * for a tool that needs the member's private credential, the link to connect it. A stateless client that declares
 * URL-mode elicitation is asked to open the connect link (an `InputRequiredResult`, MRTR) until it declines; any other
 * client gets the link as a tool error, a 2025 client too, as its elicitation would need the request's SSE stream
 * (docs/ARCHITECTURE.md, "Tools"), and so does every client when there is no URL to open. A pending call's link is
 * always a tool result: its approver may be someone else, and the call is made again once approved.
 */
const toolResult = Effect.fnUntraced(function* (
  outcome: EndedCall,
  name: string,
  request: RpcRequest,
  context: Served,
) {
  if (outcome.outcome === "result") return outcome.result;

  if (outcome.outcome === "failed") return toolError(outcome.message);

  if (outcome.outcome === "refused") return toolError(refusedText(name, outcome.refusal));

  if (outcome.outcome === "not_approved") return toolError(notApprovedText(name, outcome.reason));

  if (outcome.outcome === "pending") {
    const link = yield* approvalLink(outcome.approval.id);
    const by = new Date(outcome.approval.expiresAt).toISOString();

    const where = link === APPROVAL_PAGE ? `on ${link}` : `at ${link}`;

    return toolText(
      `${name} was not called yet: the call waits for approval by ${approvedBy(outcome.approval.approver)}. ` +
        `It can be approved or denied ${where} until ${by}. Once it is approved, call ${name} again with the ` +
        `same arguments: it goes through once.`,
    );
  }

  const link = yield* connectLink(outcome.toolkit.id);
  const key = `connect_${outcome.toolkit.name}`;
  const toolkit = outcome.toolkit.name;

  // The toolkit's shared sign-in is an org admin's to redo: the member is told, not asked.
  if (outcome.reason === "sign_in" && outcome.slot === "shared")
    return toolError(
      `${name} cannot be called: the toolkit ${toolkit}'s sign-in expired. An org admin must sign in to it again ` +
        `at ${link}.`,
    );

  const again = outcome.reason === "sign_in";

  if (link !== CONNECT_PAGE && elicitsUrls(context.era) && !declined(request.params, key))
    return {
      resultType: "input_required",
      inputRequests: {
        [key]: {
          method: "elicitation/create",
          params: {
            mode: "url",
            url: link,
            message: again
              ? `Sign in to the toolkit ${toolkit} again to use ${name}.`
              : `Connect your own credential for the toolkit ${toolkit} to use ${name}.`,
          },
        },
      },
    };

  return toolError(
    again
      ? `${name} needs you to sign in to the toolkit ${toolkit} again: your sign-in expired. Sign in at ${link}, ` +
          `then call the tool again.`
      : `${name} needs your own credential for the toolkit ${toolkit}, which you have not ` +
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

  const call: ToolCall = {
    name,
    arguments: args,
    toolkits: context.toolkits === undefined ? undefined : [...context.toolkits],
    apiKeyId: identity.principal.kind === "key" ? identity.principal.keyId : undefined,
    principalId: identity.principalId,
    // A 2025 client is never asked (see `toolResult`): it gets a pending approval's link.
    approvalForm: elicitsForms(context.era) ? approvalFormOf(request.params) : undefined,
    approvalOutcomes: true,
  };

  const outcome = yield* toolsControlPlane("callTool", (stub) =>
    stub.tools().callTool(viewer, call, policy),
  );

  if (outcome.outcome === "unknown")
    return errorAnswer(200, request.id, RpcCode.invalidParams, `Unknown tool: ${name}`);

  // The call goes on once the caller answers the form: its record is written then.
  if (outcome.outcome === "approve")
    return resultAnswer(request.id, framed(context.era, approvalForm(name, outcome)));

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
    approval: usage.approval,
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
