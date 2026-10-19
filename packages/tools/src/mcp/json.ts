/** JSON helpers the MCP client and endpoint share. */
import { Schema } from "effect";

/** Whether a JSON value is an object (not an array, not `null`). */
export const isJsonObject = Schema.is(Schema.JsonObject);
