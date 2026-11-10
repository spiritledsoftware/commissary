/**
 * Inline tool definitions of mid-conversation Claude `tool_addition` blocks.
 *
 * Go source: internal/util/translator.go (forEachClaudeInlineToolAdditionDefinition); upstream 12d97cfe.
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";

/** The definition a `tool_addition` block carries, if it carries one (a `tool_reference` carries none). */
export const toolAdditionDefinition = (part: Json | undefined): JsonObject | undefined => {
  if (asString(get(part, "type")) !== "tool_addition") return undefined;
  const tool = get(part, "tool");
  const definition = get(tool, "definition");

  if (asString(get(tool, "type")) !== "tool_definition" && !isJsonObject(definition))
    return undefined;

  return isJsonObject(definition) ? definition : undefined;
};

/** Every inline definition the request's `role: system` messages add, in order. */
export const inlineToolAdditionDefinitions = (request: Json | undefined): JsonObject[] => {
  const messages = get(request, "messages");
  const out: JsonObject[] = [];

  if (!isJsonArray(messages)) return out;

  for (const message of messages) {
    if (asString(get(message, "role")) !== "system") continue;
    const content = get(message, "content");

    if (!isJsonArray(content)) continue;

    for (const part of content) {
      const definition = toolAdditionDefinition(part);

      if (definition !== undefined) out.push(definition);
    }
  }

  return out;
};
