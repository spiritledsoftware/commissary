/**
 * Error classification shared by the Worker (retry loop) and the ControlPlane (result handling).
 *
 * Go source: sdk/cliproxy/auth/conductor_cooldown.go (isModelSupportError, isInvalidGrantError,
 * isCloudflareChallengeError, shouldSkipCredentialCooldown, isConnectionLifecycleError, isTransientTransportError,
 * isRequestInvalidError, isExplicitModelNotFoundError, ...), internal/clienterror/client_error.go (IsRequestFault),
 * sdk/cliproxy/auth/conductor_selection.go (isCredentialRetryRoundStatus). Docs: credentials.md §8.3-8.4.
 *
 * Errors are described by {@link ClassifiableError}: `status` is the upstream HTTP status (0 when the failure happened
 * before an HTTP answer), `message` the upstream body or error text, `code` one of the conductor codes.
 */
import { isJsonObject, type Json, type JsonObject, tryParseJson } from "@commissary/json";

/** Well-known error codes (sdk/cliproxy/auth/errors.go). */
export const ErrorCode = {
  requestScoped: "request_scoped",
  connectionLifecycle: "connection_lifecycle",
  transientTransport: "transient_transport",
  forceCooldown: "force_cooldown",
  modelNotFound: "model_not_found",
} as const;

export interface ClassifiableError {
  readonly status: number;
  readonly message: string;
  readonly code?: string | undefined;
}

const lower = (text: string): string => text.trim().toLowerCase();

// --- request faults (internal/clienterror) --------------------------------------------------------------------------

const REQUEST_FAULT_CODES = new Set([
  "cyber_policy",
  "context_length_exceeded",
  "message_too_big",
  "string_above_max_length",
  "invalid_prompt",
  "invalid_value",
  "unsupported_value",
  "invalid_request_error",
  "previous_response_not_found",
]);

const REQUEST_FAULT_TYPES = new Set([
  "invalid_request",
  "invalid_request_error",
  "bad_request_error",
  "invalid_prompt",
]);

const parseJsonObject = (text: string): JsonObject | undefined => {
  const trimmed = text.trim();

  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  const parsed = tryParseJson(trimmed);

  return isJsonObject(parsed) ? parsed : undefined;
};

const isJsonText = (text: string): boolean => {
  const trimmed = text.trim();

  if (trimmed === "") return false;

  try {
    JSON.parse(trimmed);

    return true;
  } catch {
    return false;
  }
};

/** gjson-style lookup of a dotted path of plain keys; non-strings read as "". */
const stringAt = (root: JsonObject, path: string): string => {
  let current: Json | undefined = root;

  for (const key of path.split(".")) {
    if (!isJsonObject(current)) return "";
    current = current[key];
  }

  if (typeof current === "string") return current;

  return typeof current === "number" ? String(current) : "";
};

const CODE_PATHS = ["error.code", "code", "response.error.code", "body.error.code"];

const TYPE_PATHS = ["error.type", "type", "response.error.type", "body.error.type"];

const hasBodyValue = (
  body: string,
  paths: readonly string[],
  accept: (value: string) => boolean,
): boolean => {
  const root = parseJsonObject(body);

  return root !== undefined && paths.some((path) => accept(lower(stringAt(root, path))));
};

/** `IsItemNotPersisted`: Responses items referenced although `store` was false. */
export const isItemNotPersisted = (message: string): boolean => {
  const text = message.toLowerCase();

  return (
    text.includes("item with id") &&
    text.includes("not found") &&
    text.includes("items are not persisted when `store` is set to false")
  );
};

/** `IsClaudeThreadNotFound`: stale `previous_message_id` continuation. */
const isClaudeThreadNotFound = (status: number, body: string): boolean => {
  if (status !== 404) return false;
  const trimmed = body.trim();

  if (trimmed === "") return false;
  const root = parseJsonObject(trimmed);

  if (root !== undefined) {
    const message = lower(stringAt(root, "error.message"));

    return (
      lower(stringAt(root, "error.type")) === "not_found_error" &&
      message.includes("thread state") &&
      message.includes("previous_message_id")
    );
  }

  if (isJsonText(trimmed)) return false;
  const text = trimmed.toLowerCase();

  return text.includes("thread state") && text.includes("previous_message_id");
};

