import type { ModelInvocationCandidate } from "../hook.js";
import type {
  ContentPart,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ToolCallContentPart,
} from "../protocol.js";
import type { ModelInvocation } from "../runtime.js";
import { UnexpectedExecutionError } from "../runtime.js";
import type { JsonValue } from "../types.js";
import { RuntimeInvariantError } from "./execution-signals.js";

/** Test whether a value is compatible with the Runtime JSON protocol. */
export function isJsonValue(value: unknown): value is JsonValue {
  const active = new Set<object>();
  const pending: Array<{ readonly value: unknown; readonly exit?: true }> = [{ value }];
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.exit === true) {
        active.delete(current.value as object);
        continue;
      }
      const item = current.value;
      if (item === null || typeof item === "string" || typeof item === "boolean") {
        continue;
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) {
          return false;
        }
        continue;
      }
      if (typeof item !== "object" || active.has(item)) {
        return false;
      }
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        return false;
      }
      active.add(item);
      pending.push({ value: item, exit: true });
      if (Array.isArray(item)) {
        const keys = Object.keys(item);
        if (
          keys.length !== item.length ||
          keys.some((key) => !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key)
        ) {
          return false;
        }
        for (let index = item.length - 1; index >= 0; index -= 1) {
          pending.push({ value: item[index] });
        }
      } else {
        for (const child of Object.values(item)) {
          pending.push({ value: child });
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

/** Parse a value as Runtime-compatible JSON or throw an invariant defect. */
export function requireJson(value: unknown, description: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new RuntimeInvariantError(`${description} is not JSON-compatible`);
  }
  return value;
}

/** Parse authoritative Model usage from a Runtime boundary. */
export function parseModelUsage(value: unknown, description: string): ModelUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeInvariantError(`${description} is malformed`);
  }
  // SAFETY: The object check above establishes a string-keyed object.
  const object = value as Record<string, unknown>;
  if (
    typeof object.input !== "object" ||
    object.input === null ||
    Array.isArray(object.input) ||
    typeof object.output !== "object" ||
    object.output === null ||
    Array.isArray(object.output) ||
    Object.keys(object).some((key) => key !== "input" && key !== "output" && key !== "totalTokens")
  ) {
    throw new RuntimeInvariantError(`${description} is malformed`);
  }
  // SAFETY: The group checks above establish string-keyed input and output objects.
  const input = object.input as Record<string, unknown>;
  const output = object.output as Record<string, unknown>;
  const isOptionalCount = (count: unknown): count is number | undefined =>
    count === undefined ||
    (typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count >= 0);
  const inputTotal = input.total;
  const inputUncached = input.uncached;
  const inputCacheRead = input.cacheRead;
  const inputCacheWrite = input.cacheWrite;
  const outputTotal = output.total;
  const outputText = output.text;
  const outputReasoning = output.reasoning;
  const totalTokens = object.totalTokens;
  if (
    Object.keys(input).some(
      (key) => key !== "total" && key !== "uncached" && key !== "cacheRead" && key !== "cacheWrite",
    ) ||
    Object.keys(output).some((key) => key !== "total" && key !== "text" && key !== "reasoning") ||
    !isOptionalCount(inputTotal) ||
    !isOptionalCount(inputUncached) ||
    !isOptionalCount(inputCacheRead) ||
    !isOptionalCount(inputCacheWrite) ||
    !isOptionalCount(outputTotal) ||
    !isOptionalCount(outputText) ||
    !isOptionalCount(outputReasoning) ||
    !isOptionalCount(totalTokens)
  ) {
    throw new RuntimeInvariantError(`${description} counts must be finite nonnegative integers`);
  }
  return Object.freeze({
    input: Object.freeze({
      ...(inputTotal === undefined ? {} : { total: inputTotal }),
      ...(inputUncached === undefined ? {} : { uncached: inputUncached }),
      ...(inputCacheRead === undefined ? {} : { cacheRead: inputCacheRead }),
      ...(inputCacheWrite === undefined ? {} : { cacheWrite: inputCacheWrite }),
    }),
    output: Object.freeze({
      ...(outputTotal === undefined ? {} : { total: outputTotal }),
      ...(outputText === undefined ? {} : { text: outputText }),
      ...(outputReasoning === undefined ? {} : { reasoning: outputReasoning }),
    }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

/** Parse Model content parts from a Runtime boundary. */
export function parseContentParts(content: unknown, description: string): readonly ContentPart[] {
  if (!Array.isArray(content)) {
    throw new RuntimeInvariantError(`${description} Content is not an array`);
  }
  return Object.freeze(
    content.map((part, index) => {
      requireJson(part, `${description} Content ${index}`);
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        throw new RuntimeInvariantError(`${description} Content ${index} is malformed`);
      }
      // SAFETY: requireJson and the object check establish a string-keyed JSON object.
      const object = part as Record<string, unknown>;
      const providerDataIsValid =
        object.providerData === undefined ||
        (Array.isArray(object.providerData) &&
          object.providerData.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              !Array.isArray(item) &&
              "namespace" in item &&
              typeof item.namespace === "string" &&
              "version" in item &&
              typeof item.version === "number" &&
              Number.isFinite(item.version) &&
              Number.isInteger(item.version) &&
              "value" in item,
          ));
      if (!providerDataIsValid) {
        throw new RuntimeInvariantError(
          `${description} Content ${index} has invalid Provider Data`,
        );
      }

      let valid: boolean;
      switch (object.type) {
        case "text":
        case "reasoning":
          valid = typeof object.text === "string";
          break;
        case "file": {
          const artifact = object.artifact;
          valid =
            typeof artifact === "object" &&
            artifact !== null &&
            !Array.isArray(artifact) &&
            "id" in artifact &&
            typeof artifact.id === "string" &&
            (!("mediaType" in artifact) ||
              artifact.mediaType === undefined ||
              typeof artifact.mediaType === "string") &&
            (!("name" in artifact) ||
              artifact.name === undefined ||
              typeof artifact.name === "string");
          break;
        }
        case "tool-call":
          valid =
            typeof object.toolCallId === "string" &&
            typeof object.toolName === "string" &&
            "input" in object;
          break;
        case "tool-result":
          valid =
            typeof object.toolCallId === "string" &&
            typeof object.toolName === "string" &&
            "output" in object &&
            (object.isFailure === undefined || typeof object.isFailure === "boolean");
          break;
        case "source":
          valid =
            typeof object.id === "string" &&
            typeof object.title === "string" &&
            ((object.sourceType === "url" && typeof object.url === "string") ||
              (object.sourceType === "document" &&
                typeof object.mediaType === "string" &&
                (object.fileName === undefined || typeof object.fileName === "string")));
          break;
        default:
          valid = false;
      }
      if (!valid) {
        throw new RuntimeInvariantError(`${description} Content ${index} is malformed`);
      }
      return Object.freeze({ ...part });
    }),
  );
}

/** Throw the stable defect for a malformed Hook result. */
export function malformedHookResult(point: string, detail: string): never {
  throw new UnexpectedExecutionError("hook", new TypeError(`Hook '${point}' returned ${detail}`));
}

/** Parse an optional Hook result as an object. */
export function hookResultObject(
  point: string,
  result: unknown,
): Record<string, unknown> | undefined {
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return malformedHookResult(point, "a malformed result");
  }
  // SAFETY: The Hook result object check above establishes a string-keyed object.
  return result as Record<string, unknown>;
}

