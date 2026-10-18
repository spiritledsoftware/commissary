// The provider keys page's model: provider sections, each key's standing, the facts of a group, and the group form (its
// draft, validation and the write it becomes). Pure: no DOM, tested in test/keys.test.ts.
//
// Secrets never reach the browser: an existing key is written back by `auth_index` (the server keeps its secret and
// the settings the panel never sees); only a new or replacing key carries `api-key`.
import { flow, Option, Schema } from "effect";
import {
  ProviderKeyFamily,
  ProviderKeyGroupBody,
  ProviderKeysList,
  ProviderKeyView,
  CompatGroupBody,
  CompatGroupInput,
  CompatGroupView,
  CompatKeyInput,
  CompatKeyView,
  GroupInput,
  GroupView,
  KeyInput,
  ModelEntry,
  PutGroupRequest,
} from "@commissary/contract/provider-keys";
import { cooldownReason } from "./accounts.ts";

export type AnyGroupView = GroupView | CompatGroupView;

export type AnyKeyView = ProviderKeyView | CompatKeyView;

export const FAMILY_ORDER: ReadonlyArray<ProviderKeyFamily> = [
  "claude",
  "codex",
  "gemini",
  "interactions",
  "vertex",
  "xai",
  "meta",
  "opencode-zen",
  "opencode-go",
  // `subq` joins the panel in a later change; the server already lists its groups (skipped here).
  "typesafe",
  "openai-compatibility",
];

const FAMILY_NAMES: Readonly<Record<ProviderKeyFamily, string>> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  interactions: "Gemini Interactions",
  vertex: "Vertex AI",
  xai: "xAI",
  meta: "Meta",
  "opencode-zen": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  typesafe: "TypeSafe",
  subq: "SubQ",
  "openai-compatibility": "OpenAI-compatible",
};

export const familyName = (family: ProviderKeyFamily): string => FAMILY_NAMES[family];

export const isFamily = (value: string): value is ProviderKeyFamily =>
  FAMILY_ORDER.some((family) => family === value);

/** The base URL the server uses when a group sets none; `undefined` where a group must set one. */
const DEFAULT_BASE: Readonly<Record<ProviderKeyFamily, string | undefined>> = {
  claude: "https://api.anthropic.com",
  codex: undefined,
  gemini: "https://generativelanguage.googleapis.com",
  interactions: "https://generativelanguage.googleapis.com",
  vertex: "https://aiplatform.googleapis.com",
  xai: undefined,
  meta: "https://api.meta.ai/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  typesafe: "https://api.typesafe.ai/v1",
  subq: "https://api.subq.ai/v1",
  "openai-compatibility": undefined,
};

export const defaultBaseUrl = (family: ProviderKeyFamily): string | undefined =>
  DEFAULT_BASE[family];

const NewKeySearch = Schema.Struct({ family: Schema.optionalKey(ProviderKeyFamily) });

/** `/keys/new?family=claude`: an unknown family reads as none (the provider list). */
export const readNewKeySearch = flow(
  Schema.decodeUnknownOption(NewKeySearch),
  Option.getOrElse((): typeof NewKeySearch.Type => ({})),
);

/** A placeholder for the base URL field: the default, or an example where one is required. */
export const baseUrlPlaceholder = (family: ProviderKeyFamily): string =>
  DEFAULT_BASE[family] ?? (family === "xai" ? "https://api.x.ai/v1" : "https://api.example.com/v1");

/** `https://api.anthropic.com/v1` → `api.anthropic.com`; anything unparsable stays as written. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** `[redacted]…abcd` → `…abcd`: the tail is what tells keys apart. */
export const keyTail = (preview: string): string => {
  const at = preview.lastIndexOf("…");

  return at === -1 ? preview : preview.slice(at);
};

// ---------------------------------------------------------------------------------------------------------------
// Sections

export interface GroupRef {
  readonly family: ProviderKeyFamily;
  readonly index: number;
  readonly view: AnyGroupView;
  /** One of the caller's private groups (ADR 0023): `index` counts among those, not among the shared ones. */
  readonly private?: boolean;
}

