// The Settings page's model: which setting lives in which section, the form's inputs for a value and back, the
// client-side checks that mirror the server's (`packages/models/src/management/settings.ts`), the patch a section's draft
// becomes, and the rebase of a draft onto a newer view. Pure: no DOM, tested in test/settings.test.ts.
//
// A section's draft is a delta: the inputs the operator touched, by dotted config path. Everything else shows the
// view. A save sends only the leaves that differ from the view, `null` for a value equal to the default (the entry is
// removed and the default applies), with the revision of each of those settings (every setting is a config entry of
// its own, ADR 0025). When one of them changed meanwhile (409), the same delta is re-applied to a fresh read once,
// unless a field it changes moved on the server; then the page lists those fields.
import { Effect, Predicate, Schema } from "effect";
import { ManagementError } from "@commissary/contract/errors";
import {
  type DisableImageGeneration,
  type SaveSettings,
  type SettingsPatch as SettingsPatchType,
  SettingsPatch,
  type SettingsValues,
  type SettingsView,
} from "@commissary/contract/settings";

// ---------------------------------------------------------------------------------------------------------------
// Fields

/** A settings leaf as the contract carries it: text, a number, a flag, an unset tri-state, or a list of text. */
export type SettingValue = string | number | boolean | null | ReadonlyArray<string>;

export type SectionId =
  | "routing"
  | "retries"
  | "requests"
  | "images"
  | "providers"
  | "catalogs"
  | "refresh";

/**
 * How a value is edited: `bool` a checkbox; `tristate` a checkbox over an unset Go pointer; `int` whole numbers ≥ 0;
 * `duration` a Go duration > 0; `bootstrap` a duration, whole seconds or 0 for unlimited; `text` trimmed text;
 * `model` a `gpt-` model or empty; `timezone` an IANA zone, `Local` or empty; `words` one entry
 * per line; `choice` (one of the copy's options) and `images` radio lists; `catalog` and `cooldown` a radio list with a text field.
 */
export type FieldKind =
  | "bool"
  | "tristate"
  | "int"
  | "duration"
  | "bootstrap"
  | "text"
  | "model"
  | "timezone"
  | "words"
  | "choice"
  | "images"
  | "catalog"
  | "cooldown";

export interface FieldSpec {
  /** Dotted config path: the field's identity in drafts, patches and the server's `path`. */
  readonly path: string;
  readonly section: SectionId;
  readonly kind: FieldKind;
  /** What the field is called where the page lists it (conflicts, problems). */
  readonly label: string;
  /** `tristate`: what an unset value means. */
  readonly unset?: boolean;
}

const field = (
  section: SectionId,
  path: string,
  kind: FieldKind,
  label: string,
  unset?: boolean,
): FieldSpec => ({ path, section, kind, label, ...(unset === undefined ? {} : { unset }) });

