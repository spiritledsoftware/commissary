/**
 * The model registry: which credential ("client") serves which model under which provider.
 *
 * Go source: internal/registry/model_registry.go (`ModelRegistry`: `registerClientLocked`, `addModelRegistration`,
 * `GetModelProviders`, `GetModelInfo`, `GetAvailableModelInfos`, `GetModelCount`, `GetFirstAvailableModel`,
 * `ClientSupportsModel`, `modelRegistrationAvailability`, `LookupModelInfo`).
 *
 * The Go registry is a mutable process-wide singleton. Here it is an immutable index built from the assembled
 * models of all credentials (`credential-models.ts`) for one instant `now`; the ControlPlane owns the data, the
 * Worker rebuilds the index when the inputs change (see `service.ts`). Registration order follows the order of
 * `clients`, which decides "last registered wins" for model records.
 */
import { lookupStaticModelInfo, type ModelCatalogs } from "./catalog.ts";
import {
  MODEL_QUOTA_EXCEEDED_WINDOW_MS,
  type ClientProjection,
  NOT_PROJECTED,
} from "./availability.ts";
import { compareStrings } from "./compare.ts";
import { cloneModelInfo, type ModelInfo } from "./model-info.ts";

/** One credential's registration. `provider` is the registry provider key (lower-case). */
export interface ClientRegistration {
  readonly id: string;
  readonly provider: string;
  readonly models: ReadonlyArray<ModelInfo>;
  /** Scheduling state of one registered model (suspension/quota); absent = fully available. */
  readonly projection?: (model: ModelInfo) => ClientProjection | undefined;
  /** Whether this credential takes a Codex client's `tool_search` natively for the model (ignores cooldowns). */
  readonly nativeToolSearch?: (model: ModelInfo) => boolean;
}

interface Registration {
  info: ModelInfo;
  readonly infoByProvider: Map<string, ModelInfo>;
  /** Provider -> number of registrations (duplicates within one client count several times). */
  readonly providers: Map<string, number>;
  count: number;
  readonly quotaExceeded: Map<string, number>;
  readonly suspended: Map<string, string>;
  webSearch: boolean;
  readonly webSearchProviders: Set<string>;
}

const withWebSearch = (model: ModelInfo, supported: boolean): ModelInfo => {
  const copy = cloneModelInfo(model);

  if (supported) return { ...copy, supportsWebSearch: true };

  return copy;
};

/** `modelRegistrationAvailability` (without the cache expiry). */
const isRegistrationAvailable = (registration: Registration, now: number): boolean => {
  let expired = 0;

  for (const since of registration.quotaExceeded.values()) {
    if (now < since + MODEL_QUOTA_EXCEEDED_WINDOW_MS) expired += 1;
  }

  let cooldownSuspended = 0;
  let otherSuspended = 0;
  let quotaAndOtherSuspended = 0;

  for (const [clientId, reason] of registration.suspended) {
    if (reason.toLowerCase() === "quota") {
      cooldownSuspended += 1;
      continue;
    }

    otherSuspended += 1;
    const since = registration.quotaExceeded.get(clientId);

    if (since !== undefined && now < since + MODEL_QUOTA_EXCEEDED_WINDOW_MS)
      quotaAndOtherSuspended += 1;
  }

  const effective = Math.max(
    0,
    registration.count - expired - otherSuspended + quotaAndOtherSuspended,
  );

  return (
    effective > 0 ||
    (registration.count > 0 && (expired > 0 || cooldownSuspended > 0) && otherSuspended === 0)
  );
};

/** `GetModelCount`: clients that can currently serve the registration. */
const registrationCount = (registration: Registration, now: number): number => {
  let expired = 0;

  for (const since of registration.quotaExceeded.values()) {
    if (now - since < MODEL_QUOTA_EXCEEDED_WINDOW_MS) expired += 1;
  }

  let suspended = 0;

  for (const clientId of registration.suspended.keys()) {
    const since = registration.quotaExceeded.get(clientId);

    if (since !== undefined && now < since + MODEL_QUOTA_EXCEEDED_WINDOW_MS) continue;
    suspended += 1;
  }

  return Math.max(0, registration.count - expired - suspended);
};

/** One route to a public model for `resolveResponsesWebSearchCapability`. */
export interface NativeCapabilityRoute {
  readonly provider: string;
  /** Model-level flag; `undefined`/`null` = unknown. */
  readonly webSearch: boolean | null | undefined;
}