export interface KeySection {
  readonly id: string;
  readonly title: string;
  /** Under the title: what kind of endpoint this is, for the OpenAI-compatible ones. */
  readonly caption: string | undefined;
  readonly groups: ReadonlyArray<GroupRef>;
}

const sectionsOf = (families: ProviderKeysList["families"], privately: boolean) =>
  FAMILY_ORDER.flatMap((family): ReadonlyArray<KeySection> => {
    const groups: ReadonlyArray<AnyGroupView> = families[family];
    const mark = privately ? { private: true } : {};
    const prefix = privately ? "own:" : "";

    if (groups.length === 0) return [];

    if (family === "openai-compatibility") {
      return groups.map((view) => ({
        id: `${prefix}${family}:${view.index}`,
        title: groupTitle(family, view),
        caption: privately
          ? "OpenAI-compatible endpoint, private to you"
          : "OpenAI-compatible endpoint",
        groups: [{ family, index: view.index, view, ...mark }],
      }));
    }

    return [
      {
        id: `${prefix}${family}`,
        title: familyName(family),
        caption: privately ? "Private to you" : undefined,
        groups: groups.map((view) => ({ family, index: view.index, view, ...mark })),
      },
    ];
  });

/**
 * One section per provider in a fixed order; every OpenAI-compatible endpoint is a provider of its own. The org's
 * shared groups come first, then the caller's private ones (ADR 0023), each marked.
 */
export const keySections = (list: ProviderKeysList): ReadonlyArray<KeySection> => [
  ...sectionsOf(list.families, false),
  ...(list.own === undefined ? [] : sectionsOf(list.own, true)),
];