/**
 * `clienterror.IsRequestFault`: the failure is caused by the request, so credentials are neither rotated nor
 * penalised. 402/429 always count against the credential; 401 `authentication_error` is a credential failure.
 */
export const isRequestFault = (status: number, body: string): boolean => {
  if (status === 402 || status === 429) return false;

  if (status === 401 && hasBodyValue(body, TYPE_PATHS, (value) => value === "authentication_error"))
    return false;

  if (isClaudeThreadNotFound(status, body)) return true;

  if (
    hasBodyValue(
      body,
      CODE_PATHS,
      (value) => value === "model_not_found" || value === "model_not_found_error",
    )
  ) {
    return false;
  }

  if (hasBodyValue(body, CODE_PATHS, (value) => REQUEST_FAULT_CODES.has(value))) return true;

  if (hasBodyValue(body, TYPE_PATHS, (value) => REQUEST_FAULT_TYPES.has(value))) return true;

  if (isItemNotPersisted(body)) return true;

  return status === 400 || status === 409 || status === 413 || status === 422;
};

// --- explicit model-not-found (structured) --------------------------------------------------------------------------

const normalizeIdentifier = (value: string): string =>
  lower(value).replaceAll("-", "_").replaceAll(" ", "_");

const isModelNotFoundIdentifier = (value: string): boolean => {
  let candidate = lower(value);
  const fragment = candidate.lastIndexOf("#");

  if (fragment >= 0 && fragment + 1 < candidate.length) {
    candidate = candidate.slice(fragment + 1);
  } else {
    const query = candidate.indexOf("?");

    if (query >= 0) candidate = candidate.slice(0, query);
    candidate = candidate.replace(/\/+$/, "");
    const separator = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf(":"));

    if (separator >= 0) candidate = candidate.slice(separator + 1);
  }

  return [
    "model_not_found",
    "model_not_found_error",
    "unknown_model",
    "model_does_not_exist",
    "model_not_exist",
  ].includes(normalizeIdentifier(candidate));
};

const isNotFoundErrorIdentifier = (value: string): boolean =>
  ["not_found", "not_found_error"].includes(normalizeIdentifier(value));

const trimPunctuation = (text: string): string =>
  text.replace(/^[ .!;\t\r\n]+|[ .!;\t\r\n]+$/g, "");

const MISSING_MODEL_PHRASES = new Set([
  "not found",
  "was not found",
  "could not be found",
  "does not exist",
  "doesn't exist",
  "not exist",
  "is unknown",
  "does not exist or you do not have access to it",
]);

interface TrimmedReference {
  readonly rest: string;
  readonly matches: boolean;
}

const NO_REFERENCE: TrimmedReference = { rest: "", matches: false };

/** `trimRequestedModelReference`: strips the (possibly quoted) requested model from the start of `value`. */
const trimRequestedModelReference = (value: string, requestedModel: string): TrimmedReference => {
  const model = lower(requestedModel);

  if (model === "") return NO_REFERENCE;

  for (const candidate of [model, `'${model}'`, `"${model}"`, `\`${model}\``]) {
    if (value === candidate) return { rest: "", matches: true };

    if (!value.startsWith(candidate)) continue;
    const remainder = value.slice(candidate.length);

    if (remainder === "" || " :,".includes(remainder.charAt(0))) {
      return { rest: remainder.replace(/^[ :,]+/, ""), matches: true };
    }
  }

  return NO_REFERENCE;
};

const stripPrefixWord = (lowerText: string, prefix: string): string | undefined => {
  if (
    lowerText !== prefix &&
    !lowerText.startsWith(`${prefix} `) &&
    !lowerText.startsWith(`${prefix}:`)
  ) {
    return undefined;
  }

  let rest = lowerText.slice(prefix.length).trim();

  if (rest.startsWith(":")) rest = rest.slice(1).trim();

  return rest;
};

const isExplicitModelNotFoundMessage = (message: string, requestedModel: string): boolean => {
  const text = trimPunctuation(lower(message));

  if (text === "") return false;

  if (text.includes("in request") || text.includes("in body") || text.includes("request body"))
    return false;
  const normalized = text.replaceAll("-", "_");

  if (normalized.includes("model_not_found") || normalized.includes("unknown_model")) return true;

  for (const prefix of ["no such model", "unknown model"]) {
    const remainder = stripPrefixWord(text, prefix);

    if (remainder === undefined) continue;

    if (remainder === "") return true;
    const { rest, matches } = trimRequestedModelReference(remainder, requestedModel);

    return matches && rest === "";
  }

  for (const prefix of ["the requested model", "requested model", "the model", "model"]) {
    const remainder = stripPrefixWord(text, prefix);

    if (remainder === undefined) continue;

    if (MISSING_MODEL_PHRASES.has(trimPunctuation(remainder))) return true;
    const { rest, matches } = trimRequestedModelReference(remainder, requestedModel);

    return matches && MISSING_MODEL_PHRASES.has(trimPunctuation(rest));
  }

  return false;
};

