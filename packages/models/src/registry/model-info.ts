/**
 * Model records of the registry.
 *
 * Go source: internal/registry/model_registry.go (`ModelInfo`, `ThinkingSupport`, `ModelConfig`, `NativeCapabilities`,
 * `cloneModelInfo`). `ModelInfo` is the camelCase counterpart of the Go struct and structurally satisfies
 * `ThinkingModelInfo` (`@commissary/translation/thinking`), so it can be handed to the thinking pipeline as is.
 *
 * Go zero values mean "absent" for every optional field (`omitempty`, `> 0` checks), so consumers test truthiness
 * instead of `=== undefined`.
 */
import { Schema, type Types } from "effect";
import { BETWEEN_TOOLS, type DisableType } from "@commissary/translation/thinking";

export interface ThinkingSupport {
  readonly min?: number;
  readonly max?: number;
  readonly zeroAllowed?: boolean;
  readonly dynamicAllowed?: boolean;
  /** Claude `thinking.type` that turns thinking off; absent means `disabled` (`between_tools` on claude-sonnet-5-5). */
  readonly disableType?: DisableType;
  readonly levels?: readonly string[];
}

export interface NativeCapabilities {
  /** Tri-state like the Go `*bool`: `undefined`/`null` = unknown. */
  readonly webSearch?: boolean | null;
}

export interface ModelInfo {
  readonly id: string;
  /** Upstream model id when `id` is an alias or carries a prefix (Go `MetadataModelID`, runtime only). */
  readonly metadataModelId?: string;
  /** Thinking support was configured explicitly (runtime only). */
  readonly explicitThinking?: boolean;
  readonly explicitInputModalities?: boolean;
  readonly object: string;
  readonly created: number;
  readonly ownedBy: string;
  readonly type: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly supportedGenerationMethods?: readonly string[];
  readonly contextLength?: number;
  /** Runtime only (`oauth.settings.max-context-length`, `models[].max-context-length`). */
  readonly maxContextLength?: number;
  readonly maxCompletionTokens?: number;
  readonly supportedParameters?: readonly string[];
  readonly supportedInputModalities?: readonly string[];
  readonly supportedOutputModalities?: readonly string[];
  readonly supportsWebSearch?: boolean;
  /** Understands Responses `configuration_update` input items (catalog `support_configuration_update`). */
  readonly supportConfigurationUpdate?: boolean;
  readonly nativeCapabilities?: NativeCapabilities;
  readonly thinking?: ThinkingSupport;
  readonly config?: { readonly overrideHeader?: Readonly<Record<string, string>> };
  /** Defined through config `models[]`: thinking is applied without validation (runtime only). */
  readonly userDefined?: boolean;
  readonly isCompat?: boolean;
}

/** Deep copy (registry records are shared between registrations, so derived records are always copies). */
export const cloneModelInfo = (model: ModelInfo): ModelInfo => structuredClone(model);

// --- wire format (catalog JSON, snake_case like the Go JSON tags) ---------------------------------------------------

const optionalNull = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Strings = Schema.Array(Schema.String);

const WireThinking = Schema.Struct({
  min: optionalNull(Schema.Number),
  max: optionalNull(Schema.Number),
  zero_allowed: optionalNull(Schema.Boolean),
  dynamic_allowed: optionalNull(Schema.Boolean),
  disable_type: optionalNull(Schema.Literal(BETWEEN_TOOLS)),
  levels: optionalNull(Strings),
});

/** One catalog entry (a section of the built model catalog, `catalog-build.ts`). Unknown keys are ignored like Go does. */
export const WireModel = Schema.Struct({
  id: Schema.String,
  object: optionalNull(Schema.String),
  created: optionalNull(Schema.Number),
  owned_by: optionalNull(Schema.String),
  type: optionalNull(Schema.String),
  display_name: optionalNull(Schema.String),
  name: optionalNull(Schema.String),
  version: optionalNull(Schema.String),
  description: optionalNull(Schema.String),
  inputTokenLimit: optionalNull(Schema.Number),
  outputTokenLimit: optionalNull(Schema.Number),
  supportedGenerationMethods: optionalNull(Strings),
  context_length: optionalNull(Schema.Number),
  max_completion_tokens: optionalNull(Schema.Number),
  supported_parameters: optionalNull(Strings),
  supportedInputModalities: optionalNull(Strings),
  supportedOutputModalities: optionalNull(Strings),
  supports_web_search: optionalNull(Schema.Boolean),
  support_configuration_update: optionalNull(Schema.Boolean),
  native_capabilities: optionalNull(Schema.Struct({ web_search: optionalNull(Schema.Boolean) })),
  thinking: optionalNull(WireThinking),
  config: optionalNull(
    Schema.Struct({ override_header: optionalNull(Schema.Record(Schema.String, Schema.String)) }),
  ),
});

export type WireModel = typeof WireModel.Type;

/** Assigns only defined, non-null values (keeps `exactOptionalPropertyTypes` happy and drops Go zero values). */
const put = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined,
): void => {
  if (value !== undefined && value !== null) target[key] = value;
};

export const fromWire = (wire: WireModel): ModelInfo => {
  const info: Types.Mutable<ModelInfo> = {
    id: wire.id,
    object: wire.object ?? "",
    created: wire.created ?? 0,
    ownedBy: wire.owned_by ?? "",
    type: wire.type ?? "",
  };

  put(info, "displayName", wire.display_name);
  put(info, "name", wire.name);
  put(info, "version", wire.version);
  put(info, "description", wire.description);
  put(info, "inputTokenLimit", wire.inputTokenLimit);
  put(info, "outputTokenLimit", wire.outputTokenLimit);
  put(info, "supportedGenerationMethods", wire.supportedGenerationMethods);
  put(info, "contextLength", wire.context_length);
  put(info, "maxCompletionTokens", wire.max_completion_tokens);
  put(info, "supportedParameters", wire.supported_parameters);
  put(info, "supportedInputModalities", wire.supportedInputModalities);
  put(info, "supportedOutputModalities", wire.supportedOutputModalities);
  put(info, "supportsWebSearch", wire.supports_web_search);
  put(info, "supportConfigurationUpdate", wire.support_configuration_update);

  if (wire.native_capabilities !== undefined && wire.native_capabilities !== null) {
    info.nativeCapabilities =
      wire.native_capabilities.web_search === undefined
        ? {}
        : { webSearch: wire.native_capabilities.web_search };
  }

  if (wire.thinking !== undefined && wire.thinking !== null) {
    const thinking: Types.Mutable<ThinkingSupport> = {};
    put(thinking, "min", wire.thinking.min);
    put(thinking, "max", wire.thinking.max);
    put(thinking, "zeroAllowed", wire.thinking.zero_allowed);
    put(thinking, "dynamicAllowed", wire.thinking.dynamic_allowed);
    put(thinking, "disableType", wire.thinking.disable_type);
    put(thinking, "levels", wire.thinking.levels);
    info.thinking = thinking;
  }

  const overrideHeader = wire.config?.override_header;

  if (overrideHeader !== undefined && overrideHeader !== null) info.config = { overrideHeader };

  return info;
};

export const decodeWireModel = Schema.decodeUnknownSync(WireModel);
