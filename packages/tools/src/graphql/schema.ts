/**
 * The tool list of a GraphQL toolkit (#204, ADR 0036): one tool per field of the schema's query root and mutation root,
 * read by graphql-js from the endpoint's answer to introspection or from an uploaded SDL file, with what a call needs
 * to make its request ({@link GraphQLOperation}) and the schema as SDL, which a call checks a caller's own selection
 * against (`request.ts`).
 *
 * - **Upstream name**: the root and the field, `query.issues`, `mutation.createIssue`. Subscriptions are not tools.
 * - **Input schema**: one property per argument, in JSON Schema: `Int` an integer, `Float` a number, `String` and `ID`
 *   strings, `Boolean` a boolean, another scalar any value, an enum its values as strings, a list an array and an input
 *   object an object of its fields (a `@oneOf` one takes exactly one); a non-null argument or field without a default
 *   is required. A default value is kept as `default`. Recursive input objects are cut at a shallower depth until the
 *   schema fits `MAX_SCHEMA_BYTES` (`toolkits/input-schema.ts`), descriptions dropped first. A field whose result is an
 *   object, an interface or a union also takes `selection` ({@link GraphQLOperation.selectionArgument}): a selection
 *   set in place of the default.
 * - **A root list's cap**: a field whose result is a list or a connection, with an optional `Int` argument `first` or
 *   `limit` the schema gives no default, sends {@link LIST_CAP} for it when a call leaves it out (its input schema says
 *   `default: 10`), so a call that names no page size does not ask for the whole list.
 * - **Default selection** ({@link defaultSelection}): the result's scalar and enum fields first, then those of the
 *   objects it links to, level by level, at most {@link MAX_SELECTION_DEPTH} levels and {@link MAX_SELECTION_FIELDS}
 *   fields; a list or connection below the result is capped at {@link LIST_CAP} items through its `first` or `limit`
 *   argument, and left out when it has neither. Each tool's default is checked against the schema when the list is
 *   built ({@link checkedDefault}); one that does not check out is `{ __typename }`.
 * - **Description**: the field's, at most `MAX_DESCRIPTION` characters.
 * - **Class** (`resolve.ts`): a query field reads, a mutation field writes.
 * - **Deprecated** fields are listed, flagged, and hidden unless an override shows them.
 */
import { Buffer } from "node:buffer";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  getNamedType,
  GraphQLError,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type IntrospectionQuery,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isRequiredArgument,
  isRequiredInputField,
  isScalarType,
  isUnionType,
  parse,
  printSchema,
  validate,
  valueFromASTUntyped,
} from "graphql";
import { Predicate, Result, type Schema } from "effect";
import { isJsonObject } from "../http/shared.ts";
import {
  descriptionText,
  fittedInputSchema,
  type InputWalk,
  visit,
} from "../toolkits/input-schema.ts";
import type { ListedTool } from "../toolkits/store.ts";

/**
 * The largest uploaded SDL file a toolkit is built from: graphql-js's syntax tree of SDL takes about 9.5 times its
 * text, where an introspection answer (up to `MAX_DOCUMENT_BYTES`) takes about 2.6 times (docs/ARCHITECTURE.md).
 */
export const MAX_SDL_BYTES = 4 * 1024 * 1024;

/** Levels of objects a default selection reaches: the result's own fields are the first. */
export const MAX_SELECTION_DEPTH = 3;

/** The most fields a default selection holds (`__typename` counts as one). */
export const MAX_SELECTION_FIELDS = 50;

/**
 * The items a list or connection is capped at: below a field's result in a default selection, and a root field's own
 * when a call names no page size.
 */
export const LIST_CAP = 10;

/** The introspection query a build sends first: descriptions and `@oneOf` input objects (`isOneOf`). */
export const INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true, oneOf: true });

/**
 * The introspection query a build sends when the endpoint refused {@link INTROSPECTION_QUERY}: a server older than
 * `@oneOf` does not know `isOneOf`.
 */
export const LEGACY_INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true });

/** What a call of a GraphQL tool needs to make its request, stored with the tool. */
export interface GraphQLOperation {
  readonly root: "query" | "mutation";
  readonly field: string;
  /**
   * The field's arguments: each one's name (also its input property) and its type, as a variable declares it, and what
   * a call that leaves it out sends ({@link LIST_CAP} for a root list's page size, see the module's notes).
   */
  readonly arguments: ReadonlyArray<GraphQLArgument>;
  /** The default selection set of the field's result, `{ id title }`; absent for a scalar or enum result. */
  readonly selection?: string;
  /** The input property a caller's own selection set is read from (`selection`, unless an argument has that name). */
  readonly selectionArgument?: string;
  readonly deprecated?: true;
}

