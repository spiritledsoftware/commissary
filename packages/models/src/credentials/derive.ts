/**
 * Auth-file record -> `Credential`.
 *
 * Go source: internal/watcher/synthesizer/file.go (`synthesizeFileAuths`), sdk/cliproxy/auth/{priority,weight,
 * custom_headers,oauth_model_alias}.go, internal/auth/kimi/kimi.go (domain/base URL), internal/auth/codex/jwt_parser.go
 * (plan type). Docs: credentials.md §2.1, §3.
 * Derivation is pure so global config changes (exclusions) are applied by re-deriving, never by rewriting files.
 */
import type { Config, OAuthModelAlias } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { decodeJwtClaims } from "./expiry.ts";
import { type Credential } from "./model.ts";
import { normalizeExclusions } from "./selection/model-name.ts";
import { DEFAULT_WEIGHT, parseWeightValue } from "./weight.ts";

/** What the store keeps per file credential. */
export interface StoredCredential {
  readonly id: string;
  readonly provider: string;
  readonly metadata: JsonObject;
  readonly credentialVersion: number;
  /** The member a private credential belongs to (a column beside the file JSON); absent: shared. */
  readonly owner?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** Prefix: trimmed, slashes stripped from both ends, ignored when it still contains a slash. */
export const normalizePrefix = (raw: string | undefined): string | undefined => {
  const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");

  return trimmed === "" || trimmed.includes("/") ? undefined : trimmed;
};

/** `ExtractCustomHeadersFromMetadata`: non-empty string values with trimmed names. */
export const extractHeaders = (raw: Json | undefined) => {
  const out: Record<string, string> = {};

  if (!isJsonObject(raw)) return out;

  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    const headerValue = typeof value === "string" ? value.trim() : "";

    if (name !== "" && headerValue !== "") out[name] = headerValue;
  }

  return out;
};

/** `SanitizeOAuthModelAlias`: drop empty or identical pairs, de-duplicate by lower-cased alias (first wins). */
export const sanitizeAliases = (aliases: ReadonlyArray<OAuthModelAlias>): OAuthModelAlias[] => {
  const seen = new Set<string>();
  const out: OAuthModelAlias[] = [];

  for (const entry of aliases) {
    const name = entry.name.trim();
    const alias = entry.alias.trim();

    if (name === "" || alias === "" || name.toLowerCase() === alias.toLowerCase()) continue;
    const key = alias.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, name, alias });
  }

  return out;
};

/** Per-account `model_aliases` from auth-file metadata. */
export const aliasesFromMetadata = (raw: Json | undefined): OAuthModelAlias[] => {
  if (!Array.isArray(raw)) return [];
  const entries: OAuthModelAlias[] = [];

  for (const item of raw) {
    if (!isJsonObject(item)) continue;
    entries.push({
      name: text(item.name),
      alias: text(item.alias),
      ...(item.fork === true ? { fork: true } : {}),
      ...(item["force-mapping"] === true ? { "force-mapping": true } : {}),
      ...(text(item["display-name"]) !== "" ? { "display-name": text(item["display-name"]) } : {}),
    });
  }

  return sanitizeAliases(entries);
};

const stringList = (raw: Json | undefined): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];

/** The account's own `excluded_models` as selection reads them: trimmed, lower-cased, de-duplicated, in order. */
export const ownExclusions = (raw: Json | undefined): string[] => [
  ...new Set(
    stringList(raw)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  ),
];

/** `ApplyAuthPriorityMetadata`: numbers are truncated, strings must be integers; anything else is ignored. */
const parsePriority = (raw: Json | undefined): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);

  if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) return Number(raw.trim());

  return undefined;
};

const KIMI_PROVIDERS = new Set(["kimi", "kimi-ai", "kimi.ai", "kimi.com"]);

const KIMI_COM_BASE = "https://api.kimi.com/coding";

const KIMI_AI_BASE = "https://api.kimi.ai/coding";

const isKimiAiDomain = (domain: string): boolean => {
  const value = domain.trim().toLowerCase();

  return value === "kimi.ai" || value === "ai" || value === "kimi-ai" || value.endsWith(".kimi.ai");
};

