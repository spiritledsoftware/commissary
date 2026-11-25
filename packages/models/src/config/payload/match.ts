/**
 * Model/protocol/header/condition matching for payload rules.
 *
 * Go source: internal/runtime/executor/helps/payload_helpers.go (payloadModelRulesMatch, payloadHeadersMatch,
 * payloadFromProtocolMatches, payloadModelCandidates, matchModelPattern, payload*ConditionsMatch) and
 * internal/thinking/suffix.go (ParseSuffix).
 */
import { get, type Json, jsonEquals } from "@commissary/json";
import type { PayloadModelRule } from "./schema.ts";
import { buildPayloadPath, resolvePayloadRulePaths } from "./paths.ts";

/** Inbound request headers: Web `Headers`, or a record whose values may be multi-valued. */
export type HeaderInput =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `*`-only glob matching (Go matchModelPattern); both sides are trimmed. */
export const matchModelPattern = (rawPattern: string, rawModel: string): boolean => {
  const pattern = rawPattern.trim();
  const model = rawModel.trim();

  if (pattern === "") return false;

  if (pattern === "*") return true;
  let pi = 0;
  let si = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (si < model.length) {
    if (pi < pattern.length && pattern[pi] === model[si]) {
      pi++;
      si++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi;
      matchIdx = si;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      si = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === "*") pi++;

  return pi === pattern.length;
};

/** Mirrors thinking.ParseSuffix: `name(value)` -> base name and whether a suffix was present. */
interface ThinkingSuffix {
  readonly modelName: string;
  readonly hasSuffix: boolean;
}

const parseThinkingSuffix = (model: string): ThinkingSuffix => {
  const lastOpen = model.lastIndexOf("(");

  if (lastOpen === -1 || !model.endsWith(")")) {
    const plain: ThinkingSuffix = { modelName: model, hasSuffix: false };

    return plain;
  }

  const suffixed: ThinkingSuffix = { modelName: model.slice(0, lastOpen), hasSuffix: true };

  return suffixed;
};

/**
 * `[upstream model, base of requested model, requested model with suffix]`, deduplicated case-insensitively, then the
 * published route's source, which keeps its canonical spelling: selectors are case-sensitive. Go:
 * internal/runtime/executor/helps/payload_helpers.go (`payloadModelCandidates`, f89d408e).
 */
export const payloadModelCandidates = (
  rawModel: string,
  rawRequestedModel: string,
  rawSourceModel = "",
): string[] => {
  const model = rawModel.trim();
  const requestedModel = rawRequestedModel.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string): void => {
    const value = raw.trim();

    if (value === "") return;
    const key = value.toLowerCase();

    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };

  add(model);

  if (requestedModel !== "") {
    const parsed = parseThinkingSuffix(requestedModel);
    add(parsed.modelName);

    if (parsed.hasSuffix) add(requestedModel);
  }

  const source = rawSourceModel.trim();

  if (source !== "" && !candidates.includes(source)) candidates.push(source);

  return candidates;
};

const normalizeFromProtocol = (protocol: string): string => {
  const normalized = protocol.trim().toLowerCase();

  return normalized === "openai-response" ||
    normalized === "openai-responses" ||
    normalized === "response"
    ? "responses"
    : normalized;
};

const fromProtocolMatches = (
  pattern: string | undefined,
  fromProtocol: string | undefined,
): boolean => {
  const wanted = normalizeFromProtocol(pattern ?? "");

  if (wanted === "") return true;
  const actual = normalizeFromProtocol(fromProtocol ?? "");

  return actual !== "" && wanted === actual;
};

const headerValues = (headers: HeaderInput | undefined, key: string): string[] => {
  if (headers === undefined) return [];

  if (headers instanceof Headers) {
    const joined = headers.get(key);

    if (joined === null) return [];

    // The Fetch API folds repeated headers into one comma-separated value; any single value may match too.
    return [joined, ...joined.split(",").map((value) => value.trim())];
  }

  const values: string[] = [];

  for (const [name, value] of Object.entries(headers)) {
    if (!equalFold(name, key) || value === undefined) continue;

    if (typeof value === "string") values.push(value);
    else values.push(...value);
  }

  return values;
};

const headersMatch = (
  headers: HeaderInput | undefined,
  rules: Readonly<Record<string, string>> | undefined,
): boolean => {
  if (rules === undefined) return true;

  for (const [rawKey, pattern] of Object.entries(rules)) {
    const key = rawKey.trim();

    if (key === "") continue;
    const values = headerValues(headers, key);

    if (values.length === 0) return false;

    if (!values.some((value) => matchModelPattern(pattern, value))) return false;
  }

  return true;
};

const pathMatchesValue = (payload: Json, path: string, value: Json): boolean =>
  resolvePayloadRulePaths(payload, path).some((resolved) => {
    const current = get(payload, resolved);

    return current !== undefined && jsonEquals(current, value);
  });

const pathExists = (payload: Json, path: string): boolean =>
  resolvePayloadRulePaths(payload, path).some((resolved) => {
    const current = get(payload, resolved);

    return current !== undefined && current !== null;
  });

const conditionsMatch = (payload: Json, root: string, rule: PayloadModelRule): boolean => {
  for (const condition of rule.match ?? []) {
    for (const [path, value] of Object.entries(condition)) {
      if (path.trim() === "") continue;

      if (!pathMatchesValue(payload, buildPayloadPath(root, path), value)) return false;
    }
  }

  for (const condition of rule["not-match"] ?? []) {
    for (const [path, value] of Object.entries(condition)) {
      if (path.trim() === "") continue;

      if (pathMatchesValue(payload, buildPayloadPath(root, path), value)) return false;
    }
  }

  for (const path of rule.exist ?? []) {
    if (path.trim() === "") continue;

    if (!pathExists(payload, buildPayloadPath(root, path))) return false;
  }

  for (const path of rule["not-exist"] ?? []) {
    if (path.trim() === "") continue;

    if (pathExists(payload, buildPayloadPath(root, path))) return false;
  }

  return true;
};

export interface PayloadMatchContext {
  readonly protocol: string;
  readonly fromProtocol: string;
  readonly headers: HeaderInput | undefined;
  readonly root: string;
  readonly candidates: readonly string[];
}

/** True when any model entry matches any model candidate and its protocol/header/payload conditions hold. */
export const payloadModelRulesMatch = (
  rules: readonly PayloadModelRule[] | undefined,
  context: PayloadMatchContext,
  payload: Json,
): boolean => {
  if (rules === undefined || rules.length === 0 || context.candidates.length === 0) return false;

  for (const model of context.candidates) {
    for (const entry of rules) {
      const name = (entry.name ?? "").trim();

      if (name === "") continue;
      const entryProtocol = (entry.protocol ?? "").trim();

      if (
        entryProtocol !== "" &&
        context.protocol !== "" &&
        !equalFold(entryProtocol, context.protocol)
      )
        continue;

      if (!fromProtocolMatches(entry["from-protocol"], context.fromProtocol)) continue;

      if (!headersMatch(context.headers, entry.headers)) continue;

      if (!matchModelPattern(name, model)) continue;

      if (conditionsMatch(payload, context.root, entry)) return true;
    }
  }

  return false;
};
