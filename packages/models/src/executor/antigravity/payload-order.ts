/**
 * The key order of an Antigravity agent request: the native client's order, so the upstream sees the same wire format
 * (CLIProxyAPI b8e3bc66).
 *
 * Go source: internal/runtime/executor/helps/antigravity_payload_order.go (`SerializeAntigravityPayload`,
 * `antigravityAgentFields`). Go reorders the raw bytes; Commissary reorders the parsed object before `JSON.stringify`,
 * which also compacts. One JavaScript limit: an object key that is an array index (`"0"`, `"12"`) always comes first,
 * in numeric order, whatever the table says.
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

type Mode =
  | "opaque"
  | "dictionary"
  | "schemaProperties"
  | "schemaDefinitions"
  | "envelope"
  | "request"
  | "content"
  | "part"
  | "call"
  | "response"
  | "tool"
  | "declaration"
  | "labels"
  | "generation"
  | "thinking"
  | "schema";

type RankedMode = Exclude<Mode, "opaque" | "dictionary" | "schemaProperties" | "schemaDefinitions">;

interface Fields {
  readonly ranks: ReadonlyMap<string, number>;
  readonly modes: ReadonlyMap<string, Mode>;
}

/** Only `sample` gives a wire rank; the child groups also recognise alternate spellings, without a rank. */
const fields = (sample: string, ...children: ReadonlyArray<readonly [string, Mode]>): Fields => {
  const ranks = new Map<string, number>();
  const modes = new Map<string, Mode>();

  sample
    .split(" ")
    .filter((key) => key !== "")
    .forEach((key, index) => ranks.set(key, index + 1));

  for (const [keys, mode] of children) {
    for (const key of keys.split(" ")) if (key !== "") modes.set(key, mode);
  }

  return { ranks, modes };
};

const AGENT_FIELDS: Readonly<Record<RankedMode, Fields>> = {
  envelope: fields("project requestId request model userAgent requestType", ["request", "request"]),
  request: fields(
    "contents systemInstruction tools labels generationConfig sessionId",
    ["contents systemInstruction system_instruction", "content"],
    ["tools", "tool"],
    ["labels", "labels"],
    ["generationConfig generation_config", "generation"],
  ),
  content: fields("role parts", ["parts", "part"]),
  part: fields(
    "text functionCall functionResponse thoughtSignature",
    ["functionCall function_call", "call"],
    ["functionResponse function_response", "response"],
  ),
  call: fields("id name args", ["args", "dictionary"]),
  response: fields("id name response", ["response", "dictionary"], ["parts", "part"]),
  tool: fields("functionDeclarations", [
    "functionDeclarations function_declarations",
    "declaration",
  ]),
  declaration: fields("name description parameters", [
    "parameters parametersJsonSchema parameters_json_schema response responseJsonSchema response_json_schema",
    "schema",
  ]),
  labels: fields(
    "cascade_id last_step_index model_enum request_id root_cascade_id trajectory_id used_claude used_claude_conservative used_non_gemini_model",
  ),
  generation: fields(
    "maxOutputTokens thinkingConfig",
    ["thinkingConfig thinking_config", "thinking"],
    ["responseSchema response_schema responseJsonSchema response_json_schema", "schema"],
  ),
  thinking: fields("includeThoughts thinkingLevel"),
  schema: fields(
    "type description properties required items enum minLength minimum minItems",
    [
      "items additionalProperties additionalItems propertyNames contains prefixItems anyOf oneOf allOf not if then else unevaluatedItems unevaluatedProperties",
      "schema",
    ],
    ["properties", "schemaProperties"],
    ["$defs definitions patternProperties dependentSchemas dependencies", "schemaDefinitions"],
  ),
};

interface Member {
  readonly key: string;
  readonly rank: number;
  /** Lexical modes compare keys; ranked ones keep the source order among equal ranks. */
  readonly lexical: boolean;
  readonly index: number;
  readonly mode: Mode;
}

const memberOf = (mode: Mode, key: string, index: number): Member => {
  switch (mode) {
    case "dictionary":
      return { key, rank: 0, lexical: true, index, mode: "dictionary" };
    case "schemaProperties":
      return { key, rank: 0, lexical: true, index, mode: "schema" };
    case "schemaDefinitions":
      return { key, rank: 0, lexical: false, index, mode: "schema" };
    case "opaque":
      return { key, rank: 0, lexical: false, index, mode: "opaque" };
    default: {
      const table = AGENT_FIELDS[mode];

      return {
        key,
        rank: table.ranks.get(key) ?? table.ranks.size + 1,
        lexical: false,
        index,
        mode: table.modes.get(key) ?? "opaque",
      };
    }
  }
};

const compareMembers = (a: Member, b: Member): number => {
  if (a.rank !== b.rank) return a.rank - b.rank;

  if (a.lexical && a.key !== b.key) return a.key < b.key ? -1 : 1;

  return a.index - b.index;
};

const order = (value: Json, mode: Mode): Json => {
  if (mode === "opaque") return value;

  if (isJsonArray(value)) return value.map((element) => order(element, mode));

  if (!isJsonObject(value)) return value;
  const members = Object.keys(value).map((key, index) => memberOf(mode, key, index));
  members.sort(compareMembers);
  const out: JsonObject = {};

  for (const member of members) {
    const child = value[member.key];

    if (child !== undefined) out[member.key] = order(child, member.mode);
  }

  return out;
};

/** `SerializeAntigravityPayload`: compact JSON, in the native key order for agent requests. */
export const serializeAntigravityPayload = (payload: Json, orderAgentKeys: boolean): string =>
  JSON.stringify(orderAgentKeys ? order(payload, "envelope") : payload);
