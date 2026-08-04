import { isJsonValue, type JsonArray, type JsonObject, type JsonValue } from "./json.js";
import {
  parseStoreUpdateInput,
  type FieldInput,
  type RecordDefinition,
  type SelectedRecord,
  type UpdateFieldSchema,
  type UpdateInput,
} from "./record.js";
import { StoreValidationError, type StoreCollectionOperation } from "./store-errors.js";

const fieldType: unique symbol = Symbol("commissary.store.field");
const predicateType: unique symbol = Symbol("commissary.store.predicate");
const orderType: unique symbol = Symbol("commissary.store.order");
const valueExpressionType: unique symbol = Symbol("commissary.store.value-expression");
const unsetType: unique symbol = Symbol("commissary.store.unset-expression");
const expressionNode = Symbol("commissary.store.expression-node");
const baseStoreOperatorSet: unique symbol = Symbol("commissary.store.base-operator-set");

/** Identity carried by expressions from the shared JavaScript operator set. */
export type BaseStoreOperatorSetId = typeof baseStoreOperatorSet;

/** Immutable nonempty object-key path for one query field. */
export type FieldPath = readonly [string, ...string[]];

interface FieldNode<Value> {
  readonly [fieldType]: Value;
}

type NestedFields<Value> =
  NonNullable<Value> extends readonly JsonValue[]
    ? {}
    : NonNullable<Value> extends JsonObject
      ? Fields<NonNullable<Value>>
      : {};

/** Typed field reference supplied to a Store expression callback. */
export type Field<Value> = FieldNode<Value> & NestedFields<Value>;

/** Typed field references for one selected Record or nested object. */
export type Fields<Record extends object> = {
  readonly [Key in keyof Record]-?: Field<Extract<Record[Key], JsonValue | undefined>>;
};
/** Opaque boolean expression returned by query operators. */
export interface Predicate {
  readonly [predicateType]: true;
}

/** Opaque ordering expression returned by query operators. */
export interface Order {
  readonly [orderType]: true;
}

/** Same-type string or numeric comparison operator. */
export interface CompareOperator {
  <Value extends string>(
    left: Field<Value | null | undefined> | Value,
    right: Field<Value | null | undefined> | Value,
  ): Predicate;
  <Value extends number>(
    left: Field<Value | null | undefined> | Value,
    right: Field<Value | null | undefined> | Value,
  ): Predicate;
}

/** Required non-null string or numeric ordering operator. */
export interface OrderOperator {
  (field: Field<string>): Order;
  (field: Field<number>): Order;
}

/** Shared query operators implemented by the JavaScript fallback. */
export interface QueryOperators {
  /** Compare two same-type values for structural equality. */
  readonly eq: <Value extends JsonValue>(
    left: Field<Value | undefined> | Value,
    right: Field<Value | undefined> | Value,
  ) => Predicate;
  /** Compare whether the left value is less than the right value. */
  readonly lt: CompareOperator;
  /** Compare whether the left value is less than or equal to the right value. */
  readonly lte: CompareOperator;
  /** Compare whether the left value is greater than the right value. */
  readonly gt: CompareOperator;
  /** Compare whether the left value is greater than or equal to the right value. */
  readonly gte: CompareOperator;
  /** Require every supplied Predicate to match. */
  readonly and: (...predicates: readonly (Predicate | undefined)[]) => Predicate;
  /** Require at least one supplied Predicate to match. */
  readonly or: (...predicates: readonly (Predicate | undefined)[]) => Predicate;
  /** Negate one Predicate. */
  readonly not: (predicate: Predicate) => Predicate;
  /** Match a Field value against one of the supplied candidates. */
  readonly inArray: <Value extends JsonValue>(
    field: Field<Value | undefined>,
    values: readonly Value[],
  ) => Predicate;
  /** Match a missing or null Field value. */
  readonly isNull: (field: Field<JsonValue | undefined>) => Predicate;
  /** Sort one Field in ascending order. */
  readonly asc: OrderOperator;
  /** Sort one Field in descending order. */
  readonly desc: OrderOperator;
}

/** Operator type components carried by a Store and all its Collections. */
export interface StoreOperatorTypes {
  /** Operator object supplied to Store callbacks. */
  readonly operators: object;
  /** Predicate result type accepted by the Store. */
  readonly predicate: unknown;
  /** Order result type accepted by the Store. */
  readonly order: unknown;
  /** Identity that prevents expressions from different operator sets from mixing. */
  readonly expressionOwner: unknown;
}

/** Selected or literal operand accepted by one update value expression. */
export type ValueExpressionInput<Value extends JsonValue | undefined, OperatorSet> =
  | Value
  | Field<Value>
  | ValueExpression<Value, OperatorSet>;

/** Opaque update value expression bound to one operator set and callback scope. */
export interface ValueExpression<Value extends JsonValue | undefined, OperatorSet> {
  readonly [valueExpressionType]: {
    readonly value: Value;
    readonly operatorSet: OperatorSet;
  };
}

/** Opaque field-removal expression bound to one operator set. */
export interface UnsetExpression<OperatorSet> {
  readonly [unsetType]: OperatorSet;
}

/** Optional property keys inferred only from the selected Record type. */
export type OptionalKeys<Value extends object> = {
  readonly [Key in keyof Value]-?: {} extends Pick<Value, Key> ? Key : never;
}[keyof Value];

