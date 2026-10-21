// The Toolkits page's model (#208, ADR 0036, ADR 0037, GLOSSARY "Toolkit", "Shadowed / rename suggested"): each
// toolkit's row (its kind, source, sign-in state, tool count and the flags that need attention), the order of the rows,
// what an org admin sees of other members' private toolkits, and which controls a caller gets. The server decides what
// each caller sees and enforces every rule again; this keeps the panel from offering what would be refused. Pure: no
// DOM, tested in test/toolkits.test.ts.
import type {
  CredentialsAccepted,
  CredentialSlot,
  LimitedToolkitView,
  ToolkitCredentialView,
  ToolkitKind,
  ToolkitView,
} from "@commissary/contract/tools";
import type { Me } from "@commissary/contract/orgs";
import { asSentence } from "./failure.ts";
import { formatCount, formatDate } from "./format.ts";
import { atLeast, effectiveRole } from "./role.ts";
import { wayName } from "./toolkit-credentials.ts";
import type { Outcome } from "./use-action.ts";

/** What the caller may do in the org the panel shows, as far as toolkits go. */
export interface ToolsCaller {
  /** An org admin (or owner). */
  readonly admin: boolean;
  /** The org lets members connect private credentials to org toolkits (`private_credentials`). */
  readonly privateCredentials: boolean;
  /** The org lets members add private toolkits (`private_toolkits`). */
  readonly privateToolkits: boolean;
}

/** Whether the caller may add a toolkit: an org admin an org toolkit, anyone a private one where the org allows it. */
export const canAdd = (caller: ToolsCaller): boolean => caller.admin || caller.privateToolkits;

/** The caller as `GET /me` (addressed to the org) says: a setting it leaves out is off. */
export const toolsCallerOf = (
  me: Pick<Me, "role" | "platform_admin" | "private_credentials" | "private_toolkits">,
): ToolsCaller => ({
  admin: atLeast(effectiveRole(me), "admin"),
  privateCredentials: me.private_credentials === true,
  privateToolkits: me.private_toolkits === true,
});

const KIND_LABELS: Readonly<Record<ToolkitKind, string>> = {
  mcp: "MCP server",
  openapi: "OpenAPI document",
  graphql: "GraphQL endpoint",
  discovery: "Google Discovery document",
  browser: "Browser",
  sandbox: "Sandbox",
  agents: "Agents",
};

export const kindLabel = (kind: ToolkitKind): string => KIND_LABELS[kind];

/** What an uploaded document of a kind is: a GraphQL toolkit's is its schema (SDL), the others' their document. */
export const documentLabel = (kind: ToolkitKind): string =>
  kind === "graphql" ? "GraphQL schema" : kindLabel(kind);

/** Which credentials an org toolkit accepts, as its pickers and its page say it. */
export const ACCEPTS: ReadonlyArray<{
  readonly value: CredentialsAccepted;
  readonly label: string;
}> = [
  { value: "shared", label: "The org's shared credential only" },
  { value: "private", label: "Each member's private credential only" },
  { value: "both", label: "Either: a member's private credential wins over the shared one" },
];

export const isAccepted = (value: string): value is CredentialsAccepted =>
  ACCEPTS.some((each) => each.value === value);

export const acceptsLabel = (accepts: CredentialsAccepted): string =>
  ACCEPTS.find((each) => each.value === accepts)?.label ?? accepts;

/** Why a toolkit's name would be refused (ADR 0037), or `undefined`; empty takes the default. */
export const toolkitNameProblem = (name: string): string | undefined => {
  const trimmed = name.trim();

  if (trimmed === "") return undefined;

  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(trimmed))
    return "A name is lowercase letters and digits, words joined by single _.";

  return trimmed.length > 32 ? "A name is at most 32 characters." : undefined;
};

