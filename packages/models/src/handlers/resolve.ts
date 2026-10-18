/**
 * Model resolution for an inbound request: `(suffix)` parsing, `auto`, endpoint-specific model guards and provider
 * lookup, and the System One endpoint guard (ADR 0032).
 *
 * Go source: sdk/api/handlers/handlers_routing.go (getRequestDetailsWithOptions, validateImageOnlyModel,
 * validateSpeechOnlyModel, adjustExecutionProvidersForEntryProtocol), internal/util/provider.go (GetProviderName,
 * ResolveAutoModel). The thinking suffix stays inside the model string all the way to the executor.
 */
import { Effect } from "effect";
import { ExecutionError } from "../executor/errors.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { parseSuffix } from "@commissary/translation/thinking";
import { unknownModelBody } from "../credentials/selection/failures.ts";
import { ModelProviders } from "./model-providers.ts";

export interface ResolvedModel {
  readonly providers: ReadonlyArray<string>;
  /** Route model (`auto` replaced), suffix kept. */
  readonly model: string;
}

export interface ResolveOptions {
  readonly allowImageModel?: boolean;
  readonly allowSpeechModel?: boolean;
  /** Entry protocol, for provider ordering. */
  readonly entryProtocol?: string;
}

const IMAGE_ONLY_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-image-2.0",
]);

const SPEECH_ONLY_MODELS = new Set(["grok-tts", "grok-voice-tts-1.0"]);

const NATIVE_ENTRY_PROTOCOLS = new Set([
  "interactions",
  "openai",
  "openai-response",
  "claude",
  "gemini",
]);

const GEMINI_INTERACTIONS = "gemini-interactions";

/** `routeModelBaseName`: text after the last `/`. */
export const routeModelBaseName = (model: string): string => {
  const trimmed = model.trim();
  const index = trimmed.lastIndexOf("/");

  return index >= 0 && index < trimmed.length - 1 ? trimmed.slice(index + 1).trim() : trimmed;
};

const isInteractions = (provider: string) => provider.trim().toLowerCase() === GEMINI_INTERACTIONS;

/** `adjustExecutionProvidersForEntryProtocol`. */
export const adjustProvidersForEntryProtocol = (
  providers: ReadonlyArray<string>,
  entryProtocol: string | undefined,
): ReadonlyArray<string> => {
  if (entryProtocol === undefined) return providers;
  const entry = entryProtocol.trim().toLowerCase();

  if (entry === "interactions") {
    return [
      ...providers.filter(isInteractions),
      ...providers.filter((provider) => !isInteractions(provider)),
    ];
  }

  if (!NATIVE_ENTRY_PROTOCOLS.has(entry))
    return providers.filter((provider) => !isInteractions(provider));

  return providers;
};

/**
 * The System One endpoint guard (ADR 0032, no Go counterpart): `/v1/systemone` serves only models the registry types
 * `systemone`, and every other endpoint refuses them. The type is read for the model as named (prefix, alias or
 * suffixed custom name), without the suffix first. A provider lookup without types (test doubles) skips the guard.
 */
const systemOneEndpointError = Effect.fnUntraced(function* (
  guardName: string,
  candidates: ReadonlyArray<string>,
  entryProtocol: string | undefined,
) {
  const models = yield* ModelProviders;

  if (models.modelType === undefined) return undefined;
  let type: string | undefined;

  for (const candidate of new Set(candidates.flatMap((id) => [id, id.toLowerCase()]))) {
    if (candidate === "") continue;
    type = yield* models.modelType(candidate).pipe(Effect.orElseSucceed(() => undefined));

    if (type !== undefined) break;
  }

  const systemOneModel = type === EntryOnlyFormats.SystemOne;
  const systemOneEntry = entryProtocol === EntryOnlyFormats.SystemOne;

  if (systemOneModel === systemOneEntry) return undefined;

  return new ExecutionError({
    status: 400,
    code: "model_not_supported",
    message: systemOneModel
      ? `model ${guardName} is a System One model: it is only supported on /v1/systemone`
      : `model ${guardName} is not a System One model: /v1/systemone only serves System One models`,
    requestScoped: true,
  });
});

export const resolveModel = Effect.fnUntraced(function* (
  modelName: string,
  options: ResolveOptions = {},
) {
  const models = yield* ModelProviders;
  const initial = parseSuffix(modelName);
  let resolved = modelName;

  if (initial.modelName === "auto") {
    const first = yield* models.firstAvailableModel;

    if (first === undefined) {
      yield* Effect.logWarning("failed to resolve 'auto' model: no model available");
    } else {
      resolved = initial.hasSuffix ? `${first}(${initial.rawSuffix})` : first;
    }
  }

  const baseModel = parseSuffix(resolved).modelName.trim();
  const guardName = routeModelBaseName(baseModel === "" ? resolved : baseModel);

  if (IMAGE_ONLY_MODELS.has(guardName.toLowerCase()) && options.allowImageModel !== true) {
    return yield* new ExecutionError({
      status: 503,
      message: `model ${guardName} is only supported on /v1/images/generations and /v1/images/edits`,
      requestScoped: true,
    });
  }

  if (SPEECH_ONLY_MODELS.has(guardName.toLowerCase()) && options.allowSpeechModel !== true) {
    return yield* new ExecutionError({
      status: 400,
      message: `model ${guardName} is only supported on /v1/audio/speech and /v1/tts`,
      requestScoped: true,
    });
  }

  const NO_PROVIDERS: ReadonlyArray<string> = [];

  const lookup = (model: string) =>
    Effect.gen(function* () {
      if (model === "") return NO_PROVIDERS;
      const exact = yield* models.providersFor(model);

      if (exact.length > 0 || model.toLowerCase() === model) return exact;

      return yield* models.providersFor(model.toLowerCase());
    });

  let providers = yield* lookup(baseModel);

  // Custom models may be registered with their suffixed name, e.g. `my-model(8192)`.
  if (providers.length === 0 && baseModel !== resolved) providers = yield* lookup(resolved);

  if (providers.length === 0) {
    return yield* new ExecutionError({
      status: 400,
      code: "model_not_found",
      message: unknownModelBody(modelName),
      requestScoped: true,
    });
  }

  const endpointError = yield* systemOneEndpointError(
    guardName,
    [baseModel, resolved],
    options.entryProtocol,
  );

  if (endpointError !== undefined) return yield* endpointError;

  return {
    providers: adjustProvidersForEntryProtocol([...new Set(providers)], options.entryProtocol),
    model: resolved,
  } satisfies ResolvedModel;
});
