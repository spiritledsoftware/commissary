/**
 * `/v9/management/toolkits` (`ToolsGroup` in `@commissary/contract/tools`): toolkits built from remote MCP servers,
 * OpenAPI documents, GraphQL endpoints and Google Discovery documents, their credentials, their tool lists and the overrides on their tools (#196,
 * ADR 0036, ADR 0037, ADR 0038). The app Worker's `management/routes.ts` mounts them next to its own and Models'.
 *
 * Every member of the org may use them (`access-rules.ts`); the Tools part decides what the caller reaches from the
 * viewer each route hands it: an org admin manages org toolkits, a member their private ones and their private
 * credentials. A toolkit's source, and an OpenAPI toolkit's base URL, pass the outbound guard when they are saved (ADR
 * 0044), and the part builds tool lists with the request's guard policy (a Discovery document's `rootUrl` too, which
 * refuses the save, #205). An OpenAPI or Discovery toolkit's document may be uploaded instead of given by URL (#203,
 * #205), at most {@link MAX_DOCUMENT_BYTES}, and a GraphQL toolkit's schema as SDL instead of
 * introspected (#204), at most {@link MAX_SDL_BYTES}, also as a first upload on an introspected one; their managers
 * read it back. Edits of a toolkit or an override name its revision in
 * `If-Match`.
 *
 * `GET /v9/management/tools`: the tools the caller may use, by toolkit (#200): what a key's tool scope picks from.
 *
 * `/v9/management/grants/tools` (`ToolGrantsGroup` in `@commissary/contract/grants`): the tool grants (#198, ADR 0038),
 * beside Models' model grants at `/grants`, so the panel shows both on one Grants page. Org admins only (the role
 * table's default); a write names the grant's revision in `If-Match` (`POST` creates at 0).
 *
 * `/v9/management/approvals` (`ApprovalsGroup` in `@commissary/contract/approvals`): the pending approvals of tool calls
 * (#201, ADR 0038), which the panel's approval page and pending list read and decide. Every member may call them; the
 * Tools part shows each approval to its eligible approvers and its caller only, and lets only the former decide it.
 */
import { Effect, Result, Schema } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import { ApprovalDecision } from "@commissary/contract/approvals";
import { ToolGrantBody } from "@commissary/contract/grants";
import {
  AddToolkit,
  ConnectCredential,
  CredentialSlot,
  SetOAuthApp,
  SetToolOverride,
  StartSignIn,
  ToolkitDocument,
  UpdateToolkit,
} from "@commissary/contract/tools";
import {
  boundedBodyText,
  checkOutboundUrl,
  CurrentOutboundPolicy,
  handled,
  ifMatch,
  jsonReply,
  type Reply,
  replyError,
} from "@commissary/core";
import { bodyJson } from "@commissary/state";
import type { ToolsErrorCode, ToolsResult } from "../control-plane-part.ts";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import { MAX_SDL_BYTES } from "../graphql/schema.ts";
import { MAX_DOCUMENT_BYTES } from "../http/call.ts";
import { signInUrls } from "../oauth/urls.ts";
import { defaultToolkitName } from "../toolkits/names.ts";

const BASE = "/v9/management";

const STATUS: Readonly<Record<ToolsErrorCode, number>> = {
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  name_taken: 409,
  not_accepted: 422,
  private_credentials_unavailable: 403,
  private_toolkits_unavailable: 403,
  no_credential: 409,
  tool_list_failed: 502,
  body_too_large: 413,
  built_in: 403,
  outbound_refused: 422,
  sign_in_failed: 502,
};

const orRefuse = <A>(result: ToolsResult<A>): Effect.Effect<A, Reply> => {
  if (result.ok) return Effect.succeed(result.value);

  // A URL the outbound guard refused answers as a source it refuses does: its message, and the field's path.
  return Effect.fail(
    result.error === "outbound_refused"
      ? replyError(422, result.message, { path: result.path ?? "" })
      : replyError(STATUS[result.error], result.error, {
          message: result.message,
          ...(result.path === undefined ? {} : { path: result.path }),
        }),
  );
};

const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

/**
 * A body that may carry an OpenAPI document: read up to twice {@link MAX_DOCUMENT_BYTES} (a document's JSON string
 * escapes its newlines and quotes), `413 body_too_large` above; the document itself is checked by {@link checkedDocument}.
 */
