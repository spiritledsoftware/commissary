/**
 * `/v9/management/api-keys` (`ApiKeysGroup` in @commissary/contract/api-keys): the API keys clients send instead of an
 * Access sign-in (ADR 0022). Workers addition, no Go counterpart.
 *
 * Any member of the org may use these routes (`policy.ts`): a member creates keys for themselves and lists and
 * revokes their own; an org admin (or a platform admin) lists and revokes every key of the org. A key may carry a tool
 * scope (#200), set when it is created and changed by its member (`PATCH /api-keys/:id`); every view says how many tools
 * the key may use now and what its scope names that is gone (Tools' `keyToolSummaries`). Keys are issued to
 * members only, so a caller without a member id in the org (a service token, a platform admin from outside) cannot
 * create one. Each isolate caches a verified key briefly, so a revoked key may keep working for that long
 * (`@commissary/auth` `api-key.ts`).
 */
import { Clock, Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { type AccessIdentity, AccessPrincipal, roleAtLeast } from "@commissary/auth";
import {
  type ApiKeyErrorCode,
  type ApiKeyListing,
  type ApiKeyResult,
  controlPlane,
  bodyJson,
} from "@commissary/state";
import { CreateApiKey, type ApiKeyView, UpdateApiKey } from "@commissary/contract/api-keys";
import { type KeyToolSummary, keyToolSummaries } from "@commissary/tools/management";
import { handled, jsonReply, type Reply, replyError } from "@commissary/core";

const BASE = "/v9/management";

const STATUS: Readonly<Record<ApiKeyErrorCode | "member_not_found", number>> = {
  invalid_name: 422,
  invalid_expiry: 422,
  invalid_tool_scope: 422,
  too_many_keys: 409,
  api_key_not_found: 404,
  member_not_found: 403,
};

const iso = (ms: number): string => new Date(ms).toISOString();

const view = (
  key: ApiKeyListing,
  caller: AccessIdentity,
  tools: KeyToolSummary | undefined,
): ApiKeyView => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  member_id: key.memberId,
  ...(key.memberEmail === undefined ? {} : { member_email: key.memberEmail }),
  mine: key.memberId === caller.memberId,
  created_at: iso(key.createdAt),
  ...(key.lastUsedAt === undefined ? {} : { last_used_at: iso(key.lastUsedAt) }),
  ...(key.expiresAt === undefined ? {} : { expires_at: iso(key.expiresAt) }),
  ...(key.revokedAt === undefined ? {} : { revoked_at: iso(key.revokedAt) }),
  ...(key.toolScope === undefined ? {} : { tool_scope: key.toolScope }),
  ...(tools === undefined ? {} : { tool_count: tools.toolCount }),
  ...(tools === undefined || tools.missing.length === 0
    ? {}
    : { tool_scope_missing: tools.missing }),
});

/** The views of `keys`, each with what Tools says of its tools (none when Tools cannot be reached). */
const views = Effect.fnUntraced(function* (
  keys: ReadonlyArray<ApiKeyListing>,
  caller: AccessIdentity,
) {
  const summaries = yield* keyToolSummaries(keys);

  return keys.map((key, index) => view(key, caller, summaries?.[index]));
});

const orRefuse = <A>(
  result:
    | ApiKeyResult<A>
    | { readonly ok: false; readonly error: "member_not_found"; readonly message: string },
): Effect.Effect<A, Reply> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(replyError(STATUS[result.error], result.error, { message: result.message }));

/** Org admins (and platform admins, owners of every org) see and revoke every key of the org. */
const managesEveryKey = (identity: AccessIdentity): boolean =>
  identity.platformAdmin || roleAtLeast(identity.role, "admin");

const memberRequired = () =>
  replyError(403, "member_required", {
    message: "API keys are issued to members of the org; add yourself as a member first",
  });

const listApiKeys = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const every = managesEveryKey(identity);

  if (!every && identity.memberId === undefined) return jsonReply(200, { keys: [] });

  const now = yield* Clock.currentTimeMillis;

  const keys = yield* controlPlane("listApiKeys", (stub) =>
    stub.listApiKeys(every ? undefined : identity.memberId, now),
  );

  return jsonReply(200, { keys: yield* views(keys, identity) });
});

const createApiKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const memberId = identity.memberId;

  if (memberId === undefined) return yield* memberRequired();

  const input = yield* bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(CreateApiKey)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

  const expiresAt = input.expires_at === undefined ? undefined : Date.parse(input.expires_at);
  const toolScope = input.tool_scope ?? undefined;

  if (expiresAt !== undefined && Number.isNaN(expiresAt))
    return yield* replyError(422, "invalid_expiry", { message: "expires_at is an ISO 8601 time" });
  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("createApiKey", (stub) =>
    stub.createApiKey(
      {
        memberId,
        name: input.name,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(toolScope === undefined ? {} : { toolScope }),
      },
      now,
    ),
  );

  const created = yield* orRefuse(result);
  const [shown] = yield* views([created.record], identity);

  return jsonReply(201, { ...shown, key: created.key });
});

/** `PATCH /api-keys/:id`: a member changes the tool scope of a key of their own (#200); another's answers as unknown. */
const updateApiKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const params = yield* HttpRouter.params;
  const id = params["id"] ?? "";
  const memberId = identity.memberId;

  if (memberId === undefined)
    return yield* replyError(404, "api_key_not_found", { message: "no API key has this id" });

  const input = yield* bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(UpdateApiKey)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("setApiKeyToolScope", (stub) =>
    stub.setApiKeyToolScope(id, input.tool_scope, memberId, now),
  );

  const updated = yield* orRefuse(result);
  const [shown] = yield* views([updated], identity);

  return jsonReply(200, shown);
});

const revokeApiKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const params = yield* HttpRouter.params;
  const id = params["id"] ?? "";
  const every = managesEveryKey(identity);

  if (!every && identity.memberId === undefined)
    return yield* replyError(404, "api_key_not_found", { message: "no API key has this id" });
  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("revokeApiKey", (stub) =>
    stub.revokeApiKey(id, now, every ? undefined : identity.memberId),
  );

  const revoked = yield* orRefuse(result);

  return jsonReply(200, view(revoked, identity, undefined));
});

const route = <R>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

export const apiKeyRoutes = [
  route("GET", "/api-keys", listApiKeys),
  route("POST", "/api-keys", createApiKey),
  route("PATCH", "/api-keys/:id", updateApiKey),
  route("DELETE", "/api-keys/:id", revokeApiKey),
];
