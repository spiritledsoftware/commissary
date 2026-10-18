/**
 * The error shape of the System One client format (ADR 0032): every `/v1/systemone` error, Commissary's own and the
 * providers', reaches the client as TypeSafe's `{"detail":{"error_type","message"}}`, so TypeSafe's SDKs parse and
 * retry failures as they would against TypeSafe. Shared by the Models handler, the API Worker's gate and the
 * authentication refusals, which all answer that path. Workers addition, no Go counterpart.
 */
import { normalizedPath } from "./client-api.ts";

/** The System One endpoint (TypeSafe's `POST /v1/systemone`). */
export const SYSTEM_ONE_PATH = "/v1/systemone";

/** Whether a request URL (absolute or origin-relative) is the System One endpoint; a trailing slash counts. */
export const isSystemOnePath = (requestUrl: string): boolean => {
  const path = normalizedPath(requestUrl);

  return path === SYSTEM_ONE_PATH || path === `${SYSTEM_ONE_PATH}/`;
};

/** TypeSafe's `error_type` for a status, used when an error carries none of its own. */
export const systemOneErrorType = (status: number): string => {
  switch (status) {
    case 400:
      return "api_usage_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 408:
      return "timeout_error";
    case 413:
      return "request_too_large";
    case 415:
      return "unsupported_media_type";
    case 422:
      return "validation_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "api_usage_error";
  }
};

/** A System One error body: `{"detail":{"error_type","message"}}`; `errorType` defaults from the status. */
export const systemOneErrorBody = (status: number, message: string, errorType?: string): string =>
  JSON.stringify({
    detail: {
      error_type:
        errorType !== undefined && errorType.trim() !== ""
          ? errorType.trim()
          : systemOneErrorType(status),
      message,
    },
  });