/** Literal, value-expression, or optional-key removal accepted by update set. */
export type UpdateValue<
  LiteralInput,
  SelectedValue extends JsonValue | undefined,
  OperatorSet,
  Removable extends boolean,
> =
  | LiteralInput
  | ValueExpression<SelectedValue, OperatorSet>
  | (Removable extends true ? UnsetExpression<OperatorSet> : never);

/** Numeric binary expression used by fallback arithmetic operators. */
export interface NumericBinaryExpression<OperatorSet> {
  (
    left: ValueExpressionInput<number, OperatorSet>,
    right: ValueExpressionInput<number, OperatorSet>,
  ): ValueExpression<number, OperatorSet>;
}

/** String or readonly-array concatenation expression. */
export interface ConcatExpression<OperatorSet> {
  (
    left: ValueExpressionInput<string, OperatorSet>,
    right: ValueExpressionInput<string, OperatorSet>,
  ): ValueExpression<string, OperatorSet>;
  <Left extends readonly JsonValue[], Right extends readonly JsonValue[]>(
    left: ValueExpressionInput<Left, OperatorSet>,
    right: ValueExpressionInput<Right, OperatorSet>,
  ): ValueExpression<readonly (Left[number] | Right[number])[], OperatorSet>;
}

/** Nullish fallback expression with lazy fallback evaluation. */
export interface CoalesceExpression<OperatorSet> {
  <Left extends JsonValue | undefined, Fallback extends JsonValue>(
    left: ValueExpressionInput<Left, OperatorSet>,
    fallback: ValueExpressionInput<Fallback, OperatorSet>,
  ): ValueExpression<Exclude<Left, null | undefined> | Fallback, OperatorSet>;
}

/** Lazy conditional value expression. */
export interface IfElseExpression<OperatorSet> {
  <WhenTrue extends JsonValue | undefined, WhenFalse extends JsonValue | undefined>(
    predicate: Predicate,
    whenTrue: ValueExpressionInput<WhenTrue, OperatorSet>,
    whenFalse: ValueExpressionInput<WhenFalse, OperatorSet>,
  ): ValueExpression<WhenTrue | WhenFalse, OperatorSet>;
}

type ObjectMergeValue<Value, OperatorSet, Removable extends boolean> =
  | Exclude<Extract<Value, JsonValue | undefined>, undefined>
  | Field<Extract<Value, JsonValue | undefined>>
  | ValueExpression<Extract<Value, JsonValue | undefined>, OperatorSet>
  | (Removable extends true ? UnsetExpression<OperatorSet> : never);

/** Typed patch values for one shallow object merge. */
export type ObjectMergePatch<Value extends JsonObject, OperatorSet> = {
  readonly [Key in keyof Value]?: ObjectMergeValue<
    Value[Key],
    OperatorSet,
    Key extends OptionalKeys<Value> ? true : false
  >;
};

/** Shallow object merge expression. */
export interface ObjectMergeExpression<OperatorSet> {
  <Value extends JsonObject>(
    target: ValueExpressionInput<Value, OperatorSet>,
    patch: ObjectMergePatch<Value, OperatorSet>,
  ): ValueExpression<Value, OperatorSet>;
}

/** Typed element root supplied to one array filter callback. */
export type ArrayFilterElement<Element extends JsonValue> =
  NonNullable<Element> extends readonly JsonValue[]
    ? Field<NonNullable<Element>>
    : NonNullable<Element> extends JsonObject
      ? Fields<NonNullable<Element>>
      : Field<Element>;

/** Array filter expression with one isolated child query scope. */
export interface ArrayFilterExpression<OperatorSet> {
  <Element extends JsonValue>(
    array: ValueExpressionInput<readonly Element[], OperatorSet>,
    predicate: (element: ArrayFilterElement<Element>, operators: QueryOperators) => Predicate,
  ): ValueExpression<readonly Element[], OperatorSet>;
}

/** Shared update operators implemented by the JavaScript fallback. */
export interface UpdateExpressionOperators<OperatorSet = BaseStoreOperatorSetId> {
  /** Add two numeric operands. */
  readonly add: NumericBinaryExpression<OperatorSet>;
  /** Subtract the right numeric operand from the left operand. */
  readonly subtract: NumericBinaryExpression<OperatorSet>;
  /** Multiply two numeric operands. */
  readonly multiply: NumericBinaryExpression<OperatorSet>;
  /** Divide the left numeric operand by the right operand. */
  readonly divide: NumericBinaryExpression<OperatorSet>;
  /** Return the JavaScript remainder of two numeric operands. */
  readonly modulo: NumericBinaryExpression<OperatorSet>;
  /** Concatenate strings or readonly arrays. */
  readonly concat: ConcatExpression<OperatorSet>;
  /** Return the left operand unless it is null or missing. */
  readonly coalesce: CoalesceExpression<OperatorSet>;
  /** Select one of two lazy operands with a Predicate. */
  readonly ifElse: IfElseExpression<OperatorSet>;
  /** Remove one optional Field. */
  readonly unset: () => UnsetExpression<OperatorSet>;
  /** Apply one shallow object patch. */
  readonly merge: ObjectMergeExpression<OperatorSet>;
  /** Filter one array with an isolated child Predicate scope. */
  readonly filter: ArrayFilterExpression<OperatorSet>;
}

type SelectedFieldValue<
  Definition extends RecordDefinition,
  Key extends keyof Definition["fields"],
> = Extract<
  Key extends keyof SelectedRecord<Definition> ? SelectedRecord<Definition>[Key] : never,
  JsonValue | undefined
