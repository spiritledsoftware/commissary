/**
 * The tool list of an OpenAPI toolkit (#203, ADR 0036): one tool per operation of an OpenAPI 3.1 document
 * (`document.ts` brings 3.0 and Swagger 2.0 there), with what a call needs to make its request ({@link
 * OpenApiOperation}), so a call never reads the document again.
 *
 * - **Upstream name**: the `operationId`, or the method and the path (`GET /pets/{petId}`) when there is none. The
 *   stable id and the full name follow from it (ADR 0037).
 * - **Input schema**: one object joining the path, query, header and cookie parameters (by name; a name two locations
 *   share takes its location as a prefix, `query_id`) and the request body (`body`), each property name made one that
 *   model APIs take (`[A-Za-z0-9_.-]`, at most 64 characters). Local `$ref`s are resolved, a recursive one ends in an
 *   empty schema, and keywords that only document (`example`, `xml`, extensions, ...) are dropped, as are a request
 *   body's read-only properties. A schema above `MAX_SCHEMA_BYTES` is cut at a shallower depth until it fits.
 * - **Description**: the summary and the description, at most `MAX_DESCRIPTION` characters
 *   (`toolkits/input-schema.ts`).
 * - **Class** (`resolve.ts`): `GET` and `HEAD` read, every other method writes.
 * - **Deprecated** operations are listed, flagged, and hidden unless an override shows them.
 *
 * Webhooks, callbacks and external `$ref`s are not read (#203's scope).
 */
import { Predicate, Result, type Schema } from "effect";
import type { HttpMethod } from "effect/http/HttpMethod";
import type { Security, SecurityScheme } from "../http/call.ts";
import { HTTP_METHODS, JSON_MEDIA_TYPE } from "../http/shared.ts";
import {
  descriptionText,
  fittedInputSchema,
  type InputWalk,
  visit,
} from "../toolkits/input-schema.ts";
import type { ListedTool } from "../toolkits/store.ts";
import { type DocumentObject, readOpenApiDocument, upgradedOpenApiDocument } from "./document.ts";
import { applyJsonPatch, type JsonPatchOperation } from "./patch.ts";

const LOCATIONS = ["path", "query", "header", "cookie"] as const;

export type ParameterLocation = (typeof LOCATIONS)[number];

/** Header parameters OpenAPI says are ignored: the request's own. */
const IGNORED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);

/** A parameter of an operation, and the input property it is read from. */
export interface OperationParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly argument: string;
  readonly required: boolean;
  readonly style?: string;
  readonly explode?: boolean;
  /**
   * A path parameter whose value keeps the URI's reserved characters (`/` among them) as they are: a Discovery method's
   * `{+name}` (#205).
   */
  readonly allowReserved?: true;
  /** The pattern a path argument must match (a Discovery parameter's, for a `{+name}` one). */
  readonly pattern?: string;
}

/** An operation's request body, and the input property it is read from. */
export interface OperationBody {
  readonly argument: string;
  readonly contentType: string;
  readonly required: boolean;
  /** How a form body's properties are serialised (OpenAPI's encoding object), by property. */
  readonly encoding?: Readonly<
    Record<string, { readonly style?: string; readonly explode?: boolean }>
  >;
}

/** What a call of an OpenAPI tool needs to make its request, stored with the tool. */
export interface OpenApiOperation {
  /** Uppercase. */
  readonly method: string;
  /** The path template, `/pets/{petId}`. */
  readonly path: string;
  /** The server URL the document names for it, absolute; undefined when it names none a call can reach. */
  readonly server?: string;
  readonly parameters: ReadonlyArray<OperationParameter>;
  readonly body?: OperationBody;
  /** Its security alternatives (`http/call.ts`); undefined when the document defines no security schemes. */
  readonly security?: Security;
  readonly deprecated?: true;
  /** The OAuth 2 scopes a Discovery method names (#205), any of which a sign-in may ask for. */
  readonly scopes?: ReadonlyArray<string>;
}

/** The tools a document lists, and what names a toolkit by default. */
export interface OpenApiToolList {
  readonly title: string | undefined;
  /** The first server the document names, absolute. */
  readonly server: string | undefined;
  readonly tools: ReadonlyArray<ListedTool>;
  /** Why the catalog's fixes to the document were not applied (they no longer apply to it). */
  readonly unpatched?: string;
}

