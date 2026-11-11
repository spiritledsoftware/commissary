/**
 * Codex `is-compat` resolution.
 *
 * Go source: internal/runtime/executor/codex_executor_auth.go (resolveCodexModelIsCompat, resolveCodexKeyConfig),
 * sdk/cliproxy/auth/api_key_model_capabilities.go (CodexAPIKeyModelIsCompat).
 */
import type { Config, ModelEntry } from "../../config/schema.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import type { CredentialSnapshot } from "../picker.ts";
import type { ExecutionContext, ExecutorRequest } from "../types.ts";

interface FlatEntry {
  readonly providerKey: string;
  readonly baseUrl: string;
  readonly models: ReadonlyArray<ModelEntry>;
}

/** The `api-keys.codex` keys in the flat order the credential synthesiser numbers them (`config_index`). */
const flatEntries = (config: Config): FlatEntry[] => {
  const out: FlatEntry[] = [];

  for (const group of config["api-keys"].codex) {
    for (const key of group.keys) {
      out.push({
        providerKey: key["api-key"].trim(),
        baseUrl: (group["base-url"] ?? "").trim(),
        models: key.models ?? group.models ?? [],
      });
    }
  }

  return out;
};

const eq = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** `resolveCodexKeyConfig`: the config entry of a provider-key credential (index first, then key + base URL). */
export const resolveCodexKeyConfig = (
  config: Config,
  credential: CredentialSnapshot,
): FlatEntry | undefined => {
  const attrKey = (credential.attributes["api_key"] ?? "").trim();
  const attrBase = (credential.attributes["base_url"] ?? "").trim();
  const entries = flatEntries(config);
  const rawIndex = (credential.attributes["config_index"] ?? "").trim();

  if (/^\d+$/.test(rawIndex)) {
    const entry = entries[Number(rawIndex)];

    if (
      entry !== undefined &&
      (attrKey === "" || eq(entry.providerKey, attrKey)) &&
      (attrBase === "" || eq(entry.baseUrl, attrBase))
    )
      return entry;
  }

  for (const entry of entries) {
    if (attrKey !== "" && attrBase !== "") {
      if (eq(entry.providerKey, attrKey) && eq(entry.baseUrl, attrBase)) return entry;
      continue;
    }

    if (
      attrKey !== "" &&
      eq(entry.providerKey, attrKey) &&
      (entry.baseUrl === "" || eq(entry.baseUrl, attrBase))
    )
      return entry;

    if (attrKey === "" && attrBase !== "" && eq(entry.baseUrl, attrBase)) return entry;
  }

  if (attrKey !== "") return entries.find((entry) => eq(entry.providerKey, attrKey));

  return undefined;
};

/** `CodexAPIKeyModelIsCompat`: the config model whose name/alias equals the (suffix-stripped) model. */
const configModelIsCompat = (
  config: Config,
  credential: CredentialSnapshot,
  model: string,
): boolean => {
  if (credential.provider.trim().toLowerCase() !== "codex") return false;
  const entry = resolveCodexKeyConfig(config, credential);

  if (entry === undefined || entry.models.length === 0) return false;
  const requested = model.trim();

  if (requested === "") return false;
  const stripped = parseSuffix(requested).modelName.trim();
  const base = stripped === "" ? requested : stripped;

  for (const candidate of entry.models) {
    let name = candidate.name.trim();
    let alias = (candidate.alias ?? "").trim();

    if (name === "") name = alias;

    if (alias === "") alias = name;

    if (name === "") continue;

    if (eq(name, requested) || eq(name, base) || eq(alias, requested) || eq(alias, base))
      return candidate["is-compat"] === true;
  }

  return false;
};

/** The upstream model names configured on a provider-key credential's entry (an entry without a name uses its alias). */
export const configuredUpstreamNames = (config: Config, credential: CredentialSnapshot): string[] =>
  (resolveCodexKeyConfig(config, credential)?.models ?? []).map((model) =>
    model.name.trim() !== "" ? model.name : (model.alias ?? ""),
  );

/**
 * `resolveCodexModelIsCompat`: the resolved model info wins; without one the credential's config entry decides (a
 * non-empty `models` list is authoritative), then the generic provider-key capability lookup.
 */
export const resolveCodexModelIsCompat = (
  config: Config,
  credential: CredentialSnapshot,
  request: Pick<ExecutorRequest, "model" | "modelInfo">,
  baseModel: string,
): boolean => {
  if (request.modelInfo !== undefined) return request.modelInfo.isCompat === true;
  const entry = resolveCodexKeyConfig(config, credential);

  if (entry !== undefined && entry.models.length > 0) {
    const requested = request.model.trim();
    const target = baseModel.trim();

    for (const model of entry.models) {
      const name = model.name.trim();
      const alias = (model.alias ?? "").trim();

      if (
        (target !== "" && (eq(name, target) || eq(alias, target))) ||
        (requested !== "" && (eq(name, requested) || eq(alias, requested)))
      )
        return model["is-compat"] === true;
    }

    return false;
  }

  return (
    configModelIsCompat(config, credential, baseModel) ||
    configModelIsCompat(config, credential, request.model)
  );
};

/** `resolveCodexModelIsCompat` of an attempt's request: the model it names, without its `(thinking)` suffix. */
export const isCompatModel = (
  context: Pick<ExecutionContext, "config" | "credential">,
  request: Pick<ExecutorRequest, "model" | "modelInfo">,
): boolean =>
  resolveCodexModelIsCompat(
    context.config,
    context.credential,
    request,
    parseSuffix(request.model).modelName,
  );
