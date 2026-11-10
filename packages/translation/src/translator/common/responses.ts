/**
 * Shared OpenAI Responses item helpers.
 *
 * Go source: internal/translator/common/responses.go.
 */
import { del, get, type Json, type JsonObject, set } from "@commissary/json";
import { isArr, isObj, str } from "./gjson.ts";

/** `ExtractResponsesCallID`: call_id -> tool_call_id -> callId -> id (excluding `fco_` output item ids). */
export const extractResponsesCallID = (node: Json | undefined): string => {
  for (const key of ["call_id", "tool_call_id", "callId"]) {
    const value = str(get(node, key)).trim();

    if (value !== "") return value;
  }

  const id = str(get(node, "id")).trim();

  return id.startsWith("fco_") ? "" : id;
};

const isOutputType = (type: string): boolean =>
  type === "function_call_output" || type === "custom_tool_call_output";

/** `isCodexDelegationToolOutput`: Codex Desktop's `codex_app` thread tools, which other code rewrites by namespace. */
const isCodexDelegationToolOutput = (item: Json | undefined): boolean => {
  if (str(get(item, "type")).trim() !== "function_call_output") return false;

  if (str(get(item, "namespace")).trim() !== "codex_app") return false;
  const name = str(get(item, "name")).trim();

  return name === "create_thread" || name === "send_message_to_thread";
};

/**
 * `NormalizeResponsesToolCallOutputs`: assigns missing call ids to tool outputs by explicit id, then function name,
 * then FIFO order. Outputs that already carry an unmatched explicit id are never rewritten.
 */
export const normalizeResponsesToolCallOutputs = (items: readonly Json[]): Json[] => {
  if (items.length === 0) return [...items];
  const normalized: Json[] = [...items];
  const explicitOutputCounts = new Map<string, number>();

  for (const item of items) {
    if (isOutputType(str(get(item, "type")))) {
      const id = extractResponsesCallID(item);

      if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1);
    }
  }

  let pendingCallIDs: string[] = [];
  const pendingCallNames = new Map<string, string>();
  const reserved = (id: string): boolean => (explicitOutputCounts.get(id) ?? 0) > 0;

  let i = 0;

  while (i < normalized.length) {
    const itemType = str(get(normalized[i], "type"));

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callID = extractResponsesCallID(normalized[i]);

      if (callID !== "") {
        pendingCallIDs.push(callID);
        pendingCallNames.set(callID, str(get(normalized[i], "name")));
      }

      i++;
    } else if (isOutputType(itemType)) {
      const start = i;

      while (i < normalized.length && isOutputType(str(get(normalized[i], "type")))) i++;
      const outputs = normalized.slice(start, i);

      if (pendingCallIDs.length > 0) {
        const used = outputs.map(() => false);
        const matched = pendingCallIDs.map(() => -1);

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          const outIdx = outputs.findIndex(
            (out, idx) => !used[idx] && extractResponsesCallID(out) === pendingID,
          );

          if (outIdx >= 0) {
            used[outIdx] = true;
            matched[pendingIdx] = outIdx;
            explicitOutputCounts.set(pendingID, (explicitOutputCounts.get(pendingID) ?? 0) - 1);
          }
        });

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          // SAFETY: `matched` has one slot per entry of pendingCallIDs, so pendingIdx is in range.
          if ((matched[pendingIdx] as number) >= 0 || reserved(pendingID)) return;
          const expectedName = pendingCallNames.get(pendingID) ?? "";

          if (expectedName === "") return;

          const outIdx = outputs.findIndex(
            (out, idx) =>
              !used[idx] &&
              extractResponsesCallID(out) === "" &&
              !isCodexDelegationToolOutput(out) &&
              str(get(out, "name")).trim() !== "" &&
              str(get(out, "name")).trim() === expectedName,
          );

          if (outIdx >= 0) {
            used[outIdx] = true;
            matched[pendingIdx] = outIdx;
          }
        });

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          // SAFETY: `matched` has one slot per entry of pendingCallIDs, so pendingIdx is in range.
          if ((matched[pendingIdx] as number) >= 0 || reserved(pendingID)) return;
          const expectedName = pendingCallNames.get(pendingID) ?? "";

          const outIdx = outputs.findIndex((out, idx) => {
            if (used[idx] || extractResponsesCallID(out) !== "" || isCodexDelegationToolOutput(out))
              return false;
            const outName = str(get(out, "name")).trim();

            return outName === "" || expectedName === "" || outName === expectedName;
          });

          if (outIdx >= 0) {
            used[outIdx] = true;
            matched[pendingIdx] = outIdx;
          }
        });

        const remaining: string[] = [];
        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          // SAFETY: `matched` has one slot per entry of pendingCallIDs, so pendingIdx is in range.
          const outIdx = matched[pendingIdx] as number;

          if (outIdx < 0) {
            remaining.push(pendingID);

            return;
          }

          const out = outputs[outIdx];

          if (str(get(out, "call_id")) !== pendingID && isObj(out)) {
            normalized[start + outIdx] = { ...out, call_id: pendingID } satisfies JsonObject;
          }
        });
        pendingCallIDs = remaining;
      }
    } else {
      i++;
    }
  }

  return normalized;
};

