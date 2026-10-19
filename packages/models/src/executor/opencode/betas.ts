/**
 * The `anthropic-beta` value of an OpenCode Messages request.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go"):
 * the client's betas are forwarded, except the identity ones (`claude-code-*`, `oauth-*`: they describe the Claude Code
 * and Anthropic-account client, not the request schema, and must not reach a provider-key gateway), and the beta a
 * request body needs is added even when the client did not send it.
 */
import { isJsonArray, isJsonObject, type Json } from "@commissary/json";

/** Beta that allows `output_config` on a mid-conversation system message. */
export const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";

const IDENTITY_BETA_PREFIXES = ["claude-code-", "oauth-"];

const hasMidConversationOutputConfig = (body: Json): boolean => {
  const messages = isJsonObject(body) ? body["messages"] : undefined;

  return (
    isJsonArray(messages) &&
    messages.some(
      (message) =>
        isJsonObject(message) &&
        message["role"] === "system" &&
        message["output_config"] !== undefined &&
        message["output_config"] !== null,
    )
  );
};

/**
 * The client's betas (trimmed, deduplicated, in the client's order, without the identity ones) followed by the beta
 * the final body needs; `undefined` when there are none.
 */
export const messagesBetaHeader = (
  clientBeta: string | null | undefined,
  body: Json,
): string | undefined => {
  const betas = new Set(
    (clientBeta ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(
        (beta) =>
          beta !== "" &&
          !IDENTITY_BETA_PREFIXES.some((prefix) => beta.toLowerCase().startsWith(prefix)),
      ),
  );

  if (hasMidConversationOutputConfig(body)) betas.add(MID_CONVERSATION_OUTPUT_CONFIG_BETA);

  return betas.size === 0 ? undefined : [...betas].join(",");
};
