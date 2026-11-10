/**
 * Claude 5.5 structured output on Antigravity: the schema becomes prompt text.
 *
 * Go source: internal/runtime/executor/helps/antigravity_structured_output.go (`PrepareAntigravityClaudeStructuredOutput`),
 * called from antigravity_executor_request.go (`buildRequest`) and antigravity_executor_tokens.go (CLIProxyAPI 1d45a5f3).
 *
 * Opus 5.5 and Sonnet 5.5 reject the forced tool use behind a native response schema, so the schema moves into the
 * system instruction (best effort) and the native output fields are removed. `ANY`/`VALIDATED` function calling falls
 * back to `AUTO`, and the request builder must not restore `VALIDATED` afterwards (`constrainRequestPayload`).
 */
import { asString, del, get, isJsonArray, isJsonObject, type Json, set } from "@commissary/json";
import { buildClaudeStructuredOutputInstruction } from "@commissary/translation";
import { isClaude55Model } from "../helps/claude-55-model.ts";

const CONTAINERS = ["request.generationConfig", "request.generation_config"] as const;

const SCHEMA_KEYS = [
  "responseSchema",
  "responseJsonSchema",
  "response_schema",
  "response_json_schema",
] as const;

const TOOL_CONFIGS = ["request.toolConfig", "request.tool_config"] as const;

const CALLING_KEYS = ["functionCallingConfig", "function_calling_config"] as const;

/**
 * `PrepareAntigravityClaudeStructuredOutput`: for a Claude 5.5 model and a request with an object response schema,
 * appends the schema instruction to the system instruction, removes only the native output leaves (other fields and
 * aliases stay) and downgrades forced function calling to `AUTO`. Run after the sensitive-word obfuscation and before
 * schema cleaning and the payload rules.
 *
 * Contract: always mutates `payload` in place and returns whether it converted (the request builder then does not set
 * `VALIDATED`; `countTokens` ignores the result). Call it once per request: the conversion consumes the native schema,
 * so a second call finds none, appends nothing and returns `false`, which would let `VALIDATED` come back.
 */
export const prepareClaudeStructuredOutput = (model: string, payload: Json): boolean => {
  if (!isClaude55Model(model)) return false;
  let schema: Json | undefined;

  for (const container of CONTAINERS) {
    for (const key of SCHEMA_KEYS) {
      const candidate = get(payload, `${container}.${key}`);

      if (!isJsonObject(candidate)) continue;
      schema = candidate;
      break;
    }

    if (schema !== undefined) break;
  }

  if (schema === undefined) return false;
  // The untouched schema wrapped as a format, not as format settings themselves.
  const instruction = buildClaudeStructuredOutputInstruction({ type: "json_schema", schema });
  const request = get(payload, "request");

  if (!isJsonObject(request)) return false;

  const systemKey =
    request.systemInstruction === undefined && request.system_instruction !== undefined
      ? "system_instruction"
      : "systemInstruction";

  let system = request[systemKey];

  if (!isJsonObject(system)) {
    system = {};
    request[systemKey] = system;
  }

  if (isJsonArray(system.parts)) system.parts.push({ text: instruction });
  else system.parts = [{ text: instruction }];

  for (const container of CONTAINERS) {
    for (const key of [...SCHEMA_KEYS, "responseMimeType", "response_mime_type"])
      del(payload, `${container}.${key}`);
  }

  for (const container of TOOL_CONFIGS) {
    for (const key of CALLING_KEYS) {
      const path = `${container}.${key}`;

      switch (asString(get(payload, `${path}.mode`)).toUpperCase()) {
        case "ANY":
        case "VALIDATED":
          set(payload, `${path}.mode`, "AUTO");
          del(payload, `${path}.allowedFunctionNames`);
          del(payload, `${path}.allowed_function_names`);
      }
    }
  }

  return true;
};
