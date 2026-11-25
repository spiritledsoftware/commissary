/**
 * Schema for `requests.payload` (legacy top-level `payload`).
 *
 * Go source: internal/config/config_types.go (PayloadConfig, PayloadRule, PayloadFilterRule, PayloadModelRule) and
 * internal/config/payload_replace.go (PayloadReplaceRule, PayloadReplaceTarget, PayloadReplacement).
 * Every field is optional like the Go zero values; the engine treats missing values as empty.
 */
import { Effect, Schema } from "effect";

/** Parameter values are arbitrary JSON (`null` is a meaningful value for `override`). */
const ParamValue = Schema.MutableJson;

export const PayloadModelRule = Schema.Struct({
  /** Model name or `*` wildcard pattern (`gpt-*`, `*-5`, `gemini-*-pro`). */
  name: Schema.optionalKey(Schema.String),
  /** Target (provider) protocol, case-insensitive. */
  protocol: Schema.optionalKey(Schema.String),
  /** Header name -> wildcard pattern; every entry must match. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Source (client) protocol; `openai-response(s)`/`response` normalise to `responses`. */
  "from-protocol": Schema.optionalKey(Schema.String),
  /** Every `path: value` pair must be present and equal. */
  match: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, ParamValue))),
  /** No `path: value` pair may match. */
  "not-match": Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, ParamValue))),
  /** Paths that must exist and not be null. */
  exist: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Paths that must be missing or null. */
  "not-exist": Schema.optionalKey(Schema.Array(Schema.String)),
});

export type PayloadModelRule = typeof PayloadModelRule.Type;

export const PayloadRule = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(PayloadModelRule)),
  /** gjson/sjson path -> value (`*-raw` rules: raw JSON text or any JSON value). */
  params: Schema.optionalKey(Schema.Record(Schema.String, ParamValue)),
});

export type PayloadRule = typeof PayloadRule.Type;

export const PayloadFilterRule = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(PayloadModelRule)),
  /** Paths to delete. */
  params: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type PayloadFilterRule = typeof PayloadFilterRule.Type;

export const INVALID_REPLACEMENT_ERROR =
  "payload replacement must contain either one string mapping or pattern and replacement";

/** The shape of a replacement entry: one key (a literal), exactly `pattern` and `replacement` (a regex), or neither. */
export const payloadReplacementKind = (
  entry: Readonly<Record<string, string>>,
): "literal" | "regex" | undefined => {
  const keys = Object.keys(entry);

  if (keys.length === 1) return "literal";

  return keys.length === 2 && Object.hasOwn(entry, "pattern") && Object.hasOwn(entry, "replacement")
    ? "regex"
    : undefined;
};

/**
 * One replacement step: a literal `{ "from": "to" }` (exactly one key) or a Go RE2 regex
 * `{ pattern, replacement }` (exactly those two keys). Other shapes fail to decode, as they fail Go's config load.
 * An empty destination or replacement deletes the matched text.
 */
export const PayloadReplacement = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(
    (entry: Readonly<Record<string, string>>) =>
      payloadReplacementKind(entry) !== undefined || INVALID_REPLACEMENT_ERROR,
  ),
);

export type PayloadReplacement = typeof PayloadReplacement.Type;

/**
 * What a replace rule edits: JSON `paths` (relative to the payload root), or the one-based `positions` (or `all`) of
 * one `role`'s messages in the final upstream body. Paths and role selectors are mutually exclusive.
 */
export const PayloadReplaceTarget = Schema.Struct({
  /** `system`, `developer` or `user`. */
  role: Schema.optionalKey(Schema.String),
  /** One-based positions among the role's messages; a top-level system field counts as the first system message. */
  positions: Schema.optionalKey(Schema.Array(Schema.Int)),
  /** Every message of the role instead of `positions`. */
  all: Schema.optionalKey(Schema.Boolean),
  /** gjson paths to existing string values; an alternative to `role`. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type PayloadReplaceTarget = typeof PayloadReplaceTarget.Type;

export const PayloadReplaceRule = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(PayloadModelRule)),
  target: Schema.optionalKey(PayloadReplaceTarget),
  /** Applied in order to every selected string. */
  replacements: Schema.optionalKey(Schema.Array(PayloadReplacement)),
});

export type PayloadReplaceRule = typeof PayloadReplaceRule.Type;

const RuleList = Schema.Array(PayloadRule).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

const FilterRuleList = Schema.Array(PayloadFilterRule).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

const ReplaceRuleList = Schema.Array(PayloadReplaceRule).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

export const PayloadConfig = Schema.Struct({
  default: RuleList,
  "default-raw": RuleList,
  override: RuleList,
  "override-raw": RuleList,
  replace: ReplaceRuleList,
  filter: FilterRuleList,
});

export type PayloadConfig = typeof PayloadConfig.Type;
