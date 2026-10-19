/**
 * `/v9/management/provider-keys*` (`ProviderKeysGroup` in @commissary/contract/provider-keys): the provider keys page's
 * list, group writes and connection test.
 *
 * Workers addition, no Go counterpart (Go's panel edits whole family arrays through `PUT /api-keys` style routes with
 * raw keys). Reads never carry secrets (`provider-keys-view.ts`). Writes are semantic, one group at a time: a key group and
 * its keys are config entries (ADR 0025), and a write names the group's `id` and the `revision` it was read at. The
 * edit is applied to the assembled document to check it, then the group alone is written (`writeKeyGroup`), with no
 * retry: a group changed since is a `409 conflict` instead of silently overwriting a concurrent change, and a write of
 * another group never conflicts. The edited document is dry-run through the config decoder first, so a group the
 * normaliser would drop for its own shape (codex without base-url, an empty key) is refused with `422` and the reason
 * instead of "succeeding". A typed key that duplicates a key of another group is dropped from the written group,
 * silently and never refused (stored keys win, `provider-keys-write.ts` `settleDuplicates`): the reply must not tell a
 * right guess of a stored key from a wrong one, and the normaliser's first-wins must not delete the stored key instead.
 */
import { Effect, Schema } from "effect";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import { AccessPrincipal } from "@commissary/auth";
import { decodeConfig, decodeRawConfig } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { keyIdentities } from "../config/normalize.ts";
import type { WriteResult } from "../config/store.ts";
import { configKeyIds } from "../credentials/key-ids.ts";
import { isJsonObject, type JsonObject } from "@commissary/json";
import { refusedGroupBaseUrl } from "./base-url-guard.ts";
import { probeProviderKey } from "./provider-keys-probe.ts";
import { currentAuthIndexer } from "./auth-index.ts";
import {
  applyGroupWrite,
  checkSurvival,
  type Edit,
  type GroupWrite,
  isDedupedFamily,
  settleDuplicates,
} from "./provider-keys-write.ts";
import {
  type ProviderKeyFamily,
  DeleteGroupRequest,
  ProbeRequest,
  PutGroupRequest,
} from "@commissary/contract/provider-keys";
import { handled, jsonReply, type Reply, replyError } from "@commissary/core";
import { bodyJson } from "@commissary/state";
import { storedConfig } from "./settings-routes.ts";
import { currentViewer } from "@commissary/auth";
import { modelsControlPlane } from "../env.ts";

const BASE = "/v9/management/provider-keys";

const invalidBody = () => replyError(400, "invalid body");

/** The request body, decoded with `schema`; the raw JSON is returned for the parts written through untouched. */
const decoded = <S extends Schema.Decoder<unknown>>(
  schema: S,
): Effect.Effect<
  { readonly value: S["Type"]; readonly raw: JsonObject },
  Reply,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const raw = yield* bodyJson;

    if (!isJsonObject(raw)) return yield* invalidBody();
    const value = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(invalidBody));

    return { value, raw };
  });

const conflict = () => replyError(409, "conflict");

const refuse = <A>(edit: Edit<A>) =>
  edit.ok ? Effect.succeed(edit.value) : Effect.fail(replyError(edit.status, edit.error));

type GroupWriteResult =
  | WriteResult<{ readonly id: string; readonly revision: number }>
  | { readonly ok: false; readonly error: "forbidden"; readonly message: string };

/** The answer to a group write. */
const written = (result: GroupWriteResult) => {
  if (result.ok)
    return Effect.succeed(
      jsonReply(200, {
        status: "ok",
        version: result.version,
        id: result.id,
        revision: result.revision,
      }),
    );

  if (result.error === "forbidden")
    return Effect.fail(
      replyError(403, "private_credentials_unavailable", { message: result.message }),
    );

  if (result.error === "conflict") return Effect.fail(conflict());

  if (result.error === "not_found") return Effect.fail(replyError(404, "group not found"));

  return Effect.fail(replyError(422, result.message));
};

/** The position of group `id` in `family` of the assembled config; a group gone since it was read is a conflict. */
const indexOf = (
  config: {
    readonly "api-keys": Record<ProviderKeyFamily, ReadonlyArray<{ readonly id?: string }>>;
  },
  family: ProviderKeyFamily,
  id: string | undefined,
) => {
  if (id === undefined) return Effect.succeed(undefined);
  const index = config["api-keys"][family].findIndex((group) => group.id === id);

  return index < 0 ? Effect.fail(conflict()) : Effect.succeed(index);
};

const familyCounts = (groups: ReadonlyArray<{ readonly keys: ReadonlyArray<unknown> }>): number[] =>
  groups.map((group) => group.keys.length);

const familyOf = (
  config: {
    readonly "api-keys": Record<
      ProviderKeyFamily,
      ReadonlyArray<{ readonly keys: ReadonlyArray<unknown> }>
    >;
  },
  family: ProviderKeyFamily,
) => config["api-keys"][family];

/**
 * The caller's private key groups as the config the write is checked against (what `storedConfig` is for the org's
 * shared groups); refused unless the org lets members have private credentials.
 */
