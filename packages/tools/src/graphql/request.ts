/**
 * The request a call of a GraphQL tool makes (#204), and how its answer reads. One `POST` of a JSON body (`query` and
 * `variables`) to the endpoint: the operation declares a variable for each argument the call gives, of the argument's
 * type, and selects the root field with them and the field's default selection (`schema.ts`), or the caller's own
 * selection set, which is checked against the toolkit's schema first (graphql-js's validation) so a bad one is refused
 * before anything is sent. A root list's page size the call leaves out is sent as `LIST_CAP` (`schema.ts`). The
 * answer's `errors` without `data` make the result an error; data with errors is a result holding both
 * ({@link graphQLAnswer}).
 */
import { type GraphQLSchema, Kind, parse, validate } from "graphql";
import { Predicate, Result, type Schema } from "effect";
import type { HttpCall, JsonAnswer } from "../http/call.ts";
import { isJsonObject } from "../http/shared.ts";
import { type GraphQLArgument, type GraphQLOperation, operationDocument } from "./schema.ts";

/** The longest selection set a caller may give, in UTF-8 bytes. */
export const MAX_SELECTION_BYTES = 16 * 1024;

/** The most tokens graphql-js reads of a call's document: a bound on the work a selection costs to check. */
const MAX_TOKENS = 10_000;

/** The most validation errors a refusal names. */
const MAX_ERRORS = 3;

/**
 * Whether `document` (the call's, holding the caller's selection set) is still one operation that selects one field,
 * and is valid against the toolkit's schema; why not otherwise. A selection that closes the field's set to add another
 * field or operation is refused like an invalid one.
 */
const checkedSelection = (
  document: string,
  schema: Result.Result<GraphQLSchema, string>,
): Result.Result<void, string> => {
  if (Result.isFailure(schema)) return Result.fail(schema.failure);
  let parsed: ReturnType<typeof parse>;

  try {
    parsed = parse(document, { noLocation: true, maxTokens: MAX_TOKENS });
  } catch {
    return Result.fail("the selection is not a GraphQL selection set");
  }

  const [definition] = parsed.definitions;

  if (
    parsed.definitions.length !== 1 ||
    definition?.kind !== Kind.OPERATION_DEFINITION ||
    definition.selectionSet.selections.length !== 1
  )
    return Result.fail("the selection is not one GraphQL selection set");

  const errors = validate(schema.success, parsed, undefined, { maxErrors: MAX_ERRORS });

  return errors.length === 0
    ? Result.void
    : Result.fail(`the selection is not valid: ${errors.map((error) => error.message).join(" ")}`);
};

/**
 * The request a call of `operation` with `args` makes to `endpoint`, or why it cannot be made: a required argument is
 * missing, or the caller's selection set (`operation.selectionArgument`) is not a string, is longer than
 * {@link MAX_SELECTION_BYTES} or does not check out against the toolkit's schema, which `schema` reads (only for a call
 * that gives a selection).
 */
export const graphQLCall = (
  operation: GraphQLOperation,
  endpoint: string,
  args: Schema.JsonObject | undefined,
  schema: () => Result.Result<GraphQLSchema, string>,
): Result.Result<HttpCall, string> => {
  const input = args ?? {};
  const variables: Record<string, Schema.Json> = {};
  const given: Array<GraphQLArgument> = [];

  for (const argument of operation.arguments) {
    const value = input[argument.name] ?? argument.default;

    if (value === undefined) {
      if (argument.required)
        return Result.fail(`the call misses the required argument ${argument.name}`);
      continue;
    }

    variables[argument.name] = value;
    given.push(argument);
  }

  const own =
    operation.selectionArgument === undefined ? undefined : input[operation.selectionArgument];

  if (own !== undefined && !Predicate.isString(own))
    return Result.fail(`${operation.selectionArgument} must be a GraphQL selection set, a string`);

  const trimmed = own?.trim();

  if (trimmed !== undefined && new TextEncoder().encode(trimmed).byteLength > MAX_SELECTION_BYTES)
    return Result.fail(`the selection is longer than ${MAX_SELECTION_BYTES} bytes`);

  const selection =
    trimmed === undefined || trimmed === ""
      ? operation.selection
      : trimmed.startsWith("{")
        ? trimmed
        : `{ ${trimmed}\n}`;

  const document = operationDocument(operation, given, selection);

  if (selection !== operation.selection) {
    const checked = checkedSelection(document, schema());

    if (Result.isFailure(checked)) return Result.fail(checked.failure);
  }

  return Result.succeed({
    method: "POST",
    url: endpoint,
    headers: { accept: "application/graphql-response+json, application/json;q=0.9" },
    body: {
      kind: "text",
      contentType: "application/json",
      text: JSON.stringify({ query: document, variables }),
    },
  });
};

/**
 * Whether a GraphQL answer is an error (GraphQL over HTTP): it has errors and no data. The whole answer is shown
 * (`data`, `errors`, `extensions`).
 */
export const graphQLAnswer: JsonAnswer = (body) => {
  if (!isJsonObject(body)) return false;
  const errors = body["errors"];
  const data = body["data"];

  return (data === undefined || data === null) && Array.isArray(errors) && errors.length > 0;
};
