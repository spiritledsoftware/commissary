/**
 * Meta Muse tool namespace.
 *
 * Go source: internal/runtime/executor/helps/meta_muse_tools.go (`EnsureMetaMuseToolNamespace`). Captured from the Muse
 * Code 1.4.12 reminder agent: subscription-key tool requests can require a canonical `muse` namespace even with current
 * client headers. Caller tools are kept untouched (names, schemas, indexes); the namespace is appended after them.
 */
import { get, isJsonArray, isJsonObject, type Json, type JsonObject } from "@commissary/json";

const MUSE_NAMESPACE: JsonObject = {
  type: "namespace",
  name: "muse",
  description: "Muse Code tool set.",
  tools: [
    {
      type: "function",
      name: "submit_reminder_decision",
      description: "Submit this reminder child's explicit decision.",
      parameters: {
        additionalProperties: false,
        properties: {
          advisory_text: {
            description: "Short text to deliver to the main agent when reminding.",
            type: ["null", "string"],
          },
          confidence: {
            description: "Confidence in the decision.",
            enum: ["low", "medium", "high"],
            type: ["null", "string"],
          },
          decision: { enum: ["remind", "none"], type: "string" },
          priority: {
            description: "Requested reminder priority.",
            enum: ["low", "normal", "high"],
            type: ["null", "string"],
          },
          reason: {
            description: "Brief reason for reminding or staying silent.",
            type: "string",
          },
          skill_id: {
            description: "The listed skill id to remind when needs_reminder is true.",
            type: ["null", "string"],
          },
          visible_for_steps: {
            description: "Requested ephemeral visibility length in main model steps.",
            maximum: 8,
            minimum: 1,
            type: ["null", "integer"],
          },
        },
        required: [
          "advisory_text",
          "confidence",
          "decision",
          "priority",
          "reason",
          "skill_id",
          "visible_for_steps",
        ],
        type: "object",
      },
      strict: true,
    },
  ],
};

/** Appends the namespace to a non-empty `tools` array without one named `muse`; anything else is returned as is. */
export const ensureMetaMuseToolNamespace = (body: Json): Json => {
  const tools = get(body, "tools");

  if (!isJsonObject(body) || !isJsonArray(tools) || tools.length === 0) return body;

  if (
    tools.some(
      (tool) => isJsonObject(tool) && tool["type"] === "namespace" && tool["name"] === "muse",
    )
  )
    return body;

  body["tools"] = [...tools, structuredClone(MUSE_NAMESPACE)];

  return body;
};