const decodeWithDocument = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
) =>
  Effect.flatMap(boundedBodyText(2 * MAX_DOCUMENT_BYTES), (text) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => replyError(400, "invalid body")),
    ),
  );

/**
 * An uploaded document within `limit` ({@link MAX_DOCUMENT_BYTES}; a GraphQL schema's SDL, {@link MAX_SDL_BYTES}),
 * `413 body_too_large` otherwise.
 */
const checkedDocument = Effect.fnUntraced(function* (
  document: string,
  limit: number = MAX_DOCUMENT_BYTES,
) {
  if (new TextEncoder().encode(document).byteLength > limit)
    return yield* replyError(413, "body_too_large", {
      message: `the document is larger than ${limit} bytes`,
      path: "document",
    });

  return document;
});

const idParam = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;

  return id ?? "";
});

const slotParam = Effect.gen(function* () {
  const { slot } = yield* HttpRouter.params;

  if (!Schema.is(CredentialSlot)(slot)) return yield* replyError(404, "not_found");

  return slot;
});

/**
 * A toolkit's source (`path: "source"`) or base URL (`path: "base_url"`) as the outbound guard allows it, normalised;
 * 422 otherwise.
 */
const checkedSource = Effect.fnUntraced(function* (source: string, path = "source") {
  const checked = checkOutboundUrl(source.trim(), yield* CurrentOutboundPolicy);

  if (Result.isFailure(checked)) return yield* replyError(422, checked.failure.message, { path });

  if (checked.success.username !== "" || checked.success.password !== "")
    return yield* replyError(422, "invalid", {
      message: `a toolkit's ${path === "source" ? "source" : "base URL"} names no user or password: connect a credential instead`,
      path,
    });

  return checked.success;
});

const invalid = (message: string, path: string) => replyError(422, "invalid", { message, path });

/** A URL the outbound guard allows (normalised), or the guard's `422` with `path`. */
const checkedUrl = Effect.fnUntraced(function* (url: string, path: string) {
  const checked = checkOutboundUrl(url.trim(), yield* CurrentOutboundPolicy);

  if (Result.isFailure(checked)) return yield* replyError(422, checked.failure.message, { path });

  return checked.success.toString();
});

/**
 * A credential as it is connected, a client credentials grant's token URL checked by the outbound guard (`422` with
 * `path`, ADR 0044) and normalised.
 */
const checkedCredential = Effect.fnUntraced(function* (
  credential: ConnectCredential,
  path: string,
) {
  if (credential.kind !== "client_credentials" || credential.token_url === undefined)
    return credential;

  return { ...credential, token_url: yield* checkedUrl(credential.token_url, path) };
});

const list = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* toolsControlPlane("listToolkits", (stub) => stub.tools().listToolkits(viewer)),
  );
});