/** A group's name, else its host, else its position. */
export const groupTitle = (family: ProviderKeyFamily, view: AnyGroupView): string => {
  const name = view.group.name?.trim();

  if (name !== undefined && name !== "") return name;

  if (family !== "openai-compatibility" && (view.group["base-url"] ?? "") === "") {
    return `Group ${view.index + 1}`;
  }

  return hostOf(view.effective_base_url);
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** The facts printed under a group's title: where it sends requests and how it routes them. */
export const groupFacts = (
  family: ProviderKeyFamily,
  view: AnyGroupView,
): ReadonlyArray<string> => {
  const { group } = view;
  const facts: Array<string> = [];
  const configured = (group["base-url"] ?? "") !== "";
  facts.push(
    configured || view.effective_base_url === ""
      ? hostOf(view.effective_base_url)
      : `${hostOf(view.effective_base_url)} (default)`,
  );

  if ((group.prefix ?? "") !== "") facts.push(`Prefix ${group.prefix}/`);

  if ((group.priority ?? 0) !== 0) facts.push(`Priority ${group.priority}`);

  const models = group.models?.length ?? 0;

  facts.push(
    models > 0
      ? plural(models, "model")
      : family === "openai-compatibility"
        ? "No models listed"
        : "Provider catalog",
  );

  const exclusions =
    "excluded-models" in group
      ? (group["excluded-models"]?.filter((pattern) => pattern !== "*").length ?? 0)
      : 0;

  if (exclusions > 0) facts.push(plural(exclusions, "exclusion"));

  return facts;
};

// ---------------------------------------------------------------------------------------------------------------
// Standing

export interface KeyStanding {
  /**
   * `closed` (red trail mark, back time when known), `resting` (some models resting: an ink note), `disabled`,
   * `unused` (the entry makes no credential) or `ok`.
   */
  readonly tone: "ok" | "closed" | "resting" | "disabled" | "unused";
  readonly label: string;
  /** When a closed key takes requests again (ms). */
  readonly backAt: number | undefined;
}

const at = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Cooldowns still running at `now`. */
export const liveCooldowns = (key: AnyKeyView, now: number) =>
  key.runtime?.cooldowns.filter((cooldown) => (at(cooldown.retry_at) ?? 0) > now) ?? [];

export const keyStanding = (key: AnyKeyView, now: number): KeyStanding => {
  if (key.disabled) return { tone: "disabled", label: "Disabled", backAt: undefined };

  const runtime = key.runtime;

  if (runtime === null) {
    return { tone: "unused", label: "Makes no credential", backAt: undefined };
  }

  const live = liveCooldowns(key, now);
  const whole = live.filter((cooldown) => cooldown.scope === "credential");

  if (whole.length > 0) {
    const backAt = Math.max(...whole.map((cooldown) => at(cooldown.retry_at) ?? now));
    const reason = whole.find((cooldown) => at(cooldown.retry_at) === backAt)?.reason ?? "unknown";

    return { tone: "closed", label: `Resting: ${cooldownReason(reason)}`, backAt };
  }

  if (runtime.status === "error") {
    const message = runtime.last_error?.message ?? "";
    const status = runtime.last_error?.http_status;

    const detail = [status === undefined ? "" : `HTTP ${status}`, message]
      .filter((part) => part !== "")
      .join(", ");

    return {
      tone: "closed",
      label: detail === "" ? "Failing" : `Failing: ${detail}`,
      backAt: at(runtime.next_retry_after),
    };
  }

  const retry = at(runtime.next_retry_after);

  if (runtime.unavailable && retry !== undefined && retry > now) {
    return { tone: "closed", label: "Resting", backAt: retry };
  }

  if (live.length > 0) {
    return {
      tone: "resting",
      label: `${plural(live.length, "model")} resting`,
      backAt: undefined,
    };
  }

  return { tone: "ok", label: "Taking requests", backAt: undefined };
};

export const needsAttention = (key: AnyKeyView, now: number): boolean => {
  const { tone } = keyStanding(key, now);

  return tone === "closed" || tone === "resting";
};

/** Requests over the recent-requests ring: `[all, failed]`. */
export const recentRequests = (key: AnyKeyView): readonly [number, number] => {
  const ring = key.runtime?.recent_requests ?? [];
  const failed = ring.reduce((sum, bucket) => sum + bucket.failed, 0);

  return [ring.reduce((sum, bucket) => sum + bucket.success, 0) + failed, failed];
};

/** Whether a key or its group mentions the search (lower-cased). */
export const keyMatches = (ref: GroupRef, key: AnyKeyView, title: string, query: string): boolean =>
  query === "" ||
  [
    title,
    familyName(ref.family),
    groupTitle(ref.family, ref.view),
    ref.view.effective_base_url,
    ref.view.group.prefix,
    key.key_preview,
  ].some((field) => field?.toLowerCase().includes(query) === true);

// ---------------------------------------------------------------------------------------------------------------
// The group form

export interface ModelDraft {
  readonly name: string;
  readonly alias: string;
  /** OpenCode Zen/Go only: the upstream protocol; empty follows the OpenCode catalog. */
  readonly protocol: string;
  /** The stored entry, so its other settings (display name, thinking, ...) survive the edit. */
  readonly stored: ModelEntry | undefined;
}

/** A new, empty model row. */
export const newModelDraft = (name = ""): ModelDraft => ({
  name,
  alias: "",
  protocol: "",
  stored: undefined,
});

/** The families whose model rows choose an upstream protocol. */
export const choosesProtocol = (family: ProviderKeyFamily | undefined): boolean =>
  family === "opencode-zen" || family === "opencode-go";

/** The protocol choices of an OpenCode model row (`""`: what the OpenCode catalog says). */
export const PROTOCOL_CHOICES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "", label: "Auto (catalog)" },
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
  { value: "messages", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini (Zen only)" },
  { value: "systemone", label: "System One (Zen only)" },
];

export interface KeyDraft {
  /** Stable React key. */
  readonly id: string;
  /** The stored key this row keeps; absent for a new key. */
  readonly stored: AnyKeyView | undefined;
  /** A new secret: required for a new key, replaces the stored one when set. */
  readonly secret: string;
  readonly weight: string;
}

export interface GroupDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly prefix: string;
  readonly priority: string;
  readonly models: ReadonlyArray<ModelDraft>;
  /** Exclusion patterns, one per line or comma-separated. */
  readonly excluded: string;
  readonly keys: ReadonlyArray<KeyDraft>;
  /** OpenAI-compatible endpoints only. */
  readonly disabled: boolean;
  readonly promptCacheKey: boolean;
}