/** A node of the document: a JSON object. */
type Node = Schema.JsonObject;

/** A value of the document, if any. */
export type Value = Schema.Json | undefined;

/** `value` as a JSON object, if it is one (Discovery documents, #205, are read with it too). */
export const asObject = (value: Value): Node | undefined =>
  // SAFETY: an object inside a JSON value is a JSON object (checked shallowly: a deep check of every node would read
  // a document of several MB over and over).
  Predicate.isObject(value) ? (value as Node) : undefined;

/** `value` as a string, if it is one with more than white space. */
export const asString = (value: Value): string | undefined =>
  Predicate.isString(value) && value.trim() !== "" ? value : undefined;

/** The value a local JSON pointer (`#/components/schemas/Pet`) names in `document`. */
const pointer = (document: Node, ref: string): Value => {
  if (!ref.startsWith("#")) return undefined;
  let node: Value = document;

  for (const raw of ref.slice(1).split("/").slice(1)) {
    const segment = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    const object = asObject(node);

    if (Array.isArray(node)) node = node[Number(segment)];
    else if (object !== undefined) node = object[segment];
    else return undefined;
  }

  return node;
};

/** `node` with its `$ref` followed (a ref to a ref too), at most 32 times; undefined when it leads nowhere. */
const followed = (document: Node, node: Value): Node | undefined => {
  let current = asObject(node);

  for (let hop = 0; hop < 32 && current !== undefined; hop += 1) {
    const ref = current["$ref"];

    if (!Predicate.isString(ref)) return current;
    current = asObject(pointer(document, ref));
  }

  return undefined;
};

// --- schemas -----------------------------------------------------------------------------------------------------------

/** Keywords that only document a schema, or point into the document: dropped. */
const DROPPED = new Set([
  "example",
  "examples",
  "xml",
  "externalDocs",
  "discriminator",
  "$id",
  "$schema",
  "$comment",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$defs",
  "definitions",
]);

/** Keywords whose value is a schema. */
const SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);

/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas"]);

interface SchemaWalk extends InputWalk {
  readonly document: Node;
}

/** A schema past the depth limit: its type alone, if it has one. */
const summary = (walk: SchemaWalk, node: Value): Schema.JsonObject => {
  const schema = followed(walk.document, node);
  const type = schema?.["type"];

  if (Predicate.isString(type)) return { type };

  return Array.isArray(type) ? { type: type.filter(Predicate.isString) } : {};
};

/**
 * `node` as a self-contained JSON Schema: refs resolved (a ref already being resolved above it, a cycle, ends in `{}`;
 * one that leads nowhere is `{}`), documenting keywords dropped and, in a request (`writing`), read-only properties
 * left out. Below `walk.maxDepth` a schema is its {@link summary}.
 */
const resolveSchema = (
  walk: SchemaWalk,
  node: Value,
  depth: number,
  refs: ReadonlySet<string>,
  writing: boolean,
): Schema.JsonObject => {
  visit(walk);
  const schema = asObject(node);

  if (schema === undefined) return {};
  const ref = schema["$ref"];

  if (Predicate.isString(ref)) {
    if (refs.has(ref)) return {};
    const target = asObject(pointer(walk.document, ref));

    if (target === undefined) return {};
    // Keywords beside a `$ref` (3.1) apply too: a description, most often.
    const { $ref: _ref, ...siblings } = schema;

    const merged = Object.fromEntries([...Object.entries(target), ...Object.entries(siblings)]);

    return resolveSchema(walk, merged, depth, new Set([...refs, ref]), writing);
  }

  if (depth > walk.maxDepth) return summary(walk, schema);

  const out: Record<string, Schema.Json> = {};
  const readOnly = new Set<string>();

  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key) || key.startsWith("x-")) continue;

    if (key === "description" && !walk.descriptions) continue;

    if (SCHEMA_MAPS.has(key)) {
      const map = asObject(value);

      if (map === undefined) continue;
      const resolved: Record<string, Schema.Json> = {};

      for (const [name, property] of Object.entries(map)) {
        if (
          writing &&
          key === "properties" &&
          followed(walk.document, property)?.["readOnly"] === true
        ) {
          readOnly.add(name);
          continue;
        }

        resolved[name] = resolveSchema(walk, property, depth + 1, refs, writing);
      }

      out[key] = resolved;
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value))
      out[key] = value.map((item) => resolveSchema(walk, item, depth + 1, refs, writing));
    else if (SCHEMA_KEYWORDS.has(key))
      out[key] = Predicate.isBoolean(value)
        ? value
        : resolveSchema(walk, value, depth + 1, refs, writing);
    else if (value !== undefined)
      // SAFETY: a parsed document holds JSON values only (JSON.parse, or YAML's core schema), and none is changed.
      out[key] = value;
  }

  const required = out["required"];

  if (readOnly.size > 0 && Array.isArray(required))
    out["required"] = required.filter((name) => !(Predicate.isString(name) && readOnly.has(name)));

  return out;
};

