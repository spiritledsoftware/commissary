/**
 * The models.dev document (`https://models.dev/api.json`, ≈5 MB, every provider) trimmed to the providers Commissary
 * reads and the fields it uses (ADR 0020). One trimmed document feeds every provider's model catalog (`catalog.ts`)
 * and the OpenCode gateways (`opencode-catalog.ts`).
 *
 * Shared by the sync script (`bun run catalog:sync`, run by Node directly, so this module imports nothing but `effect`;
 * it imports it as `@commissary/models/models-dev`)
 * and by the cron refresh (`refresh.ts`). Decoding strips every key the schemas do not name, so the output keeps the
 * models.dev shape: trimming a trimmed document is a no-op and the runtime parser accepts both. Prices (`cost`, US
 * dollars per million tokens) are kept: they price usage records (`usage/pricing.ts`, ADR 0024). A `cost` that does not
 * decode is dropped on its own and leaves the model in the catalog. OpenCode's free tier (both prices zero) is also
 * kept as `free: true` on the two OpenCode providers. `reasoning_options: null` on a model (models.dev sends it for
 * models that reason without knobs)
 * is kept as `[]`, so "reasons, no knobs" survives trimming. A malformed model entry is skipped and counted
 * (`skipped`); a missing provider or one without any usable model rejects
 * the document, so a broken upstream document never replaces a good one.
 */
import { Effect, Result, Schema, type Types } from "effect";

/** models.dev provider ids Commissary reads; every one must be present in a document. */
export const MODELS_DEV_PROVIDERS = [
  "anthropic",
  "google",
  "google-vertex",
  "xai",
  "meta",
  "kimi-code-plan-global",
  "openai",
  "opencode",
  "opencode-go",
] as const;

export type ModelsDevProviderId = (typeof MODELS_DEV_PROVIDERS)[number];

/** Providers whose free models (both prices zero) are flagged `free`: the OpenCode gateways. */
const FREE_FLAGGED: ReadonlySet<string> = new Set(["opencode", "opencode-go"]);

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

const ReasoningOption = Schema.Struct({
  /** `effort` (`values`), `budget_tokens` (`min`/`max`) or `toggle`. */
  type: Schema.String,
  values: optional(Strings),
  min: optional(Schema.Finite),
  max: optional(Schema.Finite),
});

export type ReasoningOption = typeof ReasoningOption.Type;

/** What a model charges per million tokens of each kind, in US dollars; a kind models.dev does not list is absent. */
const RateFields = {
  input: optional(Schema.Finite),
  output: optional(Schema.Finite),
  cache_read: optional(Schema.Finite),
  cache_write: optional(Schema.Finite),
};

const Rates = Schema.Struct(RateFields);

/**
 * A model's prices. `tiers` are models.dev's long-context prices (`tier.size` is the context length above which they
 * apply); `context_over_200k` is the older spelling of the 200k tier. The audio prices models.dev also lists are not
 * read.
 */
export const Cost = Schema.Struct({
  ...RateFields,
  reasoning: optional(Schema.Finite),
  tiers: optional(
    Schema.Array(
      Schema.Struct({
        ...RateFields,
        tier: optional(Schema.Struct({ type: Schema.String, size: Schema.Finite })),
      }),
    ),
  ),
  context_over_200k: optional(Rates),
});

export type ModelsDevCost = typeof Cost.Type;

const ModelFields = {
  id: Schema.String,
  name: optional(Schema.String),
  description: optional(Schema.String),
  /** `deprecated` (and possibly `alpha`/`beta`). */
  status: optional(Schema.String),
  /** `YYYY-MM-DD` (sometimes `YYYY-MM`). */
  release_date: optional(Schema.String),
  reasoning: optional(Schema.Boolean),
  reasoning_options: optional(Schema.Array(ReasoningOption)),
  modalities: optional(Schema.Struct({ input: optional(Strings), output: optional(Strings) })),
  limit: optional(
    Schema.Struct({
      context: optional(Schema.Finite),
      input: optional(Schema.Finite),
      output: optional(Schema.Finite),
    }),
  ),
  /** Per-model AI SDK package; overrides the provider's `npm`. */
  provider: optional(Schema.Struct({ npm: optional(Schema.String) })),
  /** Prices; a malformed one is dropped rather than failing the model. */
  cost: optional(Cost.pipe(Schema.catchDecoding(() => Effect.succeedNone))),
};

/** A trimmed model. */
export const ModelsDevModel = Schema.Struct({ ...ModelFields, free: optional(Schema.Boolean) });

export type ModelsDevModel = typeof ModelsDevModel.Type;