/** An argument of a root field, as a call declares it. */
export interface GraphQLArgument {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly default?: number;
}

/** The tools of a schema, and the schema as SDL, which calls check a caller's selection against. */
export interface GraphQLToolList {
  readonly tools: ReadonlyArray<ListedTool>;
  readonly schema: string;
}

/** Where a schema is read from: an endpoint's answer to {@link INTROSPECTION_QUERY}, or an uploaded SDL file. */
export type SchemaText =
  | { readonly introspection: string; readonly sdl?: never }
  | { readonly sdl: string; readonly introspection?: never };

// --- reading a schema ------------------------------------------------------------------------------------------------

/** Where a syntax error is, `(line 3, column 7)`, if graphql-js says. */
const locationOf = (error: GraphQLError): string => {
  const location = error.locations?.[0];

  return location === undefined ? "" : ` (line ${location.line}, column ${location.column})`;
};

/** What a build says of an endpoint that does not answer introspection. */
export const NO_INTROSPECTION =
  "the GraphQL endpoint did not answer introspection (it may not allow it): upload its schema (SDL) instead";

/**
 * Whether an answer's `data` holds a `__schema` object: an introspection result as far as a build reads it here, as
 * buildClientSchema checks the rest and throws on what is missing.
 */
const holdsSchema = (data: unknown): data is IntrospectionQuery =>
  isJsonObject(data) && isJsonObject(data["__schema"]);

/** The schema an endpoint's answer to introspection describes, or why none. Messages never quote the answer. */
const introspected = (text: string): Result.Result<GraphQLSchema, string> => {
  let answer: unknown;

  try {
    answer = JSON.parse(text);
  } catch {
    return Result.fail("the GraphQL endpoint's answer to introspection is not JSON");
  }

  const data = isJsonObject(answer) ? answer["data"] : undefined;

  if (!holdsSchema(data)) return Result.fail(NO_INTROSPECTION);

  try {
    return Result.succeed(buildClientSchema(data, { assumeValid: true }));
  } catch {
    return Result.fail("the GraphQL endpoint's answer to introspection is not a schema");
  }
};

/** The schema of an uploaded SDL file, checked as SDL, or why none. Messages never quote the text. */
const uploadedSchema = (text: string): Result.Result<GraphQLSchema, string> => {
  if (Buffer.byteLength(text, "utf8") > MAX_SDL_BYTES)
    return Result.fail(`the schema is larger than ${MAX_SDL_BYTES} bytes`);

  try {
    return Result.succeed(buildSchema(text, { assumeValid: true, noLocation: true }));
  } catch (error) {
    return Result.fail(
      `the schema is not valid GraphQL SDL${error instanceof GraphQLError ? locationOf(error) : ""}`,
    );
  }
};

/**
 * The schema calls check a selection against, from the SDL a build stored ({@link GraphQLToolList.schema}): built as
 * valid, since a build printed it from a schema it read.
 */
export const storedSchema = (sdl: string): Result.Result<GraphQLSchema, string> => {
  try {
    return Result.succeed(
      buildSchema(sdl, { assumeValid: true, assumeValidSDL: true, noLocation: true }),
    );
  } catch {
    return Result.fail("the toolkit's schema could not be read: refresh its tool list");
  }
};

/**
 * The one schema a part keeps built for the calls that check a caller's selection, so a run of them builds it once
 * (GitHub's takes about 60 ms and 16 MB, docs/ARCHITECTURE.md): the last toolkit's whose call read it, for the list
 * built at the time it was read with. The part forgets it when the toolkit's list is stored again or the toolkit is
 * removed.
 */
export class SchemaCache {
  #kept:
    | { readonly toolkitId: string; readonly builtAt: number; readonly schema: GraphQLSchema }
    | undefined;