/** Test whether a Hook value is a complete Model Request. */
export function isModelRequest(value: unknown): value is ModelRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("context" in value) ||
    !Array.isArray(value.context) ||
    !("messages" in value) ||
    !Array.isArray(value.messages) ||
    !("tools" in value) ||
    !Array.isArray(value.tools) ||
    !("providerOptions" in value) ||
    !Array.isArray(value.providerOptions)
  ) {
    return false;
  }
  return (
    value.context.every(
      (node) =>
        typeof node === "object" &&
        node !== null &&
        !Array.isArray(node) &&
        "id" in node &&
        typeof node.id === "string" &&
        "content" in node &&
        Array.isArray(node.content),
    ) &&
    value.messages.every(isModelMessage) &&
    value.tools.every(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        !Array.isArray(tool) &&
        "name" in tool &&
        typeof tool.name === "string" &&
        "inputSchema" in tool &&
        (!("description" in tool) ||
          tool.description === undefined ||
          typeof tool.description === "string"),
    ) &&
    value.providerOptions.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        "namespace" in option &&
        typeof option.namespace === "string" &&
        "value" in option,
    )
  );
}

/** Test whether a Hook value is a complete Model Message. */
export function isModelMessage(value: unknown): value is ModelMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("role" in value) ||
    !["system", "user", "assistant", "tool"].includes(String(value.role)) ||
    !("content" in value) ||
    !Array.isArray(value.content) ||
    ("data" in value &&
      value.data !== undefined &&
      (!Array.isArray(value.data) ||
        value.data.some(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Array.isArray(item) ||
            !("key" in item) ||
            typeof item.key !== "string" ||
            !("version" in item) ||
            typeof item.version !== "number" ||
            !Number.isFinite(item.version) ||
            !Number.isInteger(item.version) ||
            !("value" in item),
        )))
  ) {
    return false;
  }
  try {
    parseContentParts(value.content, "Model Message");
    requireJson(value, "Model Message");
    return true;
  } catch {
    return false;
  }
}

