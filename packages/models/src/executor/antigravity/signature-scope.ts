/**
 * The Antigravity signature cache scoped to one credential (CLIProxyAPI 85225381, 06225fcf): a thinking signature one
 * Google account produced is never recovered for a request on another, nor after the credential was replaced.
 *
 * Go source: internal/runtime/executor/antigravity_executor_request.go (`antigravitySignatureCacheScope`,
 * `antigravitySignatureGrantIdentity`) and internal/cache/signature_cache.go (`WithSignatureCacheScope`,
 * `signatureCacheGroupKey`). Go keys the scope by credential id, a hash of the access and refresh tokens and the project,
 * and carries the grant identity through token refreshes in credential metadata. Commissary hashes the refresh token
 * alone (the access token without one), which a refresh keeps and a new login replaces, so no refresh step has to carry
 * it. The scope goes into the text key of the org's cache, which also scopes the `CACHE` KV entries.
 */
import { sha256Hex } from "@commissary/core";
import type { JsonObject } from "@commissary/json";
import type { MemorySignatureCache, SignatureCache } from "@commissary/translation/signature";
import { metadataString } from "../gemini/targets.ts";

const digest = (value: string): string => sha256Hex(value).slice(0, 16);

/**
 * `antigravitySignatureCacheScope`: the credential id, its grant (refresh token, else access token) and its stored
 * `project_id`, as Go reads it from the credential's metadata (a project discovered during the attempt joins the scope
 * once it is stored). Empty without a token, and an empty scope recovers and records nothing (Go
 * `RequireSignatureCacheScope`).
 */
export const antigravitySignatureScope = (credentialId: string, metadata: JsonObject): string => {
  const grant =
    metadataString(metadata, "refresh_token") || metadataString(metadata, "access_token");

  if (grant === "") return "";
  const project = metadataString(metadata, "project_id");

  return [
    `id:${credentialId.trim()}`,
    `grant:${digest(grant)}`,
    ...(project === "" ? [] : [project]),
  ].join("\0");
};

/** The key of `text` within `scope`: the scope digest goes in front, so neither the map nor KV can mix scopes. */
export const scopedSignatureText = (scope: string, text: string): string =>
  text === "" ? "" : `\0ag-scope:${digest(scope)}\0${text}`;

/** A cache that recovers and records nothing: an attempt without a scope fails closed. */
const closedCache: SignatureCache = {
  get: () => "",
  set: () => false,
  delete: () => undefined,
  clear: () => undefined,
};

/** The view of the org's cache that one credential's attempt reads and writes. */
export const scopedSignatureCache = (base: MemorySignatureCache, scope: string): SignatureCache =>
  scope === ""
    ? closedCache
    : {
        get: (modelName, text) => base.get(modelName, scopedSignatureText(scope, text)),
        set: (modelName, text, signature) =>
          text !== "" && base.set(modelName, scopedSignatureText(scope, text), signature),
        delete: (modelName, text) => base.delete(modelName, scopedSignatureText(scope, text)),
        // Clearing would drop every scope of the org: a scoped view never does.
        clear: () => undefined,
      };