// --- operations --------------------------------------------------------------------------------------------------------

/** A property name model APIs take: `[A-Za-z0-9_.-]`, 1 to 64 characters. */
const argumentName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);

  return cleaned === "" ? "_" : cleaned;
};

/** Hands out unique input property names. */
const namer = () => {
  const taken = new Set<string>();

  return (preferred: ReadonlyArray<string>): string => {
    const candidates = preferred.map(argumentName);
    const free = candidates.find((candidate) => !taken.has(candidate));
    const base = candidates.at(-1) ?? "_";
    let name = free;

    for (let index = 2; name === undefined; index += 1) {
      const numbered = `${base.slice(0, 60)}_${index}`;

      if (!taken.has(numbered)) name = numbered;
    }

    taken.add(name);

    return name;
  };
};

/** A parameter as the document gives it, its ref followed. */
interface RawParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly node: Node;
}

const parametersOf = (document: Node, list: Value): ReadonlyArray<RawParameter> =>
  (Array.isArray(list) ? list : []).flatMap((item): ReadonlyArray<RawParameter> => {
    const node = followed(document, item);
    const name = asString(node?.["name"]);
    const location = LOCATIONS.find((candidate) => candidate === node?.["in"]);

    if (node === undefined || name === undefined || location === undefined) return [];

    if (location === "header" && IGNORED_HEADERS.has(name.toLowerCase())) return [];

    return [{ name, in: location, node }];
  });

/** A path item's parameters with the operation's, which win by name and location. */
const mergedParameters = (
  document: Node,
  pathItem: Node,
  operation: Node,
): ReadonlyArray<RawParameter> => {
  const own = parametersOf(document, operation["parameters"]);
  const key = (parameter: RawParameter) => `${parameter.in}:${parameter.name}`;
  const overridden = new Set(own.map(key));

  return [
    ...parametersOf(document, pathItem["parameters"]).filter(
      (parameter) => !overridden.has(key(parameter)),
    ),
    ...own,
  ];
};

/** The media types a body is preferred in: JSON, then forms, then text, then whatever comes first. */
const bodyMediaType = (content: Node): string | undefined => {
  const types = Object.keys(content);
  const lower = (type: string) => type.toLowerCase().split(";")[0]?.trim() ?? "";

  return (
    types.find((type) => JSON_MEDIA_TYPE.test(lower(type))) ??
    types.find((type) => lower(type) === "application/x-www-form-urlencoded") ??
    types.find((type) => lower(type) === "multipart/form-data") ??
    types.find((type) => lower(type).startsWith("text/")) ??
    types[0]
  );
};

/** A parameter's schema: its own, or the one of its first media type (`content`). */
const parameterSchema = (parameter: RawParameter): Value => {
  if (parameter.node["schema"] !== undefined) return parameter.node["schema"];
  const content = asObject(parameter.node["content"]);
  const first = content === undefined ? undefined : Object.values(content)[0];

  return asObject(first)?.["schema"];
};

/** A server's URL with its variables' defaults, absolute against the document's URL; undefined if it cannot be. */
const serverUrl = (servers: Value, documentUrl: string | undefined): string | undefined => {
  const server = Array.isArray(servers) ? asObject(servers[0]) : undefined;
  const template = asString(server?.["url"]);

  if (template === undefined) return undefined;
  const variables = asObject(server?.["variables"]) ?? {};

  const url = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = asObject(variables[name])?.["default"];

    return Predicate.isString(value) ? value : "";
  });

  try {
    return new URL(url, documentUrl).toString();
  } catch {
    return undefined;
  }
};