>;

/** Mixed literal and expression values returned by one update set callback. */
export type UpdateSet<Definition extends RecordDefinition, OperatorSet> = {
  readonly [Key in keyof Definition["fields"]]?: UpdateValue<
    FieldInput<UpdateFieldSchema<Definition["fields"][Key]>>,
    SelectedFieldValue<Definition, Key>,
    OperatorSet,
    Key extends OptionalKeys<SelectedRecord<Definition>> ? true : false
  >;
};
/** Shared JavaScript query and update operators. */
export type BaseStoreOperators = QueryOperators & UpdateExpressionOperators<BaseStoreOperatorSetId>;
/** Type components for the shared JavaScript operator implementation. */
export interface BaseStoreOperatorTypes extends StoreOperatorTypes {
  /** Shared JavaScript operator object. */
  readonly operators: BaseStoreOperators;
  /** Shared JavaScript Predicate type. */
  readonly predicate: Predicate;
  /** Shared JavaScript Order type. */
  readonly order: Order;
  /** Shared JavaScript expression owner identity. */
  readonly expressionOwner: BaseStoreOperatorSetId;
}

/** JavaScript where evaluator with the top-level fields it reads. */
export interface StoreWhereEvaluator<Record extends object> {
  (record: Record): boolean;
  /** Top-level Record fields read by the evaluator. */
  readonly fields: readonly string[];
}

/** JavaScript order comparator with the top-level fields it reads. */
export interface StoreOrderComparator<Record extends object> {
  (left: Record, right: Record): number;
  /** Top-level Record fields read by the comparator. */
  readonly fields: readonly string[];
}

/** Compiled literal and expression update evaluated against pre-update selected values. */
export interface CompiledStoreUpdate {
  /** Top-level Record fields read by update expressions. */
  readonly fields: readonly string[];
  /** Top-level Record fields that the update can change. */
  readonly changedFields: readonly string[];
  /** Evaluate the compiled update against one pre-update selected Record. */
  readonly evaluate: (record: JsonObject) => JsonObject;
}

type QueryOperation =
  | "eq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "and"
  | "or"
  | "not"
  | "inArray"
  | "isNull";
type OrderDirection = "asc" | "desc";
type CallbackScope = Readonly<{
  readonly operation: StoreCollectionOperation;
  readonly phase: "query" | "update";
  readonly scope: symbol;
}>;

interface RuntimeField {
  readonly kind: "field";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly path: readonly string[];
}

interface RuntimePredicate {
  readonly kind: "predicate";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly operation: QueryOperation;
  readonly operands: readonly unknown[];
}

interface RuntimeOrder {
  readonly kind: "order";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly direction: OrderDirection;
  readonly field: RuntimeField;
}

interface RuntimeValueExpression {
  readonly kind: "value";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly operation:
    | "add"
    | "subtract"
    | "multiply"
    | "divide"
    | "modulo"
    | "concat"
    | "coalesce"
    | "ifElse"
    | "merge"
    | "filter";
  readonly operands: readonly unknown[];
}

interface RuntimeUnsetExpression {
  readonly kind: "unset";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
}

interface RuntimeMergePatchEntry {
  readonly key: string;
  readonly value: RuntimeField | RuntimeValueExpression | RuntimeUnsetExpression | JsonValue;
}

interface RuntimeMergePatch {
  readonly kind: "mergePatch";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly entries: readonly RuntimeMergePatchEntry[];
}

interface RuntimeFilterPredicate {
  readonly kind: "filterPredicate";
  readonly owner: BaseStoreOperatorSetId;
  readonly scope: CallbackScope;
  readonly predicate: RuntimePredicate;
}

type RuntimeExpression =
  | RuntimeField
  | RuntimePredicate
  | RuntimeOrder
  | RuntimeValueExpression
  | RuntimeUnsetExpression;

function queryError(
  collection: string,
  message: string,
  field?: string,
  operation: StoreCollectionOperation = "find",
): StoreValidationError {
  return new StoreValidationError({
    collection,
    operation,
    phase: "query",
    ...(field === undefined ? {} : { field }),
    issues: [{ message, path: field === undefined ? [] : [field] }],
  });
}

function updateError(collection: string, message: string, field?: string): StoreValidationError {
  return new StoreValidationError({
    collection,
    operation: "update",
    phase: "update",
    ...(field === undefined ? {} : { field }),
    issues: [{ message, path: field === undefined ? [] : [field] }],
  });
}

function callbackExpressionError(
  collection: string,
  scope: CallbackScope,
  message: string,
): StoreValidationError {
  return scope.phase === "update"
    ? updateError(collection, message)
    : queryError(collection, message, undefined, scope.operation);
}

function expressionOf(value: unknown): RuntimeExpression | undefined {
  if (typeof value !== "object" || value === null || !(expressionNode in value)) {
    return undefined;
  }
  const expression = Reflect.get(value, expressionNode);
  // SAFETY: This private symbol is written only by constructors below; each consumer validates the discriminant, owner, and callback scope.
  return typeof expression === "object" && expression !== null
    ? (expression as RuntimeExpression)
    : undefined;
}

function fieldExpression(value: unknown, collection: string, scope: CallbackScope): RuntimeField {
  const expression = expressionOf(value);
  if (
    expression?.kind !== "field" ||
    expression.owner !== baseStoreOperatorSet ||
    expression.scope !== scope
  ) {
    throw callbackExpressionError(
      collection,
      scope,
      "Field expression belongs to another callback scope or operator set",
    );
  }
  return expression;
}