/** Where a toolkit comes from, as a row shows it: its URL without the scheme, an uploaded document, or Commissary. */
export const sourceText = (toolkit: ToolkitView): string => {
  if (toolkit.built_in === true) return "Provided by Commissary";

  if (toolkit.source === "") return "Uploaded document";

  return toolkit.source.replace(/^https?:\/\//, "");
};

/** One sign-in of a row: the shared credential's, or the caller's own. */
export interface SignInState {
  readonly slot: CredentialSlot;
  readonly text: string;
}

const credentialText = (credential: ToolkitCredentialView | undefined): string => {
  if (credential === undefined) return "not connected";

  return credential.needs_sign_in === true ? "needs sign-in" : wayName(credential.kind);
};

/** Whether a toolkit takes a credential in the slot: a shared one (an org toolkit that accepts one), or the caller's own. */
export const acceptsSlot = (toolkit: ToolkitView, slot: CredentialSlot): boolean => {
  if (toolkit.built_in === true) return false;

  if (slot === "shared") return !toolkit.private && toolkit.accepts !== "private";

  return toolkit.private || toolkit.accepts !== "shared";
};

/** The sign-ins a row shows: each slot the toolkit takes, or holds a credential in. */
export const signInStates = (toolkit: ToolkitView): ReadonlyArray<SignInState> => {
  if (toolkit.built_in === true) return [];
  const { shared, mine } = toolkit.credentials;

  return [
    ...(acceptsSlot(toolkit, "shared") || shared !== undefined
      ? [{ slot: "shared" as const, text: `Shared: ${credentialText(shared)}` }]
      : []),
    ...(acceptsSlot(toolkit, "private") || mine !== undefined
      ? [{ slot: "private" as const, text: `Yours: ${credentialText(mine)}` }]
      : []),
  ];
};

/**
 * Something about a toolkit that needs its managers or the caller: `failing` when something is closed or failing (the
 * red trail mark), `note` for what to tidy (a name to change), which works meanwhile.
 */
export interface Flag {
  readonly text: string;
  readonly severity: "failing" | "note";
}

/** What needs attention, most pressing first. */
export const flagsOf = (toolkit: ToolkitView): ReadonlyArray<Flag> => {
  const { shared, mine } = toolkit.credentials;

  const flags: ReadonlyArray<Flag | undefined> = [
    toolkit.tool_list.error === undefined
      ? undefined
      : { text: `Listing failed: ${toolkit.tool_list.error}`, severity: "failing" },
    shared?.needs_sign_in === true
      ? { text: "The shared credential needs sign-in again", severity: "failing" }
      : undefined,
    mine?.needs_sign_in === true
      ? { text: "Your private credential needs sign-in again", severity: "failing" }
      : undefined,
    shared?.active === false
      ? {
          text: "The shared credential is not used: the toolkit does not accept it",
          severity: "failing",
        }
      : undefined,
    mine?.active === false
      ? {
          text: "Your private credential is not used: the toolkit does not accept it, or the org has private credentials off",
          severity: "failing",
        }
      : undefined,
    toolkit.rename_suggested === true
      ? { text: "An org toolkit took this name: rename yours", severity: "note" }
      : undefined,
    toolkit.shadowed === true
      ? { text: "Your private toolkit of this name is served instead", severity: "note" }
      : undefined,
  ];

  return flags.flatMap((flag) => (flag === undefined ? [] : [flag]));
};

/** Whether a row needs attention first: something closed or failing. */
const failing = (flags: ReadonlyArray<Flag>): boolean =>
  flags.some((flag) => flag.severity === "failing");

/** A row of the toolkits table. */
export interface ToolkitRow {
  readonly toolkit: ToolkitView;
  readonly kind: string;
  readonly source: string;
  readonly signIns: ReadonlyArray<SignInState>;
  readonly tools: string;
  readonly flags: ReadonlyArray<Flag>;
}

export const toolkitRow = (toolkit: ToolkitView): ToolkitRow => ({
  toolkit,
  kind: kindLabel(toolkit.kind),
  source: sourceText(toolkit),
  signIns: signInStates(toolkit),
  tools:
    toolkit.tool_list.built_at === undefined
      ? "Not listed yet"
      : formatCount(toolkit.tool_list.tools),
  flags: flagsOf(toolkit),
});

/** The rows in the order the page lists them: those closed or failing first, then by name. */
export const sortRows = (rows: ReadonlyArray<ToolkitRow>): ReadonlyArray<ToolkitRow> =>
  rows.toSorted(
    (a, b) =>
      Number(failing(b.flags)) - Number(failing(a.flags)) ||
      a.toolkit.name.localeCompare(b.toolkit.name),
  );

/** Another member's private toolkit as an org admin sees it: its owner and when it was added, nothing else. */
export interface OtherToolkitRow {
  readonly id: string;
  /** The owner's email, else their member id. */
  readonly owner: string;
  readonly added: string;
  /** For the `If-Match` of its removal. */
  readonly revision: number;
}

export const otherRows = (
  others: ReadonlyArray<LimitedToolkitView>,
): ReadonlyArray<OtherToolkitRow> =>
  others.map((other) => ({
    id: other.id,
    owner: other.owner.email ?? other.owner.member_id,
    added: `Added ${formatDate(Date.parse(other.created_at))}`,
    revision: other.revision,
  }));

/**
 * Who connected a credential or changed a toolkit, as a person reads it: an Access principal's email (`user:<email>`),
 * else the principal as it is (a service token, a management key).
 */
export const principalName = (principal: string): string =>
  principal.startsWith("user:") ? principal.slice("user:".length) : principal;

/** The controls a caller gets on a toolkit's page. */
export interface ToolkitControls {
  /** Rename it, change what it accepts, set its OAuth app and credential settings, override its tools. */
  readonly manage: boolean;
  /** Connect, sign in or remove its shared credential. */
  readonly shared: boolean;
  /** Connect, sign in or remove the caller's own credential. */
  readonly private: boolean;
  /** Build its tool list now. */
  readonly refresh: boolean;
  readonly remove: boolean;
  /**
   * Price its calls, and its tools' (#209): org admins, on an org toolkit (the browser and sandbox toolkits take a
   * price per hour of their time). A private toolkit takes no price, not even from its owner.
   */
  readonly prices: boolean;
  /**
   * Set its approval rules (#209): org admins on an org toolkit, the built-in ones included, and a member on their own
   * private toolkit.
   */
  readonly approvals: boolean;
}

/**
 * What a caller may do with a toolkit: org admins manage org toolkits, a member their own private toolkits (the list
 * holds no one else's); a built-in toolkit takes only its tools' overrides, its approval rules and its prices per hour
 * (and settings outside this page). A member
 * lists an org toolkit's tools again only while it has no shared credential, so the listing uses their own.
 */
export const controlsFor = (toolkit: ToolkitView, caller: ToolsCaller): ToolkitControls => {
  const builtIn = toolkit.built_in === true;
  const manage = toolkit.private || caller.admin;
  const privateAllowed = toolkit.private ? caller.privateToolkits : caller.privateCredentials;
  const sharedInUse = acceptsSlot(toolkit, "shared") && toolkit.credentials.shared !== undefined;

  return {
    manage,
    shared: !builtIn && caller.admin && acceptsSlot(toolkit, "shared"),
    private: !builtIn && privateAllowed && acceptsSlot(toolkit, "private"),
    refresh: !builtIn && (manage || !sharedInUse),
    remove: !builtIn && manage,
    prices: caller.admin && !toolkit.private,
    approvals: manage,
  };
};

/** Why the caller cannot connect a private credential to a toolkit, when they cannot. */
export const noPrivateCredentialText = (toolkit: ToolkitView, caller: ToolsCaller): string => {
  if (toolkit.built_in === true)
    return "Commissary provides this toolkit itself: it takes no credential.";

  if (toolkit.private)
    return "This org does not let members use private toolkits now: an org admin can turn them back on.";

  if (toolkit.accepts === "shared")
    return "It signs in with the org's shared credential only, which an org admin connects; you use it under your tool grants.";

  return caller.privateCredentials
    ? "It takes no private credential of yours."
    : "This org does not let members connect private credentials now: ask an org admin to connect the shared one, or to turn private credentials on.";
};

/** The connect page a call without the caller's private credential links to: its form, or why there is none. */
export type ConnectPage =
  | { readonly kind: "form" }
  | { readonly kind: "refused"; readonly reason: string };

export const connectPageOf = (toolkit: ToolkitView, caller: ToolsCaller): ConnectPage =>
  controlsFor(toolkit, caller).private
    ? { kind: "form" }
    : { kind: "refused", reason: noPrivateCredentialText(toolkit, caller) };

/** What the connect page says once the credential is connected: the call is the client's to make again. */
export const RETRY_TEXT = "Now go back to your client or agent and make the call again.";

const PROBLEMS = new Map<string, string>([
  ["name_taken", "Another toolkit has that name: pick another."],
  [
    "conflict",
    "Someone changed this toolkit meanwhile. The page shows it as it is now: try again.",
  ],
  ["not_accepted", "The toolkit does not accept that credential."],
  [
    "private_credentials_unavailable",
    "This org does not let members connect their own credentials to org toolkits.",
  ],
  [
    "private_toolkits_unavailable",
    "This org does not let members add private toolkits, or use the ones they have.",
  ],
  ["built_in", "Commissary provides this toolkit itself: it cannot be changed that way."],
  ["forbidden", "Only an org admin can do that."],
  ["body_too_large", "The document is larger than Commissary reads."],
  [
    "lookup_failed",
    "integrations.sh could not be asked just now. Try again, or add the URL as it is.",
  ],
  ["not_found", "That toolkit is gone, or is not one you can use."],
]);

/**
 * What a refused toolkit call tells the person: the panel's words for the errors it knows (with the server's reason
 * where it gives one that matters), else the server's own reason, else its error.
 */
export const toolkitProblem = (
  error: string | undefined,
  message: string,
  detail: string | undefined,
): string => {
  if (error === "lookup_rate_limited")
    return asSentence(`Too many lookups for now${detail === undefined ? "" : `: ${detail}`}`);

  const known = error === undefined ? undefined : PROBLEMS.get(error);

  if (known !== undefined) return known;

  return detail === undefined ? message : asSentence(detail);
};

/** What a refused call tells the person ({@link toolkitProblem}); nothing when it worked. */
export const problemOf = <A>(outcome: Outcome<A>): string | undefined =>
  outcome.ok ? undefined : toolkitProblem(outcome.error, outcome.message, outcome.detail);
