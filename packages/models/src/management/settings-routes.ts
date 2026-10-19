/**
 * `GET|PATCH /v9/management/settings` and `POST /v9/management/settings/import` (`SettingsGroup` in
 * @commissary/contract/settings): the control panel's Settings page and the Go config import.
 *
 * Workers addition, no Go counterpart (Go's panel edits `/config` paths without a version). Every setting is a config
 * entry of its own (ADR 0025, `config/entries.ts`): the view carries the revision of every stored setting, and a
 * write names the revision of each setting it changes (absent = 0, not stored). The ControlPlane refuses the write
 * with `409 conflict` when one of them changed since; writes to other settings never conflict. The patch is checked
 * (`settings.ts`: owned paths, value rules, survival through the config decoder) before anything is stored; refusals
 * carry `{error, message, path}`.
 *
 * The import replaces every config entry of the org with a Go config document (YAML or JSON, v8 or legacy layout) in
 * one transaction, and answers the keys that have no effect on Workers, which it does not store (ADR 0015). It is the
 * one write of the whole configuration. Who manages the org is not part of it (members, ADR 0022): a document's
 * `access.admin-*` lists are named as not applied. A key whose secret is already stored keeps that key's credential
 * id.
 */
import { Effect, Result, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "@commissary/auth";
import { decodeConfig, parseConfigYaml } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type JsonObject } from "@commissary/json";
import { Revisions } from "@commissary/contract/config";
import { boundedBodyText, handled, jsonReply, replyError } from "@commissary/core";
import { bodyJson } from "@commissary/state";
import { currentViewer } from "@commissary/auth";
import {
  applySettingsPatch,
  checkSurvival,
  type SettingsProblem,
  settingsView,
  validateSettings,
} from "./settings.ts";
import { modelsControlPlane } from "../env.ts";
import { refusedConfigBaseUrl } from "./base-url-guard.ts";

const PATH = "/v9/management/settings";

/** The largest config document the import takes. */
const MAX_IMPORT_BYTES = 512 * 1024;

const refuse = (refused: SettingsProblem) =>
  replyError(refused.status, refused.error, { message: refused.message, path: refused.path });

const orRefuse = <A>(result: Result.Result<A, SettingsProblem>) =>
  Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(refuse(result.failure));

const failIf = (refused: SettingsProblem | undefined) =>
  refused === undefined ? Effect.void : Effect.fail(refuse(refused));

/**
 * The org's config as its entries make it up, with the revision of every entry; a failed decode of the assembled
 * document is an internal error.
 */
export const storedConfig = Effect.gen(function* () {
  const wire = yield* modelsControlPlane("configEntries", (stub) => stub.models().configEntries());

  const config = yield* decodeStoredConfig(wire.document).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  // SAFETY: the assembled config document is always a serialized JSON object (`ConfigStore.current`).
  const document = JSON.parse(wire.document) as JsonObject;

  return {
    version: wire.version,
    updatedAt: wire.updatedAt,
    revisions: wire.revisions,
    document,
    config,
  };
});

const view = Effect.gen(function* () {
  const current = yield* storedConfig;
  const viewer = yield* currentViewer;

  const sources = yield* modelsControlPlane("listModelSources", (stub) =>
    stub.models().listModelSources(viewer),
  );

  return jsonReply(
    200,
    settingsView({
      config: current.config,
      version: current.version,
      revisions: current.revisions.settings,
      updatedAt: current.updatedAt,
      prefixedCredentials: sources.filter(
        (source) => source.owner === undefined && (source.prefix ?? "").trim() !== "",
      ).length,
    }),
  );
});

const SaveBody = Schema.Struct({ revisions: Revisions });

const invalidBody = () => replyError(400, "invalid body");

const save = Effect.gen(function* () {
  const raw = yield* bodyJson;

  if (!isJsonObject(raw) || !isJsonObject(raw.patch)) return yield* invalidBody();

  const { revisions } = yield* Schema.decodeUnknownEffect(SaveBody)(raw).pipe(
    Effect.mapError(invalidBody),
  );

  const edits = yield* orRefuse(validateSettings(raw.patch));
  const current = yield* storedConfig;
  const edited = yield* orRefuse(applySettingsPatch(current.document, edits));

  // Dry run through the decoder (what the ControlPlane will assemble): every written value must be kept as sent.
  const normalised = yield* decodeConfig(edited).pipe(
    Effect.mapError((error) => replyError(422, "invalid_setting", { message: error.message })),
  );

  yield* failIf(checkSurvival(edits, normalised));
  const identity = yield* AccessPrincipal;

  const changes = edits.map((edit) => {
    const id = edit.path.join(".");

    return {
      id,
      revision: Object.hasOwn(revisions, id) ? (revisions[id] ?? 0) : 0,
      value: edit.value,
    };
  });

  const result = yield* modelsControlPlane("writeSettings", (stub) =>
    stub.models().writeSettings(changes, identity.principalId),
  );

  if (result.ok)
    return jsonReply(200, { status: "ok", version: result.version, revisions: result.revisions });

  if (result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  return yield* replyError(422, "invalid_setting", { message: result.message });
});

/** `POST /settings/import`: replaces every config entry with a Go config document. */
const importDocument = Effect.gen(function* () {
  const text = yield* boundedBodyText(MAX_IMPORT_BYTES);
  const parsed = yield* Effect.result(parseConfigYaml(text));

  if (Result.isFailure(parsed)) {
    const error = parsed.failure;

    return yield* replyError(422, "invalid_config", {
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.column === undefined ? {} : { column: error.column }),
    });
  }

  // A provider's `base-url` the outbound guard refuses is refused when saved, not only when used (ADR 0044).
  const refusedBase = yield* refusedConfigBaseUrl(parsed.success);

  if (refusedBase !== undefined)
    return yield* replyError(422, "invalid_config", {
      message: refusedBase.refusal.message,
      path: refusedBase.path,
    });

  const identity = yield* AccessPrincipal;

  const result = yield* modelsControlPlane("importConfig", (stub) =>
    stub.models().importConfig(text, identity.principalId),
  );

  if (!result.ok && result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  if (!result.ok)
    return yield* replyError(422, "invalid_config", {
      message: result.message,
      ...(result.path === undefined ? {} : { path: result.path }),
      ...(result.line === undefined ? {} : { line: result.line }),
      ...(result.column === undefined ? {} : { column: result.column }),
    });

  if (result.notApplied.length > 0)
    yield* Effect.logWarning("config import: keys not applied on Workers (see MIGRATION.md)").pipe(
      Effect.annotateLogs({ keys: result.notApplied.join(", ") }),
    );

  return jsonReply(200, {
    status: "ok",
    version: result.version,
    not_applied: [...result.notApplied],
  });
});

export const settingsRoutes = [
  HttpRouter.route("GET", PATH, handled(view)),
  HttpRouter.route("PATCH", PATH, handled(save)),
  HttpRouter.route("POST", `${PATH}/import`, handled(importDocument)),
];