function predicateExpression(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimePredicate {
  const expression = expressionOf(value);
  if (
    expression?.kind !== "predicate" ||
    expression.owner !== baseStoreOperatorSet ||
    expression.scope !== scope
  ) {
    throw callbackExpressionError(
      collection,
      scope,
      "Predicate expression belongs to another callback scope or operator set",
    );
  }
  return expression;
}

function orderExpression(value: unknown, collection: string, scope: CallbackScope): RuntimeOrder {
  const expression = expressionOf(value);
  if (
    expression?.kind !== "order" ||
    expression.owner !== baseStoreOperatorSet ||
    expression.scope !== scope
  ) {
    throw queryError(
      collection,
      "Order expression belongs to another callback scope or operator set",
    );
  }
  return expression;
}

function valueExpression(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimeValueExpression {
  const expression = expressionOf(value);
  if (
    expression?.kind !== "value" ||
    expression.owner !== baseStoreOperatorSet ||
    expression.scope !== scope
  ) {
    throw updateError(
      collection,
      "Value expression belongs to another callback scope or operator set",
    );
  }
  return expression;
}

function unsetExpression(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimeUnsetExpression {
  const expression = expressionOf(value);
  if (
    expression?.kind !== "unset" ||
    expression.owner !== baseStoreOperatorSet ||
    expression.scope !== scope
  ) {
    throw updateError(
      collection,
      "Unset expression belongs to another callback scope or operator set",
    );
  }
  return expression;
}

function updateOperand(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimeField | RuntimeValueExpression | JsonValue {
  const expression = expressionOf(value);
  if (expression?.kind === "field") {
    return fieldExpression(value, collection, scope);
  }
  if (expression?.kind === "value") {
    return valueExpression(value, collection, scope);
  }
  if (!isJsonValue(value)) {
    throw updateError(
      collection,
      "Update operand must be a JSON value, Field, or Value expression",
    );
  }
  return value;
}

function queryOperand(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimeField | JsonValue {
  const expression = expressionOf(value);
  if (expression !== undefined) {
    return fieldExpression(value, collection, scope);
  }
  if (!isJsonValue(value)) {
    throw callbackExpressionError(
      collection,
      scope,
      "Query operand must be a JSON value or Field expression",
    );
  }
  return value;
}

function makeField(path: readonly string[], scope: CallbackScope): Field<JsonValue | undefined> {
  const runtimeField = Object.freeze({
    kind: "field" as const,
    owner: baseStoreOperatorSet,
    scope,
    path: Object.freeze([...path]),
  });
  const target = Object.freeze({
    [fieldType]: undefined,
    [expressionNode]: runtimeField,
  });
  // SAFETY: The Proxy implements recursive Field property access and retains the private runtime Field node on its target.
  return new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(current, property, receiver);
      }
      return makeField([...path, property], scope);
    },
  }) as Field<JsonValue | undefined>;
}

function makeFields<Record extends object>(scope: CallbackScope): Fields<Record> {
  const target = Object.freeze({});
  // SAFETY: The Proxy maps every string Record key to a Field expression for that key.
  return new Proxy(target, {
    get(_current, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      return makeField([property], scope);
    },
  }) as Fields<Record>;
}

function makePredicate(
  operation: QueryOperation,
  operands: readonly unknown[],
  scope: CallbackScope,
): Predicate {
  const runtimePredicate = Object.freeze({
    kind: "predicate" as const,
    owner: baseStoreOperatorSet,
    scope,
    operation,
    operands: Object.freeze([...operands]),
  });
  return Object.freeze({
    [predicateType]: true as const,
    [expressionNode]: runtimePredicate,
  });
}

function makeOrder(direction: OrderDirection, field: RuntimeField, scope: CallbackScope): Order {
  const runtimeOrder = Object.freeze({
    kind: "order" as const,
    owner: baseStoreOperatorSet,
    scope,
    direction,
    field,
  });
  return Object.freeze({
    [orderType]: true as const,
    [expressionNode]: runtimeOrder,
  });
}

function makeValueExpression(
  operation:
    | "add"
    | "subtract"
    | "multiply"
    | "divide"
    | "modulo"
    | "concat"
    | "coalesce"
    | "ifElse"
    | "merge"
    | "filter",
  operands: readonly unknown[],
  scope: CallbackScope,
): ValueExpression<JsonValue, BaseStoreOperatorSetId> {
  const runtimeValue = Object.freeze({
    kind: "value" as const,
    owner: baseStoreOperatorSet,
    scope,
    operation,
    operands: Object.freeze([...operands]),
  });
  // SAFETY: The frozen branded object contains the private runtime Value node required by the opaque public expression type.
  return Object.freeze({
    [valueExpressionType]: {
      value: undefined,
      operatorSet: baseStoreOperatorSet,
    },
    [expressionNode]: runtimeValue,
  }) as unknown as ValueExpression<JsonValue, BaseStoreOperatorSetId>;
}

function makeUnsetExpression(scope: CallbackScope): UnsetExpression<BaseStoreOperatorSetId> {
  const runtimeUnset = Object.freeze({
    kind: "unset" as const,
    owner: baseStoreOperatorSet,
    scope,
  });
  // SAFETY: The frozen branded object contains the private runtime Unset node required by the opaque public expression type.
  return Object.freeze({
    [unsetType]: baseStoreOperatorSet,
    [expressionNode]: runtimeUnset,
  }) as UnsetExpression<BaseStoreOperatorSetId>;
}

function makeMergePatch(
  value: unknown,
  collection: string,
  scope: CallbackScope,
): RuntimeMergePatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw updateError(collection, "merge patch must be an object");
  }
  const entries = Object.entries(value).map(([key, patchValue]) => {
    const expression = expressionOf(patchValue);
    const parsedValue =
      expression?.kind === "unset"
        ? unsetExpression(patchValue, collection, scope)
        : updateOperand(patchValue, collection, scope);
    return Object.freeze({ key, value: parsedValue });
  });
  return Object.freeze({
    kind: "mergePatch",
    owner: baseStoreOperatorSet,
    scope,
    entries: Object.freeze(entries),
  });
}

