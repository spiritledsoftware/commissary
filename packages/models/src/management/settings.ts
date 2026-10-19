/**
 * The Settings page's view of the config and its typed writes (pure; served by `settings-routes.ts`, contract
 * `@commissary/contract/settings`).
 *
 * Workers addition, no Go counterpart (Go v8 edits the YAML node tree through `/config`). The owned keys are
 * `SETTINGS_TREE`; a write is a deep partial of it where `null` removes the key from the document (back to its
 * default). Values the config would silently rewrite or ignore (invalid durations, unknown strategies, a
 * `gpt-image-2-base-model` without `gpt-`, negative counts, untrimmed text) are refused with their path instead: first
 * by `validateSettings`, then by the survival check, which decodes the edited document like the ControlPlane will and
 * compares every written leaf with the normalised result. Every setting is a config entry of its own (ADR 0025,
 * `config/entries.ts`); the route turns the leaf edits into entry writes.
 */
import { Result, Schema } from "effect";
import { checkOutboundUrl, OUTBOUND_REFUSED_MESSAGE, type OutboundPolicy } from "@commissary/core";
import { parseGoDuration } from "../config/accessors.ts";
import { encodeConfig } from "../config/codec.ts";
import { Config } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject, jsonEquals, setOwn } from "@commissary/json";
import type { Revisions } from "@commissary/contract/config";
import {
  SETTINGS_TREE,
  type SettingsValues as SettingsValuesType,
  SettingsValues,
  type SettingsView,
} from "@commissary/contract/settings";

/** A refused write: the reply's status and `{error, message, path}`. */
export interface SettingsProblem {
  readonly status: 400 | 422;
  readonly error: "not_a_setting" | "invalid_setting";
  readonly message: string;
  /** Dotted config path. */
  readonly path: string;
}

/** One leaf write of a patch: `null` removes the key (default). */
export interface SettingsEdit {
  readonly path: ReadonlyArray<string>;
  readonly value: Json;
}

type PatchNode =
  | { readonly kind: "leaf"; readonly schema: Schema.Top }
  | { readonly kind: "section"; readonly children: ReadonlyMap<string, PatchNode> };

interface Tree {
  readonly [key: string]: Schema.Top | Tree;
}

const sectionOf = (tree: Tree): Map<string, PatchNode> =>
  new Map(
    Object.entries(tree).map(([key, node]): [string, PatchNode] => [
      key,
      Schema.isSchema(node)
        ? { kind: "leaf", schema: node }
        : { kind: "section", children: sectionOf(node) },
    ]),
  );

/** What a patch may address: the settings. */
const PATCH_ROOT: ReadonlyMap<string, PatchNode> = sectionOf(SETTINGS_TREE);

/** The value at `path` of a JSON document; `undefined` when absent. */
const getAtPath = (root: Json, path: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = root;

  for (const segment of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }

  return current;
};

/** `document` with `value` at `path` (sections created), or with the key removed when `value` is `null`. */
const withAtPath = (document: JsonObject, path: ReadonlyArray<string>, value: Json): JsonObject => {
  const [head, ...rest] = path;

  if (head === undefined) return document;
  const out: JsonObject = { ...document };

  if (rest.length === 0) {
    if (value === null) delete out[head];
    else setOwn(out, head, value);

    return out;
  }

  const child = Object.hasOwn(document, head) ? document[head] : undefined;
  setOwn(out, head, withAtPath(isJsonObject(child) ? child : {}, rest, value));

  return out;
};

const dotted = (path: ReadonlyArray<string>): string => path.join(".");

const problem = (
  status: SettingsProblem["status"],
  error: SettingsProblem["error"],
  path: ReadonlyArray<string>,
  message: string,
): SettingsProblem => ({ status, error, path: dotted(path), message });

const invalid = (path: ReadonlyArray<string>, message: string) =>
  problem(422, "invalid_setting", path, message);

// --- value rules ---------------------------------------------------------------------------------------------------

const BOOTSTRAP_UNLIMITED = new Set(["", "0", "none", "unlimited", "disabled", "off", "never"]);

