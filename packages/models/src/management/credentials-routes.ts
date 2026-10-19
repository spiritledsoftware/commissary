/**
 * Credential (auth file) management: list, upload, delete, download, models, status, fields, refresh, cooldown reset.
 *
 * Go source: internal/api/handlers/management/auth_files.go (`ListAuthFiles`, `GetAuthFileModels`),
 * auth_files_crud.go (`UploadAuthFile`, `DeleteAuthFile`, `DownloadAuthFile`), auth_files_fields.go
 * (`PatchAuthFileStatus`, `PatchAuthFileFields`), auth_files_refresh.go (`RefreshAuthFiles`), quota.go (`ResetQuota`).
 * Auth files live in the ControlPlane Durable Object instead of a directory; the credential `id` is the file name.
 * Differences: a field patch refused for its value answers `422 {error, path}` naming the field (Go: `400`), and the
 * list masks secret-looking header values (`field-patch.ts`, `credential-entry.ts`), and the download answers only a
 * service token that is an org owner, or a platform admin (`403 download_requires_service_token` otherwise; ADR 0006's
 * rule per org, ADR 0022): the file carries the access and refresh tokens, and a service token is the credential
 * meant for automation (`docs/ACCESS.md`).
 *
 * The list also carries the provider keys whose provider reports quota with the key (OpenCode Go, `source:
 * "config"`, named by their `auth_index`; `credential-entry.ts`). File-only operations naming one of them (delete,
 * download, field edits, token refresh) answer `409 config_credential`: the key lives in the config and is edited on
 * the provider keys page. Its models are listed by the same name.
 */
import { Clock, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AccessPrincipal, AuthConfig, holdsSensitivePowers, isHosted } from "@commissary/auth";
import { isJsonObject, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { ModelRegistry } from "../registry/service.ts";
import { currentViewer } from "@commissary/auth";
import { bodyText, handled, jsonReply, queryParams, replyError } from "@commissary/core";
import { bodyJson, bodyObject } from "@commissary/state";
import { modelsControlPlane } from "../env.ts";
import { refusedMetadataBaseUrl } from "./base-url-guard.ts";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `isUnsafeAuthFileName`: empty names and anything with a path separator. */
const unsafeName = (name: string): boolean => name.trim() === "" || /[/\\]/.test(name);

// --- list ---------------------------------------------------------------------------------------------------------

interface Pagination {
  readonly page: number;
  readonly pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;

const positiveInteger = (raw: string): number | undefined => {
  const trimmed = raw.trim();

  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);

  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/** `parseAuthFilesPagination`: pagination is on when `page` or `page_size` is present. */
const parsePagination = (
  params: URLSearchParams,
): Pagination | undefined | "invalid_page" | "invalid_page_size" => {
  const page = params.get("page");
  const pageSize = params.get("page_size");

  if (page === null && pageSize === null) return undefined;
  const parsedPage = page === null ? 1 : positiveInteger(page);

  if (parsedPage === undefined) return "invalid_page";
  const parsedSize = pageSize === null ? DEFAULT_PAGE_SIZE : positiveInteger(pageSize);

  if (parsedSize === undefined) return "invalid_page_size";

  return { page: parsedPage, pageSize: parsedSize };
};

const entryName = (entry: JsonObject): string => text(entry.name);

/**
 * Fails with `409 config_credential` when `name` is a provider key's `auth_index` (the name the list gives it), so a
 * file-only operation says why it does not apply instead of answering "not found". Indexes are public: answering for
 * one confirms no key guess.
 */
const refuseConfigKey = (name: string) =>
  Effect.gen(function* () {
    const viewer = yield* currentViewer;

    const config = yield* modelsControlPlane("isConfigKey", (stub) =>
      stub.models().isConfigKey(name, viewer),
    );

    if (config) {
      return yield* replyError(409, "config_credential", {
        message: "this account is a provider key: edit or remove it on the provider keys page",
      });
    }
  });

const listCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const pagination = parsePagination(params);

  if (pagination === "invalid_page")
    return yield* replyError(400, "page must be a positive integer");

  if (pagination === "invalid_page_size")
    return yield* replyError(400, "page_size must be a positive integer");
  const name = params.get("name")?.trim() ?? "";
  // Indexes are lower-case hex; match them case-insensitively like every other `auth_index` input.
  const authIndex = params.get("auth_index")?.trim().toLowerCase() ?? "";

  const viewer = yield* currentViewer;

  const entries = yield* modelsControlPlane("listCredentialEntries", (stub) =>
    stub.models().listCredentialEntries(viewer),
  );

  const now = yield* Clock.currentTimeMillis;

  const named = entries.filter(
    (entry) =>
      (name === "" || entry.name === name || entry.id === name) &&
      (authIndex === "" || entry.auth_index === authIndex),
  );

  // What an org admin sees of other members' private credentials (existence only) is listed apart from the
  // accounts the caller manages.
  const others = named.filter((entry) => entry.limited === true);

  const matching = named
    .filter((entry) => entry.limited !== true)
    .toSorted((a, b) => {
      const left = entryName(a);
      const right = entryName(b);
      const folded = left.toLowerCase().localeCompare(right.toLowerCase());

      return folded !== 0 ? folded : left < right ? -1 : left > right ? 1 : 0;
    });

  const observedAt = new Date(now).toISOString();

  if (pagination === undefined)
    return jsonReply(200, {
      observed_at: observedAt,
      files: matching,
      ...(viewer.admin ? { others } : {}),
    });

  const total = matching.length;
  const start = Math.min((pagination.page - 1) * pagination.pageSize, total);
  const end = Math.min(start + pagination.pageSize, total);

  return jsonReply(200, {
    observed_at: observedAt,
    files: matching.slice(start, end),
    ...(viewer.admin ? { others } : {}),
    total,
    page: pagination.page,
    page_size: pagination.pageSize,
    has_more: end < total,
  });
});

