/**
 * What makes a hosted agent's definition well formed (#226, ADR 0040), apart from what it names: its name and the
 * lengths of its texts. Pure; the Agents part checks its tool scope's shape as an API key's (`normalizedToolScope`)
 * and what the definition names (models, toolkits, agents, watchers) against the org.
 */

/** A name: 1-64 of `[a-z0-9_]`, so it is the agents toolkit's `agent` argument as it is (#229). */
const NAME = /^[a-z0-9_]{1,64}$/;

export const MAX_DESCRIPTION = 1_000;

export const MAX_INSTRUCTIONS = 65_536;

export const MAX_MODEL = 200;

/** The parts of a definition checked here. */
export interface DefinitionText {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
}

/** Why `text` cannot be stored, or `undefined` when it can. */
export const definitionRefusal = (text: DefinitionText): string | undefined => {
  if (!NAME.test(text.name))
    return "an agent's name is 1 to 64 lowercase letters, digits and underscores";

  if (text.description.length > MAX_DESCRIPTION)
    return `an agent's description is at most ${MAX_DESCRIPTION} characters`;

  if (text.instructions.length > MAX_INSTRUCTIONS)
    return `an agent's instructions are at most ${MAX_INSTRUCTIONS} characters`;

  if (text.model.trim() === "" || text.model.length > MAX_MODEL)
    return `an agent names one model, as clients send it, in at most ${MAX_MODEL} characters`;

  return undefined;
};