function makeFilterPredicate(
  collection: string,
  predicate: (element: Field<JsonValue | undefined>, operators: QueryOperators) => Predicate,
): RuntimeFilterPredicate {
  const scope = Object.freeze({
    operation: "update" as const,
    phase: "update" as const,
    scope: Symbol("commissary.store.filter-scope"),
  });
  const output = predicate(makeField([], scope), makeQueryOperators(collection, scope));
  return Object.freeze({
    kind: "filterPredicate",
    owner: baseStoreOperatorSet,
    scope,
    predicate: predicateExpression(output, collection, scope),
  });
}

function makeQueryOperators(collection: string, scope: CallbackScope): QueryOperators {
  const compare =
    (operation: "lt" | "lte" | "gt" | "gte") =>
    (left: unknown, right: unknown): Predicate =>
      makePredicate(
        operation,
        [queryOperand(left, collection, scope), queryOperand(right, collection, scope)],
        scope,
      );

  // SAFETY: The implementation supplies every QueryOperators overload with one runtime JSON operand implementation.
  return Object.freeze({
    eq: (left: unknown, right: unknown) =>
      makePredicate(
        "eq",
        [queryOperand(left, collection, scope), queryOperand(right, collection, scope)],
        scope,
      ),
    lt: compare("lt"),
    lte: compare("lte"),
    gt: compare("gt"),
    gte: compare("gte"),
    and: (...predicates: readonly (Predicate | undefined)[]) =>
      makePredicate(
        "and",
        predicates
          .filter((predicate): predicate is Predicate => predicate !== undefined)
          .map((predicate) => predicateExpression(predicate, collection, scope)),
        scope,
      ),
    or: (...predicates: readonly (Predicate | undefined)[]) =>
      makePredicate(
        "or",
        predicates
          .filter((predicate): predicate is Predicate => predicate !== undefined)
          .map((predicate) => predicateExpression(predicate, collection, scope)),
        scope,
      ),
    not: (predicate: Predicate) =>
      makePredicate("not", [predicateExpression(predicate, collection, scope)], scope),
    inArray: (field: Field<JsonValue | undefined>, values: readonly JsonValue[]) => {
      if (!values.every((value) => isJsonValue(value))) {
        throw callbackExpressionError(collection, scope, "inArray candidates must be JSON values");
      }
      return makePredicate(
        "inArray",
        [fieldExpression(field, collection, scope), Object.freeze([...values])],
        scope,
      );
    },
    isNull: (field: Field<JsonValue | undefined>) =>
      makePredicate("isNull", [fieldExpression(field, collection, scope)], scope),
    asc: (field: Field<string> | Field<number>) =>
      makeOrder("asc", fieldExpression(field, collection, scope), scope),
    desc: (field: Field<string> | Field<number>) =>
      makeOrder("desc", fieldExpression(field, collection, scope), scope),
  }) as QueryOperators;
}

function makeBaseStoreOperators(collection: string, scope: CallbackScope): BaseStoreOperators {
  const numeric =
    (operation: "add" | "subtract" | "multiply" | "divide" | "modulo") =>
    (left: unknown, right: unknown) =>
      makeValueExpression(
        operation,
        [updateOperand(left, collection, scope), updateOperand(right, collection, scope)],
        scope,
      );
  // SAFETY: The implementation supplies every BaseStoreOperators overload with runtime JSON operand implementations.
  return Object.freeze({
    ...makeQueryOperators(collection, scope),
    add: numeric("add"),
    subtract: numeric("subtract"),
    multiply: numeric("multiply"),
    divide: numeric("divide"),
    modulo: numeric("modulo"),
    concat: (left: unknown, right: unknown) =>
      makeValueExpression(
        "concat",
        [updateOperand(left, collection, scope), updateOperand(right, collection, scope)],
        scope,
      ),
    coalesce: (left: unknown, fallback: unknown) =>
      makeValueExpression(
        "coalesce",
        [updateOperand(left, collection, scope), updateOperand(fallback, collection, scope)],
        scope,
      ),
    ifElse: (predicate: Predicate, whenTrue: unknown, whenFalse: unknown) =>
      makeValueExpression(
        "ifElse",
        [
          predicateExpression(predicate, collection, scope),
          updateOperand(whenTrue, collection, scope),
          updateOperand(whenFalse, collection, scope),
        ],
        scope,
      ),
    unset: () => makeUnsetExpression(scope),
    merge: (target: unknown, patch: unknown) =>
      makeValueExpression(
        "merge",
        [updateOperand(target, collection, scope), makeMergePatch(patch, collection, scope)],
        scope,
      ),
    filter: (
      array: unknown,
      predicate: (element: Field<JsonValue | undefined>, operators: QueryOperators) => Predicate,
    ) =>
      makeValueExpression(
        "filter",
        [updateOperand(array, collection, scope), makeFilterPredicate(collection, predicate)],
        scope,
      ),
  }) as BaseStoreOperators;
}

