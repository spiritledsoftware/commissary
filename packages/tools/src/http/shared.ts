/**
 * What the Tools area's HTTP paths share: the MCP client and endpoint, OpenAPI documents and the calls of their tools
 * (`call.ts`).
 */
import { Schema } from "effect";
import type { HttpMethod } from "effect/http/HttpMethod";

/** Whether a JSON value is an object (not an array, not `null`). */
export const isJsonObject = Schema.is(Schema.JsonObject);

/** A JSON media type (`application/json`, `application/problem+json`, ...), lowercase and without parameters. */
export const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;

/** The methods an OpenAPI path item may name an operation for, uppercase; a tool's request makes each of them. */
export const HTTP_METHODS: ReadonlyArray<HttpMethod> = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
];

const METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

/** Whether `method` is one of {@link HTTP_METHODS}. */
export const isHttpMethod = (method: string): method is HttpMethod => METHOD_SET.has(method);