// --- upload ---------------------------------------------------------------------------------------------------------

interface Upload {
  readonly name: string;
  readonly content: string;
}

/**
 * Stores one auth file; the error text is what the panel shows for that file. A plain member's upload is their private
 * credential; an org admin's is shared unless `?private=true` asks for a private one. Refused (`403`) where the org
 * does not let members hold private credentials.
 */
const storeUpload = (upload: Upload, wantPrivate: boolean) =>
  Effect.gen(function* () {
    const name = upload.name.trim();

    if (!name.toLowerCase().endsWith(".json")) return "file must be .json";

    if (unsafeName(name)) return "invalid name";

    const viewer = yield* currentViewer;

    const result = yield* modelsControlPlane("importAuthFile", (stub) =>
      stub.models().importAuthFile(name, upload.content, { private: wantPrivate }, viewer),
    );

    if (result.ok) return undefined;

    if (result.reason === "forbidden")
      return yield* replyError(403, "forbidden", { message: result.message });

    return result.reason === "name_taken" ? result.message : `invalid auth file: ${result.message}`;
  });

/**
 * Refuses (`422`, with the field's `path` and the file's `name`) an upload whose `base_url` or `token_uri` the outbound
 * guard refuses: refused when saved, not only when used (ADR 0044). Every file is checked before any is stored. A file
 * that is no JSON is the ControlPlane's to refuse.
 */
const refuseOutboundUrls = (uploads: ReadonlyArray<Upload>) =>
  Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const refused = yield* refusedMetadataBaseUrl(tryParseJson(upload.content) ?? null);

        if (refused !== undefined)
          return yield* replyError(422, refused.refusal.message, {
            path: refused.path,
            name: upload.name,
          });
      }),
    { discard: true },
  );

/** `?private=true`: the upload (or login) is for the caller's own private credential. */
const wantsPrivate = (params: URLSearchParams): boolean => params.get("private") === "true";

/** Files of a multipart form, ordered by field name like Go; `undefined` when the body is not multipart. */
const multipartUploads = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data"))
    return undefined;

  const web = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.mapError(() => replyError(400, "invalid multipart form")),
  );

  const form = yield* Effect.tryPromise({
    try: async () => await web.formData(),
    catch: (cause) =>
      replyError(
        400,
        `invalid multipart form: ${cause instanceof Error ? cause.message : "unreadable"}`,
      ),
  });

  const uploads: Upload[] = [];
  const keys = [...new Set(form.keys())].toSorted();

  for (const key of keys) {
    for (const value of form.getAll(key)) {
      if (typeof value === "string") continue;
      const content = yield* Effect.promise(async () => await value.text());
      uploads.push({ name: value.name.split(/[/\\]/).pop() ?? "", content });
    }
  }

  return uploads;
});

