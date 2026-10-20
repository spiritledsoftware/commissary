// The consent page of an MCP client's sign-in on Commissary Cloud (#200, `/authorize`): what the page says of the
// client, which asserts its own name unless its id is a URL on its own domain (a Client ID Metadata Document), where its
// tokens go, and what a refused sign-in tells the member. Every string of the client is shown as text, never as
// markup. Pure: no DOM, tested in test/consent.test.ts.
import type { McpSignInClient } from "@commissary/contract/mcp-sign-ins";
import { asSentence } from "./failure.ts";
import { orgPanelPath } from "./org.ts";

/** The longest client name the page shows whole; a longer one is cut (the key's name is cut at 100 by the server). */
export const CLIENT_NAME_SHOWN = 80;

/** The query the client sent to `/authorize`, as the page passes it on (`""` when it sent none). */
export const authorizeQuery = (search: string): string =>
  search === "" || search === "?" ? "" : search.startsWith("?") ? search : `?${search}`;

/** Whether the page was opened by a client at all: an authorization request names its client. */
export const isAuthorizeRequest = (search: string): boolean =>
  new URLSearchParams(authorizeQuery(search)).has("client_id");

/** The client's name as the page shows it: trimmed, without control characters, cut when long. */
export const clientName = (client: Pick<McpSignInClient, "client_name">): string => {
  const name = Array.from(client.client_name)
    .map((character) =>
      (character.codePointAt(0) ?? 0) < 0x20 || character === "\u007f" ? " " : character,
    )
    .join("")
    .trim();

  const characters = Array.from(name);

  if (characters.length === 0) return "An unnamed app";

  return characters.length > CLIENT_NAME_SHOWN
    ? `${characters.slice(0, CLIENT_NAME_SHOWN).join("")}…`
    : name;
};

/** Who vouches for the name: the client's domain, or no one. */
export const identityNote = (client: Pick<McpSignInClient, "client_domain">): string =>
  client.client_domain === undefined
    ? "The app gave this name itself; Commissary cannot check it. Continue only if you just started signing in from this app."
    : `The app is identified by ${client.client_domain}, which publishes its details.`;

/** Where the app's tokens go once the member allows it. */
export const redirectNote = (
  client: Pick<McpSignInClient, "redirect_host" | "redirect_is_loopback">,
): string =>
  client.redirect_is_loopback
    ? "Its access goes to an app on this computer."
    : `Its access goes to ${client.redirect_host}.`;

/** What a refused sign-in says, by the server's error code. */
export const consentProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "sign_in_refused":
      return detail === undefined ? message : asSentence(detail);
    case "member_required":
      return "An app signs in as a member of the org, and you are not one here. Choose an org you are a member of.";
    case "too_many_keys":
      return "You hold the most API keys a member may. Revoke keys you no longer use, then start again from the app.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

/** The consent page of `slug` for the same request: where the org chooser of `/authorize` sends the member. */
export const consentPageOf = (slug: string, search: string): string =>
  `${orgPanelPath(slug, "/authorize")}${authorizeQuery(search)}`;