/** Parse one Model Event returned by a transformation Hook. */
export function parseModelEvent(value: unknown, pointName: string): ModelEvent {
  try {
    requireJson(value, `Model Event from Hook '${pointName}'`);
  } catch {
    return malformedHookResult(pointName, "a non-JSON Model Event");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return malformedHookResult(pointName, "a malformed Model Event");
  }
  // SAFETY: The Model Event object check above establishes a string-keyed object.
  const object = value as Record<string, unknown>;
  switch (object.type) {
    case "text-delta":
    case "reasoning-delta":
      if (typeof object.delta !== "string") {
        return malformedHookResult(pointName, "a malformed Model delta Event");
      }
      break;
    case "tool-call":
      if (!("call" in object)) {
        return malformedHookResult(pointName, "a malformed Tool Call Event");
      }
      try {
        const [call] = parseContentParts([object.call], "Model Event");
        if (call?.type !== "tool-call") {
          return malformedHookResult(pointName, "a malformed Tool Call Event");
        }
      } catch {
        return malformedHookResult(pointName, "a malformed Tool Call Event");
      }
      break;
    case "usage":
      try {
        parseModelUsage(object.usage, `Usage Event from Hook '${pointName}'`);
      } catch {
        return malformedHookResult(pointName, "a malformed Usage Event");
      }
      break;
    case "finish": {
      const response = object.response;
      if (
        typeof response !== "object" ||
        response === null ||
        Array.isArray(response) ||
        !("message" in response) ||
        !isModelMessage(response.message) ||
        !("finishReason" in response) ||
        !["stop", "tool-calls", "length", "content-filter", "error", "pause", "other"].includes(
          String(response.finishReason),
        )
      ) {
        return malformedHookResult(pointName, "a malformed finish Event");
      }
      if ("usage" in response && response.usage !== undefined) {
        try {
          parseModelUsage(response.usage, `finish Usage from Hook '${pointName}'`);
        } catch {
          return malformedHookResult(pointName, "a malformed finish Usage");
        }
      }
      break;
    }
    case "failure": {
      const failure = object.failure;
      if (
        typeof failure !== "object" ||
        failure === null ||
        Array.isArray(failure) ||
        !("type" in failure) ||
        failure.type !== "model-failure" ||
        !("reason" in failure) ||
        (failure.reason !== "content-policy" && failure.reason !== "invalid-request") ||
        !("provider" in failure) ||
        typeof failure.provider !== "string" ||
        !("message" in failure) ||
        typeof failure.message !== "string"
      ) {
        return malformedHookResult(pointName, "a malformed Failure Event");
      }
      break;
    }
    case "interruption": {
      const interruption = object.interruption;
      if (
        typeof interruption !== "object" ||
        interruption === null ||
        Array.isArray(interruption) ||
        !("type" in interruption)
      ) {
        return malformedHookResult(pointName, "a malformed Interruption Event");
      }
      // SAFETY: The object check above establishes a string-keyed object.
      const fields = interruption as Record<string, unknown>;
      const optionalString = (item: unknown): boolean =>
        item === undefined || typeof item === "string";
      let valid: boolean;
      switch (fields.type) {
        case "authentication-required":
          valid = typeof fields.provider === "string" && optionalString(fields.detail);
          break;
        case "provider-compatibility":
          valid =
            typeof fields.provider === "string" &&
            typeof fields.detail === "string" &&
            optionalString(fields.capability) &&
            optionalString(fields.providerDataNamespace) &&
            (fields.providerDataVersion === undefined ||
              (typeof fields.providerDataVersion === "number" &&
                Number.isFinite(fields.providerDataVersion) &&
                Number.isInteger(fields.providerDataVersion)));
          break;
        case "provider-unavailable":
          valid =
            typeof fields.provider === "string" &&
            ["rate-limit", "transport", "internal-provider", "quota-exhausted"].includes(
              String(fields.reason),
            ) &&
            (fields.retryAfterMs === undefined ||
              (typeof fields.retryAfterMs === "number" &&
                Number.isFinite(fields.retryAfterMs) &&
                fields.retryAfterMs >= 0)) &&
            optionalString(fields.resetAt) &&
            optionalString(fields.detail);
          break;
        case "model-output":
          valid = typeof fields.provider === "string" && typeof fields.detail === "string";
          break;
        case "artifact-storage-required":
          valid =
            (fields.operation === "read" || fields.operation === "write") &&
            optionalString(fields.detail);
          break;
        default:
          valid = false;
      }
      if (!valid) {
        return malformedHookResult(pointName, "a malformed Interruption Event");
      }
      if (fields.usage !== undefined) {
        try {
          parseModelUsage(fields.usage, `Interruption Usage from Hook '${pointName}'`);
        } catch {
          return malformedHookResult(pointName, "a malformed Interruption Usage");
        }
      }
      break;
    }
    default:
      return malformedHookResult(pointName, "an unknown Model Event");
  }
  // SAFETY: The Event discriminant and every allowed field were parsed above.
  return Object.freeze({ ...value }) as ModelEvent;
}

