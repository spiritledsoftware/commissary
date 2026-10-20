// Reading a tool result in tests: the text of its first content.
import type { Schema } from "effect";

/** The text of a tool result's first content, or what else a call came to (`unknown`, `refused`, ...). */
export const textOf = (result: Schema.JsonObject | string): string | undefined =>
  typeof result === "string"
    ? result
    : // SAFETY: the tools these tests call answer text contents.
      (result["content"] as ReadonlyArray<{ readonly text: string }>)[0]?.text;