const providerPathSupportsWebSearch = (provider: string): boolean | undefined => {
  const key = provider.trim().toLowerCase();

  switch (key) {
    case "codex":
    case "xai":
    case "claude":
    case "antigravity":
      return true;
    case "openai":
    case "openai-compatibility":
    case "gemini":
    case "aistudio":
    case "vertex":
    case "kimi":
    case "kimi-ai":
    case "kimi.ai":
    case "kimi.com":
    case "interactions":
    case "gemini-interactions":
      return false;
    default:
      return key.startsWith("openai-compatible-") ? false : undefined;
  }
};

/** `ResolveResponsesWebSearchCapability`: a known unsupported route or an explicit model-level false wins. */
export const resolveResponsesWebSearchCapability = (
  routes: ReadonlyArray<NativeCapabilityRoute>,
): boolean | undefined => {
  if (routes.length === 0) return undefined;
  let unknown = false;

  for (const route of routes) {
    if (route.webSearch === false) return false;
    const path = providerPathSupportsWebSearch(route.provider);

    if (path === undefined) {
      unknown = true;
      continue;
    }

    if (!path) return false;

    if (route.webSearch === undefined || route.webSearch === null) unknown = true;
  }

  return unknown ? undefined : true;
};

export class ModelRegistryIndex {
  readonly #models = new Map<string, Registration>();
  readonly #clientModels = new Map<string, ReadonlyArray<ModelInfo>>();
  readonly #clientProviders = new Map<string, string>();
  readonly #clientNativeToolSearch = new Map<string, (model: ModelInfo) => boolean>();
  readonly #now: number;

  /** `now` (epoch ms) is the instant projections are evaluated at; availability queries take their own `now`. */
  constructor(clients: ReadonlyArray<ClientRegistration>, now: number) {
    this.#now = now;

    for (const client of clients) this.#register(client);
  }

  #register(client: ClientRegistration): void {
    const provider = client.provider.toLowerCase();
    const models = client.models.filter((model) => model.id !== "");

    if (models.length === 0) return;
    this.#clientModels.set(client.id, models);

    if (provider !== "") this.#clientProviders.set(client.id, provider);

    if (client.nativeToolSearch !== undefined)
      this.#clientNativeToolSearch.set(client.id, client.nativeToolSearch);

    const projected = new Set<string>();

    for (const model of models) {
      let registration = this.#models.get(model.id);

      if (registration === undefined) {
        registration = {
          info: cloneModelInfo(model),
          infoByProvider: new Map(),
          providers: new Map(),
          count: 0,
          quotaExceeded: new Map(),
          suspended: new Map(),
          webSearch: false,
          webSearchProviders: new Set(),
        };
        this.#models.set(model.id, registration);
      }

      registration.count += 1;

      if (model.supportsWebSearch === true) {
        registration.webSearch = true;

        if (provider !== "") registration.webSearchProviders.add(provider);
      }

      registration.info = withWebSearch(model, registration.webSearch);

      if (provider !== "") {
        registration.providers.set(provider, (registration.providers.get(provider) ?? 0) + 1);
        registration.infoByProvider.set(
          provider,
          withWebSearch(model, registration.webSearchProviders.has(provider)),
        );
      }

      if (projected.has(model.id)) continue;
      projected.add(model.id);
      const projection = client.projection?.(model) ?? NOT_PROJECTED;

      if (projection.suspended) registration.suspended.set(client.id, projection.suspendReason);

      if (projection.quotaExceeded)
        registration.quotaExceeded.set(client.id, projection.quotaSince ?? this.#now);
    }

    // A later client can add web search support for models registered earlier: keep the flag consistent.
    for (const registration of this.#models.values()) {
      if (registration.webSearch && registration.info.supportsWebSearch !== true) {
        registration.info = { ...registration.info, supportsWebSearch: true };
      }

      for (const [name, info] of registration.infoByProvider) {
        if (registration.webSearchProviders.has(name) && info.supportsWebSearch !== true) {
          registration.infoByProvider.set(name, { ...info, supportsWebSearch: true });
        }
      }
    }
  }

  /** `GetModelProviders`: providers ordered by registration count (descending), then name. */
  providersForModel(modelId: string): string[] {
    const registration = this.#models.get(modelId);

    if (registration === undefined) return [];

    return [...registration.providers]
      .filter(([, count]) => count > 0)
      .toSorted(
        ([nameA, countA], [nameB, countB]) => countB - countA || compareStrings(nameA, nameB),
      )
      .map(([name]) => name);
  }

