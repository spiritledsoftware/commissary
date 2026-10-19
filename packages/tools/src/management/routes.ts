/**
 * `/v9/management/toolkits` (`ToolsGroup` in `@commissary/contract/tools`): toolkits built from remote MCP servers,
 * their credentials, their tool lists and the overrides on their tools (#196, ADR 0036, ADR 0037, ADR 0038). The app
 * Worker's `management/routes.ts` mounts them next to its own and Models'.
 *
 * Every member of the org may use them (`access-rules.ts`); the Tools part decides what the caller reaches from the
 * viewer each route hands it: an org admin manages org toolkits, a member their private ones and their private
 * credentials. A toolkit's source passes the outbound guard when it is saved (ADR 0044), and the part builds tool lists
 * with the request's guard policy. Edits of a toolkit or an override name its revision in `If-Match`.
 */
import { Effect, Result, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import {
  AddToolkit,
  CredentialSlot,
  SetToolOverride,
  ToolkitSecret,
  UpdateToolkit,
} from "@commissary/contract/tools";
import {
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
import { toolsControlPlane } from "../env.ts";
import { defaultToolkitName } from "../toolkits/names.ts";

const BASE = "/v9/management";

const STATUS: Readonly<Record<ToolsErrorCode, number>> = {
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  name_taken: 409,
  not_accepted: 422,
  private_credentials_off: 403,
  no_credential: 409,
  tool_list_failed: 502,
};

const orRefuse = <A>(result: ToolsResult<A>): Effect.Effect<A, Reply> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(replyError(STATUS[result.error], result.error, { message: result.message }));

const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

const idParam = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;

  return id ?? "";
});

const slotParam = Effect.gen(function* () {
  const { slot } = yield* HttpRouter.params;

  if (!Schema.is(CredentialSlot)(slot)) return yield* replyError(404, "not_found");

  return slot;
});

/** The source of a new toolkit as the outbound guard allows it, normalised; 422 otherwise. */
const checkedSource = Effect.fnUntraced(function* (source: string) {
  const checked = checkOutboundUrl(source.trim(), yield* CurrentOutboundPolicy);

  if (Result.isFailure(checked))
    return yield* replyError(422, checked.failure.message, { path: "source" });

  if (checked.success.username !== "" || checked.success.password !== "")
    return yield* replyError(422, "invalid", {
      message: "a toolkit's source names no user or password: connect a credential instead",
    });

  return checked.success;
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
  const input = yield* decode(AddToolkit);
  const source = yield* checkedSource(input.source);
  const policy = yield* CurrentOutboundPolicy;
  // A plain member only ever adds private toolkits; an org admin chooses.
  const isPrivate = input.private === true || !viewer.admin;

  const result = yield* toolsControlPlane("addToolkit", (stub) =>
    stub.tools().addToolkit(
      viewer,
      {
        source: source.toString(),
        name: input.name ?? defaultToolkitName(source),
        private: isPrivate,
        accepts: input.accepts ?? (isPrivate ? "private" : "shared"),
        credential: input.credential,
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

  const result = yield* toolsControlPlane("updateToolkit", (stub) =>
    stub.tools().updateToolkit(viewer, id, revision, input, principalId),
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
  const secret = yield* decode(ToolkitSecret);
  const policy = yield* CurrentOutboundPolicy;

  const result = yield* toolsControlPlane("connectCredential", (stub) =>
    stub.tools().connectCredential(viewer, id, slot, secret, principalId, policy),
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

const route = <R>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

/** Tools' management routes. */
export const ManagementRoutes = HttpRouter.addAll([
  route("GET", "/toolkits", list),
  route("POST", "/toolkits", add),
  route("PATCH", "/toolkits/:id", update),
  route("DELETE", "/toolkits/:id", remove),
  route("PUT", "/toolkits/:id/credentials/:slot", connect),
  route("DELETE", "/toolkits/:id/credentials/:slot", disconnect),
  route("POST", "/toolkits/:id/refresh", refresh),
  route("GET", "/toolkits/:id/tools", tools),
  route("PUT", "/toolkits/:id/overrides", override),
]);