/** A model as models.dev sends it. */
const RawModel = Schema.Struct({
  ...ModelFields,
  reasoning_options: optional(Schema.NullOr(Schema.Array(ReasoningOption))),
  free: optional(Schema.Boolean),
});

const ProviderHead = Schema.Struct({
  name: optional(Schema.String),
  /** Default AI SDK package of the provider's models. */
  npm: optional(Schema.String),
  /** Gateway base URL. */
  api: optional(Schema.String),
  /** Model entries stay undecoded here: each is decoded on its own so one bad entry does not reject the provider. */
  models: Schema.Record(Schema.String, Schema.Unknown),
});

export interface ModelsDevProvider {
  readonly id: ModelsDevProviderId;
  readonly name?: string;
  readonly npm?: string;
  readonly api?: string;
  /** By model id. */
  readonly models: Readonly<Record<string, ModelsDevModel>>;
}

export type ModelsDevCatalog = Readonly<Record<ModelsDevProviderId, ModelsDevProvider>>;

export type TrimResult =
  | {
      readonly ok: true;
      readonly value: ModelsDevCatalog;
      /** Model entries that did not decode and were left out (a new shape upstream, a type change). */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly error: string };

const Document = Schema.Struct(
  Object.fromEntries(MODELS_DEV_PROVIDERS.map((id) => [id, ProviderHead])),
);

const decodeDocument = Schema.decodeUnknownResult(Schema.fromJsonString(Document));

const decodeModel = Schema.decodeUnknownResult(RawModel);

type Head = typeof ProviderHead.Type;

const trimModel = (id: ModelsDevProviderId, raw: typeof RawModel.Type): ModelsDevModel => {
  const { free, ...rest } = raw;
  const { cost } = rest;
  const isFree = free === true || (FREE_FLAGGED.has(id) && cost?.input === 0 && cost.output === 0);

  // `reasoning_options: null` (reasons, no knobs) is kept as an empty list, in the key's place.
  const model: Types.Mutable<ModelsDevModel> = {
    ...rest,
    reasoning_options: rest.reasoning_options ?? [],
  };

  if (rest.reasoning_options === undefined) delete model.reasoning_options;

  return isFree ? { ...model, free: true } : model;
};

interface TrimmedProvider {
  readonly provider: ModelsDevProvider;
  readonly skipped: number;
}

const trimProvider = (
  id: ModelsDevProviderId,
  head: Head,
): Result.Result<TrimmedProvider, string> => {
  const models: Record<string, ModelsDevModel> = {};
  let skipped = 0;

  for (const key of Object.keys(head.models).toSorted()) {
    const decoded = decodeModel(head.models[key]);

    if (Result.isFailure(decoded)) {
      skipped += 1;
      continue;
    }

    const model = trimModel(id, decoded.success);
    const modelId = model.id.trim();

    if (modelId === "") {
      skipped += 1;
      continue;
    }

    models[modelId] = modelId === model.id ? model : { ...model, id: modelId };
  }

  if (Object.keys(models).length === 0) return Result.fail(`provider ${id} has no usable models`);
  const provider: Types.Mutable<Omit<ModelsDevProvider, "models">> = { id };

  if (head.name !== undefined) provider.name = head.name;

  if (head.npm !== undefined) provider.npm = head.npm;

  if (head.api !== undefined) provider.api = head.api;

  return Result.succeed({ provider: { ...provider, models }, skipped });
};

/**
 * Commissary's part of a models.dev document (JSON text, full or already trimmed). Fails when a provider is missing or
 * has no usable model.
 */
export const trimModelsDev = (text: string): TrimResult => {
  const decoded = decodeDocument(text);

  if (Result.isFailure(decoded))
    return { ok: false, error: `invalid catalog: ${String(decoded.failure)}` };
  // SAFETY: Document is built from MODELS_DEV_PROVIDERS with ProviderHead for each key (Object.fromEntries erased the key names).
  const heads = decoded.success as Readonly<Record<ModelsDevProviderId, Head>>;
  const out: Partial<Record<ModelsDevProviderId, ModelsDevProvider>> = {};
  let skipped = 0;

  for (const id of MODELS_DEV_PROVIDERS) {
    const trimmed = trimProvider(id, heads[id]);

    if (Result.isFailure(trimmed)) return { ok: false, error: trimmed.failure };
    out[id] = trimmed.success.provider;
    skipped += trimmed.success.skipped;
  }

  // SAFETY: the loop above assigns every id of MODELS_DEV_PROVIDERS, which are exactly the keys of ModelsDevCatalog.
  return { ok: true, value: out as ModelsDevCatalog, skipped };
};