export const FIELDS: ReadonlyArray<FieldSpec> = [
  field("routing", "routing.strategy", "choice", "Strategy"),
  field("routing", "routing.session-affinity", "bool", "Session affinity"),
  field("routing", "routing.session-affinity-ttl", "duration", "Session binding"),
  field("routing", "routing.session-affinity-subagents", "bool", "Subagents"),
  field("routing", "routing.force-model-prefix", "bool", "Model prefixes"),

  field("retries", "routing.retry.request-retry", "int", "Retry rounds"),
  field("retries", "routing.retry.max-retry-credentials", "int", "Credentials per round"),
  field("retries", "routing.retry.max-retry-interval", "int", "Longest wait for a cooldown"),
  field("retries", "routing.cooldown.disable-cooling", "bool", "Cooldowns"),
  field(
    "retries",
    "routing.cooldown.transient-error-cooldown-seconds",
    "cooldown",
    "After a provider error",
  ),
  field("retries", "upstream.claude.model-level-cooling", "bool", "Per-model cooldown, Claude"),
  field("retries", "upstream.codex.model-level-cooling", "bool", "Per-model cooldown, Codex"),

  field("requests", "requests.passthrough-headers", "bool", "Response headers"),
  field("requests", "requests.nonstream-keepalive-interval", "int", "Keep-alive, whole responses"),
  field("requests", "requests.streaming.keepalive-seconds", "int", "Keep-alive, streams"),
  field("requests", "requests.streaming.bootstrap-retries", "int", "Retries before the first byte"),

  field("images", "multimedia.disable-image-generation", "images", "Image generation"),
  field("images", "multimedia.gpt-image-2-base-model", "model", "Image tool model"),
  field("images", "multimedia.video-result-auth-cache-ttl", "duration", "Video ownership"),

  field("providers", "upstream.claude.disable-claude-cloak-mode", "bool", "Claude cloaking"),
  field("providers", "upstream.claude.cloak-level", "choice", "Claude cloak level"),
  field("providers", "upstream.claude.disable-cloaking-model-list", "bool", "Claude model list"),
  field("providers", "upstream.claude.header-defaults.user-agent", "text", "Claude User-Agent"),
  field(
    "providers",
    "upstream.claude.header-defaults.package-version",
    "text",
    "Claude package version",
  ),
  field(
    "providers",
    "upstream.claude.header-defaults.runtime-version",
    "text",
    "Claude runtime version",
  ),
  field("providers", "upstream.claude.header-defaults.os", "text", "Claude OS"),
  field("providers", "upstream.claude.header-defaults.arch", "text", "Claude architecture"),
  field("providers", "upstream.claude.header-defaults.timeout", "text", "Claude timeout"),
  field("providers", "upstream.claude.header-defaults.timezone", "timezone", "Claude time zone"),
  field(
    "providers",
    "upstream.claude.header-defaults.stabilize-device-profile",
    "tristate",
    "Claude device profile",
    false,
  ),
  field("providers", "upstream.codex.disable-codex-cloaking", "bool", "Codex cloaking"),
  field("providers", "upstream.codex.stream-bootstrap-buffering", "bool", "Codex stream start"),
  field("providers", "upstream.codex.stream-bootstrap-timeout", "bootstrap", "Codex hold limit"),
  field(
    "providers",
    "upstream.codex.orphan-delegation-compatibility",
    "bool",
    "Codex orphan delegation",
  ),
  field("providers", "upstream.codex.response-steering", "bool", "Codex response steering"),
  field(
    "providers",
    "oauth.providers.codex.header-defaults.user-agent",
    "text",
    "Codex account User-Agent",
  ),
  field(
    "providers",
    "oauth.providers.codex.header-defaults.beta-features",
    "text",
    "Codex account beta features",
  ),
  field("providers", "client.codex.enable-apply-patch", "bool", "Codex apply_patch"),
  field("providers", "client.codex.optimize-multi-agent-v2", "bool", "Codex multi-agent v2"),
  field("providers", "upstream.xai.inject-x-search", "bool", "xAI search"),
  field(
    "providers",
    "oauth.providers.antigravity.sensitive-words",
    "words",
    "Antigravity sensitive words",
  ),
  field(
    "providers",
    "oauth.providers.antigravity.antigravity-credits",
    "bool",
    "Antigravity credits",
  ),
  field(
    "providers",
    "oauth.providers.antigravity.signature-cache-enabled",
    "tristate",
    "Antigravity signature cache",
    true,
  ),
  field(
    "providers",
    "oauth.providers.antigravity.signature-bypass-strict",
    "tristate",
    "Antigravity strict signatures",
    false,
  ),
  field("providers", "oauth.providers.devin.sensitive-words", "words", "Devin sensitive words"),

  field("catalogs", "models.catalog", "catalog", "Model catalog"),

  field("refresh", "oauth.auth-auto-refresh-workers", "int", "Refresh concurrency"),
];

const BY_PATH: ReadonlyMap<string, FieldSpec> = new Map(FIELDS.map((spec) => [spec.path, spec]));

export const fieldSpec = (path: string): FieldSpec | undefined => BY_PATH.get(path);

export const sectionFields = (section: SectionId): ReadonlyArray<FieldSpec> =>
  FIELDS.filter((spec) => spec.section === section);

/** The form control's id for a field (also where a server problem about it is shown). */
export const fieldId = (path: string): string => `setting-${path.replaceAll(".", "-")}`;

/** The field a server `path` is about: the field itself, or the one whose value contains it (a list entry). */
export const fieldOfPath = (path: string | undefined): FieldSpec | undefined => {
  if (path === undefined) return undefined;

  return FIELDS.filter(
    (spec) =>
      path === spec.path || path.startsWith(`${spec.path}.`) || path.startsWith(`${spec.path}[`),
  ).toSorted((a, b) => b.path.length - a.path.length)[0];
};