/** Parse one Model invocation replacement returned by a Hook. */
export function parseModelInvocationCandidate(value: unknown, pointName: string): ModelInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    return malformedHookResult(pointName, "a malformed Model invocation");
  }
  // SAFETY: The invocation object and discriminant were checked above.
  const candidate = value as ModelInvocationCandidate;
  switch (candidate.type) {
    case "response": {
      const event = parseModelEvent({ type: "finish", response: candidate.response }, pointName);
      if (event.type !== "finish") {
        return malformedHookResult(pointName, "a malformed Model response");
      }
      const toolCalls = event.response.message.content.filter(
        (part): part is ToolCallContentPart => part.type === "tool-call",
      );
      // SAFETY: The candidate and derived Tool Calls passed the canonical Model Event checks.
      return Object.freeze({
        type: "response",
        response: event.response,
        toolCalls,
      }) as unknown as ModelInvocation;
    }
    case "failure": {
      const event = parseModelEvent({ type: "failure", failure: candidate.failure }, pointName);
      if (event.type !== "failure") {
        return malformedHookResult(pointName, "a malformed Model Failure");
      }
      // SAFETY: Runtime creates this opaque invocation from a parsed Failure.
      return Object.freeze({ type: "failure", failure: event.failure }) as ModelInvocation;
    }
    case "interruption": {
      const event = parseModelEvent(
        { type: "interruption", interruption: candidate.interruption },
        pointName,
      );
      if (event.type !== "interruption") {
        return malformedHookResult(pointName, "a malformed Model Interruption");
      }
      // SAFETY: Runtime creates this opaque invocation from a parsed Interruption.
      return Object.freeze({
        type: "interruption",
        interruption: event.interruption,
      }) as ModelInvocation;
    }
    default:
      return malformedHookResult(pointName, "an unknown Model invocation");
  }
}