  /** `GetModelInfo`: the provider-specific record when the provider serves the model, else the last registered. */
  modelInfo(modelId: string, provider: string): ModelInfo | undefined {
    const registration = this.#models.get(modelId);

    if (registration === undefined) return undefined;

    if (provider !== "" && (registration.providers.get(provider) ?? 0) > 0) {
      const specific = registration.infoByProvider.get(provider);

      if (specific !== undefined) return cloneModelInfo(specific);
    }

    return cloneModelInfo(registration.info);
  }

  /** `GetAvailableModelInfos`: models with at least one usable client, sorted by id. */
  availableModels(now: number = this.#now): ModelInfo[] {
    const out: ModelInfo[] = [];

    for (const registration of this.#models.values()) {
      if (isRegistrationAvailable(registration, now)) out.push(cloneModelInfo(registration.info));
    }

    return out.toSorted((a, b) => compareStrings(a.id.trim(), b.id.trim()));
  }

  /** `GetModelCount`. */
  modelCount(modelId: string, now: number = this.#now): number {
    const registration = this.#models.get(modelId);

    return registration === undefined ? 0 : registrationCount(registration, now);
  }

  /** `GetFirstAvailableModel`: the newest available model that still has a usable client (ties: smallest id). */
  firstAvailableModel(now: number = this.#now): string | undefined {
    const candidates = this.availableModels(now).toSorted((a, b) => b.created - a.created);

    return candidates.find((model) => this.modelCount(model.id, now) > 0)?.id;
  }

  /** `ClientSupportsModel`: case-insensitive, thinking suffix not considered. */
  clientSupportsModel(clientId: string, modelId: string): boolean {
    const id = modelId.trim().toLowerCase();

    if (clientId.trim() === "" || id === "") return false;

    return (this.#clientModels.get(clientId.trim()) ?? []).some(
      (model) => model.id.trim().toLowerCase() === id,
    );
  }

  /** `GetModelsForClient`. */
  modelsForClient(clientId: string): ModelInfo[] {
    return (this.#clientModels.get(clientId) ?? []).map(cloneModelInfo);
  }

  clientProvider(clientId: string): string | undefined {
    return this.#clientProviders.get(clientId);
  }

  /**
   * `GetResponsesWebSearchCapability`: conservative tri-state over every route that serves the exact public model
   * id (`true`/`false`, `undefined` = unknown).
   */
  responsesWebSearchCapability(modelId: string): boolean | undefined {
    const id = modelId.trim();

    if (id === "") return undefined;
    const routes: NativeCapabilityRoute[] = [];

    for (const [clientId, models] of this.#clientModels) {
      const matching = models.filter((model) => model.id.trim() === id);
      const last = matching[matching.length - 1];

      for (let count = 0; count < matching.length; count += 1) {
        routes.push({
          provider: this.#clientProviders.get(clientId) ?? "",
          webSearch: last?.nativeCapabilities?.webSearch,
        });
      }
    }

    return resolveResponsesWebSearchCapability(routes);
  }

  /**
   * Whether a Codex client's `tool_search` may be advertised for the exact public model id: every credential serving it
   * is a Claude one that takes native tool search for it, whatever its cooldown or suspension (so the catalog does not
   * flap). No serving credential, or any other provider, is `false`.
   */
  nativeToolSearchCapability(modelId: string): boolean {
    const id = modelId.trim();

    if (id === "") return false;
    let served = false;

    for (const [clientId, models] of this.#clientModels) {
      const matching = models.filter((model) => model.id.trim() === id);

      if (matching.length === 0) continue;
      served = true;
      const native = this.#clientNativeToolSearch.get(clientId);

      if (this.#clientProviders.get(clientId) !== "claude" || native === undefined) return false;

      if (!matching.every((model) => native(model))) return false;
    }

    return served;
  }

  /**
   * `registry.LookupModelInfo(modelID, provider)`: the registry first (provider-specific, then global), then the
   * static catalogs. This is the lookup handed to the thinking pipeline.
   */
  lookupModelInfo(catalogs: ModelCatalogs, modelId: string, provider = ""): ModelInfo | undefined {
    const id = modelId.trim();

    if (id === "") return undefined;

    return this.modelInfo(id, provider.trim().toLowerCase()) ?? lookupStaticModelInfo(catalogs, id);
  }
}