function readSelectedField(record: JsonValue, field: RuntimeField): JsonValue | undefined {
  let current: JsonValue | undefined = record;
  for (const segment of field.path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    // SAFETY: Object.hasOwn above proves this JSON object contains the segment, whose value is JSON-compatible.
    current = Reflect.get(current, segment) as JsonValue | undefined;
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function readField(record: JsonValue, field: RuntimeField): JsonValue {
  return readSelectedField(record, field) ?? null;
}

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

/** Compare JSON values structurally while ignoring object key order. */
export function structuralJsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (isJsonArray(left)) {
    return (
      isJsonArray(right) &&
      left.length === right.length &&
      // SAFETY: Equal array lengths prove that the matching right-side index exists.
      left.every((value, index) => structuralJsonEqual(value, right[index] as JsonValue))
    );
  }
  if (isJsonArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        // SAFETY: Object.hasOwn above proves both JSON object properties exist.
        Object.hasOwn(right, key) &&
        structuralJsonEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
}

function isRuntimeFieldNode(value: unknown): value is RuntimeField {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const path = Reflect.get(value, "path");
  return (
    Reflect.get(value, "kind") === "field" &&
    Reflect.get(value, "owner") === baseStoreOperatorSet &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === "string")
  );
}

function isRuntimePredicateNode(value: unknown): value is RuntimePredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "predicate" &&
    Reflect.get(value, "owner") === baseStoreOperatorSet &&
    Array.isArray(Reflect.get(value, "operands"))
  );
}

function predicateFieldNames(predicate: RuntimePredicate): readonly string[] {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
    if (isRuntimeFieldNode(value)) {
      const root = value.path[0];
      if (root !== undefined) {
        fields.add(root);
      }
      return;
    }
    if (isRuntimePredicateNode(value)) {
      for (const operand of value.operands) {
        visit(operand);
      }
    }
  };
  visit(predicate);
  return Object.freeze([...fields]);
}

function isRuntimeValueNode(value: unknown): value is RuntimeValueExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "value" &&
    Reflect.get(value, "owner") === baseStoreOperatorSet &&
    Array.isArray(Reflect.get(value, "operands"))
  );
}

function isRuntimeUnsetNode(value: unknown): value is RuntimeUnsetExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "unset" &&
    Reflect.get(value, "owner") === baseStoreOperatorSet
  );
}

function isRuntimeMergePatch(value: unknown): value is RuntimeMergePatch {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "mergePatch" &&
    Reflect.get(value, "owner") === baseStoreOperatorSet &&
    Array.isArray(Reflect.get(value, "entries"))
  );
}

function isRuntimeFilterPredicate(value: unknown): value is RuntimeFilterPredicate {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "kind") !== "filterPredicate" ||
    Reflect.get(value, "owner") !== baseStoreOperatorSet
  ) {
    return false;
  }
  const scope = Reflect.get(value, "scope");
  const predicate = Reflect.get(value, "predicate");
  return isRuntimePredicateNode(predicate) && predicate.scope === scope;
}

function updateFieldNames(
  expressions: Iterable<RuntimeValueExpression | RuntimeUnsetExpression>,
): readonly string[] {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
    if (isRuntimeFieldNode(value)) {
      const root = value.path[0];
      if (root !== undefined) {
        fields.add(root);
      }
      return;
    }
    if (isRuntimeValueNode(value)) {
      for (const operand of value.operands) {
        visit(operand);
      }
    }
    if (isRuntimePredicateNode(value)) {
      for (const operand of value.operands) {
        visit(operand);
      }
    }
    if (isRuntimeMergePatch(value)) {
      for (const entry of value.entries) {
        visit(entry.value);
      }
    }
  };
  for (const expression of expressions) {
    visit(expression);
  }
  return Object.freeze([...fields]);
}

function evaluateUpdateOperand(
  collection: string,
  operand: unknown,
  record: JsonObject,
  field: string,
): JsonValue | undefined {
  if (isRuntimeFieldNode(operand)) {
    return readSelectedField(record, operand);
  }
  if (isRuntimeValueNode(operand)) {
    return evaluateUpdateExpression(collection, operand, record, field);
  }
  // SAFETY: Compiled expression operands enter this evaluator only after updateOperand validates them as JSON values.
  return operand as JsonValue;
}

