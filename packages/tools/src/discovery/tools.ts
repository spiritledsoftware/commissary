/**
 * The tool list of a Discovery toolkit (#205, ADR 0036): one tool per method of a Google Discovery document (the REST
 * description Google's APIs publish, `https://gmail.googleapis.com/$discovery/rest?version=v1`), the methods of nested
 * resources included. Each method is made into an OpenAPI operation and built as an OpenAPI toolkit's operations are
 * (`openapi/tools.ts`), so names, input schemas and their bounds, descriptions, deprecation, classes and calls follow
 * the same rules:
 *
 * - **Upstream name**: the method's `id` (`gmail.users.messages.list`).
 * - **Input schema**: the method's path and query parameters (a `repeated` one an array) and its request body
 *   (`body`, JSON), the `$ref`s to the document's `schemas` resolved. Discovery's own keywords become JSON Schema's: a
 *   property's `required: true` its object's `required`, a `type: "any"` no type, `default`, `minimum` and `maximum`
 *   (strings in Discovery) the values their type reads; keywords JSON Schema has no use for (`id`, `annotations`,
 *   `enumDescriptions`, ...) are dropped. The document's global parameters (`alt`, `fields`, `key`, ...) are not
 *   offered.
 * - **Description**: the method's.
 * - **Calls**: the method's HTTP method, its `path` under `rootUrl` and `servicePath`, a `{+name}` parameter expanded
 *   with its reserved characters (`/`) kept (`flatPath` names other parameters than the method's for such a path), a
 *   value that does not match the parameter's `pattern` or would make a `.` or `..` segment refused
 *   (`openapi/request.ts`). The credential is an API key in the `key` query parameter or an OAuth 2 token as a bearer
 *   token; the method's `scopes` are kept with it, so the toolkit can say which an OAuth app must ask for.
 * - **Media**: a method whose only input is an upload (`supportsMediaUpload` without a request body) is not listed; one
 *   that takes a JSON body besides is, as a JSON call (the upload protocol is not offered), and one that answers its
 *   media to a plain request (`files.export`) is, its answer shaped as any other (`http/call.ts`).
 *
 * Batch requests are not offered (#205's scope).
 */
import { Predicate, Result, type Schema } from "effect";
import { isHttpMethod } from "../http/shared.ts";
import { asObject, asString, operationTool, type Value } from "../openapi/tools.ts";
import type { ListedTool } from "../toolkits/store.ts";

/** The tools a Discovery document lists, and what names a toolkit by default. */
export interface DiscoveryToolList {
  /** The API's name (`gmail`), else its title. */
  readonly name: string | undefined;
  /** The root URL the document's calls are made under, which the outbound guard checks on save. */
  readonly rootUrl: string;
  readonly tools: ReadonlyArray<ListedTool>;
}

/** A node of the document: a JSON object. */
type Node = Schema.JsonObject;

/** `value` as a string with its white space trimmed, if it has more. */
const trimmed = (value: Value): string | undefined => asString(value)?.trim();

// --- schemas ---------------------------------------------------------------------------------------------------------

/** Where the OpenAPI operations made of the methods find the schema `name`: a JSON pointer into `components`. */
const schemaRef = (name: string): string =>
  `#/components/schemas/${encodeURIComponent(name.replaceAll("~", "~0").replaceAll("/", "~1"))}`;

/** Keywords Discovery shares with JSON Schema, kept as they are. */
const KEPT = ["description", "format", "pattern", "enum", "readOnly", "deprecated"] as const;

const BOOLEANS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["false", false],
]);

/** `value` as a value of `type`: Discovery writes defaults and bounds as strings (`"100"`, `"false"`). */
const typedValue = (value: Value, type: Value): Schema.Json | undefined => {
  if (!Predicate.isString(value)) return value;

  if (type === "boolean") return BOOLEANS.get(value);

  if (type === "integer" || type === "number") {
    const number = Number(value);

    return value.trim() !== "" && Number.isFinite(number) ? number : undefined;
  }

  return value;
};