  /**
   * The schema of `toolkitId`'s list built at `builtAt`: the one kept, or one built from `sdl()` (the stored SDL),
   * kept in its place.
   */
  schema(
    toolkitId: string,
    builtAt: number | undefined,
    sdl: () => string | undefined,
  ): Result.Result<GraphQLSchema, string> {
    const kept = this.#kept;

    if (kept !== undefined && kept.toolkitId === toolkitId && kept.builtAt === builtAt)
      return Result.succeed(kept.schema);

    // The schema kept for another toolkit goes before this one is built: two are never held together.
    this.#kept = undefined;
    const text = builtAt === undefined ? undefined : sdl();

    if (builtAt === undefined || text === undefined)
      return Result.fail("the toolkit has no schema to check the selection against: refresh it");

    const built = storedSchema(text);

    if (Result.isSuccess(built)) this.#kept = { toolkitId, builtAt, schema: built.success };

    return built;
  }

  /** Forgets the schema kept for `toolkitId` (every one, without), if it is the one kept. */
  forget(toolkitId?: string): void {
    if (toolkitId === undefined || this.#kept?.toolkitId === toolkitId) this.#kept = undefined;
  }
}

// --- input schemas ---------------------------------------------------------------------------------------------------

/** The JSON Schema of a built-in scalar; undefined for another scalar, which takes any value. */
const builtInScalar = (name: string): Schema.JsonObject | undefined => {
  switch (name) {
    case "Int":
      return { type: "integer" };
    case "Float":
      return { type: "number" };
    case "String":
    case "ID":
      return { type: "string" };
    case "Boolean":
      return { type: "boolean" };
    default:
      return undefined;
  }
};

/** What a schema property says of an argument or an input field: its description and default, when it has them. */
interface InputValue {
  readonly type: GraphQLInputType;
  readonly description?: string | null | undefined;
  readonly default?: { readonly literal?: Parameters<typeof valueFromASTUntyped>[0] } | undefined;
}

/** `type` as a JSON Schema, cut to its type alone below `walk.maxDepth`. */
const inputTypeSchema = (
  walk: InputWalk,
  type: GraphQLInputType,
  depth: number,
): Schema.JsonObject => {
  visit(walk);

  if (isNonNullType(type)) return inputTypeSchema(walk, type.ofType, depth);

  if (isListType(type))
    return depth >= walk.maxDepth
      ? { type: "array" }
      : { type: "array", items: inputTypeSchema(walk, type.ofType, depth + 1) };

  if (isEnumType(type))
    return {
      type: "string",
      enum: type
        .getValues()
        .filter((value) => value.deprecationReason == null)
        .map((value) => value.name),
    };

  if (isScalarType(type)) {
    const known = builtInScalar(type.name);

    if (known !== undefined) return known;

    return walk.descriptions ? { description: `A ${type.name}.` } : {};
  }

  if (!isInputObjectType(type) || depth >= walk.maxDepth) return { type: "object" };
  const fields = Object.values(type.getFields());

  const properties = Object.fromEntries(
    fields.map((field) => [field.name, inputValueSchema(walk, field, depth + 1)]),
  );

  const required = fields.filter(isRequiredInputField).map((field) => field.name);

  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
    ...(type.isOneOf ? { minProperties: 1, maxProperties: 1 } : {}),
  };
};

/** An argument's or an input field's schema, with its description and default. */
const inputValueSchema = (walk: InputWalk, value: InputValue, depth: number): Schema.JsonObject => {
  const schema = inputTypeSchema(walk, value.type, depth);
  const description = walk.descriptions ? descriptionText(value.description) : undefined;
  const literal = value.default?.literal;

  // SAFETY: a constant GraphQL literal is a JSON value untyped: an enum value is its name, a list an array.
  const defaultValue =
    literal === undefined ? undefined : (valueFromASTUntyped(literal) as Schema.Json);

  const own = schema["description"];

  return Object.fromEntries([
    ...Object.entries(schema),
    ...(description === undefined
      ? []
      : [["description", Predicate.isString(own) ? `${description} (${own})` : description]]),
    ...(defaultValue === undefined ? [] : [["default", defaultValue]]),
  ]);
};

/** A name for the selection's input property that no argument has. */
const selectionArgumentOf = (field: GraphQLField<unknown, unknown>): string => {
  const taken = new Set(field.args.map((argument) => argument.name));
  let name = "selection";

  for (let index = 2; taken.has(name); index += 1) name = `selection_${index}`;

  return name;
};

/** What a tool's input schema adds to its field's arguments. */
interface InputExtras {
  /** The caller's own selection set's property, for a field whose result is an object, an interface or a union. */
  readonly selection: { readonly argument: string; readonly description: string } | undefined;
  /** The argument a call sends {@link LIST_CAP} for when it leaves it out (a root list's page size). */
  readonly cap: string | undefined;
}