const text = (value: number | string | undefined): string =>
  value === undefined ? "" : String(value);

let draftKeys = 0;

/** A fresh React key for a key row. */
export const nextDraftId = (): string => {
  draftKeys += 1;

  return `key-${draftKeys}`;
};

export const newKeyDraft = (): KeyDraft => ({
  id: nextDraftId(),
  stored: undefined,
  secret: "",
  weight: "",
});

export const draftOf = (view: AnyGroupView | undefined): GroupDraft => {
  if (view === undefined) {
    return {
      name: "",
      baseUrl: "",
      prefix: "",
      priority: "",
      models: [],
      excluded: "",
      keys: [newKeyDraft()],
      disabled: false,
      promptCacheKey: false,
    };
  }

  const { group } = view;
  const keys: ReadonlyArray<AnyKeyView> = group.keys;

  return {
    name: group.name ?? "",
    baseUrl: group["base-url"] ?? "",
    prefix: group.prefix ?? "",
    priority: text(group.priority),
    models: (group.models ?? []).map((model) => ({
      name: model.name,
      alias: model.alias ?? "",
      protocol: model.protocol ?? "",
      stored: model,
    })),
    excluded: "excluded-models" in group ? (group["excluded-models"] ?? []).join("\n") : "",
    keys: keys.map((key) => ({
      id: nextDraftId(),
      stored: key,
      secret: "",
      weight: text(key.weight),
    })),
    disabled: "disabled" in group ? (group.disabled ?? false) : false,
    promptCacheKey:
      "support-prompt-cache-key" in group ? (group["support-prompt-cache-key"] ?? false) : false,
  };
};

/** Patterns from the exclusions field: split on lines and commas, trimmed, de-duplicated. */
export const parsePatterns = (raw: string): ReadonlyArray<string> => [
  ...new Set(
    raw
      .split(/[\n,]/)
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern !== ""),
  ),
];

const INTEGER = /^-?\d+$/;

const MAX_WEIGHT = 1_000_000;

export interface DraftErrors {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly priority?: string;
  readonly models?: string;
  readonly keys?: string;
  /** Per key row id: the field at fault and what is wrong with it. */
  readonly keyErrors: Readonly<Record<string, KeyError>>;
}

export interface KeyError {
  readonly field: "secret" | "weight";
  readonly text: string;
}

export const hasErrors = (errors: DraftErrors): boolean =>
  Object.keys(errors.keyErrors).length > 0 ||
  [errors.name, errors.baseUrl, errors.priority, errors.models, errors.keys].some(
    (error) => error !== undefined,
  );

/** What the server would refuse or silently drop, caught before saving. */
export const validateDraft = (family: ProviderKeyFamily, draft: GroupDraft): DraftErrors => {
  const keyErrors: Record<string, KeyError> = {};

  for (const key of draft.keys) {
    const weight = key.weight.trim();

    if (key.stored === undefined && key.secret.trim() === "") {
      keyErrors[key.id] = { field: "secret", text: "Enter the provider key, or remove this row." };
    } else if (weight !== "" && (!INTEGER.test(weight) || Number(weight) > MAX_WEIGHT)) {
      keyErrors[key.id] = { field: "weight", text: "Weight is a whole number up to 1,000,000." };
    }
  }

  const baseUrl = draft.baseUrl.trim();
  const priority = draft.priority.trim();
  const models = draft.models.filter((model) => model.name.trim() !== "");

  const baseUrlError =
    baseUrl === ""
      ? defaultBaseUrl(family) === undefined
        ? `${familyName(family)} keys need a base URL.`
        : undefined
      : /^https?:\/\/[^/\s]+/.test(baseUrl)
        ? undefined
        : "Enter a URL starting with https://.";

  const modelsError =
    family === "vertex" && models.some((model) => model.alias.trim() === "")
      ? "Vertex AI models need an alias."
      : undefined;

  return {
    ...(family === "openai-compatibility" && draft.name.trim() === ""
      ? { name: "Name the endpoint: clients see it as the provider." }
      : {}),
    ...(baseUrlError === undefined ? {} : { baseUrl: baseUrlError }),
    ...(priority === "" || INTEGER.test(priority)
      ? {}
      : { priority: "Enter a whole number, such as 10 or -1." }),
    ...(modelsError === undefined ? {} : { models: modelsError }),
    ...(family !== "openai-compatibility" && draft.keys.length === 0
      ? { keys: "Add at least one key." }
      : {}),
    keyErrors,
  };
};