const add = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const input = yield* decodeWithDocument(AddToolkit);
  const kind = input.kind ?? "mcp";

  if (kind === "mcp" && (input.document !== undefined || input.base_url !== undefined))
    return yield* invalid(
      "an MCP toolkit takes neither a document nor a base URL",
      input.document === undefined ? "base_url" : "document",
    );

  if (kind === "mcp" && input.source === undefined)
    return yield* invalid("an MCP toolkit names its server's URL", "source");

  if (kind === "graphql" && input.base_url !== undefined)
    return yield* invalid(
      "a GraphQL toolkit takes no base URL: its source is its endpoint",
      "base_url",
    );

  if (kind === "graphql" && input.source === undefined)
    return yield* invalid("a GraphQL toolkit names its endpoint's URL", "source");

  if (kind === "graphql" && input.document?.trim() === "")
    return yield* invalid("an uploaded GraphQL schema is not empty", "document");

  if (kind === "openapi" && (input.source === undefined) === (input.document === undefined))
    return yield* invalid(
      "an OpenAPI toolkit gives either its document's URL (source) or the document",
      "source",
    );

  if (kind === "discovery" && input.base_url !== undefined)
    return yield* invalid("a Discovery toolkit's calls go to its document's rootUrl", "base_url");

  if (kind === "discovery" && (input.source === undefined) === (input.document === undefined))
    return yield* invalid(
      "a Discovery toolkit gives either its document's URL (source) or the document",
      "source",
    );

  const source = input.source === undefined ? undefined : yield* checkedSource(input.source);

  const baseUrl =
    input.base_url === undefined ? undefined : yield* checkedSource(input.base_url, "base_url");

  const document =
    input.document === undefined
      ? undefined
      : yield* checkedDocument(
          input.document,
          kind === "graphql" ? MAX_SDL_BYTES : MAX_DOCUMENT_BYTES,
        );

  const credential =
    input.credential === undefined
      ? undefined
      : yield* checkedCredential(input.credential, "credential.token_url");

  const policy = yield* CurrentOutboundPolicy;
  // A plain member only ever adds private toolkits; an org admin chooses.
  const isPrivate = input.private === true || !viewer.admin;

  const result = yield* toolsControlPlane("addToolkit", (stub) =>
    stub.tools().addToolkit(
      viewer,
      {
        kind,
        source: source?.toString() ?? "",
        document,
        baseUrl: baseUrl?.toString(),
        // An OpenAPI or Discovery toolkit's default comes from its document, which the part reads.
        name:
          input.name ??
          ((kind === "mcp" || kind === "graphql") && source !== undefined
            ? defaultToolkitName(source)
            : undefined),
        private: isPrivate,
        accepts: input.accepts ?? (isPrivate ? "private" : "shared"),
        credential,
      },
      principalId,
      policy,
    ),
  );

  return jsonReply(201, yield* orRefuse(result));
});

const update = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const input = yield* decode(UpdateToolkit);

  // A base URL is checked here; `null` (clearing it) and its absence pass as they are.
  const change =
    input.base_url === undefined || input.base_url === null
      ? input
      : { ...input, base_url: (yield* checkedSource(input.base_url, "base_url")).toString() };

  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("updateToolkit", (stub) =>
    stub.tools().updateToolkit(viewer, id, revision, change, principalId, policy),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const replaceDocument = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const input = yield* decodeWithDocument(ToolkitDocument);
  const document = yield* checkedDocument(input.document);

  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("replaceDocument", (stub) =>
    stub.tools().replaceDocument(viewer, id, revision, document, principalId, policy),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const getDocument = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;

  const result = yield* toolsControlPlane("toolkitDocument", (stub) =>
    stub.tools().toolkitDocument(viewer, id),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const remove = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const revision = yield* ifMatch;

  const result = yield* toolsControlPlane("removeToolkit", (stub) =>
    stub.tools().removeToolkit(viewer, id, revision),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const connect = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const slot = yield* slotParam;
  const credential = yield* checkedCredential(yield* decode(ConnectCredential), "token_url");
  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("connectCredential", (stub) =>
    stub.tools().connectCredential(viewer, id, slot, credential, principalId, policy),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const disconnect = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const slot = yield* slotParam;

  const result = yield* toolsControlPlane("disconnectCredential", (stub) =>
    stub.tools().disconnectCredential(viewer, id, slot),
  );

  return jsonReply(200, yield* orRefuse(result));
});

// --- OAuth sign-ins (#202) -------------------------------------------------------------------------------------------

const signIn = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const slot = yield* slotParam;
  const input = yield* decode(StartSignIn);
  const policy = yield* CurrentOutboundPolicy;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urls = signInUrls(request.originalUrl, (yield* ToolsEnv).API_DOMAIN);

  const result = yield* toolsControlPlane("startSignIn", (stub) =>
    stub.tools().startSignIn(viewer, id, slot, input, principalId, policy, urls),
  );

  return jsonReply(201, yield* orRefuse(result));
});

const signInStatus = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const state = new URL(request.originalUrl, "http://localhost").searchParams.get("state") ?? "";

  const result = yield* toolsControlPlane("signInStatus", (stub) =>
    stub.tools().signInStatus(viewer, id, state),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const setOAuthApp = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const input = yield* decode(SetOAuthApp);

  const app = {
    ...input,
    authorize_url: yield* checkedUrl(input.authorize_url, "authorize_url"),
    token_url: yield* checkedUrl(input.token_url, "token_url"),
  };

  const result = yield* toolsControlPlane("setOAuthApp", (stub) =>
    stub.tools().setOAuthApp(viewer, id, app, principalId),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const clearOAuthApp = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;

  const result = yield* toolsControlPlane("clearOAuthApp", (stub) =>
    stub.tools().clearOAuthApp(viewer, id),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const refresh = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("refreshToolList", (stub) =>
    stub.tools().refreshToolList(viewer, id, policy),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const tools = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;

  const result = yield* toolsControlPlane("listTools", (stub) =>
    stub.tools().listTools(viewer, id),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const override = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const revision = yield* ifMatch;
  const input = yield* decode(SetToolOverride);

  const result = yield* toolsControlPlane("setOverride", (stub) =>
    stub.tools().setOverride(viewer, id, revision, input, principalId),
  );

  return jsonReply(200, yield* orRefuse(result));
});

// --- tool grants -------------------------------------------------------------------------------------------------------

const listGrants = Effect.gen(function* () {
  return jsonReply(
    200,
    yield* toolsControlPlane("listGrants", (stub) => stub.tools().listGrants()),
  );
});

/** Writes one tool grant (`value` `null` deletes it) and answers its id and new revision. */
const writeGrant = Effect.fnUntraced(function* (
  id: string | undefined,
  revision: number,
  value: ToolGrantBody | null,
) {
  const { principalId } = yield* AccessPrincipal;

  const result = yield* toolsControlPlane("writeGrant", (stub) =>
    stub.tools().writeGrant({ id, revision, value }, principalId),
  );

  return jsonReply(200, { status: "ok", ...(yield* orRefuse(result)) });
});

const createGrant = Effect.gen(function* () {
  return yield* writeGrant(undefined, 0, yield* decode(ToolGrantBody));
});

const replaceGrant = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;

  return yield* writeGrant(id, revision, yield* decode(ToolGrantBody));
});

const removeGrant = Effect.gen(function* () {
  const id = yield* idParam;
  const revision = yield* ifMatch;

  return yield* writeGrant(id, revision, null);
});

/** `GET /tools`: what the caller may use on the MCP endpoint, by toolkit (#200). */
const usable = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* toolsControlPlane("usableTools", (stub) => stub.tools().usableTools(viewer)),
  );
});