/** The input schema of `field` as `walk` goes. */
const inputSchemaAt = (
  field: GraphQLField<unknown, unknown>,
  extras: InputExtras,
  walk: InputWalk,
): Schema.JsonObject => {
  const properties: Record<string, Schema.Json> = {};

  for (const argument of field.args) {
    const schema = inputValueSchema(walk, argument, 0);

    properties[argument.name] =
      argument.name === extras.cap
        ? Object.fromEntries([...Object.entries(schema), ["default", LIST_CAP]])
        : schema;
  }

  if (extras.selection !== undefined)
    properties[extras.selection.argument] = {
      type: "string",
      ...(walk.descriptions ? { description: extras.selection.description } : {}),
    };

  const required = field.args.filter(isRequiredArgument).map((argument) => argument.name);

  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
};

// --- default selections ----------------------------------------------------------------------------------------------

/** One selection set as a default selection builds it: its fields and its subselections, in the schema's order. */
interface SelectionSet {
  readonly entries: Array<string | Subselection>;
  /**
   * What each response name of the set selects (`(first: 10) LabelConnection!`); a union's inline fragments share
   * their union's, as their fields land in one set.
   */
  readonly names: Map<string, string>;
}

/** A field with a selection set of its own (`labels(first: 10) { ... }`), or an inline fragment (`... on Issue`). */
interface Subselection {
  readonly head: string;
  readonly set: SelectionSet;
}

/** Whether `type` is a Relay connection: an object named `...Connection` with `nodes` or `edges`. */
const isConnection = (type: GraphQLNamedType): type is GraphQLObjectType =>
  isObjectType(type) &&
  type.name.endsWith("Connection") &&
  (type.getFields()["nodes"] !== undefined || type.getFields()["edges"] !== undefined);

/** Whether a field's result is a list or a connection. */
const isMany = (field: GraphQLField<unknown, unknown>): boolean => {
  const nullable = isNonNullType(field.type) ? field.type.ofType : field.type;

  return isListType(nullable) || isConnection(getNamedType(field.type));
};

/** Whether a field may be selected without arguments the default selection cannot give: none of them is required. */
const selectable = (field: GraphQLField<unknown, unknown>): boolean =>
  field.deprecationReason == null && !field.args.some(isRequiredArgument);

/** The `Int` argument `first` or `limit` that caps a list or connection field, if it has one. */
const capArgument = (field: GraphQLField<unknown, unknown>) =>
  field.args.find(
    (argument) =>
      (argument.name === "first" || argument.name === "limit") &&
      getNamedType(argument.type).name === "Int",
  );

/** The arguments that cap a list or connection field at {@link LIST_CAP} items (`(first: 10)`), if it has them. */
const capOf = (field: GraphQLField<unknown, unknown>): string | undefined => {
  const cap = capArgument(field);

  return cap === undefined ? undefined : `(${cap.name}: ${LIST_CAP})`;
};

const rendered = (set: SelectionSet): string => {
  const parts = set.entries.flatMap((entry) => {
    if (Predicate.isString(entry)) return [entry];
    const inner = rendered(entry.set);

    return inner === "" ? [] : [`${entry.head} ${inner}`];
  });

  return parts.length === 0 ? "" : `{ ${parts.join(" ")} }`;
};

/**
 * The response name `owner`'s field `name` takes in `set` to select `what`: its name, or an alias,
 * `Owner_name: name`, when another member of the same union took the name to select something else (fields of one
 * name in one set must select the same: graphql-js's `OverlappingFieldsCanBeMerged`).
 */
const responseName = (set: SelectionSet, owner: string, name: string, what: string): string => {
  const taken = set.names.get(name);

  if (taken === undefined || taken === what) {
    set.names.set(name, what);

    return name;
  }

  let alias = `${owner}_${name}`;

  for (let index = 2; (set.names.get(alias) ?? what) !== what; index += 1)
    alias = `${owner}_${name}_${index}`;

  set.names.set(alias, what);

  return `${alias}: ${name}`;
};

