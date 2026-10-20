/**
 * The HTTP request a call of an OpenAPI tool makes (#203): its operation's method and path, against the toolkit's base
 * URL or else the server its document names, with each argument serialised where its parameter goes (OpenAPI's
 * `style` and `explode`, their defaults per location) and the body in the operation's media type. A form body's nested
 * objects and arrays use brackets (`metadata[key]`, `items[0][price]`), as Stripe and most form APIs read them.
 *
 * A path argument never leaves the operation's path: one that would make a `.` or `..` segment (`%2e` included, which
 * URLs read as a dot) is refused, as is a reserved one (a Discovery method's `{+name}`, #205) that does not match its
 * parameter's pattern. Otherwise a caller could reach another endpoint of the API with the toolkit's credential, past
 * the grants and approval rules of the tool that endpoint is.
 */
import { Predicate, Result, type Schema } from "effect";
import type { HttpCall, HttpCallBody } from "../http/call.ts";
import { isHttpMethod, isJsonObject, JSON_MEDIA_TYPE } from "../http/shared.ts";
import type { OpenApiOperation, OperationParameter } from "./tools.ts";

/** What an array not exploded is joined by, by style; `form`'s (and any other's) is a comma. */
const DELIMITERS: ReadonlyMap<string, string> = new Map([
  ["spaceDelimited", " "],
  ["pipeDelimited", "|"],
]);

/** A primitive argument as text: a string as it is, `null` empty. */
const text = (value: Schema.Json): string => {
  if (Predicate.isString(value)) return value;

  return value === null
    ? ""
    : isJsonObject(value) || Array.isArray(value)
      ? JSON.stringify(value)
      : String(value);
};

/** An object's entries, or none. */
const entriesOf = (value: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> =>
  isJsonObject(value) ? Object.entries(value) : [];

/** `value` as bracketed pairs under `prefix`: `a[b]=1`, arrays indexed `a[0]=1`. */
const bracketed = (prefix: string, value: Schema.Json): Array<[string, string]> => {
  if (Array.isArray(value))
    return value.flatMap((item, index) => bracketed(`${prefix}[${index}]`, item));

  if (isJsonObject(value))
    return Object.entries(value).flatMap(([key, item]) => bracketed(`${prefix}[${key}]`, item));

  return [[prefix, text(value)]];
};

/** A query or form parameter as pairs, by its style (default `form`) and explode (default true for `form`). */
const queryPairs = (
  name: string,
  value: Schema.Json,
  style = "form",
  explode = style === "form",
): Array<[string, string]> => {
  if (style === "deepObject") return bracketed(name, value);

  if (Array.isArray(value)) {
    if (explode) return value.map((item) => [name, text(item)]);
    const separator = DELIMITERS.get(style) ?? ",";

    return [[name, value.map(text).join(separator)]];
  }

  if (isJsonObject(value))
    return explode
      ? Object.entries(value).map(([key, item]) => [key, text(item)])
      : [
          [
            name,
            Object.entries(value)
              .flatMap(([key, item]) => [key, text(item)])
              .join(","),
          ],
        ];

  return [[name, text(value)]];
};

/** A path, header or cookie value in the `simple` style: a list joined by commas, an object as `k,v` or `k=v`. */
const simple = (value: Schema.Json, explode: boolean, encode: (part: string) => string): string => {
  if (Array.isArray(value)) return value.map((item) => encode(text(item))).join(",");

  if (isJsonObject(value))
    return entriesOf(value)
      .map(([key, item]) =>
        explode ? `${encode(key)}=${encode(text(item))}` : `${encode(key)},${encode(text(item))}`,
      )
      .join(",");

  return encode(text(value));
};

/** RFC 6570's reserved expansion of `part`: its reserved and unreserved characters, and `%XX` escapes, kept. */
const encodeReserved = (part: string): string =>
  part.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, encodeURIComponent);

/** A path segment URLs read as `.` or `..` (and climb out of the path with): `%2e` is a dot to them. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** `pattern` (a Discovery parameter's) as a regular expression; undefined when JavaScript does not read it. */
const patternOf = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
};

/** Why the path argument `value` of `parameter`, serialised as `segment`, cannot go in the path, if it cannot. */
const pathRefusal = (
  parameter: OperationParameter,
  value: Schema.Json,
  segment: string,
): string | undefined => {
  if (segment.split("/").some((part) => DOT_SEGMENT.test(part)))
    return `the argument ${parameter.argument} cannot be or hold a . or .. path segment`;

  const pattern = parameter.pattern === undefined ? undefined : patternOf(parameter.pattern);

  return pattern === undefined || pattern.test(text(value))
    ? undefined
    : `the argument ${parameter.argument} does not match ${parameter.pattern}`;
};