/** A security scheme as a call applies it. */
const schemeOf = (node: Node | undefined): SecurityScheme => {
  const type = node?.["type"];

  if (type === "apiKey") {
    const name = asString(node?.["name"]);
    const location = node?.["in"];

    return name !== undefined &&
      (location === "header" || location === "query" || location === "cookie")
      ? { type: "apiKey", in: location, name }
      : { type: "unsupported" };
  }

  if (type === "http") {
    const scheme = asString(node?.["scheme"]);

    return scheme === undefined
      ? { type: "unsupported" }
      : { type: "http", scheme: scheme.toLowerCase() };
  }

  return type === "oauth2" || type === "openIdConnect" ? { type } : { type: "unsupported" };
};

/**
 * The security alternatives of an operation: its `security`, else the document's. A document that defines schemes but
 * requires none anywhere gets each scheme as an alternative of its own, as such documents usually mean one of them;
 * one that defines none leaves the credential as it was connected (undefined).
 */
const securityOf = (document: Node, operation: Node): Security => {
  const schemes = asObject(asObject(document["components"])?.["securitySchemes"]) ?? {};
  const names = Object.keys(schemes);

  if (names.length === 0) return undefined;
  const scheme = (name: string) => schemeOf(followed(document, schemes[name]));
  const requirements = operation["security"] ?? document["security"];

  if (!Array.isArray(requirements)) return names.map((name) => [scheme(name)]);

  // `security: []` asks for no sign-in.
  if (requirements.length === 0) return [[]];

  return requirements.map((requirement) => Object.keys(asObject(requirement) ?? {}).map(scheme));
};

/** The summary and the description, cut to `MAX_DESCRIPTION` characters (`descriptionText`). */
const descriptionOf = (operation: Node): string | undefined => {
  const summaryText = asString(operation["summary"])?.trim();
  const description = asString(operation["description"])?.trim();

  const text =
    summaryText !== undefined && description !== undefined && !description.startsWith(summaryText)
      ? `${summaryText}\n\n${description}`
      : (description ?? summaryText);

  return descriptionText(text);
};

/** The input schema's properties before resolution: each argument's schema, and whether it is required. */
interface Argument {
  readonly name: string;
  readonly schema: Value;
  readonly description: string | undefined;
  readonly required: boolean;
  /** A request body: its read-only properties are left out. */
  readonly writing: boolean;
}

/** The input schema of `args` as `walk` goes. */
const inputSchemaAt = (
  document: Node,
  args: ReadonlyArray<Argument>,
  input: InputWalk,
): Schema.JsonObject => {
  const walk: SchemaWalk = { ...input, document };
  const properties: Record<string, Schema.Json> = {};

  for (const argument of args) {
    const schema = resolveSchema(walk, argument.schema, 0, new Set(), argument.writing);

    properties[argument.name] =
      walk.descriptions && argument.description !== undefined && schema["description"] === undefined
        ? Object.fromEntries([...Object.entries(schema), ["description", argument.description]])
        : schema;
  }

  const required = args.flatMap((argument) => (argument.required ? [argument.name] : []));

  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
};

/** The deepest input schema of `args` within `MAX_SCHEMA_BYTES` ({@link fittedInputSchema}). */
const inputSchema = (document: Node, args: ReadonlyArray<Argument>): Schema.JsonObject =>
  fittedInputSchema((walk) => inputSchemaAt(document, args, walk));

/**
 * One operation of `document` as a tool: its `operationId` (else its method and path) names it. Discovery documents
 * (#205) build theirs here too, from an OpenAPI operation made of each method.
 */
