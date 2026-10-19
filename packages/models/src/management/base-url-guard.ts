/**
 * A provider's `base_url` passes the outbound guard when it is saved (ADR 0044), not only when a request uses it
 * (`handlers/conductor.ts`): a provider key group, a config import and an auth file with a `base_url` the guard refuses
 * are refused with its message. An empty or absent `base_url` means the provider's default and always passes.
 */
import { Effect, Result } from "effect";
import {
  checkOutboundUrl,
  CurrentOutboundPolicy,
  type OutboundPolicy,
  type OutboundRefused,
} from "@commissary/core";
import { isJsonObject, type Json } from "@commissary/json";
import { type Config, PROVIDER_KEY_FAMILIES } from "../config/schema.ts";

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

/** The first group `base-url` of every provider family in `config` that the guard refuses. */
export const refusedConfigBaseUrl = Effect.fnUntraced(function* (
  config: Config,
): Effect.fn.Return<RefusedBaseUrl | undefined> {
  const policy = yield* CurrentOutboundPolicy;

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

/** Auth file fields an executor or a refresh reads a base URL from (`credentials/import.ts` spells them canonically). */
const METADATA_BASE_URLS = ["base_url", "base-url", "api_base_url"] as const;

/** A base URL of auth file metadata (an upload, a field patch) that the guard refuses. */
export const refusedMetadataBaseUrl = Effect.fnUntraced(function* (
  metadata: Json,
): Effect.fn.Return<RefusedBaseUrl | undefined> {
  if (!isJsonObject(metadata)) return undefined;

  const policy = yield* CurrentOutboundPolicy;

  for (const field of METADATA_BASE_URLS) {
    const refusal = refusalOf(metadata[field], policy);

    if (refusal !== undefined) return { path: field, refusal };
  }

  return undefined;
});