/** A path parameter's segment, by its style (`simple`, `label` or `matrix`). */
const pathSegment = (parameter: OperationParameter, value: Schema.Json): string => {
  const explode = parameter.explode ?? false;

  if (parameter.allowReserved === true) return simple(value, explode, encodeReserved);

  if (parameter.style === "label") return `.${simple(value, explode, encodeURIComponent)}`;

  if (parameter.style === "matrix") {
    const name = encodeURIComponent(parameter.name);

    if (Array.isArray(value) && explode)
      return value.map((item) => `;${name}=${encodeURIComponent(text(item))}`).join("");

    return `;${name}=${simple(value, explode, encodeURIComponent)}`;
  }

  return simple(value, explode, encodeURIComponent);
};

/** The body the operation sends `value` as. */
const bodyOf = (operation: OpenApiOperation, value: Schema.Json): HttpCallBody => {
  const body = operation.body;
  const contentType = body?.contentType ?? "application/json";
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";

  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    const fields = entriesOf(value).flatMap(([key, item]) => {
      const encoding = body?.encoding?.[key];

      // A nested value goes in brackets unless its encoding asks for a form style.
      if (encoding === undefined && (isJsonObject(item) || Array.isArray(item)))
        return Array.isArray(item) &&
          item.every((entry) => !isJsonObject(entry) && !Array.isArray(entry))
          ? queryPairs(key, item)
          : bracketed(key, item);

      return queryPairs(key, item, encoding?.style, encoding?.explode);
    });

    return type === "multipart/form-data"
      ? { kind: "multipart", fields }
      : { kind: "text", contentType, text: new URLSearchParams(fields).toString() };
  }

  const json = JSON_MEDIA_TYPE.test(type);

  return {
    kind: "text",
    contentType,
    text: json || !Predicate.isString(value) ? JSON.stringify(value) : value,
  };
};

/**
 * The request `operation` makes with `args` against `baseUrl` (the toolkit's) or else the server its document names, or
 * why it cannot be made (a required argument missing, no URL to send it to).
 */
export const operationCall = (
  operation: OpenApiOperation,
  baseUrl: string | undefined,
  args: Schema.JsonObject | undefined,
): Result.Result<HttpCall, string> => {
  const base = baseUrl ?? operation.server;

  if (base === undefined)
    return Result.fail(
      "the toolkit's document names no server Commissary can reach: set the toolkit's base URL",
    );

  const method = operation.method;

  if (!isHttpMethod(method)) return Result.fail(`Commissary does not make ${method} requests`);

  const given = args ?? {};
  let path = operation.path;
  const query: Array<readonly [string, string]> = [];
  const headers: Record<string, string> = {};
  const cookies: Array<readonly [string, string]> = [];

  for (const parameter of operation.parameters) {
    const value = given[parameter.argument];

    if (value === undefined) {
      if (parameter.required) return Result.fail(`the argument ${parameter.argument} is required`);
      continue;
    }

    switch (parameter.in) {
      case "path": {
        const segment = pathSegment(parameter, value);
        const refused = pathRefusal(parameter, value, segment);

        if (refused !== undefined) return Result.fail(refused);

        path = path.replaceAll(`{${parameter.name}}`, segment);
        break;
      }

      case "query":
        query.push(...queryPairs(parameter.name, value, parameter.style, parameter.explode));
        break;
      case "header":
        headers[parameter.name] = simple(value, parameter.explode ?? false, (part) => part);
        break;
      case "cookie":
        cookies.push([parameter.name, simple(value, false, (part) => part)]);
        break;
    }
  }

  const bodyValue = operation.body === undefined ? undefined : given[operation.body.argument];

  if (operation.body?.required === true && bodyValue === undefined)
    return Result.fail(`the argument ${operation.body.argument} is required`);

  let url: URL;

  try {
    url = new URL(base);
  } catch {
    return Result.fail("the toolkit's base URL is not a URL");
  }

  // The operation's path goes after the base's own (`https://api.example.com/v1` + `/pets`).
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;

  return Result.succeed({
    method,
    url: url.toString(),
    query,
    headers,
    cookies,
    body: bodyValue === undefined ? undefined : bodyOf(operation, bodyValue),
  });
};