const isPositiveDuration = (text: string): boolean => {
  const parsed = parseGoDuration(text);

  return parsed !== undefined && parsed > 0;
};

const isTimezone = (zone: string): boolean => {
  if (zone === "" || zone === "Local") return true;

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** The values of `models.catalog` that name no URL: the official source, the bundled snapshot, no refresh. */
export const CATALOG_KEYWORDS: ReadonlySet<string> = new Set(["", "embed", "disabled"]);

const NON_NEGATIVE = new Set([
  "routing.retry.request-retry",
  "routing.retry.max-retry-credentials",
  "routing.retry.max-retry-interval",
  "requests.nonstream-keepalive-interval",
  "requests.streaming.keepalive-seconds",
  "requests.streaming.bootstrap-retries",
  "oauth.auth-auto-refresh-workers",
]);

const DURATIONS = new Set([
  "routing.session-affinity-ttl",
  "multimedia.video-result-auth-cache-ttl",
]);

const CATALOGS = new Set(["models.catalog"]);

/** A value as a message names it: “EST” (the panel shows the message under the field, beside its hint). */
const quoted = (value: Json): string =>
  `“${typeof value === "string" ? value : JSON.stringify(value)}”`;

/**
 * A message when a typed value is not what Workers would apply as written (the semantic rules of each key). It names
 * the value and what it is not; the field's hint already says what is expected.
 */
const valueRule = (key: string, value: Json, policy: OutboundPolicy): string | undefined => {
  if (NON_NEGATIVE.has(key))
    return typeof value === "number" && value < 0 ? `${quoted(value)} is below 0` : undefined;

  if (typeof value === "string" && DURATIONS.has(key))
    return isPositiveDuration(value)
      ? undefined
      : `${quoted(value)} is not a duration greater than zero`;

  // A catalog URL is fetched by the cron and the panel's refresh: it passes the outbound guard (ADR 0044).
  if (typeof value === "string" && CATALOGS.has(key))
    return CATALOG_KEYWORDS.has(value) || Result.isSuccess(checkOutboundUrl(value, policy))
      ? undefined
      : OUTBOUND_REFUSED_MESSAGE;

  if (typeof value === "string" && key === "upstream.codex.stream-bootstrap-timeout") {
    const ok =
      BOOTSTRAP_UNLIMITED.has(value.toLowerCase()) ||
      (parseGoDuration(value) ?? -1) >= 0 ||
      /^\d+$/.test(value);

    return ok ? undefined : `${quoted(value)} is not a duration or whole seconds`;
  }

  if (typeof value === "string" && key === "multimedia.gpt-image-2-base-model")
    return value === "" || value.toLowerCase().startsWith("gpt-")
      ? undefined
      : `${quoted(value)} does not start with gpt-`;

  if (typeof value === "string" && key === "upstream.claude.header-defaults.timezone")
    return isTimezone(value) ? undefined : `${quoted(value)} is not an IANA time zone`;

  return undefined;
};

const checkLeaf = (
  schema: Schema.Top,
  path: ReadonlyArray<string>,
  value: Json,
  policy: OutboundPolicy,
): SettingsProblem | undefined => {
  // SAFETY: the settings leaves are plain JSON schemas without decoding services.
  const decoded = Schema.decodeUnknownResult(schema as Schema.Decoder<unknown>)(value);

  if (Result.isFailure(decoded)) return invalid(path, decoded.failure.message);
  const message = valueRule(dotted(path), value, policy);

  return message === undefined ? undefined : invalid(path, message);
};

const collect = (
  node: JsonObject,
  children: ReadonlyMap<string, PatchNode>,
  prefix: ReadonlyArray<string>,
  edits: SettingsEdit[],
  policy: OutboundPolicy,
): SettingsProblem | undefined => {
  for (const [key, value] of Object.entries(node)) {
    const path = [...prefix, key];
    const target = children.get(key);

    if (target === undefined)
      return problem(400, "not_a_setting", path, `${dotted(path)} is not a setting`);

    if (target.kind === "section") {
      if (!isJsonObject(value)) return invalid(path, "must be a mapping of settings");
      const nested = collect(value, target.children, path, edits, policy);

      if (nested !== undefined) return nested;
      continue;
    }

    if (value !== null) {
      const refused = checkLeaf(target.schema, path, value, policy);

      if (refused !== undefined) return refused;
    }

    edits.push({ path, value });
  }

  return undefined;
};

/**
 * Reads a `PATCH /settings` patch into leaf edits, refusing the first path that is not a setting (`400
 * not_a_setting`) or whose value is invalid (`422 invalid_setting`).
 */
export const validateSettings = (
  patch: JsonObject,
  policy: OutboundPolicy,
): Result.Result<ReadonlyArray<SettingsEdit>, SettingsProblem> => {
  const edits: SettingsEdit[] = [];
  const refused = collect(patch, PATCH_ROOT, [], edits, policy);

  return refused === undefined ? Result.succeed(edits) : Result.fail(refused);
};

/** The document with every edit applied: a value is written, `null` removes the key (missing keys are fine). */
export const applySettingsPatch = (
  document: JsonObject,
  edits: ReadonlyArray<SettingsEdit>,
): Result.Result<JsonObject, SettingsProblem> =>
  Result.succeed(edits.reduce((out, edit) => withAtPath(out, edit.path, edit.value), document));

/**
 * Every written leaf must be stored as sent: `normalised` is the edited document after decoding (what the
 * ControlPlane stores). A leaf the normaliser rewrites (trimmed, lower-cased, clamped) is refused with its path.
 */
export const checkSurvival = (
  edits: ReadonlyArray<SettingsEdit>,
  normalised: Config,
): SettingsProblem | undefined => {
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  const stored = encodeConfig(normalised) as Json;

  for (const edit of edits) {
    if (edit.value === null) continue;
    const kept = getAtPath(stored, edit.path);

    if (kept === undefined || !jsonEquals(kept, edit.value))
      return invalid(
        edit.path,
        kept === undefined
          ? "would not be kept by the configuration"
          : `would be stored as ${JSON.stringify(kept)}`,
      );
  }

  return undefined;
};

// --- view ----------------------------------------------------------------------------------------------------------

const valuesJson = (tree: Tree, source: Json, prefix: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(
    Object.entries(tree).map(([key, node]) => {
      const path = [...prefix, key];

      // A missing leaf is an unset Go pointer (`null` in the view).
      return [
        key,
        Schema.isSchema(node) ? (getAtPath(source, path) ?? null) : valuesJson(node, source, path),
      ];
    }),
  );

const decodeValues = Schema.decodeUnknownSync(SettingsValues);

/** The Settings-owned values of `config` (defaults filled, unset tri-states `null`). */
export const settingsValues = (config: Config): SettingsValuesType =>
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  decodeValues(valuesJson(SETTINGS_TREE, encodeConfig(config) as Json, []));

let defaultValues: SettingsValuesType | undefined;

const defaults = (): SettingsValuesType =>
  (defaultValues ??= settingsValues(Schema.decodeUnknownSync(Config)({})));

export interface SettingsViewInput {
  readonly config: Config;
  readonly version: number;
  /** The revision of every stored setting (`config/store.ts`). */
  readonly revisions: Revisions;
  /** Epoch milliseconds of the last write; 0 when nothing was stored. */
  readonly updatedAt: number;
  readonly prefixedCredentials: number;
}

/** `GET /settings`: values, defaults and the read-only context. Never carries a secret. */
export const settingsView = (input: SettingsViewInput): SettingsView => {
  const { config } = input;
  const payload = config.requests.payload;

  return {
    version: input.version,
    revisions: input.revisions,
    ...(input.updatedAt > 0 ? { updated_at: new Date(input.updatedAt).toISOString() } : {}),
    values: settingsValues(config),
    defaults: defaults(),
    payload: {
      default: payload.default.length,
      "default-raw": payload["default-raw"].length,
      override: payload.override.length,
      "override-raw": payload["override-raw"].length,
      filter: payload.filter.length,
    },
    prefixed_credentials: input.prefixedCredentials,
    request_scoped_errors: config.oauth["request-scoped-errors"],
  };
};