/**
 * The default selection set of a field whose result is `type` (an object, an interface or a union), `{ id title }`: a
 * breadth-first walk that takes each type's scalar and enum fields (not deprecated, without required arguments) before
 * the next level's, at most {@link MAX_SELECTION_DEPTH} levels and {@link MAX_SELECTION_FIELDS} fields. An object
 * field below the result is a level deeper; one that is a list or a connection is capped at {@link LIST_CAP} items by
 * its `first` or `limit` argument, and left out when it has neither. A connection's own level is its `pageInfo`
 * (`hasNextPage`, `endCursor`), its `totalCount` and its `nodes` (or `edges { node }`) at the connection's level; an
 * interface or a union adds `__typename`, and a union each member's fields in an inline fragment, a field another
 * member selects differently under the same name aliased ({@link responseName}). A selection that finds no field is
 * `{ __typename }`.
 */
export const defaultSelection = (type: GraphQLNamedType): string => {
  const root: SelectionSet = { entries: [], names: new Map() };
  const queue: Array<{ set: SelectionSet; type: GraphQLNamedType; depth: number }> = [];
  let fields = 0;

  const take = (set: SelectionSet, owner: string, name: string, what: string): void => {
    if (fields >= MAX_SELECTION_FIELDS) return;
    set.entries.push(responseName(set, owner, name, what));
    fields += 1;
  };

  /** A subselection of `set`: a field's (its own response names) or an inline fragment's (its union's). */
  const subselection = (set: SelectionSet, head: string, fragment: boolean): SelectionSet => {
    const nested: SelectionSet = { entries: [], names: fragment ? set.names : new Map() };

    set.entries.push({ head, set: nested });

    return nested;
  };

  /** A field of `owner` with a selection set of `of`, walked `depth` levels down. */
  const nest = (
    set: SelectionSet,
    owner: string,
    field: GraphQLField<unknown, unknown>,
    args: string,
    of: GraphQLNamedType,
    depth: number,
  ): void => {
    const name = responseName(set, owner, field.name, `${args} ${field.type.toString()}`);

    queue.push({ set: subselection(set, `${name}${args}`, false), type: of, depth });
  };

  queue.push({ set: root, type, depth: 1 });

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (fields >= MAX_SELECTION_FIELDS) break;
    const { set, type: current, depth } = next;

    if (isUnionType(current)) {
      take(set, current.name, "__typename", "String!");

      for (const member of current.getTypes())
        queue.push({ set: subselection(set, `... on ${member.name}`, true), type: member, depth });

      continue;
    }

    if (!isObjectType(current) && !isInterfaceType(current)) continue;

    if (isInterfaceType(current)) take(set, current.name, "__typename", "String!");
    const own = current.getFields();

    if (isConnection(current)) {
      const pageInfo = own["pageInfo"];
      const pageType = pageInfo === undefined ? undefined : getNamedType(pageInfo.type);

      if (pageInfo !== undefined && isObjectType(pageType)) {
        const name = responseName(set, current.name, "pageInfo", pageInfo.type.toString());
        const page = subselection(set, name, false);

        for (const field of ["hasNextPage", "endCursor"]) {
          const found = pageType.getFields()[field];

          if (found !== undefined) take(page, pageType.name, field, found.type.toString());
        }
      }

      const totalCount = own["totalCount"];

      if (
        totalCount !== undefined &&
        selectable(totalCount) &&
        isLeafType(getNamedType(totalCount.type))
      )
        take(set, current.name, "totalCount", totalCount.type.toString());

      const nodes = own["nodes"];
      const edges = own["edges"];
      const edgeType = getNamedType(edges?.type);
      const edgeNode = isObjectType(edgeType) ? edgeType.getFields()["node"] : undefined;

      if (nodes !== undefined && !isLeafType(getNamedType(nodes.type)))
        nest(set, current.name, nodes, "", getNamedType(nodes.type), depth);
      else if (
        edges !== undefined &&
        isObjectType(edgeType) &&
        edgeNode !== undefined &&
        !isLeafType(getNamedType(edgeNode.type))
      ) {
        const name = responseName(set, current.name, "edges", edges.type.toString());

        nest(
          subselection(set, name, false),
          edgeType.name,
          edgeNode,
          "",
          getNamedType(edgeNode.type),
          depth,
        );
      }

      continue;
    }

    for (const field of Object.values(own)) {
      if (!selectable(field)) continue;
      const named = getNamedType(field.type);

      if (isLeafType(named)) {
        take(set, current.name, field.name, field.type.toString());
        continue;
      }

      if (depth >= MAX_SELECTION_DEPTH) continue;
      const cap = isMany(field) ? capOf(field) : "";

      if (cap !== undefined) nest(set, current.name, field, cap, named, depth + 1);
    }
  }

  const selection = rendered(root);

  return selection === "" ? "{ __typename }" : selection;
};