/** The value at a dotted path of the settings values (`undefined` when there is none). */
export const valueAt = (values: SettingsValues, path: string): SettingValue | undefined => {
  let node: unknown = values;

  for (const key of path.split(".")) {
    if (Array.isArray(node) || !Predicate.hasProperty(node, key)) return undefined;
    node = node[key];
  }

  if (Array.isArray(node))
    return node.filter((entry): entry is string => typeof entry === "string");

  return typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "boolean" ||
    node === null
    ? node
    : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Inputs

/** A radio choice with the text beside it (the catalog's URL, the cooldown's seconds). */
export interface Choice {
  readonly choice: string;
  readonly text: string;
}

/** What a form control holds: text, a checkbox, or a choice with text. */
export type Input = string | boolean | Choice;

const isChoice = (input: Input): input is Choice => typeof input === "object";

const asText = (input: Input): string => (typeof input === "string" ? input : "");

const strings = (value: SettingValue | undefined): ReadonlyArray<string> =>
  typeof value === "object" && value !== null ? value : [];

/** The form's input for a stored value. */
export const inputOf = (spec: FieldSpec, value: SettingValue | undefined): Input => {
  switch (spec.kind) {
    case "bool":
      return value === true;
    case "tristate":
      return typeof value === "boolean" ? value : (spec.unset ?? false);
    case "int":
      return typeof value === "number" ? String(value) : "0";
    case "words":
      return strings(value).join("\n");
    case "images":
      return typeof value === "string" ? value : String(value === true);
    case "catalog": {
      const text = typeof value === "string" ? value : "";

      if (text === "") return { choice: "official", text: "" };

      return text === "embed" || text === "disabled"
        ? { choice: text, text: "" }
        : { choice: "custom", text };
    }

    case "cooldown": {
      const seconds = typeof value === "number" ? value : 0;

      if (seconds === 0) return { choice: "default", text: "" };

      return seconds < 0
        ? { choice: "off", text: "" }
        : { choice: "custom", text: String(seconds) };
    }

    default:
      return typeof value === "string" ? value : "";
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Checks (mirroring packages/models/src/management/settings.ts)

const UNITS = new Map<string, number>([
  ["ns", 1e-6],
  ["us", 1e-3],
  ["µs", 1e-3],
  ["μs", 1e-3],
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

/** Go `time.ParseDuration` in milliseconds (`1h30m`, `1.5s`, `0`); `undefined` when invalid (packages/models/src/config/accessors.ts). */
export const parseGoDuration = (input: string): number | undefined => {
  const text = input.trim();

  if (text === "0" || text === "+0" || text === "-0") return 0;

  if (!/^([+-]?)((?:\d+\.?\d*|\.\d+)[a-zµμ]+)+$/.test(text)) return undefined;
  const sign = text.startsWith("-") ? -1 : 1;
  let total = 0;

  for (const part of text.replace(/^[+-]/, "").matchAll(/(\d+\.?\d*|\.\d+)([a-zµμ]+)/g)) {
    const [, amount = "", unitName = ""] = part;
    const unit = UNITS.get(unitName);

    if (unit === undefined) return undefined;
    total += Number.parseFloat(amount) * unit;
  }

  return sign * total;
};

const BOOTSTRAP_UNLIMITED = new Set(["", "0", "none", "unlimited", "disabled", "off", "never"]);

const isTimezone = (zone: string): boolean => {
  if (zone === "" || zone === "Local") return true;

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

const isHttpUrl = (text: string): boolean => {
  try {
    const url = new URL(text);

    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
};

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export type Parsed =
  | { readonly ok: true; readonly value: SettingValue }
  | { readonly ok: false; readonly error: string };

const ok = (value: SettingValue): Parsed => ({ ok: true, value });

const fail = (error: string): Parsed => ({ ok: false, error });

/** A value as an error names it: “EST”. */
const quoted = (text: string): string => `“${text}”`;

const IMAGE_MODES = new Map<string, DisableImageGeneration>([
  ["false", false],
  ["true", true],
  ["chat", "chat"],
  ["passthrough", "passthrough"],
]);

/**
 * The value an input stands for, normalised as the server stores it (trimmed), or what is
 * wrong with it. The server refuses a value it would rewrite, so the page sends the stored form.
 */
export const parseInput = (spec: FieldSpec, input: Input): Parsed => {
  switch (spec.kind) {
    case "bool":
    case "tristate":
      return typeof input === "boolean" ? ok(input) : fail("Choose on or off.");
    case "int": {
      const text = asText(input).trim();

      if (text === "") return fail("Enter a number.");

      if (!/^\d+$/.test(text)) return fail(`${quoted(text)} is not a whole number of 0 or more.`);

      return ok(Number(text));
    }

    case "duration": {
      const text = asText(input).trim();
      const ms = parseGoDuration(text);

      if (text === "") return fail("Enter a duration.");

      if (ms === undefined) return fail(`${quoted(text)} is not a duration.`);

      return ms > 0 ? ok(text) : fail(`${quoted(text)} is zero; it must be longer than that.`);
    }

    case "bootstrap": {
      const text = asText(input).trim();

      const valid =
        BOOTSTRAP_UNLIMITED.has(text.toLowerCase()) ||
        (parseGoDuration(text) ?? -1) >= 0 ||
        /^\d+$/.test(text);

      if (!valid) return fail(`${quoted(text)} is not a duration or whole seconds.`);

      return ok(text === "" ? "0" : text);
    }

    case "model": {
      const text = asText(input).trim();

      return text === "" || text.toLowerCase().startsWith("gpt-")
        ? ok(text)
        : fail(`${quoted(text)} does not start with gpt-.`);
    }

    case "timezone": {
      const text = asText(input).trim();

      return isTimezone(text) ? ok(text) : fail(`${quoted(text)} is not an IANA time zone.`);
    }

    case "words":
      return ok(lines(asText(input)));
    case "choice":
      return ok(asText(input));
    case "images": {
      const mode = IMAGE_MODES.get(asText(input));

      return mode === undefined ? fail("Choose how image generation works.") : ok(mode);
    }

    case "catalog": {
      if (!isChoice(input)) return fail("Choose a source.");

      if (input.choice === "official") return ok("");

      if (input.choice === "embed" || input.choice === "disabled") return ok(input.choice);
      const url = input.text.trim();

      if (url === "") return fail("Enter the catalog's address.");

      return isHttpUrl(url) ? ok(url) : fail(`${quoted(url)} is not an http(s) address.`);
    }

    case "cooldown": {
      if (!isChoice(input)) return fail("Choose a cooldown.");

      if (input.choice === "default") return ok(0);

      if (input.choice === "off") return ok(-1);
      const text = input.text.trim();

      return /^\d+$/.test(text) && Number(text) > 0
        ? ok(Number(text))
        : fail(
            text === "" ? "Enter the seconds." : `${quoted(text)} is not a whole number above 0.`,
          );
    }

    default:
      return ok(asText(input).trim());
  }
};

const jsonSame = (a: SettingValue | undefined, b: SettingValue | undefined): boolean => {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null)
    return a.length === b.length && a.every((entry, index) => entry === b[index]);

  return a === b;
};

/** Whether two values of a field have the same effect (an unset tri-state is its documented default). */
export const sameValue = (
  spec: FieldSpec,
  a: SettingValue | undefined,
  b: SettingValue | undefined,
): boolean => {
  if (spec.kind === "tristate")
    return (typeof a === "boolean" ? a : spec.unset) === (typeof b === "boolean" ? b : spec.unset);

  // Every negative transient cooldown turns it off.
  if (spec.kind === "cooldown" && typeof a === "number" && typeof b === "number" && a < 0 && b < 0)
    return true;

  return jsonSame(a, b);
};

// ---------------------------------------------------------------------------------------------------------------
// Drafts

/** A section's draft: the inputs the operator touched, by field path. */
export type Edits = Readonly<Record<string, Input>>;

/** The input a field shows: the draft's, else the view's value. */
export const shownInput = (spec: FieldSpec, edits: Edits, values: SettingsValues): Input =>
  edits[spec.path] ?? inputOf(spec, valueAt(values, spec.path));

const isChange = (spec: FieldSpec, input: Input, values: SettingsValues): boolean => {
  const parsed = parseInput(spec, input);

  return !parsed.ok || !sameValue(spec, parsed.value, valueAt(values, spec.path));
};

/** The fields whose input differs from the view (an invalid input counts as a change). */
export const changedFields = (edits: Edits, values: SettingsValues): ReadonlyArray<FieldSpec> =>
  FIELDS.filter((spec) => {
    const input = edits[spec.path];

    return input !== undefined && isChange(spec, input, values);
  });

/** What is wrong with the draft's changed inputs, by field path. */
export const draftErrors = (
  edits: Edits,
  values: SettingsValues,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    changedFields(edits, values).flatMap((spec) => {
      const input = edits[spec.path];

      if (input === undefined) return [];
      const parsed = parseInput(spec, input);

      return parsed.ok ? [] : [[spec.path, parsed.error] as const];
    }),
  );

/** Whether a field's shown value is its default (an invalid input is not). */
export const isDefault = (
  spec: FieldSpec,
  edits: Edits,
  values: SettingsValues,
  defaults: SettingsValues,
): boolean => {
  const parsed = parseInput(spec, shownInput(spec, edits, values));

  return parsed.ok && sameValue(spec, parsed.value, valueAt(defaults, spec.path));
};

/** A patch under construction: nested sections down to leaf writes. */
interface PatchTree {
  [key: string]: SettingValue | PatchTree;
}

const isTree = (node: SettingValue | PatchTree | undefined): node is PatchTree =>
  typeof node === "object" && node !== null && !Array.isArray(node);

const setAt = (tree: PatchTree, path: ReadonlyArray<string>, value: SettingValue): void => {
  const [head, ...rest] = path;

  if (head === undefined) return;

  if (rest.length === 0) {
    tree[head] = value;

    return;
  }

  const child = tree[head];
  const next: PatchTree = isTree(child) ? { ...child } : {};

  setAt(next, rest, value);
  tree[head] = next;
};

const decodePatch = Schema.decodeUnknownSync(SettingsPatch);

/** A patch of leaf writes by dotted path (`null` removes the key). */
export const patchOf = (
  writes: ReadonlyArray<readonly [string, SettingValue]>,
): SettingsPatchType => {
  const tree: PatchTree = {};

  for (const [path, value] of writes) setAt(tree, path.split("."), value);

  return decodePatch(tree);
};

/** Each changed leaf of a draft, `null` when it goes back to the default; `undefined` when an input is invalid. */
const draftWrites = (
  edits: Edits,
  view: Pick<SettingsView, "values" | "defaults">,
): ReadonlyArray<readonly [string, SettingValue]> | undefined => {
  const writes: Array<readonly [string, SettingValue]> = [];

  for (const spec of changedFields(edits, view.values)) {
    const input = edits[spec.path];

    if (input === undefined) continue;
    const parsed = parseInput(spec, input);

    if (!parsed.ok) return undefined;
    const fallback = valueAt(view.defaults, spec.path);

    writes.push([spec.path, sameValue(spec, parsed.value, fallback) ? null : parsed.value]);
  }

  return writes;
};

/**
 * The patch a draft becomes against `view`: each changed leaf, `null` when it goes back to the default. `undefined`
 * when nothing changed or an input is invalid (`draftErrors` says what).
 */
export const draftPatch = (
  edits: Edits,
  view: Pick<SettingsView, "values" | "defaults">,
): SettingsPatchType | undefined => {
  const writes = draftWrites(edits, view);

  return writes === undefined || writes.length === 0 ? undefined : patchOf(writes);
};

/**
 * The save a draft becomes against `view`: its patch and, for every setting the patch changes, the revision `view`
 * holds (0 for a setting that is not stored). `undefined` when nothing changed or an input is invalid.
 */
export const draftSave = (edits: Edits, view: SettingsView): SaveSettings | undefined => {
  const writes = draftWrites(edits, view);

  if (writes === undefined || writes.length === 0) return undefined;

  return {
    revisions: Object.fromEntries(writes.map(([path]) => [path, view.revisions[path] ?? 0])),
    patch: patchOf(writes),
  };
};

export interface Rebased {
  readonly edits: Edits;
  /** Fields this draft changes that also changed on the server (to something else). */
  readonly moved: ReadonlyArray<FieldSpec>;
}

/**
 * Moves a draft from the values it was made on (`before`) to newer ones (`after`). An input the server now holds is
 * dropped, as is an untouched one (the field shows the new value); a change whose field the server changed to
 * something else stays in the draft and is listed in `moved`.
 */
export const rebaseDraft = (
  edits: Edits,
  before: SettingsValues,
  after: SettingsValues,
): Rebased => {
  const kept: Record<string, Input> = {};
  const moved: FieldSpec[] = [];

  for (const [path, input] of Object.entries(edits)) {
    const spec = fieldSpec(path);

    if (spec === undefined) continue;
    const parsed = parseInput(spec, input);
    const now = valueAt(after, path);

    if (parsed.ok && sameValue(spec, parsed.value, now)) continue;

    if (!isChange(spec, input, before)) continue;
    kept[path] = input;

    if (!sameValue(spec, valueAt(before, path), now)) moved.push(spec);
  }

  return { edits: kept, moved };
};

// ---------------------------------------------------------------------------------------------------------------
// Saving

/** How a section save reads the latest view and sends one write. */
export interface SettingsIo<E, R> {
  readonly read: Effect.Effect<SettingsView, E, R>;
  readonly write: (save: SaveSettings) => Effect.Effect<{ readonly version: number }, E, R>;
}

export type SaveOutcome =
  | { readonly kind: "saved"; readonly version: number }
  | { readonly kind: "unchanged" }
  /** Settings this draft changes changed meanwhile, to other values: nothing was written. */
  | {
      readonly kind: "moved";
      readonly fields: ReadonlyArray<FieldSpec>;
      readonly view: SettingsView;
    };

const isConflict = <E>(error: E | ManagementError): boolean =>
  error instanceof ManagementError && error.error === "conflict";

/**
 * Saves a section's draft against the view it was made on, naming the revision of each setting it changes. On 409
 * (one of those settings changed first) it re-reads the view and, when none of the draft's fields moved there,
 * re-applies the same delta once with the fresh revisions; a second 409 fails with `conflict`.
 */
export const saveDraft = <E, R>(
  edits: Edits,
  base: SettingsView,
  io: SettingsIo<E, R>,
): Effect.Effect<SaveOutcome, E | ManagementError, R> => {
  const attempt = (draft: Edits, view: SettingsView) => {
    const save = draftSave(draft, view);

    if (save === undefined) return Effect.succeed<SaveOutcome>({ kind: "unchanged" });

    return io
      .write(save)
      .pipe(Effect.map((saved): SaveOutcome => ({ kind: "saved", version: saved.version })));
  };

  return attempt(edits, base).pipe(
    Effect.catchIf(isConflict, () =>
      Effect.flatMap(io.read, (latest) => {
        const rebased = rebaseDraft(edits, base.values, latest.values);

        if (rebased.moved.length > 0)
          return Effect.succeed<SaveOutcome>({
            kind: "moved",
            fields: rebased.moved,
            view: latest,
          });

        return attempt(rebased.edits, latest);
      }),
    ),
  );
};

/** What a failed save tells the operator, for the problems that are not about one field. */
export const saveProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "conflict":
      return "These settings changed elsewhere while saving. Reload to see the current settings; your edits stay in the form until you do.";
    default:
      return message;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Readings

const unit = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** A duration spelled out: 5_400_000 → "1 hour 30 minutes"; the two largest units, rounded down. */
export const spellDuration = (ms: number): string => {
  const parts: string[] = [];
  let rest = Math.round(ms);

  for (const [size, name] of [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
    [1, "millisecond"],
  ] as const) {
    const count = Math.floor(rest / size);

    if (count > 0) parts.push(unit(count, name));
    rest -= count * size;
  }

  return parts.length === 0 ? "0 seconds" : parts.slice(0, 2).join(" ");
};

/** The live reading beside a duration input ("= 1 hour 30 minutes"), or `undefined` when it does not parse. */
export const durationReading = (spec: FieldSpec, input: Input): string | undefined => {
  const text = asText(input).trim();

  if (spec.kind === "bootstrap") {
    if (BOOTSTRAP_UNLIMITED.has(text.toLowerCase())) return "= no limit";

    if (/^\d+$/.test(text)) return `= ${spellDuration(Number(text) * 1000)}`;
  }

  const ms = parseGoDuration(text);

  if (ms === undefined || (spec.kind === "duration" && ms <= 0)) return undefined;

  return ms === 0 ? "= no limit" : `= ${spellDuration(ms)}`;
};

const IMAGE_NAMES = new Map([
  ["false", "on"],
  ["true", "off everywhere"],
  ["chat", "off in chat"],
  ["passthrough", "passed through"],
]);

const CHOICE_NAMES = new Map([
  ["official", "official"],
  ["embed", "embedded copy"],
  ["disabled", "off"],
  ["default", "60 s"],
  ["off", "off"],
]);

/** A stored value in a few words, for the list of fields that changed elsewhere. */
export const valueText = (spec: FieldSpec, value: SettingValue | undefined): string => {
  const input = inputOf(spec, value);

  if (typeof input === "boolean") return input ? "on" : "off";

  if (isChoice(input)) {
    if (input.choice !== "custom") return CHOICE_NAMES.get(input.choice) ?? input.choice;

    return spec.kind === "cooldown" ? `${input.text} s` : input.text;
  }

  if (spec.kind === "images") return IMAGE_NAMES.get(input) ?? input;

  if (spec.kind === "words") {
    const entries = lines(input);

    return entries.length === 0 ? "none" : entries.join(", ");
  }

  return input === "" ? "empty" : input;
};