/** `responsesToolOutputExplicitCallID`: the first non-blank string of call_id, tool_call_id, callId. */
const explicitOutputCallId = (item: Json): string => {
  for (const key of ["call_id", "tool_call_id", "callId"]) {
    const value = get(item, key);

    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }

  return "";
};

/** `extractOrphanResponsesToolOutputParts`: the text lines of an output and its non-text parts, kept as they are. */
interface OrphanOutputParts {
  readonly text: string;
  readonly extra: Json[];
}

const orphanOutputParts = (output: Json | undefined): OrphanOutputParts => {
  if (output === undefined || output === null) return { text: "", extra: [] };

  if (typeof output === "string") return { text: output.trim(), extra: [] };

  if (isArr(output)) {
    const lines: string[] = [];
    const extra: Json[] = [];

    for (const part of output) {
      if (typeof part === "string") {
        if (part.trim() !== "") lines.push(part.trim());
        continue;
      }

      if (!isObj(part)) continue;
      let matchedText = false;

      for (const key of ["text", "input_text", "output_text"]) {
        const value = part[key];

        if (typeof value !== "string") continue;
        matchedText = true;

        if (value.trim() !== "") lines.push(value.trim());
        break;
      }

      if (!matchedText) extra.push(part);
    }

    if (lines.length > 0 || extra.length > 0) return { text: lines.join("\n"), extra };
  }

  // A scalar, an object or an array without usable parts: its JSON text (re-serialised, not the client's bytes).
  return { text: JSON.stringify(output).trim(), extra: [] };
};

/** `setOrphanResponsesToolOutputMessageDoc`: the user message that replaces an orphan tool output. */
const orphanOutputMessage = (item: Json): JsonObject => {
  const name = str(get(item, "name")).trim() || "tool";
  const { text, extra } = orphanOutputParts(get(item, "output"));

  return {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: `Tool output from ${name}:\n${text === "" ? "(empty)" : text}` },
      ...extra,
    ],
  };
};

/**
 * `SanitizeOrphanResponsesToolOutputsInputDoc` (05e668cf): pairs tool outputs missing a call id with the calls before
 * them when possible and rewrites the remaining standalone `function_call_output` / `custom_tool_call_output` items
 * without one into user messages. Codex Desktop injects Companion Page context that way, and strict upstreams answer
 * those items with 400 ("call_id is required"). `codex_app` delegation outputs are left for the orphan delegation
 * rewrite. Mutates `input` in place; true when something changed.
 */
export const sanitizeOrphanResponsesToolOutputs = (input: Json | undefined): boolean => {
  if (!isArr(input) || input.length === 0) return false;
  const normalized = normalizeResponsesToolCallOutputs(input);
  let changed = false;
  let pendingMissingOutputType = "";

  for (let i = 0; i < input.length; i++) {
    const item = normalized[i];

    if (!isObj(item)) {
      pendingMissingOutputType = "";
      continue;
    }

    const itemType = str(get(item, "type")).trim();

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      pendingMissingOutputType = extractResponsesCallID(item) === "" ? `${itemType}_output` : "";
      continue;
    }

    if (!isOutputType(itemType) || isCodexDelegationToolOutput(item)) {
      pendingMissingOutputType = "";
      continue;
    }

    const resolved = explicitOutputCallId(item);

    if (resolved !== "") {
      pendingMissingOutputType = "";

      const source = input[i];

      if (isObj(source) && str(get(source, "call_id")).trim() !== resolved) {
        source["call_id"] = resolved;
        changed = true;
      }

      continue;
    }

    if (
      pendingMissingOutputType === itemType &&
      str(get(item, "name")).trim() === "" &&
      str(get(item, "id")).trim() === ""
    ) {
      pendingMissingOutputType = "";
      continue;
    }

    pendingMissingOutputType = "";
    input[i] = orphanOutputMessage(item);
    changed = true;
  }

  return changed;
};

/** `SetResponsesToolCallIdentity`: writes a resolved Responses tool name and namespace (mutates `item`). */
export const setResponsesToolCallIdentity = (
  item: Json,
  name: string,
  namespace: string,
  itemPath: string,
): Json => {
  const namePath = itemPath !== "" ? `${itemPath}.name` : "name";
  const namespacePath = itemPath !== "" ? `${itemPath}.namespace` : "namespace";
  set(item, namePath, name);

  if (namespace !== "") set(item, namespacePath, namespace);
  else del(item, namespacePath);

  return item;
};