/** A Discovery schema as JSON Schema, its `$ref`s pointing into `components.schemas`. */
const jsonSchemaOf = (node: Value): Schema.JsonObject => {
  const schema = asObject(node);

  if (schema === undefined) return {};
  const out: Record<string, Schema.Json> = {};
  const ref = schema["$ref"];
  const type = schema["type"];

  if (Predicate.isString(ref)) out["$ref"] = schemaRef(ref);

  if (Predicate.isString(type) && type !== "any") out["type"] = type;

  for (const key of KEPT) {
    const value = schema[key];

    if (value !== undefined) out[key] = value;
  }

  const bounded = type === "integer" || type === "number";

  for (const key of ["default", ...(bounded ? ["minimum", "maximum"] : [])]) {
    const value = typedValue(schema[key], type);

    if (value !== undefined) out[key] = value;
  }

  const properties = asObject(schema["properties"]);

  if (properties !== undefined) {
    out["properties"] = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [name, jsonSchemaOf(property)]),
    );

    const required = Object.entries(properties).flatMap(([name, property]) =>
      asObject(property)?.["required"] === true ? [name] : [],
    );

    if (required.length > 0) out["required"] = required;
  }

  if (schema["items"] !== undefined) out["items"] = jsonSchemaOf(schema["items"]);
  const additional = schema["additionalProperties"];

  if (Predicate.isBoolean(additional)) out["additionalProperties"] = additional;
  else if (additional !== undefined) out["additionalProperties"] = jsonSchemaOf(additional);

  return out;
};

// --- methods ---------------------------------------------------------------------------------------------------------

/** The security alternatives of every method: an API key in `key`, or an OAuth 2 token. */
const SECURITY_SCHEMES: Node = {
  key: { type: "apiKey", in: "query", name: "key" },
  oauth2: { type: "oauth2" },
};

const SECURITY: Schema.Json = [{ key: [] }, { oauth2: [] }];

/** A `{+name}` in a method's path: a parameter expanded with its reserved characters kept. */
const RESERVED_EXPANSION = /\{\+([^}]+)\}/g;

/** A method's parameter as an OpenAPI parameter, if it goes in the path or the query. */
const parameterOf = (name: string, value: Value): Node | undefined => {
  const node = asObject(value);
  const location = node?.["location"];

  if (node === undefined || (location !== "path" && location !== "query")) return undefined;
  const { description, ...rest } = jsonSchemaOf(node);

  return {
    name,
    in: location,
    required: node["required"] === true,
    ...(Predicate.isString(description) ? { description } : {}),
    schema: node["repeated"] === true ? { type: "array", items: rest } : rest,
  };
};

/** Where every method of the document is called: `rootUrl` and `servicePath`. */
interface Service {
  readonly server: string;
  /** What the methods' operations resolve their `$ref`s and security schemes against. */
  readonly document: Node;
}