/**
 * Whether saving changes what identifies the stored keys, so their counters and usage history start over: the key,
 * base URL or prefix, or the name of an OpenAI-compatible endpoint (its provider name).
 */
export const changesIdentity = (
  family: ProviderKeyFamily,
  view: AnyGroupView | undefined,
  draft: GroupDraft,
): boolean =>
  view !== undefined &&
  (draft.baseUrl.trim() !== (view.group["base-url"] ?? "") ||
    draft.prefix.trim() !== (view.group.prefix ?? "") ||
    draft.keys.some((key) => key.stored !== undefined && key.secret.trim() !== "") ||
    (family === "openai-compatibility" && draft.name.trim() !== (view.group.name ?? "")));

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
};

const optionalInt = (value: string): number | undefined => {
  const trimmed = value.trim();

  return trimmed === "" ? undefined : Number(trimmed);
};

const modelEntries = (drafts: ReadonlyArray<ModelDraft>): ReadonlyArray<ModelEntry> =>
  drafts.flatMap((draft) => {
    const name = draft.name.trim();

    if (name === "") return [];
    const { alias: _alias, name: _name, protocol: _protocol, ...rest } = draft.stored ?? { name };
    const alias = draft.alias.trim();

    return [
      {
        ...rest,
        name,
        ...(alias === "" ? {} : { alias }),
        ...(draft.protocol === "" ? {} : { protocol: draft.protocol }),
      },
    ];
  });

/** A key row as written: the stored key by `auth_index` (all its visible settings), plus a new secret and weight. */
const keyInput = (key: KeyDraft): KeyInput & CompatKeyInput => {
  const secret = key.secret.trim();
  const weight = optionalInt(key.weight);

  const kept = (() => {
    if (key.stored === undefined) return {};

    const {
      auth_index: authIndex,
      key_preview: _preview,
      disabled: _disabled,
      runtime: _runtime,
      weight: _weight,
      ...rest
    } = key.stored;

    // A stored entry without a credential has no `auth_index` to keep it by; it is written back key-less.
    return authIndex === undefined
      ? { ...rest, "api-key": "" }
      : { ...rest, auth_index: authIndex };
  })();

  return {
    ...kept,
    ...(secret === "" ? {} : { "api-key": secret }),
    ...(weight === undefined ? {} : { weight }),
  };
};

const EMPTY_GROUP: ProviderKeyGroupBody = { keys: [] };

const EMPTY_COMPAT: CompatGroupBody = { name: "", "base-url": "", keys: [] };

/**
 * The `PUT /provider-keys/groups` body for the form: every field the form does not show is kept as stored. A group that
 * exists is named by its entry `id` and `revision`; a new one has neither (revision 0).
 */