const uploadCredentials = Effect.gen(function* () {
  const wantPrivate = wantsPrivate(yield* queryParams);
  const uploads = yield* multipartUploads;

  if (uploads !== undefined) {
    if (uploads.length === 0) return yield* replyError(400, "no files uploaded");
    yield* refuseOutboundUrls(uploads);
    const stored: string[] = [];
    const failed: JsonObject[] = [];

    for (const upload of uploads) {
      const error = yield* storeUpload(upload, wantPrivate);

      if (error === undefined) stored.push(upload.name.trim());
      else failed.push({ name: upload.name, error });
    }

    if (uploads.length === 1) {
      return failed[0] === undefined
        ? jsonReply(200, { status: "ok" })
        : yield* replyError(400, text(failed[0].error));
    }

    if (failed.length > 0) {
      return jsonReply(207, { status: "partial", uploaded: stored.length, files: stored, failed });
    }

    return jsonReply(200, { status: "ok", uploaded: stored.length, files: stored });
  }

  const params = yield* queryParams;
  const name = params.get("name")?.trim() ?? "";

  if (unsafeName(name)) return yield* replyError(400, "invalid name");

  if (!name.toLowerCase().endsWith(".json"))
    return yield* replyError(400, "name must end with .json");
  const content = yield* bodyText;
  yield* refuseOutboundUrls([{ name, content }]);
  const error = yield* storeUpload({ name, content }, wantPrivate);

  return error === undefined ? jsonReply(200, { status: "ok" }) : yield* replyError(400, error);
});

// --- delete ---------------------------------------------------------------------------------------------------------

const unique = (names: ReadonlyArray<string>): string[] => [
  ...new Set(
    names.flatMap((name) => {
      const trimmed = name.trim();

      return trimmed === "" ? [] : [trimmed];
    }),
  ),
];

const strings = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** `requestedAuthFileNamesForDelete`: `?name=` (repeatable), else a body `{name}`, `{names}` or `[..]`. */
const namesToDelete = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const queried = unique(params.getAll("name"));

    if (queried.length > 0) return queried;
    const body = (yield* bodyText).trim();

    if (body === "") return [];

    const parsed = yield* Effect.try({
      // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
      try: () => JSON.parse(body) as Json,
      catch: () => replyError(400, "invalid request body"),
    });

    if (Array.isArray(parsed)) return unique(strings(parsed));

    if (!isJsonObject(parsed)) return yield* replyError(400, "invalid request body");

    return unique([
      ...(text(parsed.name) === "" ? [] : [text(parsed.name)]),
      ...strings(parsed.names),
    ]);
  });

const deleteCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const all = params.get("all");

  if (all === "true" || all === "1" || all === "*") {
    const viewer = yield* currentViewer;

    const entries = yield* modelsControlPlane("listCredentialEntries", (stub) =>
      stub.models().listCredentialEntries(viewer),
    );

    // "All" is the caller's own: an org admin does not remove the private credentials of members they merely see.
    const ids = entries
      .filter((entry) => entry.source === "file" && entry.limited !== true)
      .map((entry) => text(entry.id));

    const removed = yield* modelsControlPlane("removeCredentials", (stub) =>
      stub.models().removeCredentials(ids, viewer),
    );

    return jsonReply(200, { status: "ok", deleted: removed.length });
  }

  const names = yield* namesToDelete(params);

  if (names.length === 0) return yield* replyError(400, "invalid name");
  const unsafe = names.find(unsafeName);

  if (names.length === 1 && unsafe !== undefined) return yield* replyError(400, "invalid name");
  const safe = names.filter((name) => !unsafeName(name));
  const viewer = yield* currentViewer;

  const removed = yield* modelsControlPlane("removeCredentials", (stub) =>
    stub.models().removeCredentials(safe, viewer),
  );

  if (names.length === 1) {
    if (removed.length === 1) return jsonReply(200, { status: "ok" });

    yield* refuseConfigKey(names[0] ?? "");

    return yield* replyError(404, "auth file not found");
  }

  const failed = yield* Effect.forEach(
    names.filter((name) => !removed.includes(name)),
    (name) =>
      unsafeName(name)
        ? Effect.succeed({ name, error: "invalid name" })
        : modelsControlPlane("isConfigKey", (stub) => stub.models().isConfigKey(name, viewer)).pipe(
            Effect.map((config) => ({
              name,
              error: config ? "config_credential" : "auth file not found",
            })),
          ),
  );

  if (failed.length > 0)
    return jsonReply(207, { status: "partial", deleted: removed.length, files: removed, failed });

  return jsonReply(200, { status: "ok", deleted: removed.length, files: removed });
});

// --- download / models -------------------------------------------------------------------------------------------