export const operationTool = (
  document: Node,
  documentUrl: string | undefined,
  path: string,
  pathItem: Node,
  method: HttpMethod,
  operation: Node,
): ListedTool => {
  const name = namer();
  const args: Array<Argument> = [];
  const raw = mergedParameters(document, pathItem, operation);
  const parameters: Array<OperationParameter> = [];

  for (const location of LOCATIONS)
    for (const parameter of raw.filter((candidate) => candidate.in === location)) {
      const argument = name([parameter.name, `${location}_${parameter.name}`]);
      const required = location === "path" || parameter.node["required"] === true;
      const style = asString(parameter.node["style"]);
      const explode = parameter.node["explode"];

      parameters.push({
        name: parameter.name,
        in: location,
        argument,
        required,
        ...(style === undefined ? {} : { style }),
        ...(Predicate.isBoolean(explode) ? { explode } : {}),
      });

      args.push({
        name: argument,
        schema: parameterSchema(parameter),
        description: asString(parameter.node["description"]),
        required,
        writing: false,
      });
    }

  const requestBody = followed(document, operation["requestBody"]);
  const content = asObject(requestBody?.["content"]);
  const mediaType = content === undefined ? undefined : bodyMediaType(content);
  let body: OperationBody | undefined;

  if (content !== undefined && mediaType !== undefined) {
    const media = asObject(content[mediaType]);
    const argument = name(["body", "request_body"]);
    const required = requestBody?.["required"] === true;
    const encoding: Record<string, { style?: string; explode?: boolean }> = {};

    for (const [property, value] of Object.entries(asObject(media?.["encoding"]) ?? {})) {
      const style = asString(asObject(value)?.["style"]);
      const explode = asObject(value)?.["explode"];

      encoding[property] = {
        ...(style === undefined ? {} : { style }),
        ...(Predicate.isBoolean(explode) ? { explode } : {}),
      };
    }

    body = {
      argument,
      contentType: mediaType,
      required,
      ...(Object.keys(encoding).length === 0 ? {} : { encoding }),
    };

    args.push({
      name: argument,
      schema: media?.["schema"] ?? {},
      description: asString(requestBody?.["description"]),
      required,
      writing: true,
    });
  }

  const security = securityOf(document, operation);

  const server =
    serverUrl(operation["servers"], documentUrl) ??
    serverUrl(pathItem["servers"], documentUrl) ??
    serverUrl(document["servers"], documentUrl) ??
    // A document that names no server is served from its own location's root (OpenAPI's default `/`).
    (documentUrl === undefined ? undefined : new URL("/", documentUrl).toString());

  const plan: OpenApiOperation = {
    method,
    path,
    ...(server === undefined ? {} : { server }),
    parameters,
    ...(body === undefined ? {} : { body }),
    ...(security === undefined ? {} : { security }),
    ...(operation["deprecated"] === true ? { deprecated: true as const } : {}),
  };

  const description = descriptionOf(operation);

  return {
    name: asString(operation["operationId"])?.trim() ?? `${method} ${path}`,
    ...(description === undefined ? {} : { description }),
    inputSchema: inputSchema(document, args),
    operation: plan,
  };
};

/**
 * The tools of the OpenAPI 3.1 `document` (`parseOpenApiDocument`), fetched from `documentUrl` (undefined: uploaded,
 * so a relative server URL leads nowhere until the toolkit has a base URL), or why there are none to build.
 */
export const openApiTools = (
  document: DocumentObject,
  documentUrl: string | undefined,
): Result.Result<OpenApiToolList, string> => {
  const paths = asObject(document["paths"]) ?? {};
  const tools: Array<ListedTool> = [];

  for (const [path, value] of Object.entries(paths)) {
    const pathItem = followed(document, value);

    if (pathItem === undefined || !path.startsWith("/")) continue;

    for (const method of HTTP_METHODS) {
      const operation = asObject(pathItem[method.toLowerCase()]);

      if (operation === undefined) continue;

      tools.push(operationTool(document, documentUrl, path, pathItem, method, operation));
    }
  }

  return Result.succeed({
    title: asString(asObject(document["info"])?.["title"]),
    server: serverUrl(document["servers"], documentUrl),
    tools,
  });
};

/**
 * The tools of the OpenAPI document `text` (JSON or YAML) from `documentUrl` (undefined: uploaded), or why none; with
 * `patch` (the toolkit catalog's fixes to the document, #207) applied to the document as it is, before it is upgraded.
 * A patch that no longer applies (the document changed) leaves the document as it is, and the list says why
 * (`unpatched`).
 */
export const openApiToolList = (
  text: string,
  documentUrl: string | undefined,
  patch: ReadonlyArray<JsonPatchOperation> = [],
): Result.Result<OpenApiToolList, string> =>
  Result.flatMap(readOpenApiDocument(text), (read) => {
    const patched = patch.length === 0 ? undefined : applyJsonPatch(read, patch);

    const unpatched =
      patched !== undefined && Result.isFailure(patched) ? patched.failure : undefined;

    const document =
      (patched !== undefined && Result.isSuccess(patched)
        ? asObject(patched.success)
        : undefined) ?? read;

    return Result.map(
      Result.flatMap(upgradedOpenApiDocument(document), (upgraded) =>
        openApiTools(upgraded, documentUrl),
      ),
      (list) => (unpatched === undefined ? list : { ...list, unpatched }),
    );
  });