const isExactRequestedModelReference = (message: string, requestedModel: string): boolean => {
  const text = trimPunctuation(lower(message));

  for (const prefix of ["the requested model", "requested model", "the model", "model"]) {
    const remainder = stripPrefixWord(text, prefix);

    if (remainder === undefined) continue;
    const { rest, matches } = trimRequestedModelReference(remainder, requestedModel);

    return matches && rest === "";
  }

  return false;
};

const containsStructuredModelNotFound = (
  value: Json | undefined,
  requestedModel: string,
): boolean => {
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        (typeof item === "string" && isExplicitModelNotFoundMessage(item, requestedModel)) ||
        containsStructuredModelNotFound(item, requestedModel),
    );
  }

  if (typeof value !== "object" || value === null) return false;
  let notFoundType = false;
  let exactModelReference = false;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      switch (lower(key)) {
        case "code":
          if (isModelNotFoundIdentifier(item)) return true;
          break;
        case "type":
          if (isModelNotFoundIdentifier(item)) return true;
          notFoundType = notFoundType || isNotFoundErrorIdentifier(item);
          break;
        case "error":
        case "message":
        case "detail":
        case "error_description":
        case "title":
          if (isExplicitModelNotFoundMessage(item, requestedModel)) return true;
          exactModelReference =
            exactModelReference || isExactRequestedModelReference(item, requestedModel);
          break;
        default:
          break;
      }
    }

    if (
      typeof item === "object" &&
      item !== null &&
      containsStructuredModelNotFound(item, requestedModel)
    )
      return true;
  }

  return notFoundType && exactModelReference;
};

/** `isExplicitModelNotFoundError`: the code or a structured JSON body says the model does not exist. */
export const isExplicitModelNotFound = (error: ClassifiableError, requestedModel = ""): boolean => {
  if (error.code !== undefined && isModelNotFoundIdentifier(error.code)) return true;
  const text = error.message.trim();

  if (text === "") return false;
  let parsed: Json;

  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  return containsStructuredModelNotFound(parsed, requestedModel);
};

// --- message classes ------------------------------------------------------------------------------------------------

const MODEL_SUPPORT_PATTERNS = [
  "model_not_supported",
  "requested model is not supported",
  "requested model is unsupported",
  "requested model is unavailable",
  "model is not supported",
  "model not supported",
  "unsupported model",
  "model unavailable",
  "not available for your plan",
  "not available for your account",
];

export const isModelSupportMessage = (message: string): boolean => {
  const text = lower(message);

  return text !== "" && MODEL_SUPPORT_PATTERNS.some((pattern) => text.includes(pattern));
};

/** `isModelSupportError`: explicit model-not-found, or 400/404/422 with a "model not supported" message. */
export const isModelSupportError = (error: ClassifiableError): boolean => {
  if (isExplicitModelNotFound(error)) return true;

  if (error.status !== 400 && error.status !== 422 && error.status !== 404) return false;

  return isModelSupportMessage(error.message);
};

export const isInvalidGrantError = (error: ClassifiableError): boolean => {
  const text = `${error.code ?? ""} ${error.message}`.toLowerCase();

  if (!text.includes("invalid_grant")) return false;

  return error.status === 400 || error.status === 401 || error.status === 0;
};

export const isCloudflareChallengeMessage = (message: string): boolean => {
  const text = lower(message);

  return (
    text.includes("challenge-platform") ||
    text.includes("cf-mitigated") ||
    text.includes("cloudflare challenge") ||
    (text.includes("just a moment") && text.includes("cloudflare"))
  );
};

/** Gateway failures (>= 500, e.g. Cloudflare 520-526) are never reclassified as a challenge. */
export const isCloudflareChallengeError = (error: ClassifiableError): boolean =>
  error.status < 500 && isCloudflareChallengeMessage(error.message);

