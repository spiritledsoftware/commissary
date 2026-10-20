/**
 * An OpenAPI document as a toolkit is built from it (#203): its text, JSON or YAML, parsed and brought to OpenAPI 3.1.
 * OpenAPI 3.0 and Swagger 2.0 documents are upgraded by Scalar's upgrader (`@scalar/openapi-upgrader`, MIT: plain
 * JavaScript over the parsed document, nothing of Node.js, so it runs in the Workers runtime), which also turns 3.0's
 * schemas into 3.1's (`nullable` into a type array, a boolean `exclusiveMinimum` into a number, Swagger's body and form
 * parameters into a request body). 3.2 documents are read as 3.1.
 *
 * YAML is read by js-yaml (MIT) with its core schema: plain JSON values, about a quarter of the memory the `yaml`
 * package's document model takes. A YAML document is at most {@link MAX_YAML_DOCUMENT_BYTES} (parsing it holds about
 * twice what parsing JSON does), and its aliases may not expand past {@link MAX_YAML_NODES} values (js-yaml shares an
 * alias's value rather than copying it, so a "billion laughs" document is small in memory but not to walk).
 */
import { Buffer } from "node:buffer";
import { upgrade } from "@scalar/openapi-upgrader";
import { Predicate, Result, type Schema } from "effect";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";

/** The largest OpenAPI document in YAML a toolkit is built from (a JSON one may be twice as large). */
export const MAX_YAML_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** The most values a YAML document may hold once its aliases are expanded. */
export const MAX_YAML_NODES = 2_000_000;

/** A parsed document: an object whose values are JSON (YAML's core schema yields nothing else). */
export type DocumentObject = Schema.JsonObject;

/** A version field as text: a string, or the number a YAML `2.0` reads as (`2`: "2.0"). */
const versionText = (value: Schema.Json | undefined): string => {
  if (Predicate.isString(value)) return value;

  if (!Predicate.isNumber(value)) return "";

  return Number.isInteger(value) ? value.toFixed(1) : String(value);
};

/** Which revision a parsed document declares, if it is one Commissary reads. */
const revisionOf = (document: DocumentObject): "2.0" | "3.0" | "3.1" | undefined => {
  // A YAML `swagger: 2.0` or `openapi: 3.1` is a number.
  const swagger = document["swagger"];
  const openapi = document["openapi"];

  if (swagger !== undefined) return versionText(swagger).startsWith("2") ? "2.0" : undefined;

  const version = versionText(openapi);

  if (version.startsWith("3.0")) return "3.0";

  return version.startsWith("3.1") || version.startsWith("3.2") ? "3.1" : undefined;
};

/** Whether `value` holds at most `limit` values, its shared ones counted each time they appear. */
const expandsWithin = (value: Schema.Json, limit: number): boolean => {
  const pending: Array<Schema.Json> = [value];
  let counted = 1;

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== "object" || next === null) continue;
    const children: ReadonlyArray<Schema.Json> = Array.isArray(next) ? next : Object.values(next);

    counted += children.length;

    if (counted > limit) return false;

    for (const child of children) pending.push(child);
  }

  return true;
};

/** The parsed text (JSON when it reads as JSON, else YAML, of which JSON is a subset but slower to read), or why not. */
const parsed = (text: string): Result.Result<Schema.Json, string> => {
  const trimmed = text.trimStart();

  if (trimmed.startsWith("{"))
    try {
      // SAFETY: JSON.parse returns a JSON value.
      return Result.succeed(JSON.parse(trimmed) as Schema.Json);
    } catch {
      // Not JSON after all: YAML may still read it (a flow mapping).
    }

  if (Buffer.byteLength(text, "utf8") > MAX_YAML_DOCUMENT_BYTES)
    return Result.fail(
      `the YAML document is larger than ${MAX_YAML_DOCUMENT_BYTES} bytes: upload it as JSON instead`,
    );

  let value: Schema.Json;

  try {
    // SAFETY: js-yaml's core schema yields JSON values only (null, booleans, numbers, strings, maps and sequences).
    value = loadYaml(text, { schema: CORE_SCHEMA }) as Schema.Json;
  } catch {
    return Result.fail("the document is neither JSON nor YAML");
  }

  return expandsWithin(value, MAX_YAML_NODES)
    ? Result.succeed(value)
    : Result.fail("the document's YAML aliases expand too far");
};

// SAFETY: an object inside a JSON value is a JSON object (checked shallowly: the document may be several MB).
const asDocument = (value: Schema.Json): DocumentObject | undefined =>
  Predicate.isObject(value) ? (value as DocumentObject) : undefined;

/**
 * The OpenAPI 3.1 document `text` holds (JSON or YAML; OpenAPI 3.0, 3.1 or 3.2, or Swagger 2.0), or why it holds none.
 * Messages never quote the text.
 */
export const parseOpenApiDocument = (text: string): Result.Result<DocumentObject, string> => {
  const read = parsed(text);

  if (Result.isFailure(read)) return Result.fail(read.failure);
  const value = asDocument(read.success);

  if (value === undefined) return Result.fail("the document is not an OpenAPI document");
  const revision = revisionOf(value);

  if (revision === undefined)
    return Result.fail("the document is not OpenAPI 3.0, 3.1 or 3.2, nor Swagger 2.0");

  if (revision === "3.1") return Result.succeed(value);

  // The upgrader reads a version only as a string (a YAML `openapi: 3.0` is a number).
  const [key, version] =
    revision === "2.0" ? ["swagger", "2.0"] : ["openapi", versionText(value["openapi"])];

  const versioned: DocumentObject = Object.fromEntries([...Object.entries(value), [key, version]]);

  try {
    const upgraded: object = upgrade(versioned, "3.1");
    // SAFETY: the upgrader returns the document it was given, upgraded in place: a plain object of JSON values.
    const document = asDocument(upgraded as Schema.Json);

    return document === undefined
      ? Result.fail("the document could not be upgraded")
      : Result.succeed(document);
  } catch {
    return Result.fail(
      `the ${revision === "2.0" ? "Swagger 2.0" : "OpenAPI 3.0"} document could not be upgraded`,
    );
  }
};
