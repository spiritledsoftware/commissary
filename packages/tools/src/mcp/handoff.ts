/**
 * How the MCP endpoint reaches the person a browser session's handoff asks for (#216, ADR 0039): `browser_ask_human`
 * started a handoff, and its member acts in the session's Live View on the session's page in the panel. A 2026-07-28
 * client that declares URL elicitation is asked to open that page (an `InputRequiredResult` whose `handoff` input
 * request is a URL-mode `elicitation/create`), and its retry with the answer waits on the handoff, or declines it; any
 * other client (a 2025 client too, as for the connect link: its elicitation would need the request's SSE stream), or
 * any client when the panel's URL is not known, gets the link in a tool result that is not an error, and makes the same
 * call again to wait. The page is the panel's, behind its sign-in: no bearer link (the Live View's) is ever in it.
 */
import type { Schema } from "effect";
import type { FormAction } from "../control-plane-part.ts";
import { isJsonObject } from "../http/shared.ts";

/** The key of the handoff's URL elicitation among a call's input requests. */
export const HANDOFF_KEY = "handoff";

/** Where a handoff's person acts when the panel's URL is not known (`panelPageUrl`). */
export const SESSION_PAGE = "the session's page in the panel (Tools, Browser sessions)";

/** The panel's page of the browser session `id`, relative to the org's panel (`panelPageUrl`). */
export const sessionPagePath = (id: string): string => `tools/sessions/${encodeURIComponent(id)}`;

/**
 * The caller's answer to the handoff's elicitation, when the call is made again with one: `accept` (they went to act),
 * else declined or dismissed.
 */
export const handoffAnswerOf = (params: Schema.JsonObject): FormAction | undefined => {
  const responses = params["inputResponses"];
  const response = isJsonObject(responses) ? responses[HANDOFF_KEY] : undefined;

  if (!isJsonObject(response)) return undefined;
  const action = response["action"];

  return action === "accept" || action === "decline" ? action : "cancel";
};

/** `text` as a sentence: with a full stop at its end unless it ends with one, or with `?` or `!`. */
const sentence = (text: string): string => {
  const trimmed = text.trim();

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** What a call that started a handoff answers, from what the endpoint knows of the client and the panel. */
export interface StartedHandoff {
  /** The tool's full name, `browser_ask_human`. */
  readonly name: string;
  readonly sessionId: string;
  /** What the person is asked, as the call said it. */
  readonly reason: string | undefined;
  /** Until when it waits (epoch ms). */
  readonly until: number;
  /** The session's page in the panel, or {@link SESSION_PAGE} when its URL is not known. */
  readonly link: string;
  /** Whether the client declares URL-mode elicitation (a 2026-07-28 client). */
  readonly elicitsUrls: boolean;
}

/**
 * The answer of a call that started a handoff: the URL elicitation of the session's page, to a client that takes one
 * while the page's URL is known; else a tool result (not an error: the call worked, the person is asked) with the link
 * and the call to make again to wait.
 */
export const handoffResult = (started: StartedHandoff): Schema.JsonObject => {
  const { name, sessionId, reason, link } = started;
  const until = new Date(started.until).toISOString();

  if (started.elicitsUrls && link !== SESSION_PAGE)
    return {
      resultType: "input_required",
      inputRequests: {
        [HANDOFF_KEY]: {
          method: "elicitation/create",
          params: {
            mode: "url",
            url: link,
            message:
              `Act in your browser session ${sessionId} yourself.` +
              (reason === undefined ? "" : ` ${sentence(reason)}`) +
              ` Open its page, do it in the browser, then click Done (or Failed). What you type there is not ` +
              `shown to the agent.`,
          },
        },
      },
    };

  const where = link === SESSION_PAGE ? `on ${link}` : `at ${link}`;

  return {
    content: [
      {
        type: "text",
        text:
          `A person is asked to act in browser session ${sessionId} until ${until}. Tell the session's member to ` +
          `open its page ${where}, act in the browser there and click Done or Failed. Then call ${name} again with ` +
          `the same sessionId: it waits for them, and answers how it ended, or, after a while, that they are not done yet ` +
          `(then call it again).`,
      },
    ],
    isError: false,
  };
};