// --- pending approvals ------------------------------------------------------------------------------------------------

const listApprovals = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* toolsControlPlane("listApprovals", (stub) => stub.tools().listApprovals(viewer)),
  );
});

const getApproval = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;

  const result = yield* toolsControlPlane("getApproval", (stub) =>
    stub.tools().getApproval(viewer, id),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const decideApproval = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const { principalId } = yield* AccessPrincipal;
  const id = yield* idParam;
  const { decision } = yield* decode(ApprovalDecision);

  const result = yield* toolsControlPlane("decideApproval", (stub) =>
    stub.tools().decideApproval(viewer, id, decision, principalId),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const route = <R>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

/** Tools' management routes. */
export const ManagementRoutes = HttpRouter.addAll([
  route("GET", "/toolkits", list),
  route("GET", "/tools", usable),
  route("POST", "/toolkits", add),
  route("PATCH", "/toolkits/:id", update),
  route("DELETE", "/toolkits/:id", remove),
  route("PUT", "/toolkits/:id/credentials/:slot", connect),
  route("DELETE", "/toolkits/:id/credentials/:slot", disconnect),
  route("PUT", "/toolkits/:id/document", replaceDocument),
  route("GET", "/toolkits/:id/document", getDocument),
  route("POST", "/toolkits/:id/credentials/:slot/sign-in", signIn),
  route("GET", "/toolkits/:id/sign-in", signInStatus),
  route("PUT", "/toolkits/:id/oauth-app", setOAuthApp),
  route("DELETE", "/toolkits/:id/oauth-app", clearOAuthApp),
  route("POST", "/toolkits/:id/refresh", refresh),
  route("GET", "/toolkits/:id/tools", tools),
  route("PUT", "/toolkits/:id/overrides", override),
  route("GET", "/grants/tools", listGrants),
  route("POST", "/grants/tools", createGrant),
  route("PUT", "/grants/tools/:id", replaceGrant),
  route("DELETE", "/grants/tools/:id", removeGrant),
  route("GET", "/approvals", listApprovals),
  route("GET", "/approvals/:id", getApproval),
  route("POST", "/approvals/:id/decision", decideApproval),
]);