// --- tools -----------------------------------------------------------------------------------------------------------

/**
 * The document a call of `operation` sends: one operation of its root declaring a variable for each of `args`, of the
 * argument's type, and selecting the field with them and `selection`. The field's set starts on its own line and the
 * operation closes on the next, so a comment in a caller's selection ends there.
 */
export const operationDocument = (
  operation: Pick<GraphQLOperation, "root" | "field">,
  args: ReadonlyArray<Pick<GraphQLArgument, "name" | "type">>,
  selection: string | undefined,
): string => {
  const declared = args.map((argument) => `$${argument.name}: ${argument.type}`);
  const passed = args.map((argument) => `${argument.name}: $${argument.name}`);

  return (
    `${operation.root}${declared.length === 0 ? "" : `(${declared.join(", ")})`} {\n` +
    `  ${operation.field}${passed.length === 0 ? "" : `(${passed.join(", ")})`}` +
    `${selection === undefined ? "" : ` ${selection}`}\n}`
  );
};

/**
 * `selection` when the document of a call that gives every argument and selects it is valid against `schema`, else
 * `{ __typename }`: what the default selection's rule cannot rule out (two fields of one response name that select
 * differently in ways {@link responseName} does not see) never reaches the endpoint.
 */
const checkedDefault = (
  schema: GraphQLSchema,
  operation: Pick<GraphQLOperation, "root" | "field" | "arguments">,
  selection: string,
): string => {
  const document = parse(operationDocument(operation, operation.arguments, selection), {
    noLocation: true,
  });

  return validate(schema, document, undefined, { maxErrors: 1 }).length === 0
    ? selection
    : "{ __typename }";
};

/** One root field as a tool. */
const fieldTool = (
  schema: GraphQLSchema,
  root: "query" | "mutation",
  field: GraphQLField<unknown, unknown>,
): ListedTool => {
  const result = getNamedType(field.type);
  const composite = !isLeafType(result);
  const capping = isMany(field) ? capArgument(field) : undefined;

  // A root list's page size the schema leaves to the server: a call that names none sends LIST_CAP.
  const cap =
    capping !== undefined && capping.default === undefined && !isRequiredArgument(capping)
      ? capping.name
      : undefined;

  const args = field.args.map((argument): GraphQLArgument => ({
    name: argument.name,
    type: argument.type.toString(),
    required: isRequiredArgument(argument),
    ...(argument.name === cap ? { default: LIST_CAP } : {}),
  }));

  const selection = composite
    ? checkedDefault(schema, { root, field: field.name, arguments: args }, defaultSelection(result))
    : undefined;

  const selectionArgument = composite ? selectionArgumentOf(field) : undefined;

  const plan: GraphQLOperation = {
    root,
    field: field.name,
    arguments: args,
    ...(selection === undefined ? {} : { selection }),
    ...(selectionArgument === undefined ? {} : { selectionArgument }),
    ...(field.deprecationReason == null ? {} : { deprecated: true as const }),
  };

  const description = descriptionText(field.description);

  const extras: InputExtras = {
    cap,
    selection:
      selection === undefined || selectionArgument === undefined
        ? undefined
        : {
            argument: selectionArgument,
            description:
              `A GraphQL selection set on ${result.name} for the answer to hold in place of the default, for ` +
              `example "{ id }". The default: ${selection}`,
          },
  };

  return {
    name: `${root}.${field.name}`,
    ...(description === undefined ? {} : { description }),
    inputSchema: fittedInputSchema((walk) => inputSchemaAt(field, extras, walk)),
    graphql: plan,
  };
};

/** The tools of `schema`: its query root's fields, then its mutation root's. */
export const graphQLTools = (schema: GraphQLSchema): ReadonlyArray<ListedTool> => {
  const roots = [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
  ] as const;

  return roots.flatMap(([root, type]) =>
    type == null
      ? []
      : Object.values(type.getFields()).map((field) => fieldTool(schema, root, field)),
  );
};

/** The tools of the schema `text` holds and the schema as SDL, or why none. Messages never quote the text. */
export const graphQLToolList = (text: SchemaText): Result.Result<GraphQLToolList, string> =>
  Result.map(
    text.introspection === undefined ? uploadedSchema(text.sdl) : introspected(text.introspection),
    (schema) => ({ tools: graphQLTools(schema), schema: printSchema(schema) }),
  );
