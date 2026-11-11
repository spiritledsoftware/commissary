/**
 * `/v9/management/management-keys` (`ManagementKeysGroup` in @commissary/contract/management-keys): the keys scripts
 * send on the management API (ADR 0026), on every deployment. Workers addition, no Go counterpart.
 *
 * Org admins (and platform admins) use these routes (`policy.ts`). A key holds a role no higher than its
 * issuer's, and a management key issues none (giving a key a role is for people and service tokens). A revoked key is
 * forgotten by this isolate's cache at once (`@commissary/auth` `management-key.ts`).
 */
import { Clock, Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import {
  AccessPrincipal,
  forgetVerifiedManagementKey,
  type Principal,
  roleAtLeast,
} from "@commissary/auth";
import {
  controlPlane,
  type ManagementKeyErrorCode,
  type ManagementKeyRecord,
  bodyJson,
} from "@commissary/state";
import { CreateManagementKey, type ManagementKeyView } from "@commissary/contract/management-keys";
import { handled, jsonReply, type Reply, replyError } from "@commissary/core";

const BASE = "/v9/management";

const STATUS: Readonly<Record<ManagementKeyErrorCode, number>> = {
  invalid_name: 422,
  too_many_keys: 409,
  management_key_not_found: 404,
};

const iso = (ms: number): string => new Date(ms).toISOString();

const view = (key: ManagementKeyRecord): ManagementKeyView => ({
  id: key.id,
  name: key.name,
  role: key.role,
  prefix: key.prefix,
  created_by: key.createdBy,
  created_at: iso(key.createdAt),
  ...(key.lastUsedAt === undefined ? {} : { last_used_at: iso(key.lastUsedAt) }),
});

/** A management key may not give a role to a key or a service token (ADR 0026). */
export const managementKeyForbidden = () =>
  replyError(403, "management_key_forbidden", {
    message: "a management key cannot give a role to a key or a service token",
  });

/** Who issued a key, as lists show it, and the person it belongs to. */
const issuer = (principal: Principal) => {
  switch (principal.kind) {
    case "user":
    case "key":
      return { createdBy: principal.email.toLowerCase(), ownerEmail: principal.email };
    case "service":
      return { createdBy: `service:${principal.commonName}` };
    case "mkey":
      return undefined;
  }
};

const listManagementKeys = Effect.gen(function* () {
  const keys = yield* controlPlane("listManagementKeys", (stub) => stub.listManagementKeys());

  return jsonReply(200, { keys: keys.map(view) });
});

const createManagementKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const by = issuer(identity.principal);

  if (by === undefined) return yield* managementKeyForbidden();

  const input = yield* bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(CreateManagementKey)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

  if (!roleAtLeast(identity.role, input.role))
    return yield* replyError(403, "role_too_high", {
      message: "a management key holds at most your own role",
    });
  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("createManagementKey", (stub) =>
    stub.createManagementKey({ name: input.name, role: input.role, ...by }, now),
  );

  if (!result.ok)
    return yield* replyError(STATUS[result.error], result.error, { message: result.message });

  return jsonReply(201, { ...view(result.value.record), key: result.value.key });
});

const revokeManagementKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const params = yield* HttpRouter.params;
  const id = params["id"] ?? "";
  const keys = yield* controlPlane("listManagementKeys", (stub) => stub.listManagementKeys());
  const target = keys.find((key) => key.id === id);

  // Like issuing: an org admin does not take away a key holding the owner role.
  if (target !== undefined && !roleAtLeast(identity.role, target.role))
    return yield* replyError(403, "role_too_high", {
      message: "you can revoke only a management key holding at most your own role",
    });

  const result = yield* controlPlane("revokeManagementKey", (stub) => stub.revokeManagementKey(id));

  if (!result.ok)
    return yield* replyError(STATUS[result.error], result.error, { message: result.message });
  forgetVerifiedManagementKey(identity.org, result.value.id);

  return jsonReply(200, view(result.value));
});

const route = <R>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

export const managementKeyRoutes = [
  route("GET", "/management-keys", listManagementKeys),
  route("POST", "/management-keys", createManagementKey),
  route("DELETE", "/management-keys/:id", revokeManagementKey),
];
