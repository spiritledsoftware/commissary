/**
 * The bounds a toolkit kind that derives its tools' input schemas from a document keeps them within (OpenAPI #203,
 * GraphQL #204): a schema is walked at the deepest depth that fits {@link MAX_SCHEMA_BYTES} and visits at most {@link
 * NODE_BUDGET} nodes ({@link fittedInputSchema}), and a description is cut to {@link MAX_DESCRIPTION} characters.
 */
import type { Schema } from "effect";

/** The most JSON one tool's input schema may take. */
export const MAX_SCHEMA_BYTES = 16 * 1024;

/** The longest description kept. */
export const MAX_DESCRIPTION = 2048;

/** Schema nodes one attempt at an input schema may visit before it is abandoned for a shallower one. */
const NODE_BUDGET = 20_000;

/** Depths an input schema is tried at, deepest first. */
const DEPTHS = [8, 5, 3, 2, 1, 0];

class OverBudget extends Error {}

/** One attempt's walk: how deep it goes, whether it keeps descriptions, and the nodes it visited. */
export interface InputWalk {
  readonly maxDepth: number;
  readonly descriptions: boolean;
  nodes: number;
}

/** Counts a node `walk` visits, abandoning the attempt once it passed {@link NODE_BUDGET}. */
export const visit = (walk: InputWalk): void => {
  walk.nodes += 1;

  if (walk.nodes > NODE_BUDGET) throw new OverBudget();
};

/** The UTF-8 bytes of `value` as JSON. */
export const jsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** `text` trimmed and cut to {@link MAX_DESCRIPTION} characters; undefined when it is empty. */
export const descriptionText = (text: string | null | undefined): string | undefined => {
  const trimmed = text?.trim();

  if (trimmed === undefined || trimmed === "") return undefined;

  return trimmed.length > MAX_DESCRIPTION ? `${trimmed.slice(0, MAX_DESCRIPTION - 1)}…` : trimmed;
};

/**
 * The deepest input schema `at` builds within {@link MAX_SCHEMA_BYTES}: each depth of {@link DEPTHS} with descriptions,
 * then each without; an attempt whose walk ({@link visit}) runs over {@link NODE_BUDGET} is abandoned. At worst an
 * object of any properties.
 */
export const fittedInputSchema = (
  at: (walk: InputWalk) => Schema.JsonObject,
): Schema.JsonObject => {
  for (const descriptions of [true, false])
    for (const maxDepth of DEPTHS) {
      let schema: Schema.JsonObject;

      try {
        schema = at({ maxDepth, descriptions, nodes: 0 });
      } catch (error) {
        if (error instanceof OverBudget) continue;
        throw error;
      }

      if (jsonBytes(schema) <= MAX_SCHEMA_BYTES) return schema;
    }

  return { type: "object" };
};