/** The method `node` (named `id`, or else by `path`, its resources and its own key) as a tool; undefined when none. */
const methodTool = (
  service: Service,
  path: ReadonlyArray<string>,
  node: Node,
): ListedTool | undefined => {
  const method = trimmed(node["httpMethod"])?.toUpperCase();
  const template = trimmed(node["path"]);

  if (method === undefined || !isHttpMethod(method) || template === undefined) return undefined;

  // Media is this method's only input: it is uploaded, which Commissary does not do (#205).
  if (node["supportsMediaUpload"] === true && node["request"] === undefined) return undefined;

  const reserved = new Set([...template.matchAll(RESERVED_EXPANSION)].map((match) => match[1]));

  const declared = asObject(node["parameters"]) ?? {};

  const parameters = Object.entries(declared).flatMap(([name, value]) => {
    const parameter = parameterOf(name, value);

    return parameter === undefined ? [] : [parameter];
  });

  const description = asString(node["description"]);

  const operation: Node = {
    operationId: trimmed(node["id"]) ?? path.join("."),
    ...(description === undefined ? {} : { description }),
    parameters,
    ...(node["request"] === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchemaOf(node["request"]) } },
          },
        }),
    servers: [{ url: service.server }],
    security: SECURITY,
    ...(node["deprecated"] === true ? { deprecated: true } : {}),
  };

  const openApiPath = `/${template.replace(/^\/+/, "").replace(RESERVED_EXPANSION, "{$1}")}`;
  const tool = operationTool(service.document, undefined, openApiPath, {}, method, operation);
  const built = tool.operation;

  if (built === undefined) return tool;

  const scopes = (Array.isArray(node["scopes"]) ? node["scopes"] : []).filter(Predicate.isString);

  return {
    ...tool,
    operation: {
      ...built,
      parameters: built.parameters.map((parameter) => {
        if (parameter.in !== "path" || !reserved.has(parameter.name)) return parameter;
        // A `{+name}` keeps its slashes: what it may hold is what its pattern says (`^projects/[^/]+$`).
        const pattern = asString(asObject(declared[parameter.name])?.["pattern"]);

        return {
          ...parameter,
          allowReserved: true as const,
          ...(pattern === undefined ? {} : { pattern }),
        };
      }),
      ...(scopes.length === 0 ? {} : { scopes }),
    },
  };
};

/** The tools of `resource`'s methods, then of its resources', depth first. */
const resourceTools = (
  service: Service,
  path: ReadonlyArray<string>,
  resource: Node,
): ReadonlyArray<ListedTool> => [
  ...Object.entries(asObject(resource["methods"]) ?? {}).flatMap(([name, value]) => {
    const node = asObject(value);
    const tool = node === undefined ? undefined : methodTool(service, [...path, name], node);

    return tool === undefined ? [] : [tool];
  }),
  ...Object.entries(asObject(resource["resources"]) ?? {}).flatMap(([name, value]) => {
    const node = asObject(value);

    return node === undefined ? [] : resourceTools(service, [...path, name], node);
  }),
];

/** Where the document's calls go: `rootUrl` with `servicePath` under it; undefined when it names no absolute URL. */
const serverOf = (rootUrl: string, servicePath: string): string | undefined => {
  try {
    return new URL(`${rootUrl.replace(/\/*$/, "/")}${servicePath.replace(/^\/+/, "")}`).toString();
  } catch {
    return undefined;
  }
};

/** The parsed document, if `text` holds a Discovery document (JSON), or why not. Messages never quote the text. */
const parsedDocument = (text: string): Result.Result<Node, string> => {
  let value: Value;

  try {
    // SAFETY: JSON.parse returns a JSON value.
    value = JSON.parse(text) as Schema.Json;
  } catch {
    return Result.fail("the document is not JSON");
  }

  const document = asObject(value);

  return document !== undefined &&
    (document["kind"] === "discovery#restDescription" || document["discoveryVersion"] === "v1")
    ? Result.succeed(document)
    : Result.fail("the document is not a Discovery document");
};

/** The tools of the Discovery document `text` (JSON), or why there are none to build. */
export const discoveryToolList = (text: string): Result.Result<DiscoveryToolList, string> =>
  Result.flatMap(parsedDocument(text), (document) => {
    const rootUrl = trimmed(document["rootUrl"]);

    const server =
      rootUrl === undefined ? undefined : serverOf(rootUrl, trimmed(document["servicePath"]) ?? "");

    if (rootUrl === undefined || server === undefined)
      return Result.fail("the Discovery document names no rootUrl calls can be made under");

    const schemas = Object.fromEntries(
      Object.entries(asObject(document["schemas"]) ?? {}).map(([name, schema]) => [
        name,
        jsonSchemaOf(schema),
      ]),
    );

    const service: Service = {
      server,
      document: { components: { schemas, securitySchemes: SECURITY_SCHEMES } },
    };

    return Result.succeed({
      name: trimmed(document["name"]) ?? trimmed(document["title"]),
      rootUrl,
      tools: resourceTools(service, [], document),
    });
  });
