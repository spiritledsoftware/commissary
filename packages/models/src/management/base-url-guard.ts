/**
 * The user-supplied URLs Models fetches pass the outbound guard when they are saved (ADR 0044), not only when they are
 * used (`handlers/conductor.ts`, the guarded transports): a provider's `base_url` (key groups, a config import, auth
 * files), a Vertex service account's `token_uri` and the model catalog's source (a config import; a settings patch is
 * checked in `settings.ts`) are refused with its message. An empty or absent `base_url` means the provider's default
 * and always passes.
 */
import { Effect, Result } from "effect";
import {
  checkOutboundUrl,
  CurrentOutboundPolicy,
  type OutboundPolicy,
  type OutboundRefused,
} from "@commissary/core";
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { type Config, PROVIDER_KEY_FAMILIES } from "../config/schema.ts";
import { CATALOG_KEYWORDS } from "./settings.ts";

/** A refused `base_url`: where it is (a config path or an auth file field) and why. */
export interface RefusedBaseUrl {
  readonly path: string;
  readonly refusal: OutboundRefused;
}

const refusalOf = (value: Json | undefined, policy: OutboundPolicy) => {
  if (typeof value !== "string" || value.trim() === "") return undefined;

  const checked = checkOutboundUrl(value.trim(), policy);

  return Result.isFailure(checked) ? checked.failure : undefined;
};

/**
 * The first URL of `config` that the guard refuses: the model catalog's source (`models.catalog`, unless a keyword),
 * then the group `base-url` of every provider family.
 */
export const refusedConfigBaseUrl = Effect.fnUntraced(function* (
  config: Config,
): Effect.fn.Return<RefusedBaseUrl | undefined> {
  const policy = yield* CurrentOutboundPolicy;
  const catalog = config.models.catalog.trim();

  if (!CATALOG_KEYWORDS.has(catalog)) {
    const refusal = refusalOf(catalog, policy);

    if (refusal !== undefined) return { path: "models.catalog", refusal };
  }

  for (const family of PROVIDER_KEY_FAMILIES) {
    for (const [index, group] of config["api-keys"][family].entries()) {
      const refusal = refusalOf(group["base-url"], policy);

      if (refusal !== undefined) return { path: `api-keys.${family}[${index}].base-url`, refusal };
    }
  }

  return undefined;
});

/** The `base-url` of one provider key group as written, if the guard refuses it. */
export const refusedGroupBaseUrl = Effect.fnUntraced(function* (
  group: Json,
): Effect.fn.Return<RefusedBaseUrl | undefined> {
  if (!isJsonObject(group)) return undefined;

  const refusal = refusalOf(group["base-url"], yield* CurrentOutboundPolicy);

  return refusal === undefined ? undefined : { path: "base-url", refusal };
});

/**
 * Auth file fields Commissary fetches from: the base URL an executor or a refresh reads (`credentials/import.ts` spells
 * it canonically), and a Vertex service account's `token_uri` (nested, or in the legacy flat layout).
 */
const METADATA_URLS: ReadonlyArray<
  readonly [path: string, read: (metadata: JsonObject) => Json | undefined]
> = [
  ["base_url", (metadata) => metadata["base_url"]],
  ["base-url", (metadata) => metadata["base-url"]],
  ["api_base_url", (metadata) => metadata["api_base_url"]],
  ["token_uri", (metadata) => metadata["token_uri"]],
  [
    "service_account.token_uri",
    (metadata) => {
      const account = metadata["service_account"];

      return isJsonObject(account) ? account["token_uri"] : undefined;
    },
  ],
];

/** A URL of auth file metadata (an upload, a field patch, a Vertex import) that the guard refuses. */
export const refusedMetadataBaseUrl = Effect.fnUntraced(function* (
  metadata: Json,
): Effect.fn.Return<RefusedBaseUrl | undefined> {
  if (!isJsonObject(metadata)) return undefined;

  const policy = yield* CurrentOutboundPolicy;

  for (const [path, read] of METADATA_URLS) {
    const refusal = refusalOf(read(metadata), policy);

    if (refusal !== undefined) return { path, refusal };
  }

  return undefined;
});