const downloadCredential = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const viewer = yield* currentViewer;
  const name = (yield* queryParams).get("name")?.trim() ?? "";

  // A management key never downloads a credential (ADR 0026), on any deployment.
  if (identity.principal.kind === "mkey")
    return yield* replyError(403, "download_requires_service_token", {
      message: "a management key cannot download a credential file",
    });

  // On Commissary Cloud only platform admins download stored credentials, their owners included (ADR 0026).
  if (isHosted(yield* AuthConfig) && !identity.platformAdmin)
    return yield* replyError(403, "download_requires_platform_admin", {
      message: "on Commissary Cloud only a platform admin can download a credential file",
    });

  // A private credential is its owner's alone: not even an org admin with the sensitive powers downloads it.
  const { access, private: isPrivate } = yield* modelsControlPlane("credentialAccess", (stub) =>
    stub.models().credentialAccess(name, viewer),
  );

  if (access === "limited") {
    return yield* replyError(403, "private_credential", {
      message: "a private credential can be downloaded only by its owner",
    });
  }

  // Its owner may download it with their session; a shared credential keeps ADR 0006's rule.
  if (!holdsSensitivePowers(identity) && !(access === "full" && isPrivate))
    return yield* replyError(403, "download_requires_service_token", {
      message:
        "downloading a credential file discloses its tokens: call this endpoint with an Access service token that is an org owner, or as a platform admin (see docs/ACCESS.md)",
    });

  if (unsafeName(name)) return yield* replyError(400, "invalid name");

  const file = yield* modelsControlPlane("getCredentialFile", (stub) =>
    stub.models().getCredentialFile(name, viewer),
  );

  if (file === undefined) {
    yield* refuseConfigKey(name);

    return yield* replyError(404, "file not found");
  }

  return HttpServerResponse.text(JSON.stringify(file, null, 2), {
    contentType: "application/json",
    headers: { "content-disposition": `attachment; filename="${name.replace(/["\r\n]/g, "_")}"` },
  });
});

const credentialModels = Effect.gen(function* () {
  const name = (yield* queryParams).get("name")?.trim() ?? "";

  if (name === "") return yield* replyError(400, "name is required");
  const registry = yield* ModelRegistry;
  const viewer = yield* currentViewer;

  const snapshot = yield* registry.snapshot.pipe(
    Effect.mapError(() => replyError(502, "model registry unavailable")),
  );

  // Auth files by id; config keys only by their `auth_index` (the name the list gives them): a config credential id is
  // derived from its key, so answering for one would confirm guesses. The models of a private credential are its
  // owner's to see, and of a shared one an org admin's.
  const { access } = yield* modelsControlPlane("credentialAccess", (stub) =>
    stub.models().credentialAccess(name, viewer),
  );

  const file =
    access === "full" &&
    snapshot.sources.some((source) => source.source === "file" && source.id === name);

  const configId =
    file || !/^[0-9a-f]{16}$/i.test(name)
      ? undefined
      : yield* modelsControlPlane("credentialIdOfAuthIndex", (stub) =>
          stub.models().credentialIdOfAuthIndex(name.toLowerCase(), viewer),
        );

  const id =
    configId !== undefined &&
    snapshot.sources.some((source) => source.source === "config" && source.id === configId)
      ? configId
      : file
        ? name
        : undefined;

  const models = (id === undefined ? [] : snapshot.modelsForCredential(id)).map((model) => ({
    id: model.id,
    ...(model.displayName === undefined || model.displayName === ""
      ? {}
      : { display_name: model.displayName }),
    ...(model.type === "" ? {} : { type: model.type }),
    ...(model.ownedBy === "" ? {} : { owned_by: model.ownedBy }),
  }));

  return jsonReply(200, { models });
});

// --- status / fields / refresh / cooldown ------------------------------------------------------------------------

const refOf = (body: JsonObject) => {
  const name = text(body.name);
  const authIndex = text(body.auth_index);

  return { ...(name === "" ? {} : { name }), ...(authIndex === "" ? {} : { authIndex }) };
};

const patchStatus = Effect.gen(function* () {
  const body = yield* bodyObject;

  if (text(body.name) === "" && text(body.auth_index) === "")
    return yield* replyError(400, "name is required");

  if (typeof body.disabled !== "boolean") return yield* replyError(400, "disabled is required");

  const { principalId } = yield* AccessPrincipal;
  const viewer = yield* currentViewer;

  const result = yield* modelsControlPlane("setCredentialDisabledByRef", (stub) =>
    // SAFETY: typeof body.disabled === "boolean" was checked above; the narrowing is lost inside the callback.
    stub
      .models()
      .setCredentialDisabledByRef(refOf(body), body.disabled as boolean, principalId, viewer),
  );

  // A provider key is disabled through its excluded-models (`*`), like Go answers.
  if (result.ok) {
    return jsonReply(
      200,
      result.via === undefined
        ? { status: "ok", disabled: body.disabled }
        : { status: "ok", disabled: body.disabled, via: result.via, excluded_pattern: "*" },
    );
  }

  if (result.error === "config_credential") {
    return yield* replyError(
      409,
      'provider keys are disabled by adding "*" to their excluded-models in the config',
    );
  }

  if (result.error === "compat_endpoint") {
    return yield* replyError(
      409,
      "OpenAI-compatible keys cannot be disabled one by one: disable the endpoint",
    );
  }

  if (result.error === "invalid") return yield* replyError(422, result.message ?? "invalid config");

  // A listed config account named by its `auth_index` (the toggle goes through the `auth_index` field instead).
  if (text(body.name) !== "") yield* refuseConfigKey(text(body.name));

  return yield* replyError(404, "auth file not found");
});

