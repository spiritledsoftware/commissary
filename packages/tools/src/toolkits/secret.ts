/**
 * The static secrets a toolkit signs in with (#196): none, a bearer token, an API key in a named header or query
 * parameter, or basic auth (`ToolkitSecret`, `@commissary/contract/tools`). OAuth and the other types come later
 * (#202, #206). A header must not be one the MCP client sets itself.
 */
import type { ToolkitSecret } from "@commissary/contract/tools";

/** A header name (RFC 9110 `token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Headers the MCP client or the transport set: a key cannot replace them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

/** The longest secret value or name kept. */
const MAX_LENGTH = 8192;

const tooLong = (...values: ReadonlyArray<string>): boolean =>
  values.some((value) => value.length > MAX_LENGTH);

/** Why `secret` cannot be stored, if it cannot. */
export const secretRefusal = (secret: ToolkitSecret): string | undefined => {
  switch (secret.kind) {
    case "none":
      return undefined;
    case "bearer":
      if (secret.token.trim() === "") return "a bearer credential needs its token";

      return tooLong(secret.token) ? "the token is too long" : undefined;
    case "header":
      if (!HEADER_NAME.test(secret.name)) return "the header's name is not a valid header name";

      if (RESERVED_HEADERS.has(secret.name.toLowerCase()))
        return `the ${secret.name.toLowerCase()} header cannot carry a key`;

      if (secret.value.trim() === "") return "a header credential needs its value";

      return tooLong(secret.name, secret.value) ? "the header is too long" : undefined;
    case "query":
      if (secret.name.trim() === "") return "a query credential names its parameter";

      if (secret.value.trim() === "") return "a query credential needs its value";

      return tooLong(secret.name, secret.value) ? "the query parameter is too long" : undefined;
    case "basic":
      if (secret.username === "" || secret.username.includes(":"))
        return "basic auth needs a user name without a colon";

      return tooLong(secret.username, secret.password) ? "the credential is too long" : undefined;
  }
};