const kimiHost = (baseUrl: string): string => {
  try {
    return new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const kimiDomain = (provider: string, domain: string, baseUrl: string): string => {
  if (domain !== "") {
    if (isKimiAiDomain(domain)) return "kimi.ai";

    if (domain.trim().toLowerCase().endsWith("kimi.com")) return "kimi.com";
  }

  if (baseUrl !== "") {
    const host = kimiHost(baseUrl);

    if (host === "kimi.ai" || host.endsWith(".kimi.ai")) return "kimi.ai";

    if (host === "kimi.com" || host.endsWith(".kimi.com")) return "kimi.com";
  }

  return provider === "kimi-ai" || provider === "kimi.ai" ? "kimi.ai" : "kimi.com";
};

/** Codex plan: metadata `plan_type`, else the id_token claim `chatgpt_plan_type`, else `free`. */
const codexPlanType = (metadata: JsonObject): string | undefined => {
  const explicit = text(metadata.plan_type);

  if (explicit !== "") return explicit;
  const idToken = text(metadata.id_token);

  if (idToken === "") return undefined;
  const auth = decodeJwtClaims(idToken)?.["https://api.openai.com/auth"];
  const plan = isJsonObject(auth) ? text(auth.chatgpt_plan_type) : "";

  return plan === "" ? "free" : plan;
};

export interface DeriveOptions {
  readonly config: Pick<Config, "oauth">;
}

/** Builds the runtime credential for a stored auth file. */
export const deriveFileCredential = (
  stored: StoredCredential,
  options: DeriveOptions,
): Credential => {
  const { metadata, provider } = stored;

  const attributes: Record<string, string> = {};
  attributes.source = stored.id;
  attributes.path = stored.id;
  attributes.source_backend = "file";

  const priority = parsePriority(metadata.priority);

  if (priority !== undefined) {
    attributes.priority = String(priority);
    attributes.file_priority = "true";
  }

  let weight = DEFAULT_WEIGHT;

  if (Object.hasOwn(metadata, "weight")) {
    const parsed = parseWeightValue(metadata.weight);

    if (parsed.ok) {
      weight = parsed.value;
      attributes.weight = String(weight);
    }
  }

  const note = text(metadata.note);

  if (note !== "") attributes.note = note;
  const email = text(metadata.email);

  if (email !== "") attributes.email = email;
  const fingerprint = text(metadata.fingerprint_profile).toLowerCase();

  if (fingerprint !== "") attributes.fingerprint_profile = fingerprint;

  const excludedModels = normalizeExclusions(
    stringList(metadata.excluded_models),
    options.config.oauth["excluded-models"][provider],
  );

  if (excludedModels.length > 0) attributes.excluded_models = excludedModels.join(",");
  attributes.auth_kind = "oauth";

  if (KIMI_PROVIDERS.has(provider)) {
    const baseUrl = text(metadata.base_url);
    const domain = kimiDomain(provider, text(metadata.domain), baseUrl);
    attributes.domain = domain;
    attributes.base_url =
      baseUrl !== "" ? baseUrl : domain === "kimi.ai" ? KIMI_AI_BASE : KIMI_COM_BASE;
  }

  if (provider === "codex") {
    const plan = codexPlanType(metadata);

    if (plan !== undefined) attributes.plan_type = plan;
  }

  const proxyUrl = typeof metadata.proxy_url === "string" ? metadata.proxy_url : "";
  const prefix = normalizePrefix(typeof metadata.prefix === "string" ? metadata.prefix : undefined);

  return {
    id: stored.id,
    provider,
    source: "file",
    authKind: "oauth",
    label: email !== "" ? email : provider,
    ...(prefix === undefined ? {} : { prefix }),
    ...(stored.owner === undefined ? {} : { owner: stored.owner }),
    disabled: metadata.disabled === true,
    priority: priority ?? 0,
    weight,
    attributes,
    metadata,
    headers: extractHeaders(metadata.headers),
    ...(proxyUrl === "" ? {} : { proxyUrl }),
    excludedModels,
    modelAliases: aliasesFromMetadata(metadata.model_aliases),
    credentialVersion: stored.credentialVersion,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
};