const patchFields = Effect.gen(function* () {
  const body = yield* bodyObject;
  const name = text(body.name);

  if (name === "") return yield* replyError(400, "name is required");
  const { name: _name, ...fields } = body;

  // A `base_url` the outbound guard refuses is refused when saved, not only when used (ADR 0044).
  const refusedBase = yield* refusedMetadataBaseUrl(fields);

  if (refusedBase !== undefined)
    return yield* replyError(422, refusedBase.refusal.message, { path: refusedBase.path });
  const viewer = yield* currentViewer;

  const result = yield* modelsControlPlane("patchCredentialFields", (stub) =>
    stub.models().patchCredentialFields({ name }, fields, viewer),
  );

  if (result.ok) return jsonReply(200, { status: "ok" });

  if (result.error === "not_found") {
    yield* refuseConfigKey(name);

    return yield* replyError(404, result.message);
  }

  // A refused value names its field (`422`, like the settings writes); a malformed request stays `400`.
  return yield* result.path === undefined
    ? replyError(400, result.message)
    : replyError(422, result.message, { path: result.path });
});

const refreshCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const raw = (yield* bodyText).trim();

  const body =
    raw === ""
      ? {}
      : yield* Effect.try({
          // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
          try: () => JSON.parse(raw) as Json,
          catch: () => replyError(400, "invalid request body"),
        });

  if (!isJsonObject(body)) return yield* replyError(400, "invalid request body");
  const all = body.all === true || params.get("all") === "true";
  const viewer = yield* currentViewer;

  if (all) {
    const results = yield* modelsControlPlane("refreshAllCredentials", (stub) =>
      stub.models().refreshAllCredentials(viewer),
    );

    return jsonReply(200, { ok: true, results });
  }

  const name = text(body.name) || (params.get("name")?.trim() ?? "");
  const authIndex = text(body.auth_index) || (params.get("auth_index")?.trim() ?? "");

  if (name === "") return yield* replyError(400, "name or all=true is required");

  const result = yield* modelsControlPlane("refreshCredential", (stub) =>
    stub.models().refreshCredential({ name, ...(authIndex === "" ? {} : { authIndex }) }, viewer),
  );

  if (result.ok) return jsonReply(200, { ok: true, auth: result.entry });

  if (result.error !== "not_found") return yield* replyError(500, result.message);

  yield* refuseConfigKey(name);

  return yield* replyError(404, "auth file not found");
});

const resetCooldown = Effect.gen(function* () {
  const body = yield* bodyJson;

  if (!isJsonObject(body)) return yield* replyError(400, "invalid request body");
  const authIndex = text(body.auth_index);

  if (authIndex === "") return yield* replyError(400, "auth_index is required");

  const viewer = yield* currentViewer;

  const result = yield* modelsControlPlane("resetCredentialCooldown", (stub) =>
    stub.models().resetCredentialCooldown({ authIndex }, viewer),
  );

  if (!result.ok) return yield* replyError(404, "auth not found");

  return jsonReply(200, { status: "ok", auth_index: result.authIndex, models: result.models });
});

const BASE = "/v9/management";

export const credentialRoutes = [
  HttpRouter.route("GET", `${BASE}/credentials`, handled(listCredentials)),
  HttpRouter.route("POST", `${BASE}/credentials`, handled(uploadCredentials)),
  HttpRouter.route("DELETE", `${BASE}/credentials`, handled(deleteCredentials)),
  HttpRouter.route("GET", `${BASE}/credentials/download`, handled(downloadCredential)),
  HttpRouter.route("PATCH", `${BASE}/credentials/status`, handled(patchStatus)),
  HttpRouter.route("PATCH", `${BASE}/credentials/fields`, handled(patchFields)),
  HttpRouter.route("POST", `${BASE}/credentials/refresh`, handled(refreshCredentials)),
  HttpRouter.route("POST", `${BASE}/routing/cooldown/reset`, handled(resetCooldown)),
];

/** Needs the `ModelRegistry` service (wired in `routes.ts`). */
export const credentialModelsHandler = handled(credentialModels);
