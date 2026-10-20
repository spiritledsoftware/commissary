/**
 * JSON Patch (RFC 6902) over a parsed document: the fixes integrations.sh records for an OpenAPI document
 * (`specOverrides`, #207), applied when a toolkit added from the toolkit catalog builds its tools from it. Pure, and
 * importing only `effect`: the catalog's trim (`catalog/integrations-sh.ts`, which the Node.js sync script runs) reads
 * the operations' schema from here.
 *
 * Every operation of RFC 6902 is supported (`add`, `remove`, `replace`, `move`, `copy`, `test`); a pointer is RFC 6901's
 * (`~1` is `/`, `~0` is `~`; `-` appends to an array). The document is not changed: each operation copies the
 * containers on its path. An operation that does not apply (a missing member, a failed `test`) fails the whole patch,
 * as RFC 6902 says, with what went wrong.
 */
import { Result, Schema } from "effect";

/** One JSON Patch operation. */
export const JsonPatchOperation = Schema.Struct({
  op: Schema.Literals(["add", "remove", "replace", "move", "copy", "test"]),
  path: Schema.String,
  value: Schema.optionalKey(Schema.Json),
  from: Schema.optionalKey(Schema.String),
});

export type JsonPatchOperation = typeof JsonPatchOperation.Type;

type Json = Schema.Json;

/** A pointer's tokens; undefined when it is not one (it must be empty or start with `/`). */
const tokensOf = (pointer: string): ReadonlyArray<string> | undefined => {
  if (pointer === "") return [];

  if (!pointer.startsWith("/")) return undefined;

  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
};

type JsonObject = { readonly [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

/** `object` with its member `key` set to `value` (in its place, when it has one). */
const withMember = (object: JsonObject, key: string, value: Json): JsonObject =>
  Object.fromEntries([...Object.entries(object), [key, value]]);

/** The array index `token` names in an array of `length` (`-` past its end when `append`); undefined when none. */
const indexOf = (token: string, length: number, append: boolean): number | undefined => {
  if (token === "-") return append ? length : undefined;

  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const index = Number(token);

  return index < length || (append && index === length) ? index : undefined;
};

/** The value at `tokens`; undefined when there is none. */
const valueAt = (document: Json, tokens: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = document;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = indexOf(token, current.length, false);

      current = index === undefined ? undefined : current[index];
    } else if (isObject(current))
      current = Object.hasOwn(current, token) ? current[token] : undefined;
    else return undefined;
  }

  return current;
};

/** `container` with its member `token` changed, or why it cannot be. */
type Change = (container: Json, token: string) => Result.Result<Json, string>;

/** `document` with `change` made at the last token of `tokens`, copying the containers on the way. */
const changedAt = (
  document: Json,
  tokens: ReadonlyArray<string>,
  change: Change,
): Result.Result<Json, string> => {
  const [head, ...rest] = tokens;

  if (head === undefined) return Result.fail("the operation names the document itself");

  if (rest.length === 0) return change(document, head);

  const child = valueAt(document, [head]);

  if (child === undefined) return Result.fail(`no member ${head}`);

  return Result.map(changedAt(child, rest, change), (next) => {
    if (Array.isArray(document))
      return document.map((entry, i) => (String(i) === head ? next : entry));

    return withMember(isObject(document) ? document : {}, head, next);
  });
};

const insert =
  (value: Json): Change =>
  (container, token) => {
    if (Array.isArray(container)) {
      const index = indexOf(token, container.length, true);

      if (index === undefined) return Result.fail(`no index ${token}`);

      return Result.succeed([...container.slice(0, index), value, ...container.slice(index)]);
    }

    if (isObject(container)) return Result.succeed(withMember(container, token, value));

    return Result.fail(`${token} is not in an object or array`);
  };

const removal: Change = (container, token) => {
  if (Array.isArray(container)) {
    const index = indexOf(token, container.length, false);

    return index === undefined
      ? Result.fail(`no index ${token}`)
      : Result.succeed(container.filter((_, i) => i !== index));
  }

  if (isObject(container) && Object.hasOwn(container, token)) {
    const { [token]: _removed, ...rest } = container;

    return Result.succeed(rest);
  }

  return Result.fail(`no member ${token}`);
};

const replacement =
  (value: Json): Change =>
  (container, token) => {
    if (Array.isArray(container)) {
      const index = indexOf(token, container.length, false);

      return index === undefined
        ? Result.fail(`no index ${token}`)
        : Result.succeed(container.map((entry, i) => (i === index ? value : entry)));
    }

    if (isObject(container) && Object.hasOwn(container, token))
      return Result.succeed(withMember(container, token, value));

    return Result.fail(`no member ${token}`);
  };

const sameJson = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One operation applied to `document`. */
const applied = (document: Json, operation: JsonPatchOperation): Result.Result<Json, string> => {
  const tokens = tokensOf(operation.path);

  if (tokens === undefined) return Result.fail(`${operation.path} is not a JSON pointer`);
  const { value } = operation;

  switch (operation.op) {
    case "add":
      if (value === undefined) return Result.fail("add has no value");

      return tokens.length === 0
        ? Result.succeed(value)
        : changedAt(document, tokens, insert(value));
    case "remove":
      return changedAt(document, tokens, removal);
    case "replace":
      if (value === undefined) return Result.fail("replace has no value");

      return tokens.length === 0
        ? Result.succeed(value)
        : changedAt(document, tokens, replacement(value));
    case "test": {
      const found = valueAt(document, tokens);

      return found !== undefined && value !== undefined && sameJson(found, value)
        ? Result.succeed(document)
        : Result.fail(`test of ${operation.path} failed`);
    }

    case "move":
    case "copy": {
      const from = tokensOf(operation.from ?? "");
      const moved = from === undefined ? undefined : valueAt(document, from);

      if (from === undefined || moved === undefined)
        return Result.fail(`no value at ${operation.from ?? "(from)"}`);

      const source =
        operation.op === "move" ? changedAt(document, from, removal) : Result.succeed(document);

      return Result.flatMap(source, (next) =>
        tokens.length === 0 ? Result.succeed(moved) : changedAt(next, tokens, insert(moved)),
      );
    }
  }
};

/** `document` with `operations` applied in order, or what kept one from applying (none of them is then applied). */
export const applyJsonPatch = (
  document: Json,
  operations: ReadonlyArray<JsonPatchOperation>,
): Result.Result<Json, string> => {
  let current = document;

  for (const [index, operation] of operations.entries()) {
    const next = applied(current, operation);

    if (Result.isFailure(next))
      return Result.fail(
        `operation ${index + 1} (${operation.op} ${operation.path}): ${next.failure}`,
      );
    current = next.success;
  }

  return Result.succeed(current);
};