function evaluateUpdateExpression(
  collection: string,
  expression: RuntimeValueExpression,
  record: JsonObject,
  field: string,
): JsonValue {
  if (expression.operation === "ifElse") {
    const predicate = expression.operands[0];
    if (!isRuntimePredicateNode(predicate)) {
      throw updateError(collection, "ifElse requires a Predicate", field);
    }
    const selected = evaluatePredicate(collection, predicate, record)
      ? expression.operands[1]
      : expression.operands[2];
    const result = evaluateUpdateOperand(collection, selected, record, field);
    if (result === undefined) {
      throw updateError(collection, "ifElse result must be defined", field);
    }
    return result;
  }
  const left = evaluateUpdateOperand(collection, expression.operands[0], record, field);
  if (expression.operation === "coalesce") {
    if (left !== null && left !== undefined) {
      return left;
    }
    const fallback = evaluateUpdateOperand(collection, expression.operands[1], record, field);
    if (fallback === undefined) {
      throw updateError(collection, "coalesce fallback must be defined", field);
    }
    return fallback;
  }
  if (expression.operation === "filter") {
    const predicate = expression.operands[1];
    if (left === undefined || !isJsonArray(left) || !isRuntimeFilterPredicate(predicate)) {
      throw updateError(collection, "filter requires an array and predicate", field);
    }
    return left.filter((element) => evaluatePredicate(collection, predicate.predicate, element));
  }
  if (expression.operation === "merge") {
    const patch = expression.operands[1];
    if (
      left === null ||
      left === undefined ||
      typeof left !== "object" ||
      isJsonArray(left) ||
      !isRuntimeMergePatch(patch)
    ) {
      throw updateError(collection, "merge requires an object target and patch", field);
    }
    const result: Record<string, JsonValue> = { ...left };
    for (const entry of patch.entries) {
      if (isRuntimeUnsetNode(entry.value)) {
        Reflect.deleteProperty(result, entry.key);
        continue;
      }
      const value = evaluateUpdateOperand(collection, entry.value, record, field);
      if (value === undefined) {
        throw updateError(collection, "merge patch values must be defined", field);
      }
      Object.defineProperty(result, entry.key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    return result;
  }
  const right = evaluateUpdateOperand(collection, expression.operands[1], record, field);
  if (expression.operation === "concat") {
    if (typeof left === "string" && typeof right === "string") {
      return left + right;
    }
    if (left !== undefined && right !== undefined && isJsonArray(left) && isJsonArray(right)) {
      return [...left, ...right];
    }
    throw updateError(collection, "concat operands must both be strings or both be arrays", field);
  }
  if (
    typeof left !== "number" ||
    !Number.isFinite(left) ||
    typeof right !== "number" ||
    !Number.isFinite(right)
  ) {
    throw updateError(collection, `${expression.operation} operands must be finite numbers`, field);
  }
  const result =
    expression.operation === "add"
      ? left + right
      : expression.operation === "subtract"
        ? left - right
        : expression.operation === "multiply"
          ? left * right
          : expression.operation === "divide"
            ? left / right
            : left % right;
  if (!Number.isFinite(result)) {
    throw updateError(collection, `${expression.operation} result must be a finite number`, field);
  }
  return result;
}

function operandValue(record: JsonValue, operand: unknown): JsonValue {
  const expression = expressionOf(operand);
  if (expression?.kind === "field") {
    return readField(record, expression);
  }
  return isRuntimeFieldNode(operand) ? readField(record, operand) : (operand as JsonValue);
}

function compareValues(
  collection: string,
  operation: "lt" | "lte" | "gt" | "gte",
  left: JsonValue,
  right: JsonValue,
  predicateScope: CallbackScope,
): boolean {
  if (left === null || right === null) {
    return false;
  }
  const sameSupportedType =
    (typeof left === "string" && typeof right === "string") ||
    (typeof left === "number" &&
      Number.isFinite(left) &&
      typeof right === "number" &&
      Number.isFinite(right));
  if (!sameSupportedType) {
    throw callbackExpressionError(
      collection,
      predicateScope,
      "Order comparison operands must be finite numbers or strings of the same type",
    );
  }
  if (operation === "lt") return left < right;
  if (operation === "lte") return left <= right;
  if (operation === "gt") return left > right;
  return left >= right;
}

function compareOrderValues(collection: string, left: JsonValue, right: JsonValue): number {
  const sameSupportedType =
    (typeof left === "string" && typeof right === "string") ||
    (typeof left === "number" &&
      Number.isFinite(left) &&
      typeof right === "number" &&
      Number.isFinite(right));
  if (!sameSupportedType) {
    throw queryError(
      collection,
      "Order fields must produce finite numbers or strings of the same type",
    );
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareOrderedRecords(
  collection: string,
  orders: readonly RuntimeOrder[],
  left: JsonObject,
  right: JsonObject,
): number {
  for (const order of orders) {
    const comparison = compareOrderValues(
      collection,
      readField(left, order.field),
      readField(right, order.field),
    );
    if (comparison !== 0) {
      return order.direction === "asc" ? comparison : -comparison;
    }
  }
  return 0;
}

function evaluatePredicate(
  collection: string,
  predicate: RuntimePredicate,
  record: JsonValue,
): boolean {
  const { operation, operands } = predicate;
  if (operation === "and") {
    return operands.every((operand) =>
      evaluatePredicate(collection, operand as RuntimePredicate, record),
    );
  }
  if (operation === "or") {
    return operands.some((operand) =>
      evaluatePredicate(collection, operand as RuntimePredicate, record),
    );
  }
  if (operation === "not") {
    return !evaluatePredicate(collection, operands[0] as RuntimePredicate, record);
  }
  if (operation === "isNull") {
    return operandValue(record, operands[0]) === null;
  }
  if (operation === "inArray") {
    const value = operandValue(record, operands[0]);
    return (operands[1] as readonly JsonValue[]).some((candidate) =>
      structuralJsonEqual(value, candidate),
    );
  }
  const left = operandValue(record, operands[0]);
  const right = operandValue(record, operands[1]);
  if (operation === "eq") {
    return structuralJsonEqual(left, right);
  }
  return compareValues(collection, operation, left, right, predicate.scope);
}

/** Compile one where callback once and return its JavaScript Record evaluator. */
export function compileStoreWhere<Record extends object>(
  collection: string,
  where: ((fields: Fields<Record>, operators: BaseStoreOperators) => Predicate) | undefined,
  operation: Exclude<StoreCollectionOperation, "create"> = "find",
): StoreWhereEvaluator<Record> {
  if (where === undefined) {
    return Object.freeze(Object.assign((_record: Record) => true, { fields: Object.freeze([]) }));
  }
  const scope = Object.freeze({
    operation,
    phase: "query" as const,
    scope: Symbol("commissary.store.callback-scope"),
  });
  const predicate = where(makeFields<Record>(scope), makeBaseStoreOperators(collection, scope));
  const runtimePredicate = predicateExpression(predicate, collection, scope);
  const fields = predicateFieldNames(runtimePredicate);
  // SAFETY: Store adapters call the evaluator only with selected Records whose defined own values passed JSON validation.
  return Object.freeze(
    Object.assign(
      (record: Record) => evaluatePredicate(collection, runtimePredicate, record as JsonObject),
      { fields },
    ),
  );
}

/** Compile one order callback once and return its stable-sort comparator. */
export function compileStoreOrder<Record extends object>(
  collection: string,
  orderBy:
    | ((fields: Fields<Record>, operators: BaseStoreOperators) => ReadonlyArray<Order>)
    | undefined,
): StoreOrderComparator<Record> | undefined {
  if (orderBy === undefined) {
    return undefined;
  }
  const scope = Object.freeze({
    operation: "find" as const,
    phase: "query" as const,
    scope: Symbol("commissary.store.callback-scope"),
  });
  const output = orderBy(makeFields<Record>(scope), makeBaseStoreOperators(collection, scope));
  if (!Array.isArray(output)) {
    throw queryError(collection, "orderBy must return an array of Order expressions");
  }
  const orders = output.map((order) => orderExpression(order, collection, scope));
  if (orders.length === 0) {
    return undefined;
  }
  const fields = Object.freeze([
    ...new Set(
      orders
        .map((order) => order.field.path[0])
        .filter((field): field is string => field !== undefined),
    ),
  ]);
  // SAFETY: Store adapters call the comparator only with selected Records whose defined own values passed JSON validation.
  return Object.freeze(
    Object.assign(
      (left: Record, right: Record) =>
        compareOrderedRecords(collection, orders, left as JsonObject, right as JsonObject),
      { fields },
    ),
  );
}

/** Validate and normalize fallback find pagination before adapter execution. */
export function validateStoreFindPagination(
  collection: string,
  options: { readonly limit?: number; readonly offset?: number } | undefined,
): { readonly limit: number | undefined; readonly offset: number } {
  for (const field of ["limit", "offset"] as const) {
    const value = options?.[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw queryError(collection, `${field} must be a nonnegative safe integer`, field);
    }
  }
  return {
    limit: options?.limit,
    offset: options?.offset ?? 0,
  };
}

/** Compile a literal or callback update once for per-Record evaluation. */
export async function compileStoreUpdate<Definition extends RecordDefinition>(
  definition: Definition,
  collection: string,
  set:
    | UpdateInput<Definition>
    | ((
        fields: Fields<SelectedRecord<Definition>>,
        operators: BaseStoreOperators,
      ) => UpdateSet<Definition, BaseStoreOperatorSetId>),
): Promise<CompiledStoreUpdate> {
  if (typeof set !== "function") {
    const parsed = await parseStoreUpdateInput(definition, collection, set);
    return Object.freeze({
      fields: Object.freeze([]),
      changedFields: parsed.fields,
      evaluate: () => parsed.values,
    });
  }

  const scope = Object.freeze({
    operation: "update" as const,
    phase: "update" as const,
    scope: Symbol("commissary.store.callback-scope"),
  });
  const output = set(
    makeFields<SelectedRecord<Definition>>(scope),
    makeBaseStoreOperators(collection, scope),
  );
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw updateError(collection, "set callback must return a Record object");
  }

  const changedFields = Object.freeze(Object.keys(output));
  const literals: Record<string, unknown> = {};
  const expressions = new Map<string, RuntimeValueExpression | RuntimeUnsetExpression>();
  for (const field of changedFields) {
    if (!Object.hasOwn(definition.fields, field)) {
      throw updateError(collection, `Unknown Record field '${field}'`, field);
    }
    const value = Reflect.get(output, field);
    const expression = expressionOf(value);
    if (expression === undefined) {
      literals[field] = value;
      continue;
    }
    if (expression.kind === "value") {
      expressions.set(field, valueExpression(value, collection, scope));
    } else if (expression.kind === "unset") {
      expressions.set(field, unsetExpression(value, collection, scope));
    } else {
      throw updateError(collection, "set values must be literals or update expressions", field);
    }
  }
  const parsedLiterals = await parseStoreUpdateInput(definition, collection, literals);
  const fields = updateFieldNames(expressions.values());

  return Object.freeze({
    fields,
    changedFields,
    evaluate(record: JsonObject): JsonObject {
      const values: Record<string, JsonValue> = { ...parsedLiterals.values };
      for (const [field, expression] of expressions) {
        if (isRuntimeUnsetNode(expression)) {
          continue;
        }
        values[field] = evaluateUpdateExpression(collection, expression, record, field);
      }
      return values;
    },
  });
}