export const isConnectionLifecycleMessage = (message: string): boolean => {
  const text = lower(message);

  if (text === "") return false;

  if (
    [
      "context canceled",
      "context deadline exceeded",
      "eof",
      "unexpected eof",
      "aborted",
      "the operation was aborted",
    ].includes(text)
  ) {
    return true;
  }

  return (
    text.includes("websocket: close 1000") ||
    text.includes("websocket: close 1001") ||
    text.includes("websocket: close 1006") ||
    text.includes("unexpected eof")
  );
};

const TRANSIENT_FRAGMENTS = [
  "tls: tls handshake",
  "tls handshake timeout",
  "connection refused",
  "connection reset",
  "i/o timeout",
  "no such host",
  "server misbehaving",
  "network is unreachable",
  "no route to host",
  "broken pipe",
  "connection aborted",
  "use of closed network connection",
  "unexpected eof",
  // Workers `fetch` failures.
  "network connection lost",
  "network connection timed out",
  "connection closed",
  "internal error",
  "failed to fetch",
  "fetch failed",
];

export const isTransientTransportMessage = (message: string): boolean => {
  const text = lower(message);

  return text !== "" && TRANSIENT_FRAGMENTS.some((fragment) => text.includes(fragment));
};

/** `isConnectionLifecycleResultError`: the code, or (without an HTTP status) the message. */
export const isConnectionLifecycleError = (error: ClassifiableError): boolean =>
  error.code === ErrorCode.connectionLifecycle ||
  (error.status === 0 && isConnectionLifecycleMessage(error.message));

/** `isTransientTransportResultError`. */
export const isTransientTransportError = (error: ClassifiableError): boolean =>
  error.code === ErrorCode.transientTransport ||
  (error.status === 0 && isTransientTransportMessage(error.message));

/**
 * `isRequestInvalidError`: a client request error that must neither rotate nor penalise credentials. Model-support
 * errors, Cloudflare challenges and invalid grants stay credential matters.
 */
export const isRequestInvalidError = (error: ClassifiableError): boolean => {
  if (error.code === ErrorCode.requestScoped) return true;

  if (isCloudflareChallengeError(error)) return false;

  if (isInvalidGrantError(error)) return false;

  if (isModelSupportError(error)) return false;

  return isRequestFault(error.status, error.message);
};

/**
 * An upstream 400 or 422 that may be specific to the provider that answered it (issue #185; not in Go). Providers
 * shape requests differently (cloaking, betas, translation, gateways in between), so another provider may accept the
 * request. Commissary's own request-scoped errors (local validation) and the other request faults (409, 413) are
 * about the request itself. Whether the error is a request fault for cooldown purposes is {@link isRequestInvalidError}'s
 * decision and stays unchanged.
 */
export const isProviderSpecificRequestError = (error: ClassifiableError): boolean =>
  (error.status === 400 || error.status === 422) &&
  error.code !== ErrorCode.requestScoped &&
  isRequestInvalidError(error);

/** `isRequestScopedResultError`: request-scoped marker, "items not persisted" 404, or an invalid request. */
export const isRequestScopedResult = (error: ClassifiableError): boolean =>
  error.code === ErrorCode.requestScoped ||
  (error.status === 404 && isItemNotPersisted(error.message)) ||
  isRequestInvalidError(error);

/**
 * `shouldSkipCredentialCooldown`: request-scoped, connection-lifecycle and transient-transport failures never cool a
 * credential (unless forced).
 */
export const shouldSkipCredentialCooldown = (error: ClassifiableError | undefined): boolean => {
  if (error === undefined) return false;

  if (error.code === ErrorCode.forceCooldown) return false;

  return (
    isRequestScopedResult(error) ||
    isConnectionLifecycleError(error) ||
    isTransientTransportError(error)
  );
};

/** `isCredentialRetryRoundStatus`: statuses that may open another retry round. */
export const isCredentialRetryRoundStatus = (status: number): boolean =>
  status === 403 ||
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504 ||
  // Not in Go: TypeSafe's 529 Overloaded is its 503 (ADR 0032).
  status === 529;

/** `isRequestRetryRoundError`: retry-round status or transient transport failure. */
export const isRequestRetryRoundError = (error: ClassifiableError): boolean =>
  isCredentialRetryRoundStatus(error.status) || isTransientTransportError(error);
