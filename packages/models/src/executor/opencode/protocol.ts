/**
 * Upstream protocol of an OpenCode Zen/Go model and the config entry behind an OpenCode credential.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"). Per attempt the protocol is, in order: the `protocol` of the credential's config `models` entry for the model,
 * `systemone` for a System One model of the gateway's catalog additions (Zen's Jev, ADR 0032: models.dev lists none, and
 * the additions win should it list one later), the model's AI SDK package in the OpenCode catalog (`opencode-catalog.ts`,
 * as OpenCode's own client decides), else `chat` (`/chat/completions`) with a warning for a model the catalog does not
 * know or a package without a gateway protocol. Gemini and System One exist only on Zen; a Go model configured or
 * catalogued as either falls back to chat.
 */
import {
  type Config,
  isOpenCodeProtocol,
  type ModelEntry,
  type OpenCodeProtocol,
} from "../../config/schema.ts";
import {
  catalogModelNpm,
  findCatalogModel,
  type OpenCodeCatalog,
  type OpenCodeCatalogModel,
  protocolForNpm,
} from "../../registry/opencode-catalog.ts";
import { additionRecord } from "../../registry/catalog-additions.ts";
import { catalogAdditions } from "../../registry/catalog.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { parseSuffix } from "@commissary/translation/thinking";
import { OPENCODE_SPECS, OPENCODE_ZEN, type OpenCodeProvider } from "./providers.ts";

export interface OpenCodeKeyConfig {
  readonly providerKey: string;
  readonly models: ReadonlyArray<ModelEntry>;
  /** The key's `cloak.mode` (OpenCode Zen free-tier cloak, ADR 0033), when set. */
  readonly cloakMode?: string;
}

/** The keys of `api-keys.<provider>` in the flat order the credential synthesiser numbers them (`config_index`). */
const flatKeys = (config: Config, provider: OpenCodeProvider): OpenCodeKeyConfig[] =>
  config["api-keys"][provider].flatMap((group) =>
    group.keys.map((key) => ({
      providerKey: key["api-key"].trim(),
      models: key.models ?? group.models ?? [],
      ...(key.cloak?.mode === undefined ? {} : { cloakMode: key.cloak.mode }),
    })),
  );

/** The config key behind a credential: `config_index` when its secret matches, else the first key with that secret. */
export const resolveOpenCodeKeyConfig = (
  config: Config,
  credential: CredentialSnapshot,
  provider: OpenCodeProvider,
): OpenCodeKeyConfig | undefined => {
  const keys = flatKeys(config, provider);
  const providerKey = (credential.attributes["api_key"] ?? "").trim();
  const rawIndex = (credential.attributes["config_index"] ?? "").trim();

  if (/^\d+$/.test(rawIndex)) {
    const entry = keys[Number(rawIndex)];

    if (entry !== undefined && (providerKey === "" || entry.providerKey === providerKey))
      return entry;
  }

  return providerKey === "" ? undefined : keys.find((entry) => entry.providerKey === providerKey);
};

const eq = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The `models` entry of the upstream model: upstream `name` first, then `alias`. */
export const findModelEntry = (
  models: ReadonlyArray<ModelEntry>,
  model: string,
): ModelEntry | undefined => {
  const base = parseSuffix(model.trim()).modelName.trim();

  if (base === "") return undefined;

  return (
    models.find((entry) => eq(parseSuffix(entry.name.trim()).modelName.trim(), base)) ??
    models.find((entry) => eq((entry.alias ?? "").trim(), base))
  );
};

export interface ResolvedProtocol {
  readonly protocol: OpenCodeProtocol;
  /**
   * Where the protocol came from (`catalog`: models.dev or the catalog additions; `fallback`: chat for want of a better
   * answer).
   */
  readonly source: "config" | "catalog" | "fallback";
  /** Why the request falls back to chat (logged by the executor). */
  readonly warning?: string;
  /** The config `models` entry of the model, if any. */
  readonly entry?: ModelEntry;
  /** The catalog model, if the catalog knows it. */
  readonly catalogModel?: OpenCodeCatalogModel;
}

/** Whether the gateway has the protocol's endpoint: Gemini and System One exist only on Zen. */
export const supportsOpenCodeProtocol = (
  provider: OpenCodeProvider,
  protocol: OpenCodeProtocol,
): boolean => (protocol !== "gemini" && protocol !== "systemone") || provider === OPENCODE_ZEN;

/** Whether the gateway's catalog additions hold `model` as a System One model (Zen's Jev). */
const isSystemOneAddition = (provider: OpenCodeProvider, model: string): boolean =>
  additionRecord(catalogAdditions(), provider, model)?.type === EntryOnlyFormats.SystemOne;

/** The protocol an attempt uses for `model` (suffix allowed) on `provider`. */
export const resolveOpenCodeProtocol = (input: {
  readonly config: Config;
  readonly credential: CredentialSnapshot;
  readonly provider: OpenCodeProvider;
  readonly model: string;
  readonly catalog: OpenCodeCatalog;
}): ResolvedProtocol => {
  const { provider, catalog } = input;
  const base = parseSuffix(input.model.trim()).modelName.trim();
  const key = resolveOpenCodeKeyConfig(input.config, input.credential, provider);
  const entry = key === undefined ? undefined : findModelEntry(key.models, base);
  const catalogModel = findCatalogModel(catalog, provider, base);

  const known = {
    ...(entry === undefined ? {} : { entry }),
    ...(catalogModel === undefined ? {} : { catalogModel }),
  };

  const name = OPENCODE_SPECS[provider].displayName;

  // Validated at config load; anything else (only reachable with an unvalidated config) is ignored.
  if (isOpenCodeProtocol(entry?.protocol)) {
    if (supportsOpenCodeProtocol(provider, entry.protocol))
      return { protocol: entry.protocol, source: "config", ...known };

    return {
      protocol: "chat",
      source: "fallback",
      warning: `${name} has no ${entry.protocol} endpoint (model ${base}); using /chat/completions`,
      ...known,
    };
  }

  if (supportsOpenCodeProtocol(provider, "systemone") && isSystemOneAddition(provider, base))
    return { protocol: "systemone", source: "catalog", ...known };

  if (catalogModel === undefined) {
    return {
      protocol: "chat",
      source: "fallback",
      warning: `model ${base} is not in the ${name} catalog; using /chat/completions`,
      ...known,
    };
  }

  const npm = catalogModelNpm(catalog, provider, catalogModel);
  const protocol = protocolForNpm(npm, provider);

  if (protocol === undefined) {
    return {
      protocol: "chat",
      source: "fallback",
      warning: `${name} model ${base} uses the unknown AI SDK package ${npm}; using /chat/completions`,
      ...known,
    };
  }

  return { protocol, source: "catalog", ...known };
};