const privateStoredConfig = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const wire = yield* modelsControlPlane("privateKeyConfig", (stub) =>
    stub.models().privateKeyConfig(viewer),
  );

  if (!wire.ok)
    return yield* replyError(403, "private_credentials_unavailable", { message: wire.message });

  const config = yield* decodeStoredConfig(wire.document).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  // SAFETY: the document is the serialized JSON object of the member's private groups (`PrivateKeyStore`).
  const document = JSON.parse(wire.document) as JsonObject;

  return { document, config };
});

const list = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const view = yield* modelsControlPlane("providerKeysView", (stub) =>
    stub.models().providerKeysView(viewer),
  );

  return jsonReply(200, view);
});

/** `write` with the typed keys that duplicate another group's key dropped (families Go deduplicates only). */
const settled = (family: ProviderKeyFamily, index: number | undefined, write: GroupWrite) =>
  Effect.gen(function* () {
    if (!isDedupedFamily(family)) return write;

    // As written: nothing deduplicated yet, so the indexes are those of the document.
    const raw = yield* decodeRawConfig(write.document).pipe(
      Effect.mapError((error) => replyError(422, error.message)),
    );

    return yield* refuse(settleDuplicates(family, write, index, keyIdentities(family, raw)));
  });

const putGroup = Effect.gen(function* () {
  const { value, raw } = yield* decoded(PutGroupRequest);
  const group = raw.group;

  // The decoder accepted `raw`, so `group` is an object.
  if (!isJsonObject(group)) return yield* invalidBody();

  // A `base-url` the outbound guard refuses is refused when saved, not only when used (ADR 0044).
  const refusedBase = yield* refusedGroupBaseUrl(group);

  if (refusedBase !== undefined)
    return yield* replyError(422, refusedBase.refusal.message, { path: refusedBase.path });
  const viewer = yield* currentViewer;
  // A plain member only ever writes private groups; an org admin chooses.
  const asPrivate = value.private === true || !viewer.admin;

  const current = asPrivate ? yield* privateStoredConfig : yield* storedConfig;
  const index = yield* indexOf(current.config, value.family, value.id);
  const ids = configKeyIds(current.config, { includeDisabledGroups: true });
  const authIndexOf = yield* currentAuthIndexer;

  const applied = yield* refuse(
    applyGroupWrite(current.document, ids, authIndexOf, {
      family: value.family,
      ...(index === undefined ? {} : { index }),
      group,
    }),
  );

  // Stored keys win: a typed key equal to a key of another group goes, whatever the normaliser would keep.
  const write = yield* settled(value.family, index, applied);

  // Dry run through the decoder (what the ControlPlane will assemble): the group must survive normalisation, and no
  // other group may lose a key.
  const normalised = yield* decodeConfig(write.document).pipe(
    Effect.mapError((error) => replyError(422, error.message)),
  );

  yield* refuse(
    checkSurvival(
      value.family,
      familyCounts(familyOf(current.config, value.family)),
      familyCounts(familyOf(normalised, value.family)),
      index,
      applied.group,
      write.group,
    ),
  );

  const { principalId } = yield* AccessPrincipal;

  const change = {
    family: value.family,
    ...(value.id === undefined ? {} : { id: value.id }),
    revision: value.revision,
    group: write.group,
  };

  const result = asPrivate
    ? yield* modelsControlPlane("writePrivateKeyGroup", (stub) =>
        stub.models().writePrivateKeyGroup(change, principalId, viewer),
      )
    : yield* modelsControlPlane("writeKeyGroup", (stub) =>
        stub.models().writeKeyGroup(change, principalId),
      );

  return yield* written(result);
});

const deleteGroup = Effect.gen(function* () {
  const { value } = yield* decoded(DeleteGroupRequest);
  const { principalId } = yield* AccessPrincipal;
  const viewer = yield* currentViewer;
  const change = { family: value.family, id: value.id, revision: value.revision, group: null };

  const result =
    value.private === true || !viewer.admin
      ? yield* modelsControlPlane("writePrivateKeyGroup", (stub) =>
          stub.models().writePrivateKeyGroup(change, principalId, viewer),
        )
      : yield* modelsControlPlane("writeKeyGroup", (stub) =>
          stub.models().writeKeyGroup(change, principalId),
        );

  return yield* written(result);
});

const probe = Effect.gen(function* () {
  const { value } = yield* decoded(ProbeRequest);
  const authIndex = value.auth_index.trim();

  if (authIndex === "") return yield* replyError(400, "auth_index is required");

  const viewer = yield* currentViewer;

  const resolved = yield* modelsControlPlane("providerKeyProbeTarget", (stub) =>
    stub.models().providerKeyProbeTarget(authIndex, viewer),
  );

  if (!resolved.ok) return yield* replyError(404, "api key not found");
  const result = yield* probeProviderKey(resolved.target);

  return jsonReply(200, result);
});

export const providerKeysRoutes = [
  HttpRouter.route("GET", BASE, handled(list)),
  HttpRouter.route("PUT", `${BASE}/groups`, handled(putGroup)),
  HttpRouter.route("DELETE", `${BASE}/groups`, handled(deleteGroup)),
];

/** Needs an `HttpClient` (bound in `routes.ts`). */
export const providerKeyProbeHandler = handled(probe);