export const putGroupRequest = (
  family: ProviderKeyFamily,
  view: AnyGroupView | undefined,
  draft: GroupDraft,
  privately = false,
): PutGroupRequest => {
  const name = optionalText(draft.name);
  const baseUrl = optionalText(draft.baseUrl);
  const prefix = optionalText(draft.prefix);
  const priority = optionalInt(draft.priority);
  const models = modelEntries(draft.models);
  const keys = draft.keys.map(keyInput);

  const entry = {
    ...(view === undefined ? { revision: 0 } : { id: view.id, revision: view.revision }),
    ...(privately ? { private: true } : {}),
  };

  if (family === "openai-compatibility") {
    // SAFETY: the list files OpenAI-compatible endpoints only under `openai-compatibility`.
    const stored = view?.group as CompatGroupBody | undefined;

    const {
      keys: _keys,
      name: _name,
      "base-url": _base,
      prefix: _prefix,
      priority: _priority,
      models: _models,
      disabled: _disabled,
      "support-prompt-cache-key": _cache,
      ...kept
    } = stored ?? EMPTY_COMPAT;

    const group: CompatGroupInput = {
      ...kept,
      name: name ?? "",
      "base-url": baseUrl ?? "",
      ...(prefix === undefined ? {} : { prefix }),
      ...(priority === undefined ? {} : { priority }),
      ...(models.length === 0 ? {} : { models }),
      ...(draft.disabled ? { disabled: true } : {}),
      ...(draft.promptCacheKey ? { "support-prompt-cache-key": true } : {}),
      keys: keys.map(({ "api-key": key, auth_index: authIndex, weight }) => ({
        ...(key === undefined ? {} : { "api-key": key }),
        ...(authIndex === undefined ? {} : { auth_index: authIndex }),
        ...(weight === undefined ? {} : { weight }),
      })),
    };

    return { family, ...entry, group };
  }

  // SAFETY: every family but `openai-compatibility` lists key groups.
  const stored = view?.group as ProviderKeyGroupBody | undefined;

  const {
    keys: _keys,
    name: _name,
    "base-url": _base,
    prefix: _prefix,
    priority: _priority,
    models: _models,
    "excluded-models": _excluded,
    ...kept
  } = stored ?? EMPTY_GROUP;

  const excluded = parsePatterns(draft.excluded);

  const group: GroupInput = {
    ...kept,
    ...(name === undefined ? {} : { name }),
    ...(baseUrl === undefined ? {} : { "base-url": baseUrl }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(priority === undefined ? {} : { priority }),
    ...(models.length === 0 ? {} : { models }),
    ...(excluded.length === 0 ? {} : { "excluded-models": excluded }),
    keys,
  };

  return { family, ...entry, group };
};

/** Key fields the form shows (everything else on a key is kept as stored). */
const KEY_SHOWN = new Set(["auth_index", "key_preview", "disabled", "runtime", "weight"]);

/**
 * What the form leaves alone and saving keeps, as phrases: group settings it does not edit, per-key settings, and
 * settings that do nothing on Workers (their values are never sent to the browser).
 */
export const keptSettings = (view: AnyGroupView | undefined): ReadonlyArray<string> => {
  if (view === undefined) return [];
  const { group } = view;

  const kept = [
    group.headers === undefined ? [] : ["headers"],
    group["disable-cooling"] === undefined ? [] : ["cooling"],
    group["request-retry"] === undefined ? [] : ["request retry"],
    group["request-scoped-errors"] === undefined ? [] : ["error rules"],
  ].flat();

  const keys: ReadonlyArray<AnyKeyView> = view.group.keys;
  // A key's `excluded-models: ["*"]` is its Disable switch, which the list shows, not a setting.

  const tuned = keys.filter((key) =>
    Object.entries(key).some(
      ([field, value]) =>
        !KEY_SHOWN.has(field) &&
        value !== undefined &&
        !(field === "excluded-models" && Array.isArray(value) && value.join() === "*"),
    ),
  ).length;

  if (tuned > 0) kept.push(`settings of ${plural(tuned, "key")}`);

  // A warning opens with the config key it is about ("proxy-url is set: …").
  const inert = view.warnings.map((warning) => warning.split(" ")[0] ?? warning);

  if (inert.length > 0)
    kept.push(
      `${inert.join(" and ")}, which ${inert.length === 1 ? "has" : "have"} no effect on Workers`,
    );

  return kept;
};

/**
 * Does a refused write mean the page's view of the group is stale (the group, or one of its keys, changed or was
 * removed since the list was read)? The form then offers Reload, which refetches the list and remounts the form on the
 * group's new `id` and `revision`.
 */
export const isStaleWrite = (error: string | undefined): boolean =>
  error === "conflict" || error === "unknown_auth_index";

/** What the server's write errors mean on the form. */
export const writeProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "conflict":
      return "This group changed or was removed since this page loaded. Reload to see the current keys; your edits stay in the form until you do.";
    case "unknown_auth_index":
      return "A key in this group changed or was removed since this page loaded. Reload and make the edit again.";
    default:
      return message;
  }
};
