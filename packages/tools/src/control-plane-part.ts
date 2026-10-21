import { RpcTarget } from "cloudflare:workers";
import { Clock, type Duration, Effect, Result, type Schema } from "effect";
import {
  type Access,
  accessTo,
  isFullAccess,
  runOfPrincipal,
  runPrincipalId,
  type Scope,
  type UsageRun,
  type Viewer,
} from "@commissary/auth";
import type {
  ApprovalDecision,
  ApprovalsList,
  ApprovalView,
  Approver,
  ApproverView,
} from "@commissary/contract/approvals";
import { agentsInScope, type ToolScope } from "@commissary/contract/api-keys";
import type {
  BrowserProfileGrants,
  BrowserProfilesList,
  BrowserProfileView,
  CreateBrowserProfile,
  LimitedBrowserProfileView,
  RemovedBrowserProfile,
  UpdateBrowserProfile,
} from "@commissary/contract/browser-profiles";
import type {
  BrowserLiveView,
  BrowserSessionsList,
  BrowserSessionView,
  EndedBrowserSession,
} from "@commissary/contract/browser-sessions";
import {
  type EndedSandboxSession,
  SANDBOX_SESSIONS_LISTED,
  type SandboxSessionsList,
  type SandboxSessionView,
} from "@commissary/contract/sandbox-sessions";
import type { GrantSubject, ToolGrant, ToolGrants } from "@commissary/contract/grants";
import type {
  CatalogCredential,
  ConnectCredential,
  ConnectedGrant,
  CredentialSettings,
  ConnectedToolkitView,
  CredentialSlot,
  CredentialsAccepted,
  LimitedToolkitView,
  OAuthAppView,
  SetOAuthApp,
  SignInStarted,
  SignInStatus,
  StartSignIn,
  ToolClass,
  RemovedToolOverride,
  SandboxNetwork,
  SetToolOverride,
  ToolkitCatalogLink,
  ToolkitCredentialView,
  ToolkitDocument,
  ToolkitKind,
  ToolkitSecret,
  ToolkitsList,
  ToolkitView,
  ToolsList,
  ToolView,
  UpdateToolkit,
  UsableGrant,
  UsableTool,
  UsableTools,
} from "@commissary/contract/tools";
import {
  type RunToolTicket,
  SANDBOX_MAX_TIMEOUT_MS,
  type SandboxEnvReply,
  type SandboxEnvRequest,
} from "@commissary/contract/sandbox-env";
import type { ToolCallApproval } from "@commissary/contract/usage";
import type { RunWaitState } from "@commissary/contract/run-waits";
import {
  CurrentOutboundPolicy,
  OutboundHttpClientLive,
  type OutboundPolicy,
  outboundPolicy,
} from "@commissary/core";
import type { HttpClient } from "effect/http";
import { planLimitName, type PlanMeter, type PlanRefusal } from "@commissary/billing/api";
import type { ControlPlanePart, OrgCore } from "@commissary/state";
import type {
  ChargedCredential,
  Refusal,
  SpendAgent,
  SpendCaller,
  SpendCredential,
} from "@commissary/state/spend";
import { argumentsHash, canonicalJson } from "./approvals/hash.ts";
import {
  approvalRulesView,
  approverFor,
  approversOf,
  cleanApprovalRules,
  mayDecide,
  noRules,
  rulesWithoutMember,
  type StoredApprovalRules,
  withoutMember,
} from "./approvals/rules.ts";
import { type ApprovalKey, ApprovalStore, type StoredApproval } from "./approvals/store.ts";
import {
  freshProfileId,
  PROFILE_TABLES,
  type ProfileGrantChange,
  ProfileStore,
  type StoredProfile,
} from "./browser/profiles.ts";
import type { StorageState } from "./browser/provider.ts";
import {
  connectGrant,
  type ToolGrantChange,
  type ToolGrantEntry,
  type ToolGrantValue,
} from "./grants/grant.ts";
import { type GrantableTool, grantedTools, grantGives, inToolScope } from "./grants/reach.ts";
import { cleanToolGrant, ToolGrantStore } from "./grants/store.ts";
import { namesHolder, trimmedSubject } from "./grants/subject.ts";
import { LISTING_TIMEOUT } from "./mcp/client.ts";
import {
  authorizationUrl,
  exchangeCode,
  mintClientCredentials,
  prepareSignIn,
  refreshTokens,
} from "./oauth/flows.ts";
import type { OAuthError } from "./oauth/http.ts";
import { newPkce, newSignInState } from "./oauth/pkce.ts";
import type { ClientUrls } from "./oauth/urls.ts";
import {
  authorizeUrl as oauth1AuthorizeUrl,
  requestTemporaryCredentials,
  requestTokenCredentials,
} from "./oauth/oauth1.ts";
import {
  type ClientVia,
  type OAuth1SignInFlow,
  type OAuth2SignInFlow,
  type OAuthApp,
  OAuthStore,
} from "./oauth/store.ts";
import type { OAuth1Keys } from "./signing/oauth1.ts";
import { CATALOG_AUTHOR, type CatalogToolOverride } from "./catalog/additions.ts";
import type { JsonPatchOperation } from "./openapi/patch.ts";
import {
  DETECTS_PER_WINDOW,
  DISCOVERS_PER_WINDOW,
  type LookupTaken,
  LookupThrottle,
} from "./catalog/lookup-throttle.ts";
import { type ManagedApps, NO_MANAGED_APPS } from "./catalog/managed-apps.ts";
import { refusedForGood } from "./oauth/token.ts";
import { MAX_SDL_BYTES, SchemaCache } from "./graphql/schema.ts";
import {
  KIND_DRIVERS,
  type KindDriver,
  KindFailure,
  type Listing,
  type ListInput,
} from "./toolkits/kinds.ts";
import {
  defaultToolkitName,
  isToolkitName,
  isToolName,
  fullToolName,
  MAX_FULL_NAME,
} from "./toolkits/names.ts";
import {
  isServed,
  type Resolution,
  type ResolvedTool,
  resolveTools,
  stableId,
} from "./toolkits/resolve.ts";
import {
  freshToolkitId,
  type StoredTool,
  type ToolkitCredential,
  ToolkitStore,
  TOOLS_TABLES,
} from "./toolkits/store.ts";
import {
  HOUR_PRICES,
  type HourPriceField,
  type HourPricedKind,
  hourPriceRefusal,
  isHourPriced,
  priceRefusal,
} from "./toolkits/price.ts";
import {
  isMinted,
  isMintedKind,
  type MintedSecret,
  type OAuthSecret,
  secretRefusal,
  type StoredSecret,
  type UpstreamSecret,
} from "./toolkits/secret.ts";
import {
  credentialRefusal,
  keyRefusal,
  mintedWith,
  oauth1Signing,
  settingsRefusal,
  upstreamOf,
} from "./toolkits/credential-settings.ts";
import { exchangeToken, type Minted, mintGitHubApp, mintJwt } from "./signing/tokens.ts";
import {
  type BuiltIn,
  type CalledBuiltIn,
  type BuiltInCall,
  type BuiltInProviders,
  browserTimeOf,
  builtInToolkits,
  type CallerProfiles,
  COMMISSARY,
} from "./toolkits/built-in.ts";
import type { BrowserSessions } from "./browser/session-object.ts";
import type { BuiltInToolkit, StoredToolkit, Toolkit } from "./toolkits/toolkit.ts";
import {
  type AgentDirectory,
  isAgentsToolkit,
  runnableAgents,
  startDescription,
} from "./agents/toolkit.ts";
import { type RunWatchers, watchersOfPrincipal } from "./agents/run-watchers.ts";
import { NO_ALLOWANCE, networkProblem, normalizedNetwork } from "./sandbox/network.ts";
import { agentSandboxFits, type AgentSandboxSettings } from "./sandbox/agent-sandbox.ts";
import {
  type ComputerMeter,
  type Metered,
  type SandboxProvider,
  SESSION_IDLE_MS,
} from "./sandbox/provider.ts";
import {
  computerStoppedNote,
  meetsComputer,
  NO_COMPUTER_HOURS_HINT,
  noted,
  unknownSessionResult,
} from "./sandbox/toolkit.ts";
import { SandboxSessionStore, type TrackedSession } from "./sandbox/sessions.ts";
import {
  argumentBytes,
  gatedTool,
  type RunCallTicket,
  RunCallTickets,
  TICKET_IDLE_MS,
  ticketAllows,
} from "./sandbox/run-calls.ts";
import { sandboxOperation } from "./sandbox/run-operations.ts";
import { BrowserCrawlStore } from "./browser/crawls.ts";
import {
  apiKeyOf,
  BrowserSessionStore,
  type LoggedBrowserSession,
  openerOf,
} from "./browser/session-log.ts";
import { CLOSE_TOOL, OPEN_TOOL } from "./browser/session-tools.ts";
import type { BrowserCrawlProvider } from "./browser/provider.ts";

/** How many sessions the panel's list asks the provider about at once (#225). */
const SANDBOX_STATUS_CONCURRENCY = 8;

/** Why a call of the part was refused; the routes answer each with its status. */
export type ToolsErrorCode =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "name_taken"
  | "not_accepted"
  | "private_credentials_unavailable"
  | "private_toolkits_unavailable"
  | "no_credential"
  | "tool_list_failed"
  | "body_too_large"
  | "built_in"
  | "outbound_refused"
  | "sign_in_failed"
  /** The browser provider could not do what the panel asked of a browser session (#216: mint its Live View). */
  | "browser_failed"
  /** The sandbox provider could not do what the panel asked of a sandbox session (#225: end it). */
  | "sandbox_failed";

export type ToolsResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly error: ToolsErrorCode;
      readonly message: string;
      /** The field an `outbound_refused` URL or a `body_too_large` document came in. */
      readonly path?: string;
    };

const refuse = (error: ToolsErrorCode, message: string, path?: string) =>
  ({ ok: false, error, message, ...(path === undefined ? {} : { path }) }) as const;

/** A refused {@link ToolsResult}. */
type ToolsRefusal = Extract<ToolsResult<never>, { readonly ok: false }>;

/** A failed sign-in step as the part answers it: the guard's refusal with its field, or why the server failed it. */
const signInRefusal = (error: OAuthError): ToolsResult<never> =>
  error.reason === "refused"
    ? { ok: false, error: "outbound_refused", message: error.message, path: error.field ?? "" }
    : refuse("sign_in_failed", error.message);

/** A token that expires within this long gets a token refresh before it is used. */
const EXPIRY_MARGIN_MS = 60_000;

/** How long after a token refresh that may pass later failed (an unreachable token endpoint) the alarm tries again. */
const REFRESH_RETRY_MS = 5 * 60_000;

/** A token refresh still due after the alarm ran (one in flight elsewhere) is looked at again this much later. */
const REFRESH_RECHECK_MS = 30_000;

/** The alarm's token refreshes at once. */
const REFRESH_CONCURRENCY = 4;

/** Browser crawls cancelled at once when a member leaves or the org is deleted (#270). */
const CRAWL_CANCEL_CONCURRENCY = 4;

/**
 * What signs a request on a credential in: its secret (an OAuth credential's current access token as a bearer), or
 * why there is none: it needs sign-in again (`sign_in`), or a token refresh failed in a way that may pass (`failed`).
 */
type Signed =
  | { readonly kind: "signed"; readonly secret: UpstreamSecret }
  | { readonly kind: "sign_in" }
  | { readonly kind: "failed"; readonly message: string };

/** What a request on a credential came to: its upstream's answer, or why it was not made ({@link Signed}). */
type Attempt<A> =
  | { readonly kind: "done"; readonly done: Result.Result<A, KindFailure> }
  | Exclude<Signed, { readonly kind: "signed" }>;

const NEEDS_SIGN_IN: Signed = { kind: "sign_in" };

const bearer = (token: string): Signed => ({ kind: "signed", secret: { kind: "bearer", token } });

/** Whether a token that expires at `expiresAt` (undefined: not said) is still good to use at `now`. */
const fresh = (expiresAt: number | undefined, now: number): boolean =>
  expiresAt === undefined || expiresAt > now + EXPIRY_MARGIN_MS;

/** Whether a credential of `kind` has tokens Commissary refreshes. */
const refreshable = (kind: StoredSecret["kind"]): boolean => kind === "oauth" || isMintedKind(kind);

/** The credential settings `toolkit`'s credentials use: a built-in toolkit's, none. */
const settingsOf = (toolkit: Toolkit): CredentialSettings | undefined =>
  toolkit.builtIn ? undefined : toolkit.credentialSettings;

/** `toolkit`'s `credential_settings` field of a view or an export: none for a toolkit without settings. */
const settingsField = (toolkit: Toolkit) => {
  const settings = settingsOf(toolkit);

  return settings === undefined ? {} : { credential_settings: settings };
};

/** Why a token refresh failed, as its log says it: never a token. */
interface RefreshFailure {
  readonly reason: string;
  readonly status?: number | undefined;
  /** The token endpoint's OAuth error code (a plain code: `token.ts` reads no other). */
  readonly code?: string | undefined;
}

/** Logs a failed token refresh of `credential`: its toolkit, its slot and why, never a token. */
const refreshFailed = (credential: ToolkitCredential, failure: RefreshFailure) =>
  Effect.logWarning("toolkit token refresh failed").pipe(
    Effect.annotateLogs({
      toolkit: credential.toolkitId,
      slot: credential.owner === undefined ? "shared" : "private",
      reason: failure.reason,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.code === undefined ? {} : { code: failure.code }),
    }),
  );

/**
 * Whether the upstream refused the token itself (`401`), which a refreshed one may pass: a failure that says so, or an
 * answer `refusedAnswer` says is one.
 */
const tokenRefused = <A>(
  done: Result.Result<A, KindFailure>,
  refusedAnswer: (answer: A) => boolean,
): boolean =>
  Result.isSuccess(done) ? refusedAnswer(done.success) : done.failure.unauthorized === true;

/** Why a request on a credential was not made, as a driver's failure. */
const notSigned = (attempt: Exclude<Signed, { readonly kind: "signed" }>): KindFailure =>
  new KindFailure({
    message:
      attempt.kind === "failed" ? attempt.message : "the toolkit's credential needs sign-in again",
  });

/** What a sign-in's callback came to: `rejected`, a state that is unknown, used, expired or another org's. */
export type SignInCallbackOutcome =
  | { readonly outcome: "rejected" }
  | { readonly outcome: "completed" }
  | { readonly outcome: "failed" };

/**
 * A sign-in's callback as the public route hands it over (RFC 6749 §4.1.2, RFC 9207 `iss`), with the member the app
 * Worker's gate signed the request in as.
 */
export interface SignInCallback {
  readonly state: string;
  readonly code: string;
  readonly error: string;
  readonly iss: string | undefined;
  readonly member: string;
  /** An OAuth 1.0a sign-in's (#206): the temporary token the browser authorized, and the verifier. */
  readonly oauthToken?: string | undefined;
  readonly oauthVerifier?: string | undefined;
}

const ok = <A>(value: A): ToolsResult<A> => ({ ok: true, value });

const NOT_FOUND = refuse("not_found", "toolkit not found");

const BUILT_IN = refuse(
  "built_in",
  "the toolkit is Commissary's own: it cannot be renamed, edited (but for its approval rules, the sandbox's network and computer, and its price per browser or computer hour), given a credential, refreshed or removed",
);

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The prices per hour `change` sets (#214, #224), each with its field and the kind of toolkit it belongs to: `null`
 * clears one.
 */
const hourPricesOf = (
  change: UpdateToolkit,
): ReadonlyArray<{
  readonly kind: HourPricedKind;
  readonly field: HourPriceField;
  readonly price: number | null;
}> =>
  Object.entries(HOUR_PRICES).flatMap(([kind, { field }]) => {
    const price = change[field];

    return price === undefined || !isHourPriced(kind) ? [] : [{ kind, field, price }];
  });

/** A built-in toolkit's price per hour (#214, #224) as its view and the export show it, under its kind's field. */
const hourPriceView = (toolkit: Toolkit): Partial<Record<HourPriceField, number>> =>
  toolkit.builtIn && toolkit.hourPriceMicros !== undefined && isHourPriced(toolkit.kind)
    ? { [HOUR_PRICES[toolkit.kind].field]: toolkit.hourPriceMicros }
    : {};

/** What a call holds of the plan's ceilings while it is served (#241): see {@link ToolsPart.#planRefusal}. */
interface Held {
  /** The call is a `browser_open` whose room under the ceiling on concurrent browser sessions is held. */
  open: boolean;
  /** The sandbox session whose computer the call may start, its room under the ceiling on computers held. */
  computer: string | undefined;
}

/** Why the plan refuses a call, and whether the browser session it names is closed with it. */
interface PlanFound {
  readonly refusal: PlanRefusal;
  readonly session: boolean;
}

/**
 * Whether a call of the tool `name` ends a use of the plan's units rather than starting one: closing a browser session
 * (a tool that `ends` browser time) or a sandbox session. The plan never refuses it, however the month stands: a
 * refusal would only keep the use, and its time counting, going (#241).
 */
const endsUse = (builtIn: BuiltIn | undefined, name: string): boolean =>
  (builtIn?.toolkit.kind === "browser" && browserTimeOf(name) === "ends") ||
  (builtIn?.toolkit.kind === "sandbox" && name === "close");

/** How a built-in tool is called for a call, and whether the call opened a sandbox session (`#builtInCall`). */
interface BuiltInCalling {
  readonly call: BuiltInCall;
  /** Whether the call opened a sandbox session or started a crawl, which the part's alarm forgets later. */
  readonly opened: () => boolean;
}

/** Builds the cron task runs at once in one org. */
const CRON_CONCURRENCY = 4;

/** How long the cron task gives one build: less than an interactive refresh ({@link LISTING_TIMEOUT}). */
const CRON_BUILD_TIMEOUT: Duration.Input = "20 seconds";

/**
 * A source as a member who only reads the toolkit sees it: the values of its query parameters masked, their names kept,
 * and a parameter without a value (`?<key>`) masked whole, as its name may be the key. The host and the path are shown
 * as they are: a key belongs in a credential (a `query` one for the query), but a source may still carry one.
 */
const maskedSource = (source: string): string => {
  let url: URL;

  try {
    url = new URL(source);
  } catch {
    return source;
  }

  if (url.search === "") return source;

  url.search = url.search
    .slice(1)
    .split("&")
    .map((parameter) => {
      const equals = parameter.indexOf("=");

      return equals <= 0 || equals === parameter.length - 1
        ? "***"
        : `${parameter.slice(0, equals)}=***`;
    })
    .join("&");

  return url.toString();
};

/** A new toolkit as the routes hand it over. */
export interface AddToolkitInput {
  /** Default `mcp`. */
  readonly kind?: StoredToolkit["kind"] | undefined;
  /** The source, already checked by the outbound guard; empty for an uploaded OpenAPI or Discovery document. */
  readonly source: string;
  /** An OpenAPI or Discovery toolkit's uploaded document, or a GraphQL toolkit's uploaded schema (SDL). */
  readonly document?: string | undefined;
  /** An OpenAPI toolkit's base URL, already checked by the outbound guard. */
  readonly baseUrl?: string | undefined;
  /** Undefined: an OpenAPI toolkit's default, from its document ({@link openApiName}). */
  readonly name: string | undefined;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  /** Connected at once; an org toolkit's shared credential names who may use it (`subject`). */
  readonly credential?: ConnectCredential | undefined;
  /** The settings of its credential types (#206), their URLs already checked by the outbound guard. */
  readonly credentialSettings?: CredentialSettings | undefined;
  /** The toolkit catalog's service and source it is added from (#207). */
  readonly catalog?: ToolkitCatalogLink | undefined;
  /** The catalog additions' overrides of its tools (#207), by upstream name: stored with it, by `catalog`. */
  readonly toolOverrides?: Readonly<Record<string, CatalogToolOverride>> | undefined;
  /** The catalog's fixes to an OpenAPI toolkit's document (#207), applied each time its list is built. */
  readonly specPatch?: ReadonlyArray<JsonPatchOperation> | undefined;
}

/** What the cron task's refresh did. */
export interface RefreshSummary {
  readonly built: number;
  readonly failed: number;
  /** Toolkits with no credential the task may use (an org toolkit with private credentials only). */
  readonly skipped: number;
}

/** What the export holds of a toolkit: no secrets. */
export interface ToolkitExport {
  readonly name: string;
  readonly kind: ToolkitKind;
  /** Empty for an uploaded OpenAPI or Discovery document, which the export does not hold (`uploaded`). */
  readonly source: string;
  readonly base_url?: string;
  /**
   * An OpenAPI or Discovery toolkit built from an uploaded document, or a GraphQL toolkit from an uploaded schema: its
   * managers download it on its own route.
   */
  readonly uploaded?: true;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  /** Micro-USD per call of an org toolkit's tools (#199). */
  readonly price_micros?: number;
  /** The settings of its credential types (#206): nothing secret. */
  readonly credential_settings?: CredentialSettings;
  readonly credentials: ReadonlyArray<{
    readonly slot: CredentialSlot;
    readonly kind: ToolkitCredential["kind"];
    readonly name?: string;
  }>;
  readonly overrides: ReadonlyArray<{
    readonly tool: string;
    readonly hidden: boolean;
    readonly name?: string;
    readonly description?: string;
    readonly class?: "read" | "write";
    readonly price_micros?: number;
    /** A tool its source hides by default (a deprecated OpenAPI operation or GraphQL field), shown. */
    readonly shown?: true;
  }>;
  /** An org toolkit's tool grants, in an org admin's export only. */
  readonly grants?: ReadonlyArray<ExportedToolGrant>;
  /** The sandbox toolkit's network ceiling (#222). */
  readonly network?: SandboxNetwork;
  /** Whether the sandbox toolkit allows the computer (#223). */
  readonly computer?: boolean;
  /** The browser toolkit's price per browser hour, in micro-USD (#214). */
  readonly browser_hour_price_micros?: number;
  /** The sandbox toolkit's price per computer hour, in micro-USD (#224). */
  readonly computer_hour_price_micros?: number;
  /** Its approval rules (#201): marked tools by upstream name, approvers by what a person reads. */
  readonly approval_rules?: {
    readonly writes?: { readonly approver: ExportedApprover };
    readonly tools?: ReadonlyArray<{ readonly tool: string; readonly approver: ExportedApprover }>;
  };
}

/** An approver as the export holds it: a team by its name, members by their emails. */
export type ExportedApprover =
  | { readonly kind: "caller" }
  | { readonly kind: "team"; readonly name: string }
  | { readonly kind: "members"; readonly emails: ReadonlyArray<string> };

/** A tool grant as the export holds it: its subject by what a person reads, and its tools by upstream name. */
export interface ExportedToolGrant {
  readonly subject:
    | { readonly kind: "everyone" }
    | { readonly kind: "member"; readonly email: string }
    | { readonly kind: "team"; readonly name: string };
  readonly tools:
    | { readonly kind: "all" | "read" }
    | { readonly kind: "named"; readonly tools: ReadonlyArray<string> };
  readonly updated_at: string;
}

/** A tool as Commissary's MCP endpoint lists it (#197): its full name, its toolkit's name, and what the client sees. */
export interface ClientTool {
  readonly name: string;
  /** The toolkit's name, which `?toolkits=` narrows by. */
  readonly toolkit: string;
  readonly description?: string;
  /** The upstream input schema. */
  readonly inputSchema?: Schema.JsonObject;
  readonly toolClass: ToolClass;
}

/**
 * A hosted agent's run calling the MCP endpoint (#227, ADR 0040): its definition's tool scope, which narrows what it
 * reaches as an API key's does, and whether it acts as the shared agent itself (`asAgent`), whose reach is its
 * definition: every org toolkit with a shared credential, whatever the tool grants. A private agent's run acts as its
 * member (the viewer), with their reach. Its starter (`starterMember`) is the caller of its approvals (ADR 0040): under
 * a rule of the caller they decide, and under the others they do not. A run no one started (a shared agent's schedule
 * or webhook, #231) has none: its agent's watchers are its caller (#232, {@link RunWatchers}), any of whom decides
 * under a rule of the caller.
 */
export interface RunToolReach {
  readonly toolScope: ToolScope;
  readonly asAgent: boolean;
  readonly starterMember?: string | undefined;
  /** The run's agent (#229), which the agents toolkit does not offer it. */
  readonly agentId?: string | undefined;
  /**
   * The run as its usage records name it (#228): a shared agent's run counts toward the agent's own Spend limits, and
   * the browser sessions it opens write records naming it. Absent from an API Worker from before #228, whose shared
   * agents' runs count toward the org's limits only.
   */
  readonly usage?: UsageRun | undefined;
}

/** A call of Commissary's MCP endpoint (#197): the tool's full name, its arguments, and the toolkits it narrows to. */
export interface ToolCall {
  readonly name: string;
  readonly arguments?: Schema.JsonObject | undefined;
  /** The toolkits `?toolkits=` names; undefined: every toolkit. */
  readonly toolkits?: ReadonlyArray<string> | undefined;
  /**
   * The API key the call came with: its tool scope narrows what the call reaches (#200), and a priced call counts
   * toward its Spend limits (#199).
   */
  readonly apiKeyId?: string | undefined;
  /** An agent run's reach (#227): its definition's tool scope in place of a key's. */
  readonly run?: RunToolReach | undefined;
  /** The caller's principal, which names a caller without a member in a pending approval (#201). */
  readonly principalId?: string | undefined;
  /**
   * Present when the client shows the caller an approve-or-deny form (MCP form-mode elicitation, #201), with the
   * caller's answer to it when this is the call made again after the form: `accept` approves, anything else denies.
   * An answer counts only with the `requestState` the form was sent with (`approve`), for this very call; without it
   * the caller is asked again.
   */
  readonly approvalForm?:
    | {
        readonly answer?: FormAction | undefined;
        readonly requestState?: string | undefined;
      }
    | undefined;
  /**
   * Set by an MCP endpoint that understands the approval outcomes (`approve`, `pending`, `not_approved`, #201). An
   * API Worker deployed before them sends a call without it, and gets those outcomes as `failed` (docs/DEVELOPMENT.md,
   * "State RPC: expand, then contract"); it sends no `approvalForm`, so it is never asked to show one.
   */
  readonly approvalOutcomes?: true | undefined;
  /**
   * Set by an MCP endpoint that reaches the person a browser session's handoff asks for (#216): it gets a call that
   * started one as `handoff`, and asks them (a URL elicitation) or gives the link to the session's page. An API Worker
   * deployed before it sends none, and gets such a call as a `result` that says so in words, without the link
   * (docs/DEVELOPMENT.md, "State RPC: expand, then contract").
   */
  readonly handoffOutcomes?: true | undefined;
  /**
   * How the caller answered the elicitation that asked them to act in a browser session (#216), when the call is made
   * again with their answer: `accept` waits on the handoff, anything else declines it.
   */
  readonly handoffAnswer?: FormAction | undefined;
  /**
   * Set by an MCP endpoint whose Worker makes the agents toolkit's calls (#229, `AgentsToolkitPort`): only such a call
   * reaches its tools, and gets them as `delegated`. An API Worker deployed before the agents toolkit sends none, and
   * reaches none of its tools (docs/DEVELOPMENT.md, "State RPC: expand, then contract").
   */
  readonly agentsToolkit?: true | undefined;
  /**
   * An agent run's call that asks for a ticket rather than the call (#230, `RUN_EXECUTES_META`): a call of the sandbox
   * toolkit's `bash`, `read`, `write` or `edit` that went through every gate answers `gated`, and the run executes it
   * on its session itself ({@link ToolsPart.runSandboxOperation}). Only a run's call (`run`) is gated so.
   */
  readonly executes?: true | undefined;
  /**
   * An agent run's `sandbox_open` of its own session (#230, `RUN_SESSION_META`): that session lasts as long as the run.
   * Only a run's call is honoured so.
   */
  readonly runSession?: true | undefined;
  /**
   * Set by an MCP endpoint that understands `plan_limited` (#241). An API Worker deployed before it sends a call
   * without it, and gets a call a plan limit refuses as `failed` (docs/DEVELOPMENT.md, "State RPC: expand, then
   * contract").
   */
  readonly planOutcomes?: true | undefined;
}

/** What a caller of {@link ToolsPart.clientTools} serves beyond the part's own toolkits. */
export interface ClientToolsOptions {
  /** The endpoint's Worker makes the agents toolkit's calls ({@link ToolCall.agentsToolkit}): list its tools. */
  readonly agentsToolkit?: true | undefined;
}

/**
 * Who `viewer`'s `call` is for, as the Spend limits see it: its member and API key, or a shared agent whose run makes it
 * (#228), which counts toward the agent's own limits and has neither. A run has no API key, so no key limit applies.
 */
const spenderOf = (viewer: Viewer, call: ToolCall): SpendCaller => ({
  memberId: viewer.member,
  apiKeyId: call.apiKeyId,
  agentId: call.run?.asAgent === true ? call.run.usage?.agentId : undefined,
});

/** How a client's caller answered an elicitation form (MCP `ElicitResult.action`). */
export type FormAction = "accept" | "decline" | "cancel";

/**
 * Why a call an approval rule held was not made (#201): `denied` on its form or its approval page, or `no_approver`, a
 * caller without a member under a rule whose approver is the caller, from a client that shows no forms.
 */
export type NotApprovedReason = "denied" | "no_approver";

/**
 * What a call's usage record says of it (#199), beyond who called and how it went: never its arguments or its result.
 */
export interface CallUsage {
  readonly toolkitId: string;
  /** The tool's stable id, `<toolkit id>:<upstream name>`. */
  readonly toolId: string;
  /** Which of the toolkit's credentials served it; undefined when none could. */
  readonly credential: CredentialSlot | undefined;
  /** On a private credential, or of a private toolkit's tool: its member's alone. */
  readonly private: boolean;
  /**
   * Micro-USD charged: the tool's price on a result, with a Quick Action's browser time at the price per browser hour
   * (#214); 0 when free, refused or failed upstream. A browser session's time is its own record's.
   */
  readonly costMicros: number;
  /** How an approval rule decided the call (#201); `none` when no rule made it wait. */
  readonly approval: ToolCallApproval;
  /** The browser time the call used, in ms, when it used any the provider reported: a Quick Action's (#214). */
  readonly browserMs?: number;
}

/**
 * What a call came to: `unknown`, a tool the member does not reach (answered as a tool that does not exist);
 * `connect`, a tool that needs a private credential the member has not connected; `refused`, a priced call that a
 * Spend limit without room keeps from the upstream (#199); under an approval rule (#201), `approve`, a call its caller
 * approves on a form first (the client makes it again with their answer), `pending`, a call that waits for its
 * approver in the panel, or `not_approved`, one that was denied (or that no one could approve); the upstream's
 * `result`, an `isError` one included; or `failed`, an upstream or transport failure, with a short message that
 * quotes neither the source nor the server's answer; or, for the agents toolkit, `delegated`: a call the endpoint's
 * Worker makes (#229); or `plan_limited`, a call Commissary Cloud's plan refused before any work (#241). All but
 * `unknown` and `approve` say what the call's usage record holds (a call on a form writes
 * its record once it ends). The approval outcomes go only to a call that says it understands them
 * (`ToolCall.approvalOutcomes`), `delegated` only to one that serves the agents toolkit (`ToolCall.agentsToolkit`) and
 * `plan_limited` only to one that says it understands it (`ToolCall.planOutcomes`).
 */
export type ToolCallOutcome =
  | { readonly outcome: "unknown" }
  | {
      readonly outcome: "approve";
      readonly toolkit: { readonly id: string; readonly name: string };
      readonly arguments: Schema.JsonObject;
      /** What the client sends back with the answer, so it counts for this call only (MRTR `requestState`). */
      readonly requestState: string;
    }
  | {
      readonly outcome: "pending";
      readonly approval: {
        readonly id: string;
        readonly approver: Approver;
        /** Epoch ms. */
        readonly expiresAt: number;
      };
      readonly usage: CallUsage;
    }
  | {
      readonly outcome: "not_approved";
      readonly reason: NotApprovedReason;
      readonly usage: CallUsage;
    }
  | {
      readonly outcome: "connect";
      readonly toolkit: { readonly id: string; readonly name: string };
      /**
       * `missing`: the member has not connected their private credential; `sign_in`: the credential the call would use
       * needs sign-in again (#202), the member's own (`private`) or the shared one, which an org admin signs in to.
       */
      readonly reason: "missing" | "sign_in";
      readonly slot: CredentialSlot;
      readonly usage: CallUsage;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: Refusal;
      readonly usage: CallUsage;
      /** The browser session the call named was closed with it, as its browser time costs money (#214). */
      readonly sessionClosed?: true;
      /**
       * What the refusal did to the sandbox session the call named, as its computer time costs money (#224): its running
       * computer was `stopped`, or the call `needed` the computer (its command would have run there); with `needed`,
       * `computerStopped` when the call stopped the computer, which ran, first.
       */
      readonly computer?: "stopped" | "needed";
      readonly computerStopped?: true;
    }
  | {
      /**
       * Commissary Cloud's plan refused the call before any work (#241): a plan limit (the month's free usage of a unit
       * used up, or the billing cap), or a ceiling on concurrent browser sessions or computers. Not counted. Only to a
       * call with {@link ToolCall.planOutcomes}; the endpoint's Worker words it (`planRefusalText`).
       */
      readonly outcome: "plan_limited";
      readonly refusal: PlanRefusal;
      readonly usage: CallUsage;
      /** The browser session the call named was closed with it, as its browser time is over the plan's limit. */
      readonly sessionClosed?: true;
      /** What it did to the sandbox session the call named, as for a refusal by a Spend limit (`refused`). */
      readonly computer?: "stopped" | "needed";
      readonly computerStopped?: true;
    }
  | { readonly outcome: "result"; readonly result: Schema.JsonObject; readonly usage: CallUsage }
  | {
      /**
       * `browser_ask_human` started a handoff in the browser session `sessionId` (#216), which waits for its person
       * until `until` (epoch ms): the endpoint reaches them. Only to a call with {@link ToolCall.handoffOutcomes}.
       */
      readonly outcome: "handoff";
      readonly sessionId: string;
      /** What the person is asked, as the call said it. */
      readonly reason: string;
      readonly until: number;
      readonly usage: CallUsage;
    }
  | { readonly outcome: "failed"; readonly message: string; readonly usage: CallUsage }
  | {
      /**
       * A call of the agents toolkit (#229) that went through reach, tool scope, Spend and approval: the endpoint's
       * Worker makes it (`AgentsToolkitPort`), with the agents the caller's tool scope names (`undefined`: every agent
       * within reach). Only to a call with {@link ToolCall.agentsToolkit}.
       */
      readonly outcome: "delegated";
      readonly tool: string;
      readonly arguments: Schema.JsonObject;
      readonly scopeAgents?: ReadonlyArray<string> | undefined;
      readonly usage: CallUsage;
    }
  | {
      /**
       * A run's sandbox call that went through every gate and was charged its price (#230, {@link ToolCall.executes}):
       * the run executes it with this ticket, and settling the ticket writes its usage record
       * ({@link ToolsPart.settleRunSandboxCall}), not the endpoint.
       */
      readonly outcome: "gated";
      readonly ticket: RunToolTicket;
      readonly usage: CallUsage;
    };

/** What an API key's view says of its tools (#200): how many it may use now, and what its scope names that is gone. */
export interface KeyToolSummary {
  readonly toolCount: number;
  readonly missing: ReadonlyArray<string>;
}

/** The tool scope a caller of the MCP endpoint is narrowed by, and whether it acts as a shared agent (#227). */
interface CallerScope {
  readonly scope: ToolScope | undefined;
  readonly asAgent: boolean;
  /** The calling run's agent (#229): the agents toolkit leaves it out, as a run cannot start its own agent. */
  readonly self?: string | undefined;
}

/**
 * Whether a management caller takes the agents toolkit (#229) in toolkit lists, tool lists and the export: the app
 * Worker's routes ask for it; a caller deployed before it (DEVELOPMENT.md, "State RPC: expand, then contract") does not,
 * and never meets the toolkit kind `agents` it could not decode.
 */
export interface KindsOptions {
  readonly agentsToolkit?: boolean | undefined;
}

/** What {@link ToolsPart.#reachable} narrows to: a caller's scope, and whether to count the agents toolkit. */
interface Reach extends Partial<CallerScope> {
  /**
   * Count the agents toolkit (#229): only for an MCP endpoint whose Worker makes its calls, and for the panel's views
   * that show no toolkit kind. Off by default, so a caller deployed before it never meets its kind.
   */
  readonly agentsToolkit?: boolean | undefined;
}

/** A tool the MCP endpoint serves a member, and how they reach it. */
interface ReachableTool {
  readonly tool: ResolvedTool;
  /** As themselves: their private toolkit, or an org toolkit that takes private credentials (no grant needed). */
  readonly asMember: boolean;
  /** Through a grant of the org toolkit's shared credential. */
  readonly granted: boolean;
}

/** A browser profile's name (#215): 1-64 of `[a-z0-9_-]`, what `browser_open` takes as it is. */
const PROFILE_NAME = /^[a-z0-9_-]{1,64}$/;

const PROFILE_NOT_FOUND = refuse("not_found", "browser profile not found");

/** Whether `scope` acts as an org admin: an admin member, or the system (full access). */
const isOrgAdmin = (scope: Scope): boolean => isFullAccess(scope) || scope.admin;

/**
 * A credential's secret, without the subject it was connected for. A key in a header or the query that names no header
 * or parameter goes where the toolkit's catalog source says (`placement`, #207); a key in the header the source names
 * gets its prefix (`Token`) unless it has it. One that names none, on a toolkit whose source does not say, is refused
 * at `path`.
 */
const secretOf = (
  credential: ConnectCredential,
  placement: CatalogCredential | undefined,
  path: string,
): ToolsResult<ToolkitSecret> => {
  const { subject: _subject, ...secret } = credential;

  if (secret.kind !== "header" && secret.kind !== "query") return ok(secret);
  const placed = placement?.kind === secret.kind ? placement : undefined;
  const name = secret.name ?? placed?.name;

  if (name === undefined)
    return refuse(
      "invalid",
      `a ${secret.kind} key names its ${secret.kind === "header" ? "header" : "query parameter"}`,
      path,
    );

  const prefix =
    secret.kind === "header" && placed?.name?.toLowerCase() === name.toLowerCase()
      ? placed.prefix
      : undefined;

  const value =
    prefix === undefined || secret.value.toLowerCase().startsWith(`${prefix.toLowerCase()} `)
      ? secret.value
      : `${prefix} ${secret.value}`;

  return ok({ kind: secret.kind, name, value });
};

/** An OAuth 1.0a consumer's keys: the toolkit's OAuth app, signing as its credential settings say (#206). */
const oauth1Consumer = (app: OAuthApp, settings: CredentialSettings | undefined): OAuth1Keys => ({
  consumerKey: app.clientId,
  consumerSecret: app.clientSecret ?? "",
  ...oauth1Signing(settings),
});

/** A minted secret with the token `minted` got with the settings `with` ({@link mintedWith}), in place of the last one. */
const withToken =
  <S extends MintedSecret>(secret: S, minted_with: string) =>
  (minted: Minted): S & { readonly access_token: string } => {
    const { access_token: _token, expires_at: _expires, minted_with: _with, ...rest } = secret;

    // SAFETY: `rest` is `secret` without its token fields, which `minted` and `minted_with` give back.
    return { ...rest, ...minted, minted_with } as S & { readonly access_token: string };
  };

/** Why `secret`'s key cannot sign as the toolkit's `settings` say, as a refusal ({@link keyRefusal}). */
const keyRefused = async (
  secret: ToolkitSecret,
  settings: CredentialSettings | undefined,
): Promise<ToolsRefusal | undefined> => {
  const refused = await Effect.runPromise(keyRefusal(secret, settings));

  return refused === undefined ? undefined : refuse("invalid", refused);
};

/** Whether `viewer` reads a toolkit (an org toolkit: every member) or manages it (`full`), or only sees it (`limited`). */
const reach = (toolkit: Toolkit, viewer: Scope): Access | "read" => {
  const access = accessTo(toolkit.owner, viewer);

  return access === "none" && toolkit.owner === undefined ? "read" : access;
};

/** Whether `toolkit` takes a credential in `slot`: a private toolkit its owner's only. */
const accepts = (toolkit: Pick<Toolkit, "owner" | "accepts">, slot: CredentialSlot): boolean =>
  toolkit.owner === undefined
    ? toolkit.accepts === "both" || toolkit.accepts === slot
    : slot === "private";

/** A new toolkit's name when its source names none: the slug of its source's host. */
const fallbackName = (source: string): string =>
  source === "" ? "toolkit" : defaultToolkitName(new URL(source));

/** The credential of a build that lists without one (an OpenAPI document's, an uploaded GraphQL schema's). */
const NO_SECRET: UpstreamSecret = { kind: "none" };

/**
 * Whether `toolkit` is built from an uploaded document the part keeps (an OpenAPI or Discovery document, a GraphQL
 * schema's SDL).
 */
const uploaded = (toolkit: Toolkit): boolean => !toolkit.builtIn && toolkit.uploaded;

/** The OAuth 2 scopes `tools` name (a Discovery toolkit's methods'), sorted, each once. */
const scopesOf = (tools: ReadonlyArray<StoredTool>): ReadonlyArray<string> =>
  [...new Set(tools.flatMap((tool) => tool.operation?.scopes ?? []))].sort();

/**
 * A build's failure that refuses the save of its source: a URL in the source the outbound guard refuses (a Discovery
 * document's `rootUrl`), answered as a URL typed in is (`outbound_refused` with the field as `path`).
 */
const sourceRefusal = (failure: KindFailure): ToolsRefusal | undefined =>
  failure.field === undefined
    ? undefined
    : { ok: false, error: "outbound_refused", message: failure.message, path: failure.field };

/**
 * The Tools part of an org's ControlPlane (#196): the single writer for the org's toolkits, their credentials (sealed
 * with the org's data key, `core.secrets`), their tool lists, the overrides on their tools and the tool grants (#198,
 * `grants/`). An `RpcTarget` the composed `ControlPlane` constructs once per object (`new ToolsPart(ctx, core)`);
 * callers reach it as `stub.tools().x(…)`. A tool list is built here, from the MCP server, so a credential's secret
 * never leaves the object; the caller hands over its outbound guard's policy (ADR 0044), and every request goes through
 * the guard.
 *
 * Who may do what follows `@commissary/auth`'s ownership rules: an org toolkit is read by every member and managed by
 * org admins; a private toolkit is its owner's, and an org admin only sees that it exists (and may remove it). Methods
 * exchange plain data only.
 *
 * The built-in toolkits (`toolkits/built-in.ts`, #212) are listed beside the stored ones as org toolkits, from the
 * providers the deployment's bindings give (`builtInProviders`): their tool grants and overrides are stored like any
 * toolkit's, while they themselves cannot be edited or removed.
 */
export class ToolsPart extends RpcTarget implements ControlPlanePart {
  readonly #ctx: DurableObjectState;
  readonly #core: OrgCore;
  readonly #store: ToolkitStore;
  /** The GraphQL schema kept built for calls that check a caller's selection (#204). */
  readonly #schemas = new SchemaCache();
  readonly #grants: ToolGrantStore;
  readonly #builtIns: ReadonlyArray<BuiltIn>;
  readonly #approvals: ApprovalStore;
  readonly #oauth: OAuthStore;
  /** The policy of the part's own requests (its alarm's token refreshes): no loopback, the deployment's own hosts refused. */
  readonly #outbound: OutboundPolicy;
  /** The token refreshes in flight, by credential: concurrent callers share one. */
  readonly #refreshes = new Map<string, Promise<Signed>>();
  /** The org's open sandbox sessions (#222), and the sandbox they are in. */
  readonly #sandboxSessions: SandboxSessionStore;
  readonly #sandbox: SandboxProvider | undefined;
  /** The tickets of agent runs' gated sandbox calls (#230). */
  readonly #runCalls: RunCallTickets;
  /** The org's browser profiles (#215) and the grants on shared ones. */
  readonly #profiles: ProfileStore;
  /** Who started each of the org's browser crawls (#270), and the browser provider's crawls they run at. */
  readonly #crawls: BrowserCrawlStore;
  readonly #browserCrawls: BrowserCrawlProvider | undefined;
  /** The org's open browser sessions (#214), and their objects, which the org's deletion deletes. */
  readonly #browserSessionLog: BrowserSessionStore;
  readonly #browserSessions: BrowserSessions | undefined;
  /** Commissary Cloud's managed OAuth apps (#207), which toolkits added from the catalog sign in with by default. */
  readonly #managedApps: ManagedApps;
  /** The org's lookups at integrations.sh of domains the toolkit catalog lacks (#207), counted to throttle them. */
  readonly #lookups = new LookupThrottle();
  /** Which agents a caller may run (#229): the agents toolkit's reach, from the Agents part. */
  readonly #agents: AgentDirectory | undefined;
  /**
   * The org's Billing part, which counts what plans count of the part (#241), where the deployment has plans
   * (Commissary Cloud); read when needed, as the state Worker makes the parts of an object one after the other.
   */
  readonly #plans: () => PlanMeter | undefined;
  /**
   * The `browser_open` calls being served now, which the ceiling on concurrent browser sessions counts besides the open
   * ones (#241): the session is logged only once its object opened it. In memory: a call does not outlive the object.
   */
  #pendingOpens = 0;
  /**
   * The sandbox sessions with a computer that calls being served are in now, as many calls as each has (#241): the
   * computers that run, or may start, for the ceiling.
   */
  readonly #pendingComputers = new Map<string, number>();
  /** Who watches each agent run (#232), from the Agents part: its approvals' caller, its browser sessions' watchers. */
  readonly #runWatchers: RunWatchers | undefined;
  /** What the part reads the time from: the live clock, or a test's (`useClock`). */
  #clock: Clock.Clock = Clock.Clock.defaultValue();

  /**
   * `options.ownHosts`: the deployment's own hosts (`OWN_HOSTS`), which the part's own requests refuse;
   * `options.managedApps`: the managed OAuth apps the deployment has (`managedAppsOf(env)`,
   * `catalog/managed-apps.ts`; none on a self-hosted one); `options.plans`: the org's Billing part on Commissary Cloud,
   * and nothing on a self-hosted Commissary (#241).
   */
  constructor(
    ctx: DurableObjectState,
    core: OrgCore,
    providers: BuiltInProviders = {},
    {
      ownHosts,
      managedApps = NO_MANAGED_APPS,
      plans = () => undefined,
    }: {
      readonly ownHosts?: string;
      readonly managedApps?: ManagedApps;
      readonly plans?: () => PlanMeter | undefined;
    } = {},
  ) {
    super();
    this.#plans = plans;
    this.#ctx = ctx;
    this.#core = core;
    this.#builtIns = builtInToolkits(providers);
    this.#store = new ToolkitStore(ctx.storage.sql, core.secrets, (body) => core.transaction(body));
    this.#grants = new ToolGrantStore(ctx.storage.sql, (body) => core.transaction(body));
    this.#approvals = new ApprovalStore(ctx.storage.sql, core.secrets);
    this.#oauth = new OAuthStore(ctx.storage.sql, core.secrets);
    this.#outbound = outboundPolicy({ hosts: [ownHosts] });
    this.#sandboxSessions = new SandboxSessionStore(ctx.storage.sql);
    this.#runCalls = new RunCallTickets(ctx.storage.sql);
    this.#sandbox = providers.sandbox;
    this.#profiles = new ProfileStore(ctx.storage.sql, core.secrets);
    this.#crawls = new BrowserCrawlStore(ctx.storage.sql);
    this.#browserCrawls = providers.browser?.crawls;
    this.#browserSessionLog = new BrowserSessionStore(ctx.storage.sql);
    this.#browserSessions = providers.browserSessions;
    this.#managedApps = managedApps;
    this.#agents = providers.agents;
    this.#runWatchers = providers.runWatchers;
    this.#yieldBuiltInNames();
  }

  // --- the org-wide base's calls (`ControlPlanePart`, `@commissary/state`) ------------------------------------

  /**
   * Makes the part read the time from `clock` (a test's `TestClock`) instead of the live clock. In the object's isolate
   * only (`runInDurableObject`): a clock is not data an RPC can carry.
   */
  useClock(clock: Clock.Clock): void {
    this.#clock = clock;
  }

  #now(): number {
    return this.#clock.currentTimeMillisUnsafe();
  }

  /** Tools sealed its secrets from the start: nothing was stored in plain text. */
  sealPlaintext(): number {
    return 0;
  }

  /**
   * Forgets the upstream sessions older than seven days (ADR 0038), the sandbox sessions the sandbox ended for want
   * of use (#222) and the browser crawls whose pages the provider no longer keeps (#270), deletes the pending approvals
   * (and forms) that expired (#201) and refreshes the tokens of the OAuth credentials that expire soon (#202), then
   * wakes up when the next of these is due. Tool lists are rebuilt by the cron task. Each token refresh stands alone:
   * one that throws is logged and tried again after {@link REFRESH_RETRY_MS}, and the others, the pruning and the next
   * wake-up go on.
   */
  async alarm(now: number): Promise<number | null> {
    const due = this.#store.refreshesDue(now);

    await Effect.runPromise(
      Effect.forEach(
        due,
        (credential) => {
          const toolkit = this.#store.toolkit(credential.toolkitId);

          return toolkit === undefined
            ? Effect.void
            : Effect.tryPromise(() => this.#refresh(toolkit, credential, this.#outbound)).pipe(
                Effect.catch(() =>
                  refreshFailed(credential, { reason: "exception" }).pipe(
                    Effect.andThen(
                      Effect.try(() =>
                        this.#store.deferRefresh(
                          credential.toolkitId,
                          credential.owner,
                          this.#now() + REFRESH_RETRY_MS,
                        ),
                      ),
                    ),
                    Effect.ignore,
                  ),
                ),
              );
        },
        { concurrency: REFRESH_CONCURRENCY, discard: true },
      ),
    );

    return this.#nextWakeUp(now, now + REFRESH_RECHECK_MS);
  }

  /**
   * Prunes what is due at `now`; answers the part's next wake-up, the earliest of the sessions' (upstream and sandbox),
   * the browser crawls', the approvals' and the credentials' token refreshes (none before `refreshFrom`).
   */
  #nextWakeUp(now: number, refreshFrom = now): number | null {
    const refresh = this.#store.nextRefreshAt();

    const wakes = [
      this.#store.pruneSessions(now),
      this.#sandboxSessions.prune(now),
      this.#crawls.prune(now),
      this.#approvals.prune(now),
      refresh === null ? null : Math.max(refresh, refreshFrom),
    ].filter((at): at is number => at !== null);

    return wakes.length === 0 ? null : Math.min(...wakes);
  }

  async #wake(): Promise<void> {
    await this.#core.wakeUpChanged(this.#nextWakeUp(this.#now()));
  }

  /** Deletes the part's tables: the org was deleted (`wipeOrg`). */
  wipe(): void {
    for (const table of [...TOOLS_TABLES, ...PROFILE_TABLES])
      this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    this.#schemas.forget();
  }

  /**
   * Zero data retention (ADR 0027): a member's private toolkits, private credentials and private browser profiles go
   * with them, and so do the tool and profile grants that named them and the pending approvals of their calls (#201).
   * They leave every list of approvers. Their open sandbox sessions (#222) are deleted at once, with their files, each
   * first settled as a close is: its computer time charged and its usage record written (#224; one idle for a day is
   * closed already, its files gone: it is left to report its close), and their browser crawls
   * (#270) that may still be running are cancelled at the provider (as far as it answers) before the part forgets them
   * all.
   */
  async memberLeft(member: string): Promise<void> {
    await this.#purgeSandboxSessions(
      this.#sandboxSessions.sessions({ member, usedSince: this.#now() - SESSION_IDLE_MS }),
      true,
    );
    await this.#cancelCrawls(this.#crawls.mayRun(this.#now(), { member }));

    this.#core.transaction(() => {
      this.#store.deleteMember(member);
      this.#oauth.deleteMember(member);
      this.#crawls.deleteMember(member);
      this.#grants.forget({ kind: "member", id: member });
      this.#profiles.deleteOwner(member);
      this.#profiles.forgetSubject({ kind: "member", id: member });

      this.#approvals.deleteMember(member, (approver) => withoutMember(approver, member));

      for (const toolkit of this.#store.toolkits()) {
        const rules =
          toolkit.approvalRules === undefined
            ? undefined
            : rulesWithoutMember(toolkit.approvalRules, member);

        if (rules !== undefined) this.#store.replaceApprovalRules(toolkit.id, rules);
      }
    });
  }

  /**
   * Deletes up to `limit` of the org's open sandbox sessions with their files (#222): Tools' step of deleting the org
   * (`org-deletion.ts`), within its budget. Answers how many it deleted and how many are left.
   */
  async purgeSandboxSessions(
    limit: number,
  ): Promise<{ readonly purged: number; readonly remaining: number }> {
    const sessions = this.#sandboxSessions.sessions({ limit });
    const purged = await this.#purgeSandboxSessions(sessions);

    return {
      purged,
      remaining: this.#sandboxSessions.sessions().length,
    };
  }

  /**
   * Whether an agent run's session opened with `opened` still fits its definition's sandbox `definition` and the
   * sandbox toolkit's ceiling now (#230, `agentSandboxFits`): the Agents part of the same ControlPlane asks as a turn
   * starts, and a run whose definition or ceiling narrowed since opens a new session. A toolkit that is no sandbox fits
   * nothing.
   */
  runSandboxFits(definition: AgentSandboxSettings, opened: AgentSandboxSettings): boolean {
    const builtIn = this.#builtIn(definition.toolkit);

    if (builtIn?.toolkit.kind !== "sandbox") return false;
    const ceiling = this.#withSettings(builtIn.toolkit).ceiling ?? NO_ALLOWANCE;

    return agentSandboxFits(definition, opened, { kind: "sandbox", ...ceiling });
  }

  /**
   * Deletes the sandbox sessions of the agent runs `runIds` (#230), with their files: a run's sessions last as long as
   * the run, and go when it is deleted (its agent or its member removed, or the org's retention period for agent runs
   * passed), which the Agents part of the same ControlPlane tells this one (`apps/state/src/control-plane.ts`). Each
   * settles first, as a member's leaving settles theirs (#224): a computer still running stops, its last stretch is
   * charged and recorded. Answers the runs none of whose sessions is left; one the sandbox could not reach keeps its
   * row, for the next try.
   */
  async purgeRunSandboxSessions(runIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const principals = runIds.map(runPrincipalId);

    await this.#purgeSandboxSessions(this.#sandboxSessions.sessionsOf(principals), true);
    this.#runCalls.forgetPrincipals(principals);
    const left = new Set(this.#sandboxSessions.sessionsOf(principals).map((row) => row.principal));

    return runIds.filter((id) => !left.has(runPrincipalId(id)));
  }

  /**
   * How what a parked call of the agent run `run` waits on stands (#232, ADR 0040), as the run gateway asks it now and
   * then: a pending approval of the run's call (`waiting` while undecided, `ready` once approved or denied, as the same
   * call made again takes the outcome, `expired` once its hour passed by the part's clock), or a handoff in a browser
   * session the run opened (`waiting` while its person is asked, `ready` once it ended or the session closed). One that
   * is not the run's, or of which nothing is kept, is `gone`: the run decides by its own clock. Reads only.
   */
  async runWaitState(
    run: string,
    waiting: { readonly kind: "approval" | "handoff"; readonly id: string },
  ): Promise<RunWaitState> {
    const principal = runPrincipalId(run);

    if (waiting.kind === "approval") {
      const approval = this.#approvals.held(waiting.id);

      if (approval === undefined || approval.callerPrincipal !== principal) return "gone";

      if (approval.expiresAt <= this.#now()) return "expired";

      return approval.status === "pending" && !approval.settled ? "waiting" : "ready";
    }

    const session = this.#browserSessionLog.session(waiting.id);
    const sessions = this.#browserSessions;

    if (session === undefined || session.principal !== principal || sessions === undefined)
      return "gone";
    const watched = await sessions.watch(this.#core.org, waiting.id);

    return watched.kind === "open" && watched.handoff !== undefined ? "waiting" : "ready";
  }

  /**
   * Runs one operation of an agent run's gated sandbox call (#230) on its session: only with the call's live ticket
   * (`ticket`, of the run `run`'s), and only an operation the gated tool makes (`TICKET_OPS`). Each operation's start
   * and end keep the ticket alive (`run-calls.ts`, "Expiry"). The session is the call's, as the run's principal owns
   * it; it is used as the sandbox toolkit's own calls use it.
   *
   * Its computer time (#224) is metered as the sandbox toolkit's calls meter it: each operation passes the metering the
   * gate set (the price per computer hour, and whether a Spend limit its time counts toward had no room), and the
   * session's computer time it answers is charged at once to the call's spender's limits (a shared agent's run's, as
   * the agent, #228). With no room, an operation that met the running computer stopped it and goes on, with a note for
   * the model; a command that needs the computer is refused, which the ticket keeps, so that settling it ends the
   * run's turn.
   */
  async runSandboxOperation(
    run: string,
    ticket: string,
    request: SandboxEnvRequest,
  ): Promise<SandboxEnvReply> {
    const principal = runPrincipalId(run);
    const gated = this.#runCalls.live(ticket, principal, this.#now());
    const sandbox = this.#sandbox;

    if (gated === undefined || !ticketAllows(gated.tool, request.op))
      return { ok: false, reason: "ticket", message: "The call has no valid ticket." };

    if (sandbox === undefined)
      return { ok: false, reason: "failed", message: "The deployment has no sandbox." };
    const owner = { org: this.#core.org, principal };
    const start = this.#now();

    // A command may run as long as its timeout, the sandbox's ten minutes at most: the ticket lives past it.
    const running =
      request.op === "exec" ? Math.min(Math.max(0, request.timeoutMs), SANDBOX_MAX_TIMEOUT_MS) : 0;

    this.#runCalls.extend(ticket, start + running + TICKET_IDLE_MS);

    const meter: ComputerMeter = {
      hourPriceMicros: gated.hourPriceMicros,
      limitReached: gated.limitReached,
      ...(gated.planRefusal === undefined ? {} : { limitReason: "plan" as const }),
      ...(gated.plans ? { plans: true as const } : {}),
    };

    const operation = sandboxOperation(sandbox, owner, gated.session, request, start, meter);

    const reply = await Effect.runPromise(
      operation.pipe(
        Effect.map(({ value, ...metered }) => ({ reply: { ok: true, value } as const, metered })),
        Effect.catch((error) =>
          Effect.succeed({
            reply: {
              ok: false,
              reason:
                error.reason === "unknown_session" || error.reason === "closed" ? "lost" : "failed",
              message: error.message,
            } as const,
            metered: error,
            refused: error.reason === "refused",
            unknown: error.reason === "unknown_session",
          }),
        ),
      ),
    );

    const end = this.#now();
    const { computerTime, computerStopped } = reply.metered;
    const ledger = this.#core.spend.ledger();
    const spender = { memberId: gated.member, apiKeyId: gated.apiKey, agentId: gated.agent };

    const charged: ChargedCredential = {
      id: gated.toolkitId,
      shared: gated.credential === "shared",
      kind: "toolkit_credential",
    };

    ledger.charge(ledger.scopes(spender, charged), computerTime?.costMicros ?? 0, end);

    // The computer time counts toward the plan, and where the computer stands toward its ceiling (#241).
    this.#countTime("computerHours", computerTime?.computerMs);

    if (computerTime !== undefined)
      this.#sandboxSessions.computerRunsUntil(gated.session, computerTime.runsUntil);

    // A command that needs the computer, refused for want of room: the call's settling ends the turn with the limit's
    // refusal, a Spend limit's or else the plan's (#241).
    // The plan's, when the gate found it kept the computer from the call: that is what the session's answer said, so the
    // settling says it too, whatever a Spend limit has come to since.
    const needed = "refused" in reply && reply.refused;
    const planRefused = needed && gated.planRefusal !== undefined;
    const refusal = needed && !planRefused ? ledger.refusal(spender, charged, end) : undefined;

    if (refusal !== undefined) this.#runCalls.refused(ticket, refusal, computerStopped === true);
    else if (planRefused) this.#runCalls.planRefused(ticket, computerStopped === true);

    // The call did no work then: it is no tool call (#241), as a refused command of a call outside a run is none.
    if (refusal !== undefined || planRefused) {
      const counted = this.#runCalls.uncount(ticket);

      if (counted !== undefined) this.#plans()?.refund(counted);
    }

    this.#runCalls.extend(ticket, end + TICKET_IDLE_MS);

    // A session the sandbox does not know is forgotten, as the sandbox toolkit's own calls forget it; one found closed
    // is kept until its close is reported (#224).
    if ("unknown" in reply && reply.unknown)
      this.#sandboxSessions.ended([gated.session], principal);
    else if (reply.reply.ok || reply.reply.reason !== "lost")
      this.#sandboxSessions.used(gated.session, end, principal);

    // An operation that met the running computer stopped it for want of room, and went on: the model is told.
    return computerStopped === true && refusal === undefined && !planRefused
      ? { ...reply.reply, note: computerStoppedNote(meter) }
      : reply.reply;
  }

  /**
   * Settles the gated call `ticket` of the run `run` (#230): ends its operations and answers what the call's usage
   * record says of it (the run's settling writes it, under the ticket's id, `@commissary/tools/api`). Settling is not
   * bound by the ticket's expiry, which limits its operations only: a settling tried again within a day of the gate
   * (`SETTLE_GRACE_MS`, as the run retries one that failed, or one the API Worker could not finish) answers the same,
   * and the record is written once. `undefined` for none (unknown, past that day, or another run's), which writes none.
   */
  async settleRunSandboxCall(run: string, ticket: string): Promise<RunCallTicket | undefined> {
    return this.#runCalls.settle(ticket, runPrincipalId(run), this.#now());
  }

  /**
   * Cancels up to `limit` of the org's browser crawls that may still be running (#270), and forgets them: Tools' step
   * of deleting the org (`org-deletion.ts`), within its budget, before `wipe` drops the rest of the log. Answers how
   * many it asked the provider to cancel and how many are left.
   */
  async purgeBrowserCrawls(
    limit: number,
  ): Promise<{ readonly purged: number; readonly remaining: number }> {
    const ids = this.#crawls.mayRun(this.#now(), { limit });
    const purged = await this.#cancelCrawls(ids);

    this.#crawls.forget(ids);

    return { purged, remaining: this.#crawls.mayRun(this.#now()).length };
  }

  /**
   * Cancels the crawls `ids` at the browser provider, a few at a time, as far as it answers: a crawl that already
   * ended, or a provider that fails, is logged and passed over, as the crawl ends by itself at its page limit or after
   * seven days. Answers how many it asked to cancel (none without the provider's crawls: the deployment lost its token).
   */
  async #cancelCrawls(ids: ReadonlyArray<string>): Promise<number> {
    const crawls = this.#browserCrawls;

    if (crawls === undefined || ids.length === 0) return 0;

    await Effect.runPromise(
      Effect.forEach(
        ids,
        (id) =>
          crawls
            .cancel(id)
            .pipe(
              Effect.catchTag("BrowserProviderError", (error) =>
                Effect.logWarning("browser crawl not cancelled").pipe(
                  Effect.annotateLogs({ status: error.status ?? "none" }),
                ),
              ),
            ),
        { concurrency: CRAWL_CANCEL_CONCURRENCY, discard: true },
      ),
    );

    return ids.length;
  }

  /**
   * Deletes `sessions` in their sandbox, and their rows once deleted; answers how many it asked the sandbox to delete.
   * One the sandbox could not reach keeps its row, for the next try (it ends by itself after a day without use). When
   * their member left (`settle`, #224), each settles as a close does first: its usage record written, and its computer
   * time no call charged charged here, to its opener's Spend limits; one its alarm closed meanwhile keeps its row, for
   * the close's report.
   */
  async #purgeSandboxSessions(
    sessions: ReadonlyArray<TrackedSession>,
    settle = false,
  ): Promise<number> {
    const sandbox = this.#sandbox;

    if (sandbox === undefined || sessions.length === 0) return 0;

    const purged = await Promise.all(
      sessions.map(async (session) =>
        Effect.runPromise(
          sandbox.purge(this.#core.org, session.id, settle).pipe(
            Effect.map(({ computerTime }) => {
              this.#chargeClosed(session, computerTime?.costMicros ?? 0);

              return session.id;
            }),
            Effect.catchTag("SandboxError", (error) =>
              // One its alarm closed is kept until its close is reported (#224): its files are gone already.
              settle && error.reason === "closed"
                ? Effect.succeed(undefined)
                : Effect.logWarning("sandbox session not purged").pipe(
                    Effect.annotateLogs({ reason: error.reason, message: error.message }),
                    Effect.as(undefined),
                  ),
            ),
          ),
        ),
      ),
    );

    this.#sandboxSessions.ended(purged.filter((id) => id !== undefined));

    return sessions.length;
  }

  /** The tool and profile grants that named the team go with it. */
  teamDeleted(team: string): void {
    this.#core.transaction(() => {
      this.#grants.forget({ kind: "team", id: team });
      this.#profiles.forgetSubject({ kind: "team", id: team });
    });
  }

  /** Read on every use (`core.teamIdsOf`): nothing to forget. */
  teamMembersChanged(): void {}

  apiKeysDeleted(): void {}

  /** Read on every use: nothing to forget. */
  privateCredentialsChanged(): void {}

  /** Tools holds no agents: no Spend limit names one of its (a test's subclass names one, to limit an agent's run). */
  spendAgents(): ReadonlyArray<SpendAgent> {
    return [];
  }

  /**
   * The org toolkits' shared credentials, by their toolkit (a toolkit holds at most one): what a toolkit's Spend limit
   * names (#199). Its tool calls on the shared credential count toward it.
   */
  spendCredentials(): ReadonlyArray<SpendCredential> {
    const shared = new Set(
      this.#store
        .credentials()
        .filter((credential) => credential.owner === undefined)
        .map((credential) => credential.toolkitId),
    );

    return this.#store
      .toolkits()
      .filter((toolkit) => toolkit.owner === undefined && shared.has(toolkit.id))
      .map((toolkit) => ({
        kind: "toolkit_credential",
        id: toolkit.id,
        publicId: toolkit.id,
        label: toolkit.name,
      }));
  }

  // --- toolkits ---------------------------------------------------------------------------------------------------

  /**
   * The toolkits `viewer` reaches; an org admin also gets the other members' private toolkits, as existence only. The
   * agents toolkit (#229) only for a caller that asks for it ({@link KindsOptions}).
   */
  listToolkits(viewer: Scope, options?: KindsOptions): ToolkitsList {
    const resolution = this.#resolve(this.#servedMember(this.#memberOf(viewer)));
    const toolkits: Array<ToolkitView> = [];
    const others: Array<LimitedToolkitView> = [];

    for (const toolkit of this.#toolkits(options ?? {})) {
      const access = reach(toolkit, viewer);

      if (access === "limited") others.push(this.#limitedView(toolkit));
      else if (access !== "none") toolkits.push(this.#view(toolkit, viewer, resolution));
    }

    return isOrgAdmin(viewer) ? { toolkits, others } : { toolkits };
  }

  /**
   * Whether a toolkit added from catalog service `service` would sign in with Commissary Cloud's managed OAuth app with
   * it (#207): the deployment has the app, its secret bound here. The app Worker asks, for the catalog's views; it never
   * reads a secret itself.
   */
  hasManagedApp(service: string): boolean {
    return this.#managedApps.has(service);
  }

  /**
   * Counts a lookup at integrations.sh of a domain the toolkit catalog lacks (#207), unless the org asked too often
   * lately (`catalog/lookup-throttle.ts`): a `discover` once a minute for the org, a `detect` ten times a minute for
   * each member.
   */
  takeCatalogLookup(viewer: Viewer, via: "detect" | "discover"): LookupTaken {
    return via === "discover"
      ? this.#lookups.take("discover", DISCOVERS_PER_WINDOW, this.#now())
      : this.#lookups.take(`detect:${viewer.member ?? ""}`, DETECTS_PER_WINDOW, this.#now());
  }

  /**
   * Adds an org toolkit (org admins) or a private toolkit of the caller, with its credential if given, and builds its
   * tool list when it has one. A list that cannot be built does not undo the add.
   */
  async addToolkit(
    viewer: Viewer,
    input: AddToolkitInput,
    by: string,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<ConnectedToolkitView>> {
    const owner = input.private ? viewer.member : undefined;

    if (input.private && owner === undefined)
      return refuse("forbidden", "only a member can add a private toolkit");

    if (!input.private && !viewer.admin)
      return refuse("forbidden", "only an org admin can add an org toolkit");

    if (input.private && !this.#core.privateToolkits())
      return refuse(
        "private_toolkits_unavailable",
        "the org does not let members add private toolkits",
      );

    if (input.private && input.accepts !== "private")
      return refuse("invalid", "a private toolkit takes its owner's credential only");

    const kind = input.kind ?? "mcp";

    if (input.name !== undefined) {
      const refused = this.#nameRefusal(input.name, owner, undefined);

      if (refused !== undefined) return refused;
    }

    const settings = input.credentialSettings;

    if (settings !== undefined) {
      const refused = settingsRefusal(settings, kind);

      if (refused !== undefined) return refuse("invalid", refused.message, refused.path);
    }

    const id = freshToolkitId();
    let grant: ToolGrantValue | undefined;
    let secret: ToolkitSecret | undefined;

    if (input.credential !== undefined) {
      const slot: CredentialSlot = input.private ? "private" : "shared";
      const placed = secretOf(input.credential, input.catalog?.credential, "credential.name");

      if (!placed.ok) return placed;
      secret = placed.value;

      const credentialRefusal =
        this.#credentialRefusal(
          { owner, accepts: input.accepts, credentialSettings: settings },
          slot,
          secret,
        ) ?? (await keyRefused(secret, settings));

      if (credentialRefusal !== undefined) return credentialRefusal;
      const granted = this.#connectGrant(id, slot, input.credential.subject);

      if (!granted.ok) return granted;
      grant = granted.value;
    }

    const driver = KIND_DRIVERS[kind];
    const specPatch = kind === "openapi" ? input.specPatch : undefined;

    const listSource = { uploaded: input.document !== undefined };

    // A source read without a credential (an OpenAPI document, an uploaded GraphQL schema) is read before the toolkit
    // is added: an OpenAPI document names the toolkit by default. One that cannot be read does not keep the toolkit
    // from being added, as a list that cannot be built does not.
    const listing = driver.listsWithCredential(listSource)
      ? undefined
      : await this.#listing(driver, {
          toolkit: { source: input.source, baseUrl: input.baseUrl, specPatch },
          secret: NO_SECRET,
          document: input.document,
          timeout: LISTING_TIMEOUT,
          policy,
        });

    // A URL in the source the outbound guard refuses (a Discovery document's rootUrl) refuses the save (ADR 0044).
    const sourceRefused =
      listing !== undefined && Result.isFailure(listing)
        ? sourceRefusal(listing.failure)
        : undefined;

    if (sourceRefused !== undefined) return sourceRefused;

    const listedName =
      listing !== undefined && Result.isSuccess(listing) ? listing.success.name : undefined;

    const name = input.name ?? listedName ?? fallbackName(input.source);

    // Checked again: another toolkit may have taken the name while the document was read.
    const refused = this.#nameRefusal(name, owner, undefined);

    if (refused !== undefined) return refused;
    const now = this.#now();

    const connected = this.#core.transaction(() => {
      this.#store.insertToolkit({
        id,
        kind,
        name,
        source: input.source,
        baseUrl: kind === "openapi" ? input.baseUrl : undefined,
        uploaded: listSource.uploaded,
        credentialSettings: settings,
        catalog: input.catalog,
        specPatch,
        owner,
        accepts: input.accepts,
        revision: 1,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        updatedBy: by,
      });

      if (input.document !== undefined) this.#store.putDocument(id, input.document);

      this.#putCatalogOverrides(id, input.toolOverrides ?? {}, now);

      if (listing !== undefined) this.#storeListing(id, listing);

      if (secret !== undefined) this.#store.putCredential(id, owner, secret, by, now);

      return grant === undefined ? undefined : this.#grantOnConnect(grant, by, now);
    });

    if (driver.listsWithCredential(listSource) && input.credential !== undefined)
      await this.#buildFor(id, viewer.member, policy);

    return withGrant(this.#viewOf(id, viewer), connected);
  }

  /**
   * Renames a toolkit, changes which credentials an org toolkit accepts, prices its calls (#199; `null` clears the
   * price) or sets its approval rules (#201; `null` clears them). A credential it no longer accepts is kept, shown
   * inactive and not used, until it accepts that kind again or its holder removes it.
   */
  updateToolkit(
    viewer: Viewer,
    id: string,
    revision: number,
    change: UpdateToolkit,
    by: string,
    policy: OutboundPolicy,
  ): ToolsResult<ToolkitView> {
    const managed = this.#managed(id, viewer);

    if (!managed.ok) return managed;

    if (managed.value.builtIn)
      return this.#updateBuiltIn(viewer, managed.value, revision, change, by);
    const current = managed.value;

    if (change.network !== undefined)
      return refuse("invalid", "only the sandbox toolkit has a network");

    if (change.computer !== undefined)
      return refuse("invalid", "only the sandbox toolkit has a computer");

    const [hourPriced] = hourPricesOf(change);

    if (hourPriced !== undefined)
      return refuse(
        "invalid",
        `only the ${hourPriced.kind} toolkit has a price per ${HOUR_PRICES[hourPriced.kind].hour}`,
      );

    if (current.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${current.revision}, not ${revision}`);

    if (change.accepts !== undefined && current.owner !== undefined && change.accepts !== "private")
      return refuse("invalid", "a private toolkit takes its owner's credential only");

    const price = this.#priceChange(current, change.price_micros);

    if (!price.ok) return price;
    const rules = this.#rulesChange(current, change.approval_rules);

    if (!rules.ok) return rules;

    if (change.base_url !== undefined && current.kind !== "openapi")
      return refuse("invalid", "only an OpenAPI toolkit takes a base URL");

    const settings =
      change.credential_settings === undefined
        ? current.credentialSettings
        : (change.credential_settings ?? undefined);

    if (change.credential_settings !== undefined && settings !== undefined) {
      const refused = settingsRefusal(settings, current.kind);

      if (refused !== undefined) return refuse("invalid", refused.message, refused.path);
    }

    const name = change.name ?? current.name;

    if (name !== current.name) {
      const refused = this.#nameRefusal(name, current.owner, current.id);

      if (refused !== undefined) return refused;
    }

    const baseUrl =
      change.base_url === undefined ? current.baseUrl : (change.base_url ?? undefined);

    this.#core.transaction(() => {
      this.#store.updateToolkit(
        id,
        {
          name,
          accepts: change.accepts ?? current.accepts,
          priceMicros: price.value,
          approvalRules: rules.value,
          baseUrl,
          credentialSettings: settings,
        },
        by,
        this.#now(),
      );

      if (baseUrl !== current.baseUrl) this.#rewarn(current, baseUrl, policy);
    });
    this.#dropOrphanedApprovals(id);

    return this.#viewOf(id, viewer);
  }

  /**
   * Sets a built-in toolkit's approval rules (#201), which apply as any toolkit's, and the sandbox toolkit's network
   * ceiling (#222), the widest network its sessions may ask for, and whether they may use the computer (#223), which a
   * deployment without the computer cannot allow, and its price per hour: the browser toolkit's per browser hour (#214),
   * the sandbox toolkit's per computer hour (#224), one mechanism (`HOUR_PRICES`; `null` clears it) (an org
   * admin's: the toolkit is an org toolkit). Nothing else of it changes (`403 built_in` for a name, what it accepts or a
   * price per call; a network or computer on the browser toolkit, or the other toolkit's price per hour, too). Open
   * sandbox sessions keep the network and the computer they opened with; open sessions cost the new price per hour from
   * their next call on.
   */
  #updateBuiltIn(
    viewer: Viewer,
    current: BuiltInToolkit,
    revision: number,
    change: UpdateToolkit,
    by: string,
  ): ToolsResult<ToolkitView> {
    const {
      approval_rules: _rules,
      network,
      computer,
      browser_hour_price_micros: _browserHour,
      computer_hour_price_micros: _computerHour,
      ...rest
    } = change;

    const hourPrices = hourPricesOf(change);
    const hourPrice = hourPrices[0];

    if (
      Object.values(rest).some((value) => value !== undefined) ||
      ((network !== undefined || computer !== undefined) && current.kind !== "sandbox") ||
      hourPrices.some(({ kind }) => kind !== current.kind)
    )
      return BUILT_IN;

    if (current.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${current.revision}, not ${revision}`);
    const rules = this.#rulesChange(current, change.approval_rules);

    if (!rules.ok) return rules;

    const problem =
      (network === undefined ? undefined : networkProblem(network)) ??
      (hourPrice === undefined || hourPrice.price === null
        ? undefined
        : hourPriceRefusal(hourPrice.field, hourPrice.price));

    if (problem !== undefined) return refuse("invalid", problem);

    if (computer === true && this.#sandbox?.computer !== true)
      return refuse(
        "invalid",
        "this deployment has no computer, so sandbox sessions cannot use one (docs/DEPLOY.md, Optional pieces)",
      );

    this.#store.updateBuiltIn(
      current.id,
      current.revision,
      {
        approvalRules: rules.value,
        ceiling:
          network === undefined && computer === undefined
            ? current.ceiling
            : {
                network:
                  network === undefined
                    ? (current.ceiling ?? NO_ALLOWANCE).network
                    : normalizedNetwork(network),
                computer: computer ?? (current.ceiling ?? NO_ALLOWANCE).computer,
              },
        hourPriceMicros:
          hourPrice === undefined ? current.hourPriceMicros : (hourPrice.price ?? undefined),
      },
      by,
      this.#now(),
    );
    this.#dropOrphanedApprovals(current.id);

    return this.#viewOf(current.id, viewer);
  }

  /**
   * The approval rules a write leaves on `toolkit`: `change` cleaned (`null` clears them, `undefined` keeps the
   * toolkit's), or why not: a mark of another toolkit's tool, or a team or member the org does not have.
   */
  #rulesChange(
    toolkit: Toolkit,
    change: UpdateToolkit["approval_rules"],
  ): ToolsResult<StoredApprovalRules | undefined> {
    if (change === undefined) return ok(toolkit.approvalRules);

    if (change === null) return ok(undefined);
    const cleaned = cleanApprovalRules(toolkit.id, change);

    if ("refused" in cleaned) return refuse("invalid", cleaned.refused);

    for (const approver of approversOf(cleaned)) {
      if (approver.kind === "team" && this.#core.team(approver.id) === undefined)
        return refuse("invalid", `the org has no team ${approver.id}`);

      if (approver.kind === "members") {
        const missing = approver.ids.find((member) => this.#core.member(member) === undefined);

        if (missing !== undefined) return refuse("invalid", `the org has no member ${missing}`);
      }
    }

    return ok(noRules(cleaned) ? undefined : cleaned);
  }

  /**
   * Replaces an uploaded document (managers): an OpenAPI or Discovery document, a GraphQL schema's SDL (#204), and
   * builds its tool list from it. A GraphQL toolkit built from introspection takes a first SDL file too (an endpoint
   * that stopped answering introspection), and is built from uploaded files from then on: the cron task leaves it
   * alone, and a build needs no credential. A document that cannot be read replaces nothing, nor does a Discovery
   * document whose rootUrl the outbound guard refuses (`outbound_refused`).
   */
  async replaceDocument(
    viewer: Viewer,
    id: string,
    revision: number,
    document: string,
    by: string,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<ToolkitView>> {
    const toolkit = this.#managed(id, viewer);

    if (!toolkit.ok) return toolkit;
    const current = toolkit.value;

    if (current.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${current.revision}, not ${revision}`);

    if (current.builtIn || (!current.uploaded && current.kind !== "graphql"))
      return refuse("invalid", "the toolkit is not built from an uploaded document");

    if (current.kind === "graphql" && new TextEncoder().encode(document).byteLength > MAX_SDL_BYTES)
      return {
        ...refuse("body_too_large", `the schema is larger than ${MAX_SDL_BYTES} bytes`),
        path: "document",
      };

    const listing = await this.#listing(KIND_DRIVERS[current.kind], {
      toolkit: current,
      secret: NO_SECRET,
      document,
      timeout: LISTING_TIMEOUT,
      policy,
    });

    if (Result.isFailure(listing))
      return sourceRefusal(listing.failure) ?? refuse("invalid", listing.failure.message);

    // The document was read with nothing awaited after the revision was checked: no other edit came in between.
    const now = this.#now();

    this.#core.transaction(() => {
      this.#store.putDocument(id, document);
      this.#store.documentUploaded(id, by, now);
      this.#storeListing(id, listing);
    });

    return this.#viewOf(id, viewer);
  }

  /**
   * A toolkit's uploaded document (an OpenAPI or Discovery document, a GraphQL schema's SDL), for its managers only: a
   * document may describe more of an API than its tools show (a member who reads the toolkit sees its tool list).
   */
  toolkitDocument(viewer: Scope, id: string): ToolsResult<ToolkitDocument> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

    if (access === "read")
      return refuse("forbidden", "only an org admin reads an org toolkit's document");

    const document = uploaded(toolkit) ? this.#store.document(id) : undefined;

    return document === undefined
      ? refuse("not_found", "the toolkit has no uploaded document")
      : ok({ document });
  }

  /** Removes a toolkit with all it holds; an org admin may remove a member's private toolkit too. */
  removeToolkit(viewer: Scope, id: string, revision: number): ToolsResult<{ readonly id: string }> {
    const toolkit = this.#toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none") return NOT_FOUND;

    if (access === "read")
      return refuse("forbidden", "only an org admin can remove an org toolkit");

    const stored = this.#stored(toolkit);

    if (!stored.ok) return stored;

    if (stored.value.revision !== revision)
      return refuse(
        "conflict",
        `the toolkit is at revision ${stored.value.revision}, not ${revision}`,
      );

    this.#core.transaction(() => {
      this.#store.deleteToolkit(id);
      this.#core.spend.forget("toolkit_credential", id);
    });
    this.#schemas.forget(id);

    return ok({ id });
  }

  // --- credentials ------------------------------------------------------------------------------------------------

  /**
   * Connects the toolkit's shared credential (org admins) or the caller's private one, replacing what was there, and
   * builds the tool list if it was never built. A shared credential names who may use it (`subject`): there is no
   * default tool grant, so the subject's grant of every tool is written with it, unless the subject holds a grant on
   * the toolkit already (which stays as it is). The answer's `grant` says which.
   */
  async connectCredential(
    viewer: Viewer,
    id: string,
    slot: CredentialSlot,
    credential: ConnectCredential,
    by: string,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<ConnectedToolkitView>> {
    const target = this.#credentialTarget(viewer, id, slot);

    if (!target.ok) return target;
    const { toolkit, owner } = target.value;
    const placed = secretOf(credential, toolkit.catalog?.credential, "name");

    if (!placed.ok) return placed;
    const secret = placed.value;

    const refused =
      this.#credentialRefusal(toolkit, slot, secret) ??
      (await keyRefused(secret, toolkit.credentialSettings));

    if (refused !== undefined) return refused;
    const grant = this.#connectGrant(id, slot, credential.subject);

    if (!grant.ok) return grant;
    const now = this.#now();

    const connected = this.#core.transaction(() => {
      this.#store.putCredential(id, owner, secret, by, now);

      return grant.value === undefined ? undefined : this.#grantOnConnect(grant.value, by, now);
    });

    if (toolkit.listBuiltAt === undefined) await this.#buildFor(id, viewer.member, policy);

    return withGrant(this.#viewOf(id, viewer), connected);
  }

  disconnectCredential(viewer: Viewer, id: string, slot: CredentialSlot): ToolsResult<ToolkitView> {
    const target = this.#credentialTarget(viewer, id, slot);

    if (!target.ok) return target;

    const removed = this.#core.transaction(() => {
      if (!this.#store.deleteCredential(id, target.value.owner)) return false;

      // The shared credential's Spend limits go with it, as a Models credential's do.
      if (target.value.owner === undefined) this.#core.spend.forget("toolkit_credential", id);

      return true;
    });

    if (!removed) return refuse("not_found", "no such credential is connected");

    return this.#viewOf(id, viewer);
  }

  // --- OAuth sign-ins (#202) --------------------------------------------------------------------------------------

  /**
   * Sets the toolkit's own OAuth app (its managers: org admins for an org toolkit, the owner for a private one), its
   * secret sealed. The routes checked its URLs with the outbound guard; sign-ins already done keep the client they
   * signed in with until their next token refresh, when a changed client needs sign-in again.
   */
  setOAuthApp(viewer: Scope, id: string, app: SetOAuthApp, by: string): ToolsResult<ToolkitView> {
    const managed = this.#managed(id, viewer);

    if (!managed.ok) return managed;
    // A built-in toolkit signs in to nothing: its credential is Commissary's own binding.
    const stored = this.#stored(managed.value);

    if (!stored.ok) return stored;
    const clientId = app.client_id.trim();
    const scopes = (app.scopes ?? []).map((scope) => scope.trim()).filter((scope) => scope !== "");

    if (clientId === "") return refuse("invalid", "an OAuth app needs its client id");

    if (scopes.some((scope) => /\s/.test(scope)))
      return refuse("invalid", "a scope holds no spaces: list each one");

    const issuer = app.issuer?.trim() ?? "";

    if (issuer !== "" && !URL.canParse(issuer))
      return refuse("invalid", "the issuer is the authorization server's URL");

    if ([clientId, app.client_secret ?? "", issuer, ...scopes].some((value) => value.length > 8192))
      return refuse("invalid", "the OAuth app is too long");

    // An OAuth 1.0a consumer signs every request with its secret (#206).
    if (app.request_token_url !== undefined && (app.client_secret ?? "") === "")
      return refuse("invalid", "an OAuth 1.0a app needs its consumer secret (client_secret)");

    this.#oauth.putApp({
      toolkitId: id,
      clientId,
      clientSecret: app.client_secret === "" ? undefined : app.client_secret,
      authorizeUrl: app.authorize_url,
      tokenUrl: app.token_url,
      scopes,
      issuer: issuer === "" ? undefined : issuer,
      requestTokenUrl: app.request_token_url,
      updatedAt: this.#now(),
      updatedBy: by,
    });

    return this.#viewOf(id, viewer);
  }

  clearOAuthApp(viewer: Scope, id: string): ToolsResult<ToolkitView> {
    const managed = this.#managed(id, viewer);

    if (!managed.ok) return managed;
    // A built-in toolkit signs in to nothing: its credential is Commissary's own binding.
    const stored = this.#stored(managed.value);

    if (!stored.ok) return stored;

    if (!this.#oauth.deleteApp(id)) return refuse("not_found", "the toolkit has no OAuth app");

    return this.#viewOf(id, viewer);
  }

  /**
   * Starts an OAuth 2 authorization code sign-in with PKCE for the toolkit's shared credential (org admins, naming its
   * `subject` as connecting one does) or the caller's private one, with the toolkit's OAuth app or Commissary as the
   * MCP server's client (`prepareSignIn`). An OAuth app that sets no scopes asks for those the toolkit's tools name (a
   * Discovery toolkit's methods', #205). An OAuth app that names a temporary credential request URL is an OAuth 1.0a
   * consumer, and the sign-in OAuth 1.0a's (#206, {@link #startOAuth1SignIn}). Answers the URL the browser opens; the
   * callback finishes it ({@link completeSignIn}).
   */
  async startSignIn(
    viewer: Viewer,
    id: string,
    slot: CredentialSlot,
    input: StartSignIn,
    by: string,
    policy: OutboundPolicy,
    urls: ClientUrls,
  ): Promise<ToolsResult<SignInStarted>> {
    // Only its starter finishes a sign-in, at the callback: a member of the org.
    if (viewer.member === undefined)
      return refuse("forbidden", "only a member of the org signs in to a toolkit");
    const target = this.#credentialTarget(viewer, id, slot);

    if (!target.ok) return target;
    const { toolkit, owner } = target.value;
    const refused = this.#slotRefusal(toolkit, slot);

    if (refused !== undefined) return refused;
    const grant = this.#connectGrant(id, slot, input.subject);

    if (!grant.ok) return grant;
    const app = this.#appFor(id);

    if (app?.requestTokenUrl !== undefined)
      return await this.#startOAuth1SignIn(
        { toolkit, owner, member: viewer.member, subject: input.subject, by },
        { ...app, requestTokenUrl: app.requestTokenUrl },
        policy,
        urls,
      );

    const prepared = await this.#outboundRun(
      prepareSignIn({
        toolkitId: id,
        source: toolkit.source,
        // An OAuth app that sets no scopes asks for the ones the toolkit's tools name (a Discovery toolkit's, #205).
        app:
          app === undefined || app.scopes.length > 0
            ? app
            : { ...app, scopes: scopesOf(this.#store.tools(id)) },
        registered: this.#oauth.client(id),
        urls,
      }),
      policy,
    );

    if (Result.isFailure(prepared)) return signInRefusal(prepared.failure);
    const { flow, authorizationEndpoint, scopes } = prepared.success;
    const now = this.#now();
    const pkce = await newPkce();
    const state = newSignInState(this.#core.org);

    const session = this.#oauth.start(
      {
        state,
        toolkitId: id,
        owner,
        startedBy: viewer.member,
        flow: { kind: "oauth2", ...flow, verifier: pkce.verifier, by, subject: input.subject },
      },
      now,
    );

    return ok({
      state,
      url: authorizationUrl(authorizationEndpoint, flow, state, pkce.challenge, scopes),
      expires_at: iso(session.deadlineAt),
    });
  }

  /**
   * Where a sign-in `viewer` started on the toolkit `id` stands. Only its starter reads it (an org admin any sign-in of
   * the shared credential); another's, or one unknown or expired, is not found.
   */
  signInStatus(viewer: Viewer, id: string, state: string): ToolsResult<SignInStatus> {
    const session = this.#oauth.session(state, this.#now());

    const mine =
      session !== undefined &&
      session.toolkitId === id &&
      (session.owner === undefined
        ? viewer.admin || (viewer.member !== undefined && session.startedBy === viewer.member)
        : session.owner === viewer.member);

    if (!mine) return refuse("not_found", "no such sign-in");

    if (session.completed) return ok({ status: "ok" });

    return session.status === ""
      ? ok({ status: "wait" })
      : ok({ status: "error", message: session.status });
  }

  /**
   * The callback of a sign-in: its state is single-use and lives {@link CALLBACK_WINDOW_MS}, so an unknown, used or
   * expired one is `rejected` (as is another org's, which this object never started). Only the member who started it
   * finishes it (the request's, `callback.member`): anyone else's callback is `rejected` too, and leaves it pending for
   * its starter. When the flow knows the authorization server's issuer, the answer must name it (`iss`, RFC 9207: the
   * server said it would, or the toolkit's OAuth app names one), before anything else in it is read, an error included
   * (§2.4); its code is exchanged with the PKCE verifier, and the tokens become the credential, a shared one with its
   * subject's grant as connecting one writes it. A dynamic registration made for the sign-in is kept for the toolkit
   * then, in place of the one before. An OAuth 1.0a sign-in's verifier gets its token credentials instead
   * ({@link #completeOAuth1}). A failure is the sign-in's, for its starter to read.
   */
  async completeSignIn(
    callback: SignInCallback,
    policy: OutboundPolicy,
  ): Promise<SignInCallbackOutcome> {
    const pending = this.#oauth.session(callback.state, this.#now());

    if (pending === undefined || pending.startedBy !== callback.member)
      return { outcome: "rejected" };
    const session = this.#oauth.take(callback.state, this.#now());

    if (session?.flow === undefined) return { outcome: "rejected" };
    const { flow, toolkitId, owner } = session;

    const fail = (message: string): SignInCallbackOutcome => {
      this.#oauth.fail(session.state, message, this.#now());

      return { outcome: "failed" };
    };

    let secret: StoredSecret;
    const registered = flow.kind === "oauth1" ? undefined : flow.registered;

    if (flow.kind === "oauth1") {
      const done = await this.#completeOAuth1(toolkitId, flow, callback, policy);

      if (typeof done === "string") return fail(done);
      secret = done;
    } else {
      const exchanged = await this.#exchangeCallbackCode(toolkitId, flow, callback, policy);

      if (typeof exchanged === "string") return fail(exchanged);
      secret = exchanged;
    }

    // What the toolkit takes may have changed while the browser was away.
    const toolkit = this.#store.toolkit(toolkitId);
    const slot: CredentialSlot = owner === undefined ? "shared" : "private";

    if (toolkit === undefined) return fail("the toolkit was removed");
    const refused = this.#slotRefusal(toolkit, slot);

    if (refused !== undefined) return fail(refused.message);
    const grant = this.#connectGrant(toolkitId, slot, flow.subject);

    if (!grant.ok) return fail(grant.message);
    const now = this.#now();

    this.#core.transaction(() => {
      this.#store.putCredential(toolkitId, owner, secret, flow.by, now);

      if (registered !== undefined) this.#oauth.putClient(registered, now);

      if (grant.value !== undefined) this.#grantOnConnect(grant.value, flow.by, now);
      this.#oauth.complete(session.state, now);
    });

    await this.#wake();

    if (toolkit.listBuiltAt === undefined) await this.#buildFor(toolkitId, owner, policy);

    return { outcome: "completed" };
  }

  /**
   * An OAuth 2 callback's tokens: the issuer checked (RFC 9207) before anything else in the answer, an error included,
   * then its code exchanged with the PKCE verifier; or why not, for the sign-in's starter.
   */
  async #exchangeCallbackCode(
    toolkitId: string,
    flow: OAuth2SignInFlow,
    callback: SignInCallback,
    policy: OutboundPolicy,
  ): Promise<OAuthSecret | string> {
    const fail = (message: string) => message;

    if (
      flow.issuer !== undefined &&
      (callback.iss === undefined ? flow.issRequired : callback.iss !== flow.issuer)
    )
      return fail("the answer did not come from the toolkit's authorization server");

    if (callback.error !== "")
      return fail(
        /^[A-Za-z0-9_.-]{1,64}$/.test(callback.error)
          ? `the authorization server did not sign in (${callback.error})`
          : "the authorization server did not sign in",
      );

    if (callback.code === "") return fail("the authorization server answered no code");
    const { registered } = flow;

    const client =
      flow.via === "cimd"
        ? { secret: undefined }
        : registered === undefined
          ? this.#clientSecret(toolkitId, flow.via, flow.clientId)
          : { secret: registered.clientSecret };

    if (client === undefined) return fail("the toolkit's OAuth client changed: sign in again");

    const exchanged = await this.#outboundRun(
      exchangeCode(flow, client.secret, callback.code, this.#now()),
      policy,
    );

    return Result.isFailure(exchanged) ? fail(exchanged.failure.message) : exchanged.success;
  }

  /**
   * Starts an OAuth 1.0a sign-in (#206) with the toolkit's OAuth app as the consumer: temporary credentials asked for
   * with the callback naming the sign-in's state, kept (sealed) in its flow, and the authorization URL for the browser.
   */
  async #startOAuth1SignIn(
    target: {
      readonly toolkit: StoredToolkit;
      readonly owner: string | undefined;
      readonly member: string;
      readonly subject: GrantSubject | undefined;
      readonly by: string;
    },
    app: OAuthApp & { readonly requestTokenUrl: string },
    policy: OutboundPolicy,
    urls: ClientUrls,
  ): Promise<ToolsResult<SignInStarted>> {
    const { toolkit, owner, member, subject, by } = target;
    const state = newSignInState(this.#core.org);
    const callback = new URL(urls.callback);

    callback.searchParams.set("state", state);

    const now = this.#now();

    const started = await this.#outboundRun(
      Effect.gen(function* () {
        const consumer = oauth1Consumer(app, toolkit.credentialSettings);

        const temporary = yield* requestTemporaryCredentials(
          app.requestTokenUrl,
          consumer,
          callback.toString(),
          now,
        );

        return { temporary, url: yield* oauth1AuthorizeUrl(app.authorizeUrl, temporary.token) };
      }),
      policy,
    );

    if (Result.isFailure(started)) return signInRefusal(started.failure);
    const { temporary, url } = started.success;

    const session = this.#oauth.start(
      {
        state,
        toolkitId: toolkit.id,
        owner,
        startedBy: member,
        flow: {
          kind: "oauth1",
          consumerKey: app.clientId,
          tokenRequestUrl: app.tokenUrl,
          token: temporary.token,
          tokenSecret: temporary.tokenSecret,
          by,
          subject,
        },
      },
      this.#now(),
    );

    return ok({ state, url, expires_at: iso(session.deadlineAt) });
  }

  /**
   * An OAuth 1.0a callback's token credentials (#206): the token it names must be the sign-in's temporary one, and its
   * verifier gets the token credentials, signed with the temporary ones; the consumer is the toolkit's OAuth app as it
   * is now, which must still be the one the sign-in started with. Or why not, for the sign-in's starter.
   */
  async #completeOAuth1(
    toolkitId: string,
    flow: OAuth1SignInFlow,
    callback: SignInCallback,
    policy: OutboundPolicy,
  ): Promise<StoredSecret | string> {
    const verifier = callback.oauthVerifier ?? "";

    if (verifier === "" || callback.oauthToken !== flow.token) return "the service did not sign in";
    const app = this.#appFor(toolkitId);
    const toolkit = this.#store.toolkit(toolkitId);

    if (
      app?.clientSecret === undefined ||
      app.clientId !== flow.consumerKey ||
      toolkit === undefined
    )
      return "the toolkit's OAuth app changed: sign in again";
    const consumer = oauth1Consumer(app, toolkit.credentialSettings);

    const granted = await this.#outboundRun(
      requestTokenCredentials(
        flow.tokenRequestUrl,
        { ...consumer, token: flow.token, tokenSecret: flow.tokenSecret },
        verifier,
        this.#now(),
      ),
      policy,
    );

    if (Result.isFailure(granted)) return granted.failure.message;

    return {
      kind: "oauth1",
      consumer_key: app.clientId,
      consumer_secret: app.clientSecret,
      token: granted.success.token,
      token_secret: granted.success.tokenSecret,
    };
  }

  /** The toolkit and the owner of the credential `viewer` reaches in `slot`, or why not. */
  #credentialTarget(
    viewer: Viewer,
    id: string,
    slot: CredentialSlot,
  ): ToolsResult<{ readonly toolkit: StoredToolkit; readonly owner: string | undefined }> {
    const found = this.#toolkit(id);

    if (found === undefined) return NOT_FOUND;
    const access = reach(found, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

    // A built-in toolkit's credential is Commissary's own binding.
    const stored = this.#stored(found);

    if (!stored.ok) return stored;
    const toolkit = stored.value;

    if (slot === "shared") {
      if (toolkit.owner !== undefined)
        return refuse("not_accepted", "a private toolkit takes its owner's credential only");

      if (access !== "full")
        return refuse("forbidden", "only an org admin can manage a toolkit's shared credential");

      return ok({ toolkit, owner: undefined });
    }

    if (viewer.member === undefined)
      return refuse("forbidden", "only a member can hold a private credential");

    return ok({ toolkit, owner: viewer.member });
  }

  /** Why `secret` cannot go into `slot` of `toolkit`, if it cannot. */
  #credentialRefusal(
    toolkit: Pick<StoredToolkit, "owner" | "accepts" | "credentialSettings">,
    slot: CredentialSlot,
    secret: ToolkitSecret,
  ): ToolsResult<never> | undefined {
    const refused = this.#slotRefusal(toolkit, slot);

    if (refused !== undefined) return refused;

    if (secret.kind === "client_credentials" && slot === "private")
      return refuse("invalid", "a client credentials grant is a shared credential only");

    const invalid = secretRefusal(secret) ?? credentialRefusal(secret, toolkit.credentialSettings);

    return invalid === undefined ? undefined : refuse("invalid", invalid);
  }

  /** Why `toolkit` takes no credential in `slot`, if it takes none. */
  #slotRefusal(
    toolkit: Pick<Toolkit, "owner" | "accepts">,
    slot: CredentialSlot,
  ): ToolsRefusal | undefined {
    if (!accepts(toolkit, slot))
      return refuse("not_accepted", `the toolkit does not accept a ${slot} credential`);

    if (slot === "private" && !this.#privateAllowed(toolkit))
      return toolkit.owner === undefined
        ? refuse(
            "private_credentials_unavailable",
            "the org does not let members hold private credentials",
          )
        : refuse(
            "private_toolkits_unavailable",
            "the org does not let members use private toolkits",
          );

    return undefined;
  }

  /**
   * The grant connecting a credential in `slot` of the toolkit `id` writes: a shared credential's for the subject it
   * names (refused without one: nobody would reach it), none for a private credential, which names no subject.
   */
  #connectGrant(
    id: string,
    slot: CredentialSlot,
    subject: GrantSubject | undefined,
  ): ToolsResult<ToolGrantValue | undefined> {
    if (slot === "private")
      return subject === undefined
        ? ok(undefined)
        : refuse("invalid", "a private credential is its owner's alone: it names no subject");

    if (subject === undefined)
      return refuse(
        "invalid",
        "connecting a shared credential names who may use it (subject): there is no default tool grant",
      );

    const grant = cleanToolGrant(connectGrant(subject, id));

    if ("ok" in grant) return grant;
    const missing = this.#subjectRefusal(grant.subject);

    return missing === undefined ? ok(grant) : refuse("invalid", missing);
  }

  /**
   * Writes the grant a shared credential was connected for, unless its subject holds a grant on the toolkit already
   * (that one is kept as it is); answers which.
   */
  #grantOnConnect(grant: ToolGrantValue, by: string, now: number): ConnectedGrant {
    const held = this.#grants.heldOn(grant.subject, grant.toolkit);

    if (held !== undefined) return { id: held.id, created: false };

    const written = this.#grants.write({ revision: 0, value: grant }, by, now);

    if (!written.ok) throw new Error(`the connect grant was refused: ${written.message}`);

    return { id: written.id, created: true };
  }

  /**
   * Whether the org lets a private credential of `toolkit` be connected and used: on an org toolkit while members may
   * hold private credentials, on a private toolkit (its owner's) while they may use private toolkits. The two settings
   * are apart (ADR 0038).
   */
  #privateAllowed(toolkit: Pick<Toolkit, "owner">): boolean {
    return toolkit.owner === undefined
      ? this.#core.privateCredentials()
      : this.#core.privateToolkits();
  }

  /**
   * Whose private toolkits are in the set the MCP endpoint serves `member`: theirs while the org allows private
   * toolkits, none otherwise (they are kept, but neither served nor shadowing an org toolkit of their name).
   */
  #servedMember(member: string | undefined): string | undefined {
    return this.#core.privateToolkits() ? member : undefined;
  }

  // --- tool lists -------------------------------------------------------------------------------------------------

  /** Builds a toolkit's tool list now, with the credential the caller's build would use. */
  async refreshToolList(
    viewer: Viewer,
    id: string,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<ToolsList>> {
    const toolkit = this.#toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

    // A built-in toolkit's tool list is Commissary's own, never built from a source.
    const stored = this.#stored(toolkit);

    if (!stored.ok) return stored;

    // A shared credential the toolkit no longer accepts is not used, so it does not make the build an admin's.
    if (
      access === "read" &&
      accepts(toolkit, "shared") &&
      this.#store.credential(id, undefined) !== undefined
    )
      return refuse(
        "forbidden",
        "only an org admin can refresh a toolkit with a shared credential",
      );

    const built = await this.#buildFor(id, viewer.member, policy);

    if (!built.ok) return built;

    return this.listTools(viewer, id);
  }

  /**
   * Cron task `tool-list-refresh`: rebuilds every toolkit's list with its shared credential, or a private toolkit's with
   * its owner's. An org toolkit with private credentials only waits for a member to refresh it. An OpenAPI toolkit's
   * document is fetched again (no credential needed), a GraphQL endpoint introspected again; an uploaded document or
   * schema is skipped.
   */
  async refreshToolLists(policy: OutboundPolicy): Promise<RefreshSummary> {
    const toolkits = this.#store.toolkits();

    // A credential that needs sign-in again would only fail.
    const due = toolkits.filter((toolkit) => {
      const driver = KIND_DRIVERS[toolkit.kind];

      return (
        driver.refreshed(toolkit) &&
        (!driver.listsWithCredential(toolkit) ||
          this.#credentialFor(toolkit, toolkit.owner)?.needsSignIn === false)
      );
    });

    // A few builds at once, each on a shorter budget than an interactive refresh, so one slow server does not hold the
    // others or the cron invocation.
    const outcomes = await Effect.runPromise(
      Effect.forEach(
        due,
        (toolkit) =>
          Effect.promise(() =>
            this.#buildFor(toolkit.id, toolkit.owner, policy, CRON_BUILD_TIMEOUT),
          ),
        { concurrency: CRON_CONCURRENCY },
      ),
    );

    const built = outcomes.filter((outcome) => outcome.ok).length;

    return {
      built,
      failed: outcomes.length - built,
      skipped: toolkits.length - due.length,
    };
  }

  /**
   * The credential a build of `toolkit` asked for by `member` uses: the shared credential, or, if there is none, the
   * member's private one (a private toolkit's is its owner's). A private credential counts only while the org allows
   * it ({@link #privateAllowed}).
   */
  #credentialFor(toolkit: Toolkit, member: string | undefined): ToolkitCredential | undefined {
    if (toolkit.owner === undefined && accepts(toolkit, "shared")) {
      const shared = this.#store.credential(toolkit.id, undefined);

      if (shared !== undefined) return shared;
    }

    if (member === undefined || !accepts(toolkit, "private") || !this.#privateAllowed(toolkit))
      return undefined;

    if (toolkit.owner !== undefined && toolkit.owner !== member) return undefined;

    return this.#store.credential(toolkit.id, member);
  }

  // --- signing requests in (#202) ---------------------------------------------------------------------------------

  /**
   * What signs a request on `credential` in now: a static secret as it is, an OAuth credential's access token, with a
   * token refresh first when it expires within {@link EXPIRY_MARGIN_MS} (a client credentials grant, a JWT, a GitHub
   * App or a token exchange mints its first one, #206), or what the toolkit's credential settings make of a connected
   * secret (an OAuth 1.0a or SigV4 signer, a compound credential's template).
   */
  async #signedIn(
    toolkit: Toolkit,
    credential: ToolkitCredential,
    policy: OutboundPolicy,
  ): Promise<Signed> {
    if (credential.needsSignIn) return NEEDS_SIGN_IN;
    const secret = this.#store.secret(credential.toolkitId, credential.owner);

    if (secret === undefined) return NEEDS_SIGN_IN;

    if (secret.kind === "oauth")
      return fresh(secret.expires_at, this.#now())
        ? bearer(secret.access_token)
        : await this.#refresh(toolkit, credential, policy);

    if (isMinted(secret)) {
      // A token minted with settings since changed (or removed) is not used.
      const settings = mintedWith(secret.kind, settingsOf(toolkit));

      if (typeof settings !== "string") return { kind: "failed", message: settings.failed };

      return secret.access_token !== undefined &&
        (secret.minted_with ?? "") === settings &&
        fresh(secret.expires_at, this.#now())
        ? bearer(secret.access_token)
        : await this.#refresh(toolkit, credential, policy);
    }

    const upstream = upstreamOf(secret, settingsOf(toolkit));

    return "failed" in upstream
      ? { kind: "failed", message: upstream.failed }
      : { kind: "signed", secret: upstream };
  }

  /**
   * A token refresh of an OAuth credential: refreshes an authorization code sign-in's tokens, mints a client credentials
   * grant's token again. Concurrent callers (the alarm, calls that met an expired token or a `401`) share one. A token
   * endpoint that refuses it, a sign-in without a refresh token and one whose client is gone (the toolkit's OAuth app or
   * registration changed) mark the credential as needing sign-in; a token refresh that may pass later is tried again by
   * the alarm after {@link REFRESH_RETRY_MS}. Each failure is logged (`toolkit token refresh failed`), never a token.
   */
  #refresh(
    toolkit: Toolkit,
    credential: ToolkitCredential,
    policy: OutboundPolicy,
  ): Promise<Signed> {
    const key = `${credential.toolkitId}/${credential.owner ?? ""}`;
    const running = this.#refreshes.get(key);

    if (running !== undefined) return running;

    const refresh = this.#refreshNow(toolkit, credential, policy).finally(() =>
      this.#refreshes.delete(key),
    );

    this.#refreshes.set(key, refresh);

    return refresh;
  }

  async #refreshNow(
    toolkit: Toolkit,
    credential: ToolkitCredential,
    policy: OutboundPolicy,
  ): Promise<Signed> {
    const { toolkitId, owner, connectedAt } = credential;
    const secret = this.#store.secret(toolkitId, owner);

    const needsSignIn = async (failure: RefreshFailure): Promise<Signed> => {
      await Effect.runPromise(refreshFailed(credential, failure));
      this.#store.markNeedsSignIn(toolkitId, owner, connectedAt);
      await this.#wake();

      return NEEDS_SIGN_IN;
    };

    let refresh: Effect.Effect<
      OAuthSecret | (MintedSecret & { readonly access_token: string }),
      OAuthError,
      HttpClient.HttpClient
    >;

    const settings = settingsOf(toolkit);

    const fingerprint =
      secret !== undefined && isMinted(secret) ? mintedWith(secret.kind, settings) : "";

    const now = this.#now();

    if (typeof fingerprint !== "string") return { kind: "failed", message: fingerprint.failed };

    if (secret?.kind === "oauth") {
      const refreshToken = secret.refresh_token;

      if (refreshToken === undefined) return await needsSignIn({ reason: "no_refresh_token" });
      const client = this.#clientSecret(toolkitId, secret.via, secret.client_id);

      if (client === undefined) return await needsSignIn({ reason: "client_changed" });

      refresh = refreshTokens(
        { ...secret, refresh_token: refreshToken },
        client.secret,
        this.#now(),
      );
    } else if (secret?.kind === "client_credentials")
      refresh = mintClientCredentials(secret, toolkit.source, now);
    else if (secret?.kind === "jwt")
      refresh = mintJwt(secret, settings?.jwt, now).pipe(
        Effect.map(withToken(secret, fingerprint)),
      );
    else if (secret?.kind === "app")
      refresh = mintGitHubApp(secret, settings?.app, now).pipe(
        Effect.map(withToken(secret, fingerprint)),
      );
    else if (secret?.kind === "token_exchange")
      refresh = exchangeToken(secret, settings?.token_exchange, now).pipe(
        Effect.map(withToken(secret, fingerprint)),
      );
    else return NEEDS_SIGN_IN;

    const refreshed = await this.#outboundRun(refresh, policy);

    if (Result.isFailure(refreshed)) {
      const { reason, status, code } = refreshed.failure;

      if (refusedForGood(refreshed.failure)) return await needsSignIn({ reason, status, code });

      await Effect.runPromise(refreshFailed(credential, { reason, status, code }));
      this.#store.deferRefresh(toolkitId, owner, this.#now() + REFRESH_RETRY_MS);
      await this.#wake();

      return { kind: "failed", message: refreshed.failure.message };
    }

    const kept = this.#store.refreshSecret(
      toolkitId,
      owner,
      connectedAt,
      refreshed.success,
      this.#now(),
    );

    await this.#wake();

    return kept
      ? bearer(refreshed.success.access_token)
      : { kind: "failed", message: "the credential changed meanwhile: try again" };
  }

  /**
   * The secret of the client an OAuth credential's tokens were issued to: none for Commissary's CIMD document, the
   * registration's or the toolkit's OAuth app's. Undefined when that client is gone or is another one now.
   */
  #clientSecret(
    toolkitId: string,
    via: ClientVia,
    clientId: string,
  ): { readonly secret: string | undefined } | undefined {
    if (via === "cimd") return { secret: undefined };

    const client = via === "app" ? this.#appFor(toolkitId) : this.#oauth.client(toolkitId);

    return client === undefined || client.clientId !== clientId
      ? undefined
      : { secret: client.clientSecret };
  }

  /** Runs `effect` through the outbound guard with `policy`. */
  #outboundRun<A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient>,
    policy: OutboundPolicy,
  ): Promise<Result.Result<A, E>> {
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(OutboundHttpClientLive),
        Effect.provideService(CurrentOutboundPolicy, policy),
        Effect.result,
      ),
    );
  }

  /**
   * Runs `request` (a driver's list or call, {@link KIND_DRIVERS}) signed in with `credential`; when the upstream
   * refuses an OAuth credential's token (`401`: a failure that says so, or an answer `refusedAnswer` says is one), the
   * token gets a refresh and `request` runs once again.
   */
  async #withCredential<A>(
    toolkit: Toolkit,
    credential: ToolkitCredential,
    policy: OutboundPolicy,
    request: (secret: UpstreamSecret) => Effect.Effect<A, KindFailure>,
    refusedAnswer: (answer: A) => boolean = () => false,
  ): Promise<Attempt<A>> {
    const run = (secret: UpstreamSecret) => Effect.runPromise(Effect.result(request(secret)));
    const signed = await this.#signedIn(toolkit, credential, policy);

    if (signed.kind !== "signed") return signed;
    const done = await run(signed.secret);

    if (!tokenRefused(done, refusedAnswer) || !refreshable(credential.kind))
      return { kind: "done", done };

    const refreshed = await this.#refresh(toolkit, credential, policy);

    if (refreshed.kind !== "signed") return refreshed;

    return { kind: "done", done: await run(refreshed.secret) };
  }

  /**
   * Builds the tool list of the toolkit `id` as its kind does ({@link KIND_DRIVERS}: from its MCP server or its GraphQL
   * endpoint's introspection with a credential, from its OpenAPI document or uploaded GraphQL schema without) and
   * stores it, with the schema calls read (a GraphQL toolkit's), or records why it failed.
   */
  async #buildFor(
    id: string,
    member: string | undefined,
    policy: OutboundPolicy,
    timeout: Duration.Input = LISTING_TIMEOUT,
  ): Promise<ToolsResult<true>> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const driver = KIND_DRIVERS[toolkit.kind];

    const input = (secret: UpstreamSecret): ListInput => ({
      toolkit,
      secret,
      document: uploaded(toolkit) ? this.#store.document(id) : undefined,
      timeout,
      policy,
    });

    let listing: Result.Result<Listing, KindFailure>;

    if (driver.listsWithCredential(toolkit)) {
      const credential = this.#credentialFor(toolkit, member);

      if (credential === undefined)
        return refuse("no_credential", "the toolkit has no credential to list its tools with");

      const attempt = await this.#withCredential(toolkit, credential, policy, (secret) =>
        driver.list(input(secret)),
      );

      listing = attempt.kind === "done" ? attempt.done : Result.fail(notSigned(attempt));
    } else listing = await this.#listing(driver, input(NO_SECRET));

    // The toolkit may have gone while its source answered.
    if (this.#store.toolkit(id) === undefined) return NOT_FOUND;
    this.#core.transaction(() => this.#storeListing(id, listing));

    return Result.isSuccess(listing)
      ? ok(true)
      : refuse("tool_list_failed", listing.failure.message);
  }

  /** A build of a tool list by `driver`, run. */
  #listing(driver: KindDriver, input: ListInput): Promise<Result.Result<Listing, KindFailure>> {
    return Effect.runPromise(Effect.result(driver.list(input)));
  }

  /**
   * Stores a built tool list, with its warning as the list's error (cleared when it has none) and the schema it was
   * built from (a GraphQL toolkit's), or records why the build failed (the last good list and schema stay).
   */
  #storeListing(id: string, listing: Result.Result<Listing, KindFailure>): void {
    if (Result.isFailure(listing)) {
      this.#store.setListStatus(id, { error: listing.failure.message });

      return;
    }

    this.#store.replaceTools(id, listing.success.tools);
    this.#schemas.forget(id);

    if (listing.success.schema !== undefined) this.#store.putSchema(id, listing.success.schema);
    this.#store.setListStatus(id, { builtAt: this.#now(), warning: listing.success.warning });
  }

  /**
   * Updates the warning of `toolkit`'s list for its new base URL, unless its list's error is not the old base URL's
   * warning (a failed build's, which stays until the next build).
   */
  #rewarn(toolkit: StoredToolkit, baseUrl: string | undefined, policy: OutboundPolicy): void {
    const warn = KIND_DRIVERS[toolkit.kind].warning;

    if (warn === undefined) return;
    const tools = this.#store.tools(toolkit.id);

    if (toolkit.listError !== undefined && toolkit.listError !== warn(toolkit, tools, policy))
      return;

    this.#store.setListError(toolkit.id, warn({ baseUrl }, tools, policy));
  }

  /**
   * The tools of a toolkit, with their flags: an org toolkit's among the org's toolkits, a private toolkit's among the
   * org's and its owner's (none while the org does not serve private toolkits). The agents toolkit's (#229) only for a
   * caller that asks for it ({@link KindsOptions}).
   */
  listTools(viewer: Scope, id: string, options?: KindsOptions): ToolsResult<ToolsList> {
    const toolkit = this.#toolkit(id);

    if (toolkit === undefined || (isAgentsToolkit(toolkit) && options?.agentsToolkit !== true))
      return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;
    const resolution = this.#resolve(this.#servedMember(toolkit.owner));

    return ok({
      toolkit_id: id,
      tool_list: this.#listStatus(toolkit),
      tools: resolution.tools.filter((tool) => tool.toolkit.id === id).map(toolView),
    });
  }

  /**
   * The tools `member` may be served, one flat list of unique full names: the org's toolkits and their own private ones,
   * without hidden, clashing or missing tools (the MCP endpoint, #197, narrows it further).
   */
  servedTools(viewer: Viewer): ReadonlyArray<ToolView> {
    return this.#resolve(this.#servedMember(viewer.member)).tools.filter(isServed).map(toolView);
  }

  /**
   * The tools Commissary's MCP endpoint lists for `viewer` (#197), sorted by full name: the served tools they reach
   * (ADR 0038). A member uses every tool of their own private toolkits (while the org lets members add them) and every
   * tool of an org toolkit that takes private credentials, as themselves, while the org lets members hold private
   * credentials; and the tools of org toolkits' shared credentials their tool grants give (#198). There is no default
   * tool grant. A request with an API key (`apiKeyId`) gets what both the member's reach and the key's tool scope allow
   * (#200), read from the key on every request, so a change to the scope applies at once. An agent run (`run`, #227)
   * gets what its definition's tool scope allows, as its member or as the shared agent ({@link RunToolReach}).
   *
   * The agents toolkit's tools (#229) are listed only to a caller whose endpoint makes their calls (`options`), and
   * only while they may run an agent; `agents_start`'s description lists those agents, so it changes with them.
   */
  clientTools(
    viewer: Viewer,
    apiKeyId?: string,
    run?: RunToolReach,
    options?: ClientToolsOptions,
  ): ReadonlyArray<ClientTool> {
    const caller = this.#caller(viewer, apiKeyId, run);

    const reached = this.#reachable(viewer, {
      ...caller,
      agentsToolkit: options?.agentsToolkit === true,
    });

    return reached.map(({ tool }) => {
      const description =
        isAgentsToolkit(tool.toolkit) && tool.upstreamName === "start" && this.#agents !== undefined
          ? startDescription(runnableAgents(this.#agents, { member: viewer.member, ...caller }))
          : tool.description;

      return {
        name: tool.name,
        toolkit: tool.toolkit.name,
        ...(description === undefined ? {} : { description }),
        ...(tool.tool?.inputSchema === undefined ? {} : { inputSchema: tool.tool.inputSchema }),
        toolClass: tool.toolClass,
      };
    });
  }

  /**
   * Calls a tool `viewer` reaches ({@link clientTools}) by its full name, on the upstream tool of its upstream name.
   * The member's private credential wins over the shared one, which needs a grant (#198); without either the member
   * is asked to connect theirs. Each toolkit kind reaches its upstream its own way ({@link KIND_DRIVERS}: an MCP
   * toolkit in an upstream session, an OpenAPI toolkit with one HTTP request); a failure is logged with the toolkit and
   * the reason only.
   *
   * A priced call (#199) is checked against the Spend limits it would count toward before the upstream is reached, and
   * refused when one has no room; a free call goes ahead whatever the limits. It is charged once the upstream answered
   * with a result, an `isError` one included (the upstream did the work); a call that failed upstream is not.
   *
   * A built-in toolkit's tool (#212) is called on its provider, through Commissary's own binding (the toolkit's shared
   * credential, which a grant gives), and recorded and charged the same way; it always answers a result.
   *
   * After the Spend check, a call an approval rule makes wait (#201) goes no further until it is approved
   * ({@link #approvalOf}): on the caller's form, or in the panel, after which the same call goes through once. The
   * approved call is the one made again, so it passes the reach and Spend checks again on its way to the upstream (or
   * a built-in toolkit's provider: its rules apply as any toolkit's).
   *
   * A caller deployed before approvals (without `ToolCall.approvalOutcomes`) gets a call that waits, or was not
   * approved, as `failed`, an outcome it knows, with words that say so: its records say `upstream_failure` until it is
   * replaced (docs/DEVELOPMENT.md, "State RPC: expand, then contract").
   */
  async callTool(viewer: Viewer, call: ToolCall, policy: OutboundPolicy): Promise<ToolCallOutcome> {
    const held: Held = { open: false, computer: undefined };
    let outcome: ToolCallOutcome;

    try {
      outcome = await this.#callTool(viewer, call, policy, held);
    } finally {
      this.#release(held);
    }

    if (outcome.outcome === "plan_limited" && call.planOutcomes !== true)
      return {
        outcome: "failed",
        message: `the org's plan refused the call (${planLimitName(outcome.refusal)}); see the billing page in the panel`,
        usage: outcome.usage,
      };

    if (call.approvalOutcomes === true) return outcome;

    switch (outcome.outcome) {
      case "pending":
        return {
          outcome: "failed",
          message:
            `the call waits for approval (approval ${outcome.approval.id}, in the panel's approvals); once it is ` +
            `approved, call the tool again with the same arguments`,
          usage: outcome.usage,
        };
      case "not_approved":
        return {
          outcome: "failed",
          message:
            outcome.reason === "denied"
              ? "the call was not approved"
              : "the call waits for its caller's approval, which no one can give here",
          usage: outcome.usage,
        };
      default:
        return outcome;
    }
  }

  async #callTool(
    viewer: Viewer,
    call: ToolCall,
    policy: OutboundPolicy,
    held: Held,
  ): Promise<ToolCallOutcome> {
    const caller = this.#caller(viewer, call.apiKeyId, call.run);

    const reached = this.#reachable(viewer, {
      ...caller,
      agentsToolkit: call.agentsToolkit === true,
    }).find(
      ({ tool }) =>
        tool.name === call.name &&
        (call.toolkits === undefined || call.toolkits.includes(tool.toolkit.name)),
    );

    if (reached === undefined) return { outcome: "unknown" };
    const { tool, asMember, granted } = reached;
    const toolkit = tool.toolkit;
    const builtIn = this.#builtIn(toolkit.id);

    const own =
      builtIn === undefined &&
      asMember &&
      viewer.member !== undefined &&
      this.#store.credential(toolkit.id, viewer.member) !== undefined;

    // The member's own credential, or else the shared one a grant gives them; a built-in toolkit's shared credential
    // is Commissary's own binding, which only a grant reaches (it accepts no private credential).
    const owner = own ? viewer.member : undefined;
    const credential = own || granted ? this.#store.credential(toolkit.id, owner) : undefined;

    const serving =
      builtIn !== undefined
        ? granted
          ? { builtIn }
          : undefined
        : credential === undefined || toolkit.builtIn
          ? undefined
          : { credential, stored: toolkit };

    const usage = (
      used: CredentialSlot | undefined,
      costMicros = 0,
      approval: ToolCallApproval = "none",
      browserMs?: number,
    ): CallUsage => ({
      toolkitId: toolkit.id,
      toolId: stableId(toolkit.id, tool.upstreamName),
      credential: used,
      private: used === "private" || toolkit.owner !== undefined,
      costMicros,
      approval,
      ...(browserMs === undefined ? {} : { browserMs }),
    });

    if (serving === undefined)
      return {
        outcome: "connect",
        toolkit: { id: toolkit.id, name: toolkit.name },
        reason: "missing",
        slot: "private",
        usage: usage(undefined),
      };

    const slot: CredentialSlot = owner === undefined ? "shared" : "private";

    const signIn = (approval: ToolCallApproval = "none"): ToolCallOutcome => ({
      outcome: "connect",
      toolkit: { id: toolkit.id, name: toolkit.name },
      reason: "sign_in",
      slot,
      usage: usage(slot, 0, approval),
    });

    // A credential known to need a new sign-in answers so before anyone is asked to approve the call.
    if ("credential" in serving && serving.credential.needsSignIn) return signIn();

    const price = tool.priceMicros ?? 0;
    const ledger = this.#core.spend.ledger();
    const spender = spenderOf(viewer, call);

    // The toolkit's shared credential is a `toolkit_credential` limit's; a private one counts toward the API key's limits only.
    const charged: ChargedCredential = {
      id: toolkit.id,
      shared: slot === "shared",
      kind: "toolkit_credential",
    };

    // A built-in toolkit's price per hour of the time it meters (#214, #224), one mechanism: the browser toolkit's
    // browser time, the sandbox toolkit's computer time.
    const hourPrice =
      builtIn !== undefined && isHourPriced(builtIn.toolkit.kind)
        ? (this.#withSettings(builtIn.toolkit).hourPriceMicros ?? 0)
        : 0;

    // With a price per browser hour, a call that uses browser time (its tool says, `browserTimeOf`) counts toward the
    // limits as a priced call does; closing a session, or a tool that reaches no browser, does not.
    const timed =
      hourPrice > 0 &&
      builtIn?.toolkit.kind === "browser" &&
      browserTimeOf(tool.upstreamName) === "uses";

    // With a price per computer hour, a call that meets its session's computer (`meetsComputer`) is checked too, but
    // only the session can tell whether it meets one: with no room, it stops a running computer quietly and the call
    // goes on, saying so; only a command that would run on the computer is refused (#224).
    const computerPriced = hourPrice > 0 && builtIn?.toolkit.kind === "sandbox";
    const computerChecked = computerPriced && meetsComputer(tool.upstreamName);

    const noRoom =
      price > 0 || timed || computerChecked
        ? ledger.refusal(spender, charged, this.#now())
        : undefined;

    if (noRoom !== undefined && (price > 0 || timed)) {
      // A session whose browser time costs money is closed once a limit it counts toward has no room (#214), and a
      // sandbox session's running computer stopped (#224): the refused call never reaches the session, so the part
      // stops it, for a refused `sandbox_close` too.
      const closed =
        timed && builtIn?.calledBy === "part"
          ? await this.#closeSession(builtIn, viewer, call, policy, spender, charged)
          : false;

      const stopped =
        computerPriced && builtIn !== undefined
          ? await this.#stopComputer(builtIn, viewer, call, spender, charged, hourPrice)
          : false;

      return {
        outcome: "refused",
        refusal: noRoom,
        usage: usage(slot),
        ...(closed ? { sessionClosed: true as const } : {}),
        ...(stopped ? { computer: "stopped" as const } : {}),
      };
    }

    // Commissary Cloud's plan refuses a call that would do work beyond its limits before anyone is asked to approve it
    // (#241): nothing is counted here, and a call it refuses uses up no approval.
    const meter = this.#plans();

    const limited = async (found: PlanFound): Promise<ToolCallOutcome> => {
      // A session over the plan's browser hours is closed, as one over a Spend limit is (`#closeSession`); a running
      // computer is stopped (`#stopComputer`).
      const closed =
        found.session && builtIn?.calledBy === "part"
          ? await this.#closeSession(builtIn, viewer, call, policy, spender, charged)
          : false;

      const stopped =
        builtIn?.toolkit.kind === "sandbox" && meetsComputer(tool.upstreamName)
          ? await this.#stopComputer(builtIn, viewer, call, spender, charged, hourPrice, "plan")
          : false;

      return {
        outcome: "plan_limited",
        refusal: found.refusal,
        usage: usage(slot),
        ...(closed ? { sessionClosed: true as const } : {}),
        ...(stopped ? { computer: "stopped" as const } : {}),
      };
    };

    if (meter !== undefined) {
      const early = this.#planRefusal(meter, builtIn, tool.upstreamName, call);

      if (early !== undefined) return await limited(early);
    }

    // Only the `browser_ask_human` that starts a handoff asks a person anew (#216): one that waits on it, answers how it
    // ended, or carries the person's decline is held by no approval rule again.
    const continued = await this.#continuesHandoff(builtIn, viewer, call, tool);

    const approval = continued
      ? ({ kind: "go", approval: "none" } as const)
      : await this.#approvalOf(viewer, call, tool, slot);

    switch (approval.kind) {
      case "approve":
        return {
          outcome: "approve",
          toolkit: { id: toolkit.id, name: toolkit.name },
          arguments: call.arguments ?? {},
          requestState: approval.requestState,
        };
      case "pending":
        return {
          outcome: "pending",
          approval: {
            id: approval.approval.id,
            approver: approval.approval.approver,
            expiresAt: approval.approval.expiresAt,
          },
          usage: usage(slot, 0, "pending"),
        };
      case "not_approved":
        return {
          outcome: "not_approved",
          reason: approval.reason,
          usage: usage(slot, 0, "denied"),
        };
      case "go":
        break;
    }

    const approved = approval.approval;

    // The plan counts the call before any work (#241), and holds the ceilings' room for it while it is served: the
    // approval took time, in which others may have taken the room, so the ceilings are checked again, with nothing
    // awaited between the check and the hold. A call that ends a use (`endsUse`) is never refused.
    let counted: number | undefined;

    if (meter !== undefined) {
      const found = this.#planRefusal(meter, builtIn, tool.upstreamName, call, held);

      if (found !== undefined) return await limited(found);
      const admission = meter.admit(this.#now());

      if (admission.ok) counted = admission.monthStart;
      else if (!endsUse(builtIn, tool.upstreamName))
        return await limited({ refusal: admission.limit, session: false });
    }

    // A built-in tool always answers a result, a failure as one with `isError`; it is charged like an upstream's. A
    // browser or sandbox session's tools (#213, #222) act for the org, member and principal of the call: the session's
    // owner (a call without a principal reaches no session).
    if ("builtIn" in serving) {
      const now = this.#now();
      const { builtIn } = serving;

      // The agents toolkit's call (#229) is the endpoint's Worker's to make, with the agents the caller's scope names;
      // it is charged here, as a built-in tool's is.
      if (builtIn.calledBy === "worker") {
        if (price > 0) ledger.charge(ledger.scopes(spender, charged), price, now);

        return {
          outcome: "delegated",
          tool: tool.upstreamName,
          arguments: call.arguments ?? {},
          scopeAgents: agentsInScope(caller.scope),
          usage: usage(slot, price, approved),
        };
      }

      // A sandbox session's computer time (#224): the price from this call on, and whether a limit has no room
      // (`noRoom` is set only for a call that meets the computer), which only the session can act on.
      // The plan keeps the computer from a command that would start it, too (#241: Free has none, Pay as you go has a
      // ceiling and a billing cap), as a Spend limit does; just-bash's commands run on.
      const planRefusal =
        meter !== undefined && builtIn.toolkit.kind === "sandbox"
          ? this.#computerRefusal(meter, tool.upstreamName, call, now, held)
          : undefined;

      // A Spend limit's words win where both have no room.
      const computer: ComputerMeter | undefined =
        builtIn.toolkit.kind === "sandbox"
          ? {
              hourPriceMicros: hourPrice,
              limitReached: noRoom !== undefined || planRefusal !== undefined,
              ...(noRoom === undefined && planRefusal !== undefined
                ? { limitReason: "plan" as const }
                : {}),
              ...(meter === undefined ? {} : { plans: true as const }),
            }
          : undefined;

      // A run's call of pi's coding tool (#230) is gated here and executed by the run on its session, with the ticket,
      // which keeps the call's computer metering and spender for each of its operations.
      const sessionId = call.arguments?.["session"];

      if (
        call.executes === true &&
        call.run !== undefined &&
        call.principalId !== undefined &&
        computer !== undefined &&
        gatedTool(tool.upstreamName) &&
        typeof sessionId === "string"
      ) {
        // Only a session the part keeps as the run's own: another's id, or one it forgot, is answered as unknown, and
        // the call charged nothing.
        if (!this.#sandboxSessions.owns(sessionId, call.principalId))
          return {
            outcome: "result",
            result: unknownSessionResult(sessionId),
            usage: usage(slot, 0, approved),
          };

        if (price > 0) ledger.charge(ledger.scopes(spender, charged), price, now);
        // The call is a use of the session, as a call the part makes is.
        this.#sandboxSessions.used(sessionId, now, call.principalId);

        const id = this.#runCalls.issue(
          {
            toolkitId: toolkit.id,
            tool: tool.upstreamName,
            principal: call.principalId,
            member: viewer.member,
            apiKey: spender.apiKeyId,
            agent: spender.agentId,
            run: call.run.usage,
            session: sessionId,
            expiresAt: now + TICKET_IDLE_MS,
            requestedAt: now,
            requestBytes: argumentBytes(call.arguments),
            credential: slot,
            private: slot === "private" || toolkit.owner !== undefined,
            costMicros: price,
            approval: approved,
            hourPriceMicros: computer.hourPriceMicros,
            limitReached: computer.limitReached,
            planRefusal: noRoom === undefined ? planRefusal : undefined,
            plans: meter !== undefined,
            counted,
          },
          now,
        );

        return { outcome: "gated", ticket: { id }, usage: usage(slot, price, approved) };
      }

      const session = this.#builtInCall(
        builtIn,
        viewer,
        call,
        spender,
        policy,
        now,
        computer,
        continued,
      );

      const answer = await Effect.runPromise(
        builtIn.call(tool.upstreamName, call.arguments, session.call),
      );

      // A new sandbox session ends a day after its last use, and a new crawl is kept 21 days: the part wakes up then to
      // forget it.
      if (session.opened()) await this.#core.wakeUpChanged(this.#nextWakeUp(now));

      // The session answers its computer time since its last call, which the call charges; for want of room it stops a
      // running computer quietly (the result says so) and refuses only a command that needs the computer
      // (`#stopForLimit`).
      const {
        result,
        browserTime,
        inSession,
        computerTime,
        computer: refusedFor,
        computerStopped,
      } = answer;

      const computerCost = computerTime?.costMicros ?? 0;

      // What the call used counts toward the plan, and where the session's computer stands counts toward its ceiling.
      this.#countTime("browserHours", browserTime?.browserMs);
      this.#countTime("computerHours", computerTime?.computerMs);

      if (computerTime !== undefined && typeof call.arguments?.["session"] === "string")
        this.#sandboxSessions.computerRunsUntil(call.arguments["session"], computerTime.runsUntil);

      if (planRefusal !== undefined && noRoom === undefined && refusedFor === "needed") {
        ledger.charge(ledger.scopes(spender, charged), computerCost, this.#now());

        // The command did not run on the computer: no work, so no tool call.
        if (meter !== undefined && counted !== undefined) meter.refund(counted);

        return {
          outcome: "plan_limited",
          refusal: planRefusal,
          usage: usage(slot, 0, approved),
          computer: refusedFor,
          ...(computerStopped === true ? { computerStopped } : {}),
        };
      }

      if (noRoom !== undefined && refusedFor === "needed") {
        ledger.charge(ledger.scopes(spender, charged), computerCost, this.#now());

        // The command did not run on the computer: no work, so no tool call (#241).
        if (meter !== undefined && counted !== undefined) meter.refund(counted);

        return {
          outcome: "refused",
          refusal: noRoom,
          usage: usage(slot, 0, approved),
          computer: refusedFor,
          ...(computerStopped === true ? { computerStopped } : {}),
        };
      }

      // Browser and computer time cost their price per hour on top of the price per call (#214, #224): a Quick
      // Action's on its own record, a session's since its last call on the session's, which writes it when it closes.
      const callTime = inSession === true ? undefined : browserTime;
      const cost = price + (callTime?.costMicros ?? 0);

      ledger.charge(
        ledger.scopes(spender, charged),
        price + (browserTime?.costMicros ?? 0) + computerCost,
        this.#now(),
      );

      const done = usage(slot, cost, approved, callTime?.browserMs);
      const { handoff } = answer;

      // A handoff started (#216): the endpoint reaches the person; one from before it gets the words without the link.
      if (handoff !== undefined)
        return call.handoffOutcomes === true
          ? { outcome: "handoff", ...handoff, usage: done }
          : {
              outcome: "result",
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      `A person is asked to act in browser session ${handoff.sessionId}, on its page in the panel ` +
                      `(Tools, Browser sessions), until ${new Date(handoff.until).toISOString()}. Call ` +
                      `${call.name} again with the same sessionId to wait for them.`,
                  },
                ],
              },
              usage: done,
            };

      // A computer opened where the plan has none to give: the commands that need it will be refused, and the model is
      // told so now, not at its first one (#241).
      const hinted =
        meter !== undefined &&
        builtIn.toolkit.kind === "sandbox" &&
        tool.upstreamName === "open" &&
        call.arguments?.["computer"] === true &&
        meter.limitOf("computerHours", this.#now()) !== undefined;

      return {
        outcome: "result",
        result: hinted ? noted(result, NO_COMPUTER_HOURS_HINT) : result,
        usage: done,
      };
    }

    const attempt = await this.#callUpstream(serving.stored, {
      tool,
      owner,
      caller: viewer.member ?? "",
      credential: serving.credential,
      args: call.arguments,
      policy,
    });

    // A call that could not sign in made no request: it is not a tool call that did work.
    if (attempt.kind === "sign_in") {
      if (meter !== undefined && counted !== undefined) meter.refund(counted);

      return signIn(approved);
    }

    const called = attempt.kind === "failed" ? Result.fail(notSigned(attempt)) : attempt.done;

    if (Result.isFailure(called))
      return {
        outcome: "failed",
        message: called.failure.message,
        usage: usage(slot, 0, approved),
      };

    if (price > 0) ledger.charge(ledger.scopes(spender, charged), price, this.#now());

    return { outcome: "result", result: called.success, usage: usage(slot, price, approved) };
  }

  /**
   * What Commissary Cloud's plan says of a call about to do its work (#241): refused by the plan limit of browser hours
   * (a call that uses browser time, `session` when it may name a session to close), by the ceiling on concurrent
   * browser sessions (`browser_open`, but for an agent run's: no ceiling caps a run, ADR 0042) or by the limit on tool
   * calls; `undefined` when it may go on. Counts nothing: {@link PlanMeter.admit} counts a call that may. A call that
   * ends a use (`endsUse`) is never refused.
   *
   * With `held`, a call that may go on holds the room of the ceiling it passed, which the calls of the same object see
   * until `held` is released ({@link #release}): two `browser_open` calls at once may not both take the last room.
   */
  #planRefusal(
    meter: PlanMeter,
    builtIn: BuiltIn | undefined,
    name: string,
    call: ToolCall,
    held?: Held,
  ): PlanFound | undefined {
    if (endsUse(builtIn, name)) return undefined;

    const now = this.#now();

    const opens =
      builtIn?.toolkit.kind === "browser" && name === OPEN_TOOL && call.run === undefined;

    if (builtIn?.toolkit.kind === "browser" && browserTimeOf(name) === "uses") {
      const limit = meter.limitOf("browserHours", now);

      if (limit !== undefined) return { refusal: limit, session: true };
    }

    if (opens) {
      const ceiling = meter.checkCeiling(
        "browserSessions",
        this.#browserSessionLog.countCapped() + this.#pendingOpens,
      );

      if (ceiling !== undefined) return { refusal: ceiling, session: false };
    }

    const limit = meter.limitOf("requests", now);

    if (limit !== undefined) return { refusal: limit, session: false };

    if (opens && held !== undefined) {
      this.#pendingOpens += 1;
      held.open = true;
    }

    return undefined;
  }

  /**
   * Why the plan keeps a call of the sandbox tool `name` from the computer (#241), `undefined` when it does not: the
   * plan limit of computer hours (Free has none, so on Free the computer is unavailable; Pay as you go's billing cap),
   * or the ceiling on concurrent computers, which a session whose computer runs already is not another of, and no
   * agent run's session counts toward or meets (ADR 0042). Only a session opened with the computer has one to count: a
   * call in any other is neither checked nor held.
   *
   * Every call outside a run in a session with a computer holds its place (`held`, see {@link #planRefusal}) while it is
   * served, even where the computer runs: a command may outlast the computer's idle minutes, and keeps the slot until
   * it ends, which the count of running computers alone would not. A session with a call held counts as running for
   * the calls it has at once, and for the other sessions' checks as one computer however many calls it holds.
   */
  #computerRefusal(
    meter: PlanMeter,
    name: string,
    call: ToolCall,
    now: number,
    held: Held,
  ): PlanRefusal | undefined {
    if (!meetsComputer(name)) return undefined;

    const limit = meter.limitOf("computerHours", now);

    if (limit !== undefined) return limit;

    const session = call.arguments?.["session"];

    if (call.run !== undefined || typeof session !== "string") return undefined;

    if (!this.#sandboxSessions.mayHaveComputer(session)) return undefined;

    const runs =
      this.#pendingComputers.has(session) || this.#sandboxSessions.computerRuns(session, now);

    if (!runs) {
      // The computers of other sessions that run, or that a call being served holds a place for.
      const held = [...this.#pendingComputers.keys()].filter(
        (other) => other !== session && !this.#sandboxSessions.computerRuns(other, now),
      ).length;

      const ceiling = meter.checkCeiling(
        "computers",
        this.#sandboxSessions.computersRunning(now, session) + held,
      );

      if (ceiling !== undefined) return ceiling;
    }

    this.#pendingComputers.set(session, (this.#pendingComputers.get(session) ?? 0) + 1);
    held.computer = session;

    return undefined;
  }

  /** Gives back what a call held of the ceilings' room (`held`, {@link #planRefusal}) once it is served or refused. */
  #release(held: Held): void {
    if (held.open) this.#pendingOpens -= 1;

    if (held.computer !== undefined) {
      const left = (this.#pendingComputers.get(held.computer) ?? 1) - 1;

      if (left > 0) this.#pendingComputers.set(held.computer, left);
      else this.#pendingComputers.delete(held.computer);
    }
  }

  /** Counts `ms` of browser or computer time toward the plan, where the deployment has plans (#241). */
  #countTime(unit: "browserHours" | "computerHours", ms: number | undefined): void {
    if (ms === undefined || ms <= 0) return;

    this.#plans()?.addTime(unit, ms, this.#now());
  }

  /**
   * How a built-in tool is called for `viewer`'s `call` ({@link BuiltInCall}), and whether the call opened a sandbox
   * session. A browser or sandbox session's tools (#213, #222) act for the org, member and principal of the call: the
   * session's owner (a call without a principal reaches no session). `continuesHandoff`: the call went through the
   * approvals as one that continues a handoff (`#continuesHandoff`), so it may start none (#216).
   */
  #builtInCall(
    builtIn: CalledBuiltIn,
    viewer: Viewer,
    call: ToolCall,
    spender: SpendCaller,
    policy: OutboundPolicy,
    now: number,
    computer?: ComputerMeter,
    continuesHandoff = false,
  ): BuiltInCalling {
    const { principalId } = call;
    let opened = false;
    const crawler = { member: viewer.member, principal: principalId ?? "" };

    return {
      call: {
        // A sandbox session is its principal's (a member, or one API key of theirs): a call without one may not use
        // the sandbox.
        org: this.#core.org,
        member: viewer.member,
        principal: principalId,
        ...(call.run?.usage === undefined ? {} : { run: call.run.usage }),
        ...(call.runSession === true && call.run !== undefined ? { runSession: true } : {}),
        ...(computer === undefined ? {} : { computer }),
        profiles: this.#callerProfiles(viewer, principalId ?? viewer.member),
        // A browser session is logged while it is open, so the org's deletion deletes it (#214), and the panel lists it
        // with its profile and its handoff (#216).
        browserSessions: {
          opened: (id, profile) =>
            this.#browserSessionLog.opened({
              id,
              toolkitId: builtIn.toolkit.id,
              member: viewer.member,
              principal: principalId ?? "",
              agent: spender.agentId,
              openedAt: now,
              profile,
            }),
          closed: (id) => this.#browserSessionLog.forget([id]),
          handoff: (id, until) => this.#browserSessionLog.handoff(id, until),
        },
        ...(call.handoffAnswer === undefined ? {} : { handoffAnswer: call.handoffAnswer }),
        ...(continuesHandoff ? { continuesHandoff: true as const } : {}),
        sessions: {
          opened: (id) => {
            opened = true;
            this.#sandboxSessions.opened(
              {
                id,
                toolkitId: builtIn.toolkit.id,
                member: viewer.member,
                principal: principalId ?? "",
                agent: spender.agentId,
                openedAt: now,
              },
              call.arguments?.["computer"] === true,
            );
          },
          used: (id) => this.#sandboxSessions.used(id, now, principalId),
          ended: (id) => this.#sandboxSessions.ended([id], principalId),
        },
        // A browser crawl is its starter's, member and principal (#270), as a session is.
        crawls: {
          started: (id) => {
            opened = true;
            this.#crawls.started({
              id,
              toolkitId: builtIn.toolkit.id,
              ...crawler,
              startedAt: now,
            });
          },
          owns: (id) => this.#crawls.owns(id, crawler),
        },
        policy,
        now,
        // The toolkit with what the org set on it (its network ceiling, its price per browser hour).
        toolkit: this.#withSettings(builtIn.toolkit),
      },
      opened: () => opened,
    };
  }

  /**
   * Closes the browser session that `call`, refused by a Spend limit, names (#214): a session whose browser time costs
   * money closes once a limit it counts toward has no room, as its caller closing it would. Its browser time since its
   * last call is charged. Answers whether a session of the caller's closed; another's, or none, stays as it was.
   */
  async #closeSession(
    builtIn: CalledBuiltIn,
    viewer: Viewer,
    call: ToolCall,
    policy: OutboundPolicy,
    spender: SpendCaller,
    charged: ChargedCredential,
  ): Promise<boolean> {
    const sessionId = call.arguments?.["sessionId"];

    if (typeof sessionId !== "string") return false;
    const now = this.#now();
    const caller = this.#builtInCall(builtIn, viewer, call, spender, policy, now);

    const { result, browserTime } = await Effect.runPromise(
      builtIn.call(CLOSE_TOOL, { sessionId }, caller.call),
    );

    const ledger = this.#core.spend.ledger();

    ledger.charge(ledger.scopes(spender, charged), browserTime?.costMicros ?? 0, this.#now());
    this.#countTime("browserHours", browserTime?.browserMs);

    return result["isError"] !== true;
  }

  /**
   * Hears that the alarm of the logged browser session `sessionId` closed it after its idle minutes (#214): forgets it,
   * and charges `costMicros` of its browser time, the stretch since its last call, which no call charged, to the Spend
   * limits it counts toward, as its toolkit's shared credential served it: those of the member who opened it, their
   * teams and the org, and of the API key it was opened with, or of the shared agent whose run opened it (#228). The
   * session's Durable Object calls it. A session the part did not log (or forgot), or a cost that is not a whole number
   * of micro-USD, 0 or more, charges nothing. `browserMs`, the stretch's browser time, counts toward the org's plan
   * (#241).
   */
  browserSessionClosed(sessionId: string, costMicros: number, browserMs?: number): void {
    const session = this.#browserSessionLog.session(sessionId);

    if (session === undefined) return;
    this.#browserSessionLog.forget([sessionId]);
    this.#chargeClosed(session, costMicros);
    // The same stretch counts toward the org's plan (#241), though it cost nothing; a session's object from before
    // sends none.
    this.#countTime("browserHours", browserMs);
  }

  /**
   * Hears of computer time of the sandbox session `sessionId` that no call charged (#224): its object's alarm metered it
   * when the computer stopped after its idle minutes, or when it `closed` the session after a day without a call (it is
   * then forgotten). Charges `costMicros` of it to the Spend limits it counts toward, as a browser session's
   * ({@link browserSessionClosed}). The session's Durable Object calls it. A session the part does not keep, or a cost
   * that is not a whole number of micro-USD, 0 or more, charges nothing. `computerMs`, the time's length, counts toward
   * the org's plan (#241).
   */
  sandboxComputerTime(
    sessionId: string,
    costMicros: number,
    closed: boolean,
    computerMs?: number,
  ): void {
    const session = this.#sandboxSessions.session(sessionId);

    if (session === undefined) return;

    if (closed) this.#sandboxSessions.ended([sessionId]);
    // Its computer stopped (its idle minutes were over), unless a command started it again since: the report may come
    // after (#241).
    else this.#sandboxSessions.computerStopped(sessionId, this.#now());
    this.#chargeClosed(session, costMicros);
    // The same time counts toward the org's plan (#241), though it cost nothing; an object from before sends none.
    this.#countTime("computerHours", computerMs);
  }

  /**
   * Charges `costMicros`, the time a session's alarm metered since its last call (#214, #224), to the Spend limits of
   * its opener, as its toolkit's shared credential served it: those of the member who opened it, their teams and the
   * org, and of the API key it was opened with, or of the shared agent whose run opened it (#228). A cost that is not a
   * whole number of micro-USD, 0 or more, charges nothing.
   */
  #chargeClosed(
    session: {
      readonly toolkitId: string;
      readonly member: string | undefined;
      readonly principal: string;
      readonly agent?: string | undefined;
    },
    costMicros: number,
  ): void {
    if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return;
    const ledger = this.#core.spend.ledger();
    const apiKeyId = apiKeyOf(session.principal);

    const charged: ChargedCredential = {
      id: session.toolkitId,
      shared: true,
      kind: "toolkit_credential",
    };

    ledger.charge(
      ledger.scopes({ memberId: session.member, apiKeyId, agentId: session.agent }, charged),
      costMicros,
      this.#now(),
    );
  }

  /**
   * Stops the computer of the sandbox session that `call`, refused by a Spend limit (or by the plan, #241), names
   * (#224): a priced tool's call (`sandbox_close` too) is refused before it reaches the session, so the part stops a
   * running computer itself, as the session does for a call that reaches it. Its last stretch is charged. The refused
   * call is no use of the session. Answers whether a computer of the caller's session ran.
   */
  async #stopComputer(
    builtIn: BuiltIn,
    viewer: Viewer,
    call: ToolCall,
    spender: SpendCaller,
    charged: ChargedCredential,
    hourPriceMicros: number,
    reason: "spend" | "plan" = "spend",
  ): Promise<boolean> {
    const sessionId = call.arguments?.["session"];
    const sandbox = this.#sandbox;
    const { principalId } = call;

    if (typeof sessionId !== "string" || sandbox === undefined || principalId === undefined)
      return false;

    const stopped = await Effect.runPromise(
      sandbox
        .stopComputer({ org: this.#core.org, principal: principalId }, sessionId, this.#now(), {
          hourPriceMicros,
          limitReached: true,
          limitReason: reason,
        })
        // An object from before #224 has no `stopForLimit`: it has no metered computer to stop.
        .pipe(Effect.orElseSucceed((): Metered<boolean> => ({ value: false }))),
    );

    const ledger = this.#core.spend.ledger();

    ledger.charge(
      ledger.scopes(spender, { ...charged, id: builtIn.toolkit.id }),
      stopped.computerTime?.costMicros ?? 0,
      this.#now(),
    );
    this.#countTime("computerHours", stopped.computerTime?.computerMs);

    if (stopped.value) this.#sandboxSessions.computerRunsUntil(sessionId, undefined);

    return stopped.value;
  }

  /**
   * Deletes up to `limit` of the org's logged browser sessions (#214), each object at once without a usage record, and
   * forgets them: Tools' step of deleting the org (`org-deletion.ts`), within its budget, before `wipe` drops the rest
   * of the log, so that no session's alarm writes a record or reaches the ControlPlane once the org is gone. Answers how
   * many objects it called and how many sessions are left; one whose object failed stays logged for the next try.
   */
  async purgeBrowserSessions(
    limit: number,
  ): Promise<{ readonly purged: number; readonly remaining: number }> {
    const ids = this.#browserSessionLog.ids(limit);
    const sessions = this.#browserSessions;

    const done =
      sessions === undefined
        ? ids
        : (
            await Promise.all(
              ids.map(async (id) => {
                try {
                  await sessions.purge(this.#core.org, id);

                  return id;
                } catch {
                  return undefined;
                }
              }),
            )
          ).filter((id) => id !== undefined);

    this.#browserSessionLog.forget(done);

    return {
      purged: sessions === undefined ? 0 : ids.length,
      remaining: this.#browserSessionLog.ids().length,
    };
  }

  // --- the Browser sessions page (#216) ------------------------------------------------------------------------------

  /**
   * Whether `viewer` may watch the logged session `session`: open its Live View and answer its handoff (#216, ADR
   * 0039), the one place that decides it. The session's member, whichever of their principals opened it; and for a
   * session a shared agent's run opened, which belongs to the run, not to a member (#232, ADR 0040), the run's
   * watchers: its starter, or the agent's watchers when no one started it, as the Agents part answers at once
   * ({@link RunWatchers}), so the list asks it of every session. An org admin is no watcher of another member's
   * session.
   */
  #mayWatch(session: LoggedBrowserSession, viewer: Viewer): boolean {
    const member = viewer.member;

    if (member === undefined) return false;

    if (session.member !== undefined) return session.member === member;

    return watchersOfPrincipal(this.#runWatchers, session.principal).includes(member);
  }

  /** The logged session `id` when `viewer` may see it: a watcher, or an org admin; undefined otherwise. */
  #visibleSession(viewer: Viewer, id: string): LoggedBrowserSession | undefined {
    const session = this.#browserSessionLog.session(id);

    return session !== undefined && (this.#mayWatch(session, viewer) || isOrgAdmin(viewer))
      ? session
      : undefined;
  }

  /**
   * A logged session as the Browser sessions page shows it to `viewer`: whether it is theirs (`own`: they are its
   * member) and whether they may watch it (`watchable`, {@link #mayWatch}), with the handoff its object told, if any,
   * to a watcher only.
   */
  #sessionView(
    session: LoggedBrowserSession,
    viewer: Viewer,
    handoff: BrowserSessionView["handoff"],
  ): BrowserSessionView {
    const own = session.member !== undefined && session.member === viewer.member;
    const watchable = this.#mayWatch(session, viewer);

    const email =
      session.member === undefined ? undefined : this.#core.member(session.member)?.email;

    const profile =
      session.profile === undefined ? undefined : this.#profiles.profile(session.profile);

    const view: BrowserSessionView = {
      id: session.id,
      opened_at: iso(session.openedAt),
      member:
        session.member === undefined
          ? null
          : {
              member_id: session.member,
              ...(email === undefined ? {} : { email }),
            },
      opened_by: openerOf(session.principal),
      own,
      watchable,
      profile:
        profile === undefined
          ? null
          : {
              id: profile.id,
              private: profile.owner !== undefined,
              // Another member's private profile: an org admin sees only that it exists.
              ...(profile.owner === undefined || profile.owner === viewer.member
                ? { name: profile.name }
                : {}),
            },
      handoff: watchable ? handoff : null,
    };

    // Its run's page is for those who watch the session (#234): an org admin's view of another's session names no run.
    const run = watchable || own ? runOfPrincipal(session.principal) : undefined;

    return run === undefined ? view : { ...view, run };
  }

  /**
   * The org's open browser sessions as the Browser sessions page lists them (#216): those the caller may watch, with the
   * handoff that waits for them, and for an org admin every other session too (whose, when, which profile), which they
   * may end but not watch. Oldest first. A handoff the log says waits is asked of its session's object first, as it may
   * have ended without a call hearing it (the person clicked Done, and the client has not called since): one that no
   * longer waits is forgotten.
   */
  async listBrowserSessions(viewer: Viewer): Promise<BrowserSessionsList> {
    const now = this.#now();
    const sessions = this.#browserSessions;

    const visible = this.#browserSessionLog
      .all()
      .filter((session) => this.#mayWatch(session, viewer) || isOrgAdmin(viewer));

    const handoffOf = async (
      session: LoggedBrowserSession,
    ): Promise<BrowserSessionView["handoff"]> => {
      const until = session.handoffUntil;

      if (until === undefined || until <= now || !this.#mayWatch(session, viewer)) return null;

      if (sessions === undefined) return { until: iso(until) };
      const watched = await sessions.watch(this.#core.org, session.id);

      if (watched.kind === "open" && watched.handoff !== undefined)
        return { until: iso(watched.handoff.until) };

      if (watched.kind === "open") this.#browserSessionLog.handoff(session.id, undefined);

      return null;
    };

    return {
      sessions: await Promise.all(
        visible.map(async (session) =>
          this.#sessionView(session, viewer, await handoffOf(session)),
        ),
      ),
    };
  }

  /**
   * A browser session's page (#216): as listed, with what its handoff asks of its member, from its object. A session the
   * caller may not see, or that closed, is `not_found`.
   */
  async browserSession(viewer: Viewer, id: string): Promise<ToolsResult<BrowserSessionView>> {
    const session = this.#visibleSession(viewer, id);
    const sessions = this.#browserSessions;

    if (session === undefined || sessions === undefined)
      return refuse("not_found", "browser session not found");
    const watched = await sessions.watch(this.#core.org, id);

    if (watched.kind !== "open") return refuse("not_found", "browser session not found");

    return ok(
      this.#sessionView(
        session,
        viewer,
        // What the handoff asks is its watchers' alone: an org admin who may not watch it learns nothing of it.
        watched.handoff === undefined || !this.#mayWatch(session, viewer)
          ? null
          : { until: iso(watched.handoff.until), reason: watched.handoff.reason },
      ),
    );
  }

  /**
   * Mints a Live View link of a browser session for those who may watch it (#216, ADR 0044, {@link #mayWatch}): its
   * member, or, for a session a shared agent's run opened, the run's watchers (#232). A bearer link to the session's
   * current tab, which starts a connection only within 60 seconds, for the panel alone. An org admin may see the
   * session but not watch it (`forbidden`); anyone else, or a closed session, gets `not_found`. The link is never
   * logged.
   */
  async browserLiveView(viewer: Viewer, id: string): Promise<ToolsResult<BrowserLiveView>> {
    const session = this.#visibleSession(viewer, id);
    const sessions = this.#browserSessions;

    if (session === undefined || sessions === undefined)
      return refuse("not_found", "browser session not found");

    if (!this.#mayWatch(session, viewer))
      return refuse("forbidden", "only the session's member or its run's watchers may watch it");
    const minted = await sessions.liveView(this.#core.org, id);

    switch (minted.kind) {
      case "minted":
        return ok({ url: minted.url, expires_at: iso(minted.expiresAt) });
      case "failed":
        // The provider's words could quote the link: the panel gets fixed ones.
        return refuse("browser_failed", "the browser provider could not show the session");
      default:
        return refuse("not_found", "browser session not found");
    }
  }

  /**
   * Ends a browser session from the panel (#216): its member's, or any of the org's for an org admin. It closes as
   * `browser_close` would, its calls answer that it is closed from then on, and its browser time since its last call is
   * charged to its opener's Spend limits, as its alarm's close would be.
   */
  async endBrowserSession(viewer: Viewer, id: string): Promise<ToolsResult<EndedBrowserSession>> {
    const session = this.#visibleSession(viewer, id);
    const sessions = this.#browserSessions;

    if (session === undefined || sessions === undefined)
      return refuse("not_found", "browser session not found");
    const ended = await sessions.end(this.#core.org, id);

    // A session its object closed already is left logged until its close is reported, which charges its last stretch.
    if (ended.kind === "closed") return refuse("not_found", "browser session not found");
    this.#browserSessionLog.forget([id]);

    if (ended.kind === "unknown") return refuse("not_found", "browser session not found");
    this.#chargeClosed(session, ended.browserTime.costMicros);
    this.#countTime("browserHours", ended.browserTime.browserMs);

    return ok({ id, ended: true });
  }

  // --- the sandbox toolkit's open sessions (#225) ---------------------------------------------------------------------

  /**
   * Whether `viewer` may end the sandbox session `session`: its member's own, or any for an org admin. The list's SQL
   * applies the same rule (`mayBeOpen`'s member filter), so a hosted agent's run naming its watchers (#232) changes
   * both.
   */
  #mayEndSandbox(session: TrackedSession, viewer: Viewer): boolean {
    return (session.member !== undefined && session.member === viewer.member) || isOrgAdmin(viewer);
  }

  /**
   * The org's open sandbox sessions as the sandbox toolkit's page lists them (#225): the caller's own, and for an org
   * admin every other too (whose, when, how it opened, its network, whether its computer runs), oldest first. Nothing of
   * a session's files: the part has no read of them. The provider says which sessions are open and what each says of
   * itself: one it closed is left out (its row stays until its close is reported), one it does not know is forgotten,
   * and one it could not be asked about is listed without its network and computer.
   */
  async listSandboxSessions(viewer: Viewer): Promise<SandboxSessionsList> {
    const sandbox = this.#sandbox;

    if (sandbox === undefined) return { sessions: [], truncated: false };

    // A member's rows only, chosen before the cap, so another member's rows never crowd theirs out. A caller with no
    // member has none of their own.
    const admin = isOrgAdmin(viewer);

    const rows =
      !admin && viewer.member === undefined
        ? []
        : this.#sandboxSessions.mayBeOpen(
            this.#now(),
            SANDBOX_SESSIONS_LISTED + 1,
            admin ? undefined : viewer.member,
          );

    const truncated = rows.length > SANDBOX_SESSIONS_LISTED;

    const views = await Effect.runPromise(
      Effect.forEach(
        rows.slice(0, SANDBOX_SESSIONS_LISTED),
        (session) =>
          sandbox.status(this.#core.org, session.id).pipe(
            Effect.map((found) => ({ kind: "open", ...found }) as const),
            Effect.catchTag("SandboxError", (error) =>
              Effect.succeed(
                error.reason === "unavailable"
                  ? ({ kind: "unread" } as const)
                  : ({ kind: "gone", forget: error.reason === "unknown_session" } as const),
              ),
            ),
            Effect.map((status): SandboxSessionView | undefined => {
              if (status.kind === "gone") {
                if (status.forget) this.#sandboxSessions.ended([session.id]);

                return undefined;
              }

              const email =
                session.member === undefined ? undefined : this.#core.member(session.member)?.email;

              return {
                id: session.id,
                opened_at: iso(session.openedAt),
                member:
                  session.member === undefined
                    ? null
                    : { member_id: session.member, ...(email === undefined ? {} : { email }) },
                opened_by: openerOf(session.principal),
                own: session.member !== undefined && session.member === viewer.member,
                ...(status.kind === "open"
                  ? { network: status.network, computer: status.computer }
                  : {}),
              };
            }),
          ),
        { concurrency: SANDBOX_STATUS_CONCURRENCY },
      ),
    );

    return { sessions: views.filter((view) => view !== undefined), truncated };
  }

  /**
   * Ends a sandbox session from the panel (#225): its member's, or any of the org's for an org admin. It closes as
   * `sandbox_close` would: its files are deleted at once, its usage record is written, and its computer's time since its
   * last call is charged to its opener's Spend limits; its calls then find no such session. One the provider closed
   * already is `not_found` (its row stays until its close is reported); one it could not be asked to end stays open.
   */
  async endSandboxSession(viewer: Viewer, id: string): Promise<ToolsResult<EndedSandboxSession>> {
    const session = this.#sandboxSessions.session(id);
    const sandbox = this.#sandbox;

    if (session === undefined || sandbox === undefined || !this.#mayEndSandbox(session, viewer))
      return refuse("not_found", "sandbox session not found");

    const ended = await Effect.runPromise(
      sandbox.purge(this.#core.org, id, true).pipe(
        Effect.map(
          ({ computerTime }) =>
            ({
              reason: "ended",
              costMicros: computerTime?.costMicros ?? 0,
              computerMs: computerTime?.computerMs,
            }) as const,
        ),
        Effect.catchTag("SandboxError", (error) =>
          Effect.succeed({ reason: error.reason } as const).pipe(
            Effect.tap(() =>
              error.reason === "closed" || error.reason === "unknown_session"
                ? Effect.void
                : Effect.logWarning("sandbox session not ended").pipe(
                    Effect.annotateLogs({ reason: error.reason, message: error.message }),
                  ),
            ),
          ),
        ),
      ),
    );

    if (ended.reason === "ended") {
      this.#sandboxSessions.ended([id]);
      this.#chargeClosed(session, ended.costMicros);
      this.#countTime("computerHours", ended.computerMs);

      return ok({ id, ended: true });
    }

    if (ended.reason === "unknown_session") {
      this.#sandboxSessions.ended([id]);

      return refuse("not_found", "sandbox session not found");
    }

    if (ended.reason === "closed") return refuse("not_found", "sandbox session not found");

    return refuse("sandbox_failed", "the sandbox could not end the session; try again");
  }

  /**
   * A call of a stored toolkit's tool, by its kind's driver, signed in with `credential` ({@link #withCredential}). A
   * kind that keeps upstream sessions (MCP, #197) calls in the one kept for `caller` on the credential, at most seven
   * days: the session a call opens is kept for the next, and one a call failed in is dropped, so the next opens anew.
   */
  async #callUpstream(
    toolkit: StoredToolkit,
    call: {
      readonly tool: ResolvedTool;
      readonly owner: string | undefined;
      readonly caller: string;
      readonly credential: ToolkitCredential;
      readonly args: Schema.JsonObject | undefined;
      readonly policy: OutboundPolicy;
    },
  ): Promise<Attempt<Schema.JsonObject>> {
    const { owner, caller, credential, policy } = call;
    const driver = KIND_DRIVERS[toolkit.kind];
    const connectedAt = credential.connectedAt;

    // Sessions are the calling member's, also on the shared credential: an upstream's session state never carries over.
    const known = driver.keepsSessions
      ? this.#store.session(toolkit.id, owner, caller, this.#now())
      : undefined;

    const attempt = await this.#withCredential(
      toolkit,
      credential,
      policy,
      (secret) =>
        driver.call({
          toolkit,
          tool: call.tool,
          secret,
          args: call.args,
          policy,
          session: known,
          schema: () =>
            this.#schemas.schema(toolkit.id, toolkit.listBuiltAt, () =>
              this.#store.schema(toolkit.id),
            ),
        }),
      (called) => called.unauthorized === true,
    );

    if (attempt.kind !== "done") return attempt;
    const called = attempt.done;

    // The sessions kept are the credential's that opened them; one that changed (or went) meanwhile dropped them.
    const sameCredential = this.#store.credential(toolkit.id, owner)?.connectedAt === connectedAt;

    if (Result.isFailure(called)) {
      // The session the call failed in may be lost; the next call opens a new one, unless another call already did.
      if (known !== undefined && sameCredential) {
        const kept = this.#store.session(toolkit.id, owner, caller, this.#now());

        if (kept?.protocolVersion === known.protocolVersion && kept.sessionId === known.sessionId)
          this.#store.deleteSession(toolkit.id, owner, caller);
      }

      return { kind: "done", done: Result.fail(called.failure) };
    }

    const { result, session } = called.success;

    if (session !== undefined && session !== known && sameCredential) {
      this.#store.putSession(toolkit.id, owner, caller, session, this.#now());
      await this.#wake();
    }

    return { kind: "done", done: Result.succeed(result) };
  }

  /**
   * Whether `call` continues a handoff of its caller's rather than starting one (#216): a `browser_ask_human` that
   * carries the person's decline, or whose session has a handoff of the caller's that waits, or ended with its outcome
   * still kept (the session's object tells), under an approval rule that holds it. Any doubt (no session reached, an
   * object from before) is no.
   */
  async #continuesHandoff(
    builtIn: BuiltIn | undefined,
    viewer: Viewer,
    call: ToolCall,
    tool: ResolvedTool,
  ): Promise<boolean> {
    if (builtIn?.toolkit.kind !== "browser" || tool.upstreamName !== "ask_human") return false;

    // Without an approval rule over the call there is nothing to let it through: it may start a handoff.
    if (approverFor(tool.toolkit.approvalRules, tool.upstreamName, tool.toolClass) === undefined)
      return false;

    if (call.handoffAnswer !== undefined && call.handoffAnswer !== "accept") return true;
    const sessionId = call.arguments?.["sessionId"];
    const sessions = this.#browserSessions;

    if (typeof sessionId !== "string" || sessions === undefined || call.principalId === undefined)
      return false;

    try {
      return await sessions.hasHandoff(
        { org: this.#core.org, member: viewer.member, principal: call.principalId },
        sessionId,
      );
    } catch {
      return false;
    }
  }

  /**
   * Whether a call goes on to the upstream under the toolkit's approval rules (#201), and how it was approved. No rule:
   * it goes (`none`). A rule whose approver is the caller, from a client that shows forms: the caller is asked
   * (`approve`, with a `requestState` that binds the form to this call), and the call made again with their answer and
   * that state goes (`approved_elicitation`) or is denied; an answer without a state this part issued for this very call
   * (the same caller, tool and arguments, within the hour, once) is no answer, and the caller is asked again. Otherwise
   * the call is matched with its pending approval (same caller, tool and arguments' hash, within the hour): an approved
   * one lets it through once (`approved_panel`) and is settled; a denied one answers so and is settled, so the next
   * identical call asks anew; an undecided one answers pending again. Without one (none, or it expired), a pending
   * approval is created, the arguments sealed. A caller without a member under a rule of the caller, without a form,
   * cannot be approved by anyone, but for an agent run no one started (#232): its watchers are its caller
   * ({@link #callersOf}), and its approval waits for one of them.
   */
  async #approvalOf(
    viewer: Viewer,
    call: ToolCall,
    tool: ResolvedTool,
    slot: CredentialSlot,
  ): Promise<
    | { readonly kind: "go"; readonly approval: ToolCallApproval }
    | { readonly kind: "approve"; readonly requestState: string }
    | { readonly kind: "pending"; readonly approval: StoredApproval }
    | { readonly kind: "not_approved"; readonly reason: NotApprovedReason }
  > {
    const approver = approverFor(tool.toolkit.approvalRules, tool.upstreamName, tool.toolClass);

    if (approver === undefined) return { kind: "go", approval: "none" };
    const now = this.#now();

    // A run's approvals are its starter's (a shared agent's run has no member of its own).
    const callerMember = viewer.member ?? call.run?.starterMember;

    const key: ApprovalKey = {
      toolkitId: tool.toolkit.id,
      upstreamName: tool.upstreamName,
      argsHash: argumentsHash(call.arguments),
      callerMember,
      callerPrincipal: call.principalId ?? "",
    };

    const approval = { ...key, toolName: tool.name, credential: slot, approver };

    if (approver.kind === "caller" && call.approvalForm !== undefined) {
      const { answer, requestState } = call.approvalForm;

      if (answer !== undefined && this.#approvals.takeForm(requestState, key, now))
        return answer === "accept"
          ? { kind: "go", approval: "approved_elicitation" }
          : { kind: "not_approved", reason: "denied" };

      const state = this.#approvals.createForm(approval, now);

      await this.#core.wakeUpChanged(this.#nextWakeUp(now));

      return { kind: "approve", requestState: state };
    }

    // A run no one started has its watchers for its caller (#232); without any (no Agents area, or none left), no one
    // decides.
    if (
      approver.kind === "caller" &&
      callerMember === undefined &&
      (call.run === undefined ||
        watchersOfPrincipal(this.#runWatchers, call.principalId ?? "").length === 0)
    )
      return { kind: "not_approved", reason: "no_approver" };

    const kept = this.#approvals.unsettled(key, now);

    if (kept !== undefined) {
      if (kept.status === "pending") return { kind: "pending", approval: kept };
      // Taken once: the call goes through, or learns that it was denied.
      this.#approvals.settle(kept.id);

      return kept.status === "denied"
        ? { kind: "not_approved", reason: "denied" }
        : { kind: "go", approval: "approved_panel" };
    }

    const created = this.#approvals.create(approval, call.arguments ?? {}, now);

    await this.#core.wakeUpChanged(this.#nextWakeUp(now));

    return { kind: "pending", approval: created };
  }

  /**
   * Deletes the approvals (and forms) of the toolkit `toolkitId` that its rules no longer hold as they were: the rule
   * they wait on was removed or narrowed, its approver changed, or their tool was reclassified out of it (or is gone). An
   * approval never outlives its rule, so restoring the rule does not bring it back.
   */
  #dropOrphanedApprovals(toolkitId: string): void {
    const toolkit = this.#toolkit(toolkitId);

    const tools =
      toolkit === undefined
        ? []
        : this.#resolve(toolkit.owner).tools.filter((tool) => tool.toolkit.id === toolkitId);

    const orphaned = this.#approvals.ofToolkit(toolkitId).filter((approval) => {
      const tool = tools.find((resolved) => resolved.upstreamName === approval.upstreamName);

      const approver =
        tool === undefined
          ? undefined
          : approverFor(tool.toolkit.approvalRules, tool.upstreamName, tool.toolClass);

      return approver === undefined || canonicalJson(approver) !== canonicalJson(approval.approver);
    });

    this.#approvals.delete(orphaned.map((approval) => approval.id));
  }

  /**
   * The tool scope a caller of the MCP endpoint is narrowed by, and whether it acts as a shared agent: an agent run by
   * its definition, anyone else by their key's scope.
   */
  #caller(
    viewer: Viewer,
    apiKeyId: string | undefined,
    run: RunToolReach | undefined,
  ): CallerScope {
    if (run === undefined) return { scope: this.#keyScope(apiKeyId), asAgent: false };

    return { scope: run.toolScope, asAgent: run.asAgent, self: run.agentId };
  }

  /**
   * The served tools `viewer` reaches ({@link clientTools}), sorted by full name, and how. A private toolkit counts
   * only while the org lets members add them: otherwise it is kept, but not served, and does not shadow an org toolkit
   * of its name. `scope` (an API key's tool scope, #200) narrows them further; `undefined`: no narrowing. `asAgent` (a
   * shared agent's run, #227): every tool of an org toolkit's shared credential, whatever the grants, as no member.
   *
   * The agents toolkit's tools (#229) take no grant: they reach a caller who may run an agent (other than a calling
   * run's own), as a member or as a shared agent, within their scope's agents; and only when `agentsToolkit` asks for
   * them ({@link Reach}).
   */
  #reachable(viewer: Viewer, reach: Reach = {}): ReadonlyArray<ReachableTool> {
    const { scope, self } = reach;
    const asAgent = reach.asAgent === true;
    const member = asAgent ? undefined : viewer.member;

    const runsAgents =
      reach.agentsToolkit === true &&
      this.#agents !== undefined &&
      runnableAgents(this.#agents, { member, asAgent, scope, self }).length > 0;

    // A built-in toolkit's shared credential is Commissary's own binding, always there.
    const shared = new Set([
      ...this.#builtIns.map((builtIn) => builtIn.toolkit.id),
      ...this.#store
        .credentials()
        .filter((credential) => credential.owner === undefined)
        .map((credential) => credential.toolkitId),
    ]);

    const granted = grantedTools(this.#grants.entries(), {
      member,
      teams: member === undefined ? [] : this.#core.teamIdsOf(member),
    });

    return this.#resolve(this.#servedMember(member))
      .tools.filter(isServed)
      .map((tool) => ({
        tool,
        asMember:
          member !== undefined &&
          accepts(tool.toolkit, "private") &&
          this.#privateAllowed(tool.toolkit),
        granted: isAgentsToolkit(tool.toolkit)
          ? runsAgents
          : tool.toolkit.owner === undefined &&
            accepts(tool.toolkit, "shared") &&
            shared.has(tool.toolkit.id) &&
            (asAgent || granted(grantable(tool))),
      }))
      .filter(
        (reachable) =>
          (reachable.asMember || reachable.granted) &&
          inToolScope(scope, grantable(reachable.tool)),
      )
      .toSorted((a, b) => (a.tool.name < b.tool.name ? -1 : 1));
  }

  /**
   * The tool scope of the API key `id` (#200), read from the org-wide base on every request; `undefined` (no narrowing)
   * for a request without a key or a key without a scope. A key no longer stored (revoked, or replaced by a later
   * sign-in of its MCP client) reaches nothing (`[]`): the gate's verified-key cache may still let it through for up
   * to 30 seconds (`@commissary/auth` `VERIFIED_KEY_TTL_MS`), so its tools must not fall back to its member's reach.
   */
  #keyScope(id: string | undefined): ToolScope | undefined {
    if (id === undefined) return undefined;

    const key = this.#core.apiKey(id);

    return key === undefined ? [] : key.toolScope;
  }

  /**
   * The tools `viewer` may use, by toolkit, for the panel's tool scope editor and consent page (#200): what the MCP
   * endpoint lists for them without a key's scope, with each tool's stable id and class. Each toolkit says why they
   * reach it (`via`, #209): their own private credential (`private`, once connected; `private_available`, while it
   * can be but is not), the tool grants that name them and give some of its tools, or (the agents toolkit) that they
   * may run an agent.
   */
  usableTools(viewer: Viewer): UsableTools {
    const member = viewer.member;
    const holder = { member, teams: member === undefined ? [] : this.#core.teamIdsOf(member) };
    const applicable = this.#grants.entries().filter((grant) => namesHolder(grant.subject, holder));

    const toolkits = new Map<
      string,
      {
        id: string;
        name: string;
        tools: Array<UsableTool>;
        reached: Array<GrantableTool>;
        asMember: boolean;
        agents: boolean;
      }
    >();

    // The panel's tool scope editor names the agents toolkit as any toolkit, by id and name (no kind).
    for (const { tool, asMember, granted } of this.#reachable(viewer, { agentsToolkit: true })) {
      const toolkit = toolkits.get(tool.toolkit.id) ?? {
        id: tool.toolkit.id,
        name: tool.toolkit.name,
        tools: [],
        reached: [],
        asMember: false,
        agents: false,
      };

      toolkit.tools.push({
        id: stableId(tool.toolkit.id, tool.upstreamName),
        name: tool.name,
        tool_class: tool.toolClass,
      });

      toolkit.asMember ||= asMember;

      if (isAgentsToolkit(tool.toolkit)) toolkit.agents ||= granted;
      else if (granted) toolkit.reached.push(grantable(tool));
      toolkits.set(tool.toolkit.id, toolkit);
    }

    return {
      toolkits: [...toolkits.values()]
        .toSorted((a, b) => (a.name < b.name ? -1 : 1))
        .map(({ reached, asMember, agents, ...toolkit }) => {
          // Their own credential: the toolkit takes one and the org allows it, whether they have connected it or not.
          const connected =
            member !== undefined && this.#store.credential(toolkit.id, member) !== undefined;

          // A grant counts when it gives at least one of the tools they reach through grants.
          const grants = applicable
            .filter((grant) => reached.some((tool) => grantGives(grant, tool)))
            .map((grant): UsableGrant => this.#usableGrant(grant));

          return {
            ...toolkit,
            via: {
              ...(asMember && connected ? { private: true as const } : {}),
              ...(asMember && !connected ? { private_available: true as const } : {}),
              ...(grants.length === 0 ? {} : { grants }),
              ...(agents ? { agents: true as const } : {}),
            },
          };
        }),
    };
  }

  /** A tool grant that reaches the caller as they see it: a member subject is them, a team shows its name. */
  #usableGrant(grant: ToolGrantEntry): UsableGrant {
    const { subject, tools } = grant;

    switch (subject.kind) {
      case "everyone":
        return { subject, tools };
      case "member":
        return { subject: { kind: "member" }, tools };
      case "team":
        return {
          subject: { kind: "team", id: subject.id, name: this.#core.team(subject.id)?.name ?? "" },
          tools,
        };
    }
  }

  /**
   * For each API key (its member and tool scope), how many tools it may use now (`tool_count`) and what its scope names
   * that no longer exists (`missing`: a removed toolkit's id, a named tool's stable id its toolkit's list no longer
   * has), for the API keys' views (#200).
   */
  keyToolSummaries(
    keys: ReadonlyArray<{ readonly memberId: string; readonly toolScope?: ToolScope | undefined }>,
  ): ReadonlyArray<KeyToolSummary> {
    const listed = new Set(
      this.#store.tools().map((tool) => stableId(tool.toolkitId, tool.upstreamName)),
    );

    return keys.map((key) => {
      const missing = (key.toolScope ?? []).flatMap((entry) => {
        if (this.#store.toolkit(entry.toolkit) === undefined) return [entry.toolkit];

        return entry.tools.kind === "named" ? entry.tools.ids.filter((id) => !listed.has(id)) : [];
      });

      return {
        toolCount: this.#reachable(
          { member: key.memberId, admin: false },
          { scope: key.toolScope, agentsToolkit: true },
        ).length,
        missing,
      };
    });
  }

  // --- browser profiles (#215, ADR 0039) -----------------------------------------------------------------------------

  /**
   * The browser profiles `viewer` manages: their own private profiles and, for an org admin, the shared ones and the
   * other members' private ones as existence only (`others`: whose, without a name). A plain member reaches shared
   * profiles through grants, on the MCP endpoint (`browser_profile_list`).
   */
  listProfiles(viewer: Scope): BrowserProfilesList {
    const profiles: Array<BrowserProfileView> = [];
    const others: Array<LimitedBrowserProfileView> = [];

    for (const profile of this.#profiles.profiles()) {
      const access = accessTo(profile.owner, viewer);

      if (access === "full") profiles.push(profileView(profile));
      else if (access === "limited") others.push(this.#limitedProfileView(profile));
    }

    return isOrgAdmin(viewer) ? { profiles, others } : { profiles };
  }

  /**
   * Creates an empty browser profile: a private one of the caller (a plain member's always is, while the org allows
   * private toolkits) or, for an org admin, a shared one, which no one may use until a profile grant says so.
   */
  createProfile(
    viewer: Scope,
    input: CreateBrowserProfile,
    by: string,
  ): ToolsResult<BrowserProfileView> {
    const admin = isOrgAdmin(viewer);
    const isPrivate = input.private === true || !admin;
    const owner = isPrivate ? this.#memberOf(viewer) : undefined;

    if (isPrivate && owner === undefined)
      return refuse("forbidden", "only a member of the org can create a private browser profile");

    if (isPrivate && !this.#core.privateToolkits())
      return refuse(
        "private_toolkits_unavailable",
        "the org does not let members use private toolkits, nor private browser profiles",
      );

    const refused = this.#profileNameRefusal(input.name, owner, undefined);

    if (refused !== undefined) return refused;
    const now = this.#now();

    const profile: StoredProfile = {
      id: freshProfileId(),
      name: input.name,
      owner,
      revision: 1,
      createdAt: now,
      createdBy: by,
      updatedAt: now,
      updatedBy: by,
      savedAt: undefined,
    };

    this.#profiles.insert(profile);

    return ok(profileView(profile));
  }

  /** Renames a browser profile at `revision`: its member's private one, or an org admin's shared one. */
  updateProfile(
    viewer: Scope,
    id: string,
    revision: number,
    input: UpdateBrowserProfile,
    by: string,
  ): ToolsResult<BrowserProfileView> {
    const profile = this.#profiles.profile(id);
    const access = profile === undefined ? "none" : accessTo(profile.owner, viewer);

    if (profile === undefined || access === "none") return PROFILE_NOT_FOUND;

    if (access === "limited")
      return refuse("forbidden", "an org admin may only remove another member's private profile");

    if (profile.revision !== revision)
      return refuse("conflict", "the browser profile changed since it was read: read it again");

    const refused = this.#profileNameRefusal(input.name, profile.owner, id);

    if (refused !== undefined) return refused;
    const now = this.#now();

    this.#profiles.rename(id, input.name, revision + 1, now, by);

    return ok(
      profileView({
        ...profile,
        name: input.name,
        revision: revision + 1,
        updatedAt: now,
        updatedBy: by,
      }),
    );
  }

  /**
   * Deletes a browser profile at once (ADR 0027) with its grants: its member's private one (an org admin may remove
   * another member's too), or an org admin's shared one. A session open from it can no longer save into it.
   */
  removeProfile(viewer: Scope, id: string, revision: number): ToolsResult<RemovedBrowserProfile> {
    const profile = this.#profiles.profile(id);

    if (profile === undefined || accessTo(profile.owner, viewer) === "none")
      return PROFILE_NOT_FOUND;

    if (profile.revision !== revision)
      return refuse("conflict", "the browser profile changed since it was read: read it again");

    this.#core.transaction(() => this.#profiles.delete(id));

    return ok({ id, removed: true });
  }

  /** Every profile grant of the org, by profile and subject (the routes are for org admins). */
  listProfileGrants(): BrowserProfileGrants {
    return {
      grants: this.#profiles.grants().map((grant) => ({
        id: grant.id,
        subject: grant.subject,
        profile: grant.profile,
        revision: grant.revision,
        updated_at: grant.updatedAt,
        updated_by: grant.updatedBy,
      })),
    };
  }

  /** Writes one profile grant: one per subject and shared profile, each with its revision (ADR 0025). */
  writeProfileGrant(
    change: ProfileGrantChange,
    by: string,
  ): ToolsResult<{ readonly id: string; readonly revision: number }> {
    const value =
      change.value === null
        ? null
        : { subject: trimmedSubject(change.value.subject), profile: change.value.profile.trim() };

    if (value !== null) {
      const refusal = this.#subjectRefusal(value.subject);

      if (refusal !== undefined) return refuse("invalid", refusal);

      if (!this.#isSharedProfile(value.profile))
        return refuse("invalid", "no shared browser profile has this id");
    }

    if (change.id === undefined && value === null)
      return refuse("invalid", "a new grant names its subject and profile");

    const written = this.#profiles.writeGrant({ ...change, value }, by, this.#now());

    return written.ok ? ok({ id: written.id, revision: written.revision }) : written;
  }

  /**
   * The browser profiles `viewer`'s browser session tools reach (#215): which they may open a session from, and whether
   * they may save into one. `by` is who a save is recorded as, when the call names anyone.
   */
  #callerProfiles(viewer: Viewer, by: string | undefined): CallerProfiles {
    return {
      usable: (name) => {
        const profile = this.#usableProfiles(viewer.member).find((each) => each.name === name);

        return profile === undefined
          ? undefined
          : { id: profile.id, state: this.#profiles.state(profile.id) };
      },
      list: () =>
        this.#usableProfiles(viewer.member).map((profile) => ({
          name: profile.name,
          private: profile.owner !== undefined,
        })),
      save: (id, state) => this.#saveProfile(viewer, id, state, by),
    };
  }

  /**
   * The browser profiles `member` may use, by name: their private profiles while the org allows private toolkits, and
   * the shared profiles a grant gives them (everyone, them or one of their teams), but those that have the name of one
   * of their private profiles, which wins for them (as a private toolkit does).
   */
  #usableProfiles(member: string | undefined): ReadonlyArray<StoredProfile> {
    const teams = member === undefined ? [] : this.#core.teamIdsOf(member);

    const granted = new Set(
      this.#profiles
        .grants()
        .filter((grant) => namesHolder(grant.subject, { member, teams }))
        .map((grant) => grant.profile),
    );

    const profiles = this.#profiles.profiles();

    const own =
      member === undefined || !this.#core.privateToolkits()
        ? []
        : profiles.filter((profile) => profile.owner === member);

    const ownNames = new Set(own.map((profile) => profile.name));

    const shared = profiles.filter(
      (profile) =>
        profile.owner === undefined && granted.has(profile.id) && !ownNames.has(profile.name),
    );

    return [...own, ...shared].toSorted((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * Saves a session's `state` into the profile `id` for `viewer` (#215), replacing what it held (the later save wins):
   * into their own private profile while the org allows private toolkits, into a shared one for an org admin. Answers
   * why not otherwise.
   */
  async #saveProfile(
    viewer: Viewer,
    id: string,
    state: StorageState,
    by: string | undefined,
  ): Promise<string | undefined> {
    const profile = this.#profiles.profile(id);

    if (profile === undefined) return "its browser profile no longer exists";

    if (profile.owner === undefined && !isOrgAdmin(viewer))
      return "only an org admin may save into a shared browser profile";

    if (profile.owner !== undefined && profile.owner !== viewer.member)
      return "only its member may save into a private browser profile";

    if (profile.owner !== undefined && !this.#core.privateToolkits())
      return "the org does not let members use private browser profiles";

    try {
      return this.#profiles.saveState(id, state, this.#now(), by)
        ? undefined
        : "its browser profile no longer exists";
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("browser profile not saved").pipe(
          Effect.annotateLogs({ reason: error instanceof Error ? error.name : "unknown" }),
        ),
      );

      return "the browser profile could not store it (it may be larger than storage takes)";
    }
  }

  #isSharedProfile(id: string): boolean {
    const profile = this.#profiles.profile(id);

    return profile !== undefined && profile.owner === undefined;
  }

  /**
   * Why `name` cannot be a browser profile's (`except`: the profile being renamed): shared profiles' names are unique
   * among them; a private profile's among its member's and the shared ones, as toolkits' are.
   */
  #profileNameRefusal(
    name: string,
    owner: string | undefined,
    except: string | undefined,
  ): ToolsResult<never> | undefined {
    if (!PROFILE_NAME.test(name))
      return refuse(
        "invalid",
        "a browser profile's name is 1 to 64 lowercase letters, digits, hyphens and underscores",
      );

    const clash = this.#profiles
      .profiles()
      .some(
        (other) =>
          other.id !== except &&
          other.name === name &&
          (other.owner === undefined || (owner !== undefined && other.owner === owner)),
      );

    return clash ? refuse("name_taken", `a browser profile is already named ${name}`) : undefined;
  }

  #limitedProfileView(profile: StoredProfile): LimitedBrowserProfileView {
    const owner = profile.owner ?? "";
    const email = this.#core.member(owner)?.email;

    return {
      id: profile.id,
      private: true,
      limited: true,
      owner: { member_id: owner, ...(email === undefined ? {} : { email }) },
      created_at: iso(profile.createdAt),
      revision: profile.revision,
    };
  }

  // --- tool grants (ADR 0038) -------------------------------------------------------------------------------------

  /**
   * Every tool grant of the org (org admins; the route's policy checks), each with the named tools its toolkit's tool
   * list no longer has (`missing`).
   */
  listGrants(): ToolGrants {
    const listed = new Set(
      this.#tools().map((tool) => stableId(tool.toolkitId, tool.upstreamName)),
    );

    return {
      // A built-in toolkit's grants are kept while the deployment lacks it, and shown again when it has it.
      grants: this.#grants
        .entries()
        .filter((entry) => this.#toolkit(entry.toolkit) !== undefined)
        .map((entry): ToolGrant => {
          const missing =
            entry.tools.kind === "named" ? entry.tools.ids.filter((id) => !listed.has(id)) : [];

          return {
            id: entry.id,
            subject: entry.subject,
            toolkit: entry.toolkit,
            tools: entry.tools,
            revision: entry.revision,
            updated_at: entry.updatedAt,
            updated_by: entry.updatedBy,
            ...(missing.length === 0 ? {} : { missing }),
          };
        }),
    };
  }

  /**
   * Creates, replaces or deletes (`value: null`) one tool grant at the revision it is based on (0 to create). A grant
   * names a member or team the org has and one of its org toolkits; one per subject, toolkit and selection.
   */
  writeGrant(
    change: ToolGrantChange,
    by: string,
  ): ToolsResult<{ readonly id: string; readonly revision: number }> {
    let value: ToolGrantValue | null = null;

    if (change.value !== null) {
      const cleaned = cleanToolGrant(change.value);

      if ("ok" in cleaned) return cleaned;
      const refused = this.#grantRefusal(cleaned);

      if (refused !== undefined) return refuse("invalid", refused);
      value = cleaned;
    }

    const written = this.#grants.write({ ...change, value }, by, this.#now());

    return written.ok ? ok({ id: written.id, revision: written.revision }) : written;
  }

  /** What a grant names that the org does not have, if anything. */
  #grantRefusal(grant: ToolGrantValue): string | undefined {
    const missing = this.#subjectRefusal(grant.subject);

    if (missing !== undefined) return missing;
    const toolkit = this.#toolkit(grant.toolkit);

    if (toolkit === undefined) return `the org has no toolkit ${grant.toolkit}`;

    if (isAgentsToolkit(toolkit))
      return "the agents toolkit takes no grant: who may run which agent comes from the agents and their grants";

    return toolkit.owner === undefined
      ? undefined
      : "a private toolkit is its owner's alone: its tools take no grant";
  }

  /** The member or team a subject names that the org does not have, if any. */
  #subjectRefusal(subject: GrantSubject): string | undefined {
    if (subject.kind === "member" && this.#core.member(subject.id) === undefined)
      return `the org has no member ${subject.id}`;

    if (subject.kind === "team" && this.#core.team(subject.id) === undefined)
      return `the org has no team ${subject.id}`;

    return undefined;
  }

  // --- pending approvals (#201, ADR 0038) -------------------------------------------------------------------------

  /**
   * The pending approvals `viewer` may decide or made, newest first: undecided (and not expired). Only one they may
   * decide shows the call's arguments.
   */
  listApprovals(viewer: Viewer): ApprovalsList {
    const now = this.#now();

    return {
      approvals: this.#approvals
        .approvals(now)
        .filter((approval) => approval.status === "pending")
        .flatMap((approval) => {
          const view = this.#approvalView(approval, viewer, now);

          return view === undefined ? [] : [view];
        }),
    };
  }

  /**
   * One approval, until it expires, to its eligible approvers and its caller; `not_found` to anyone else, and once it
   * expired.
   */
  getApproval(viewer: Viewer, id: string): ToolsResult<ApprovalView> {
    const now = this.#now();
    const approval = this.#approvals.approval(id, now);
    const view = approval === undefined ? undefined : this.#approvalView(approval, viewer, now);

    return view === undefined ? refuse("not_found", "approval not found") : ok(view);
  }

  /**
   * Approves or denies a pending approval: an eligible approver only (`forbidden` for its caller under a team or list
   * rule), while it is undecided (`conflict`); an expired one is not found. Its arguments are deleted with the
   * decision. Approving does not make the call: the client makes it again, and it goes through once.
   */
  decideApproval(
    viewer: Viewer,
    id: string,
    decision: ApprovalDecision["decision"],
    by: string,
  ): ToolsResult<ApprovalView> {
    const now = this.#now();
    const approval = this.#approvals.approval(id, now);
    const view = approval === undefined ? undefined : this.#approvalView(approval, viewer, now);

    if (approval === undefined || view === undefined)
      return refuse("not_found", "approval not found");

    if (!this.#mayDecide(approval, viewer))
      return refuse(
        "forbidden",
        approval.approver.kind === "caller"
          ? "only its caller approves this call"
          : "a caller cannot approve their own call: another of its approvers decides it",
      );

    if (approval.status !== "pending")
      return refuse("conflict", `the approval was ${approval.status} already`);

    this.#approvals.decide(id, decision === "approve" ? "approved" : "denied", by, now);

    return this.getApproval(viewer, id);
  }

  /**
   * Whether `viewer` may decide `approval` now (its approver, the teams they are in now). Under a rule of the caller,
   * an agent run's call that no member made is decided by any of the run's watchers (#232, {@link #callersOf}).
   */
  #mayDecide(approval: StoredApproval, viewer: Viewer): boolean {
    const member = viewer.member;

    if (approval.approver.kind === "caller" && approval.callerMember === undefined)
      return member !== undefined && this.#callersOf(approval).includes(member);

    return mayDecide(approval.approver, approval.callerMember, {
      member,
      teams: member === undefined ? [] : this.#core.teamIdsOf(member),
    });
  }

  /**
   * The members who are `approval`'s caller: the member who made the call, or, for an agent run's call that no member
   * made (a run no one started, #232), the run's watchers as they are now (ADR 0040).
   */
  #callersOf(approval: StoredApproval): ReadonlyArray<string> {
    return approval.callerMember === undefined
      ? watchersOfPrincipal(this.#runWatchers, approval.callerPrincipal)
      : [approval.callerMember];
  }

  /**
   * An approval as `viewer` sees it at `now`, or undefined when they may not see it: its eligible approvers and its
   * caller see it; only the former get its arguments, while it keeps them.
   */
  #approvalView(approval: StoredApproval, viewer: Viewer, now: number): ApprovalView | undefined {
    const decides = this.#mayDecide(approval, viewer);

    const caller = viewer.member !== undefined && this.#callersOf(approval).includes(viewer.member);

    if (!decides && !caller) return undefined;

    const pending = approval.status === "pending";
    const args = decides && pending ? this.#approvals.arguments(approval.id, now) : undefined;

    const callerEmail =
      approval.callerMember === undefined
        ? undefined
        : this.#core.member(approval.callerMember)?.email;

    const view: ApprovalView = {
      id: approval.id,
      status: approvalStatus(approval),
      toolkit: {
        id: approval.toolkitId,
        name: this.#store.toolkit(approval.toolkitId)?.name ?? "",
      },
      tool: { id: stableId(approval.toolkitId, approval.upstreamName), name: approval.toolName },
      caller: {
        ...(approval.callerMember === undefined ? {} : { member_id: approval.callerMember }),
        ...(callerEmail === undefined ? {} : { email: callerEmail }),
        principal: approval.callerPrincipal,
      },
      credential: approval.credential,
      approver: this.#approverView(approval.approver),
      created_at: iso(approval.createdAt),
      expires_at: iso(approval.expiresAt),
      ...(approval.decidedAt === undefined ? {} : { decided_at: iso(approval.decidedAt) }),
      ...(approval.decidedBy === undefined ? {} : { decided_by: approval.decidedBy }),
      ...(args === undefined ? {} : { arguments: args }),
      can_decide: decides && pending,
    };

    // Its run's page is for the run's people (#234), who are its caller; an approver beyond them is not told the run.
    const run = caller ? runOfPrincipal(approval.callerPrincipal) : undefined;

    return run === undefined ? view : { ...view, run };
  }

  #approverView(approver: Approver): ApproverView {
    switch (approver.kind) {
      case "caller":
        return approver;
      case "team": {
        const name = this.#core.team(approver.id)?.name;

        return { kind: "team", id: approver.id, ...(name === undefined ? {} : { name }) };
      }

      case "members":
        return {
          kind: "members",
          members: approver.ids.map((id) => {
            const email = this.#core.member(id)?.email;

            return { id, ...(email === undefined ? {} : { email }) };
          }),
        };
    }
  }

  // --- overrides --------------------------------------------------------------------------------------------------

  /**
   * Writes the whole override of one tool, named by its stable id (the toolkit and the upstream name), at `revision` (0
   * when the tool has none). One that sets nothing clears it; its revision is kept (a tombstone), so a write based on
   * the override before the clear is refused. Clearing the override of a tool its source no longer lists answers
   * `removed`, as the tool then leaves the list. A rename to a full name another tool of the same set holds is refused.
   */
  setOverride(
    viewer: Viewer,
    id: string,
    revision: number,
    input: SetToolOverride,
    by: string,
  ): ToolsResult<ToolView | RemovedToolOverride> {
    const managed = this.#managed(id, viewer);

    if (!managed.ok) return managed;
    const toolkit = managed.value;
    const tool = input.tool;
    const stored = this.#store.override(id, tool);
    const current = stored === undefined || stored.cleared ? undefined : stored;

    if ((current?.revision ?? 0) !== revision)
      return refuse(
        "conflict",
        `the override is at revision ${current?.revision ?? 0}, not ${revision}`,
      );

    const listed = this.#tools(id).find((candidate) => candidate.upstreamName === tool);

    if (listed === undefined && current === undefined)
      return refuse("not_found", "the toolkit's tool list has no such tool");

    const name = input.name ?? undefined;

    if (name !== undefined) {
      if (!isToolName(name))
        return refuse("invalid", "a tool's name holds only lowercase letters, digits and _");

      const full = fullToolName(toolkit.name, name);

      if (full.shortened)
        return refuse(
          "invalid",
          `the full name ${toolkit.name}_${name} is longer than ${MAX_FULL_NAME} characters`,
        );

      const taken = this.#resolve(toolkit.owner).tools.some(
        (other) =>
          isServed(other) &&
          other.name === full.name &&
          stableId(other.toolkit.id, other.upstreamName) !== stableId(id, tool),
      );

      if (taken) return refuse("name_taken", `another tool is named ${full.name}`);
    }

    // The whole override: a price the input leaves out is cleared, as every other field is.
    const price = this.#priceChange(toolkit, input.price_micros ?? null);

    if (!price.ok) return price;

    // `hidden: false` sets something only on a tool its source hides by default (a deprecated operation): it shows it.
    const deprecated = listed?.operation?.deprecated === true;

    const value = {
      hidden: input.hidden ?? false,
      name,
      description: input.description ?? undefined,
      toolClass: input.class ?? undefined,
      priceMicros: price.value,
      shown: deprecated && input.hidden === false,
    };

    const empty =
      !value.hidden &&
      !value.shown &&
      value.name === undefined &&
      value.description === undefined &&
      value.toolClass === undefined &&
      value.priceMicros === undefined;

    // Past every revision the row reached, a tombstone's included.
    const next = (stored?.revision ?? 0) + 1;

    this.#store.putOverride(id, tool, empty ? undefined : value, next, by, this.#now());
    this.#dropOrphanedApprovals(id);

    const resolved = this.#resolve(toolkit.owner).tools.find(
      (entry) => entry.toolkit.id === id && entry.upstreamName === tool,
    );

    // Only a cleared override of a missing tool leaves nothing to show.
    return resolved === undefined
      ? ok({ id: stableId(id, tool), removed: true })
      : ok(toolView(resolved));
  }

  /**
   * The price a write leaves on `toolkit` or one of its tools: `change` (`null` clears it, `undefined` keeps the
   * toolkit's), or why not. A private toolkit takes none: a member may not price the tools of their own (ADR 0038).
   */
  #priceChange(
    toolkit: Toolkit,
    change: number | null | undefined,
  ): ToolsResult<number | undefined> {
    if (change === undefined) return ok(toolkit.priceMicros);

    if (change === null) return ok(undefined);

    if (toolkit.owner !== undefined)
      return refuse("invalid", "a private toolkit's tools take no price");
    const invalid = priceRefusal(change);

    return invalid === undefined ? ok(change) : refuse("invalid", invalid);
  }

  // --- export -----------------------------------------------------------------------------------------------------

  /**
   * The toolkits `viewer` reaches, with what their credentials are (never their secrets) and their overrides, and, for
   * an org admin, each org toolkit's tool grants. The agents toolkit (#229) only for a caller that asks for it
   * ({@link KindsOptions}).
   */
  exportToolkits(viewer: Scope, options?: KindsOptions): ReadonlyArray<ToolkitExport> {
    const admin = isOrgAdmin(viewer);
    const grants = admin ? this.#grants.entries() : [];

    return this.#toolkits(options ?? {}).flatMap((toolkit) => {
      const access = reach(toolkit, viewer);

      if (access === "none" || access === "limited") return [];

      const member = this.#memberOf(viewer);

      // The shared credential and the viewer's own private one.
      const credentials = this.#credentialsOf(toolkit)
        .filter((credential) => credential.owner === undefined || credential.owner === member)
        .map((credential) => ({
          slot: credential.owner === undefined ? ("shared" as const) : ("private" as const),
          kind: credential.kind,
          ...(credential.param === undefined ? {} : { name: credential.param }),
        }));

      return [
        {
          name: toolkit.name,
          kind: toolkit.kind,
          source: toolkit.source,
          ...(toolkit.baseUrl === undefined ? {} : { base_url: toolkit.baseUrl }),
          ...(uploaded(toolkit) ? { uploaded: true as const } : {}),
          private: toolkit.owner !== undefined,
          accepts: toolkit.accepts,
          ...(toolkit.priceMicros === undefined ? {} : { price_micros: toolkit.priceMicros }),
          ...settingsField(toolkit),
          credentials,
          overrides: this.#store.overrides(toolkit.id).map((override) => ({
            tool: override.upstreamName,
            hidden: override.hidden,
            ...(override.name === undefined ? {} : { name: override.name }),
            ...(override.description === undefined ? {} : { description: override.description }),
            ...(override.toolClass === undefined ? {} : { class: override.toolClass }),
            ...(override.priceMicros === undefined ? {} : { price_micros: override.priceMicros }),
            ...(override.shown ? { shown: true as const } : {}),
          })),
          ...(admin && toolkit.owner === undefined
            ? {
                grants: grants
                  .filter((grant) => grant.toolkit === toolkit.id)
                  .map((grant) => this.#exportedGrant(grant)),
              }
            : {}),
          ...(toolkit.approvalRules === undefined
            ? {}
            : { approval_rules: this.#exportedRules(toolkit.approvalRules) }),
          ...(toolkit.builtIn && toolkit.kind === "sandbox"
            ? { ...(toolkit.ceiling ?? NO_ALLOWANCE) }
            : {}),
          ...hourPriceView(toolkit),
        },
      ];
    });
  }

  /** A tool grant for the export: the member's email or the team's name instead of an id, upstream tool names. */
  #exportedGrant(grant: ToolGrantEntry): ExportedToolGrant {
    const { subject, tools } = grant;

    return {
      subject: this.#exportedSubject(subject),
      tools:
        tools.kind === "named"
          ? {
              kind: "named",
              tools: tools.ids.map((id) => id.slice(`${grant.toolkit}:`.length)),
            }
          : { kind: tools.kind },
      updated_at: iso(grant.updatedAt),
    };
  }

  #exportedRules(rules: StoredApprovalRules): NonNullable<ToolkitExport["approval_rules"]> {
    const approver = (given: Approver): ExportedApprover => {
      switch (given.kind) {
        case "caller":
          return given;
        case "team":
          return { kind: "team", name: this.#core.team(given.id)?.name ?? "" };
        case "members":
          return {
            kind: "members",
            emails: given.ids.map((id) => this.#core.member(id)?.email ?? ""),
          };
      }
    };

    return {
      ...(rules.writes === undefined ? {} : { writes: { approver: approver(rules.writes) } }),
      ...(rules.tools.length === 0
        ? {}
        : {
            tools: rules.tools.map((mark) => ({
              tool: mark.tool,
              approver: approver(mark.approver),
            })),
          }),
    };
  }

  #exportedSubject(subject: GrantSubject): ExportedToolGrant["subject"] {
    if (subject.kind === "member")
      return { kind: "member", email: this.#core.member(subject.id)?.email ?? "" };

    if (subject.kind === "team")
      return { kind: "team", name: this.#core.team(subject.id)?.name ?? "" };

    return { kind: "everyone" };
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  /**
   * Every toolkit of the org: the built-in ones, then the stored ones; the agents toolkit only when `options` asks for
   * it, and always for the part's own checks (names, grants), which pass none.
   */
  #toolkits(options: KindsOptions = { agentsToolkit: true }): ReadonlyArray<Toolkit> {
    return [
      ...this.#builtIns
        .filter((builtIn) => options.agentsToolkit === true || !isAgentsToolkit(builtIn.toolkit))
        .map((builtIn) => this.#withSettings(builtIn.toolkit)),
      ...this.#store.toolkits(),
    ];
  }

  #toolkit(id: string): Toolkit | undefined {
    const builtIn = this.#builtIn(id);

    return builtIn === undefined ? this.#store.toolkit(id) : this.#withSettings(builtIn.toolkit);
  }

  /** A built-in toolkit with what the org set on it (#201): its approval rules, at their revision. */
  #withSettings(toolkit: BuiltInToolkit): BuiltInToolkit {
    const settings = this.#store.builtInSettings(toolkit.id);

    return settings === undefined ? toolkit : { ...toolkit, ...settings };
  }

  #builtIn(id: string): BuiltIn | undefined {
    return this.#builtIns.find((builtIn) => builtIn.toolkit.id === id);
  }

  /**
   * `toolkit` as a stored toolkit, for what only a stored one takes (editing or removing it, its credentials, building
   * its list from its source), or `403 built_in` for a built-in toolkit: the one place the part refuses those.
   */
  #stored(toolkit: Toolkit): ToolsResult<StoredToolkit> {
    return toolkit.builtIn ? BUILT_IN : ok(toolkit);
  }

  /**
   * Renames the stored toolkits that have a built-in toolkit's name, once, to the next free name (ADR 0037): toolkits,
   * org or private, added before the deployment had the built-in one, which now takes the name everywhere. The new
   * name is the first `<name>_<n>` from 2 that no toolkit of the org has, so the rename shadows nothing; it is stored,
   * by Commissary, and moves the toolkit's revision on.
   */
  #yieldBuiltInNames(): void {
    const builtIn = new Set(this.#builtIns.map((entry) => entry.toolkit.name));

    if (builtIn.size === 0) return;

    this.#core.transaction(() => {
      for (const toolkit of this.#store.toolkits()) {
        if (!builtIn.has(toolkit.name)) continue;
        const taken = new Set(this.#toolkits().map((other) => other.name));
        let suffix = 2;

        while (taken.has(`${toolkit.name}_${suffix}`)) suffix++;

        this.#store.updateToolkit(
          toolkit.id,
          {
            name: `${toolkit.name}_${suffix}`,
            accepts: toolkit.accepts,
            priceMicros: toolkit.priceMicros,
            approvalRules: toolkit.approvalRules,
            baseUrl: toolkit.baseUrl,
            credentialSettings: toolkit.credentialSettings,
          },
          COMMISSARY,
          this.#now(),
        );
      }
    });
  }

  /** The tools listed of every toolkit (`toolkitId`: of one): the built-in ones' from code, the others' as stored. */
  #tools(toolkitId?: string): ReadonlyArray<StoredTool> {
    const builtIn = this.#builtIns.flatMap((entry) => entry.tools);

    return toolkitId === undefined
      ? [...builtIn, ...this.#store.tools()]
      : this.#builtIn(toolkitId) === undefined
        ? this.#store.tools(toolkitId)
        : builtIn.filter((tool) => tool.toolkitId === toolkitId);
  }

  /** A toolkit's credentials; a built-in toolkit's is its shared one, Commissary's own binding, of kind `none`. */
  #credentialsOf(toolkit: Toolkit): ReadonlyArray<ToolkitCredential> {
    return toolkit.builtIn
      ? [
          {
            toolkitId: toolkit.id,
            owner: undefined,
            kind: "none",
            param: undefined,
            connectedAt: toolkit.createdAt,
            connectedBy: toolkit.createdBy,
            via: undefined,
            expiresAt: undefined,
            refreshAt: undefined,
            needsSignIn: false,
          },
        ]
      : this.#store.credentials(toolkit.id);
  }

  #memberOf(viewer: Scope): string | undefined {
    return isFullAccess(viewer) ? undefined : viewer.member;
  }

  /** The toolkit `id` if `viewer` manages it (an org admin an org toolkit, a member their private one). */
  #managed(id: string, viewer: Scope): ToolsResult<Toolkit> {
    const toolkit = this.#toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

    if (access === "read")
      return refuse("forbidden", "only an org admin can change an org toolkit");

    return ok(toolkit);
  }

  /**
   * Why `name` cannot be a toolkit's (`except`: the toolkit being renamed): org toolkit names are unique in the org; a
   * private one must not clash with an org toolkit or its owner's other private toolkits. An org toolkit may take a name
   * a member uses privately.
   */
  #nameRefusal(
    name: string,
    owner: string | undefined,
    except: string | undefined,
  ): ToolsResult<never> | undefined {
    if (!isToolkitName(name))
      return refuse(
        "invalid",
        "a toolkit's name is lowercase letters and digits, words joined by _, at most 32 characters",
      );

    const clash = this.#toolkits().some(
      (other) =>
        other.id !== except &&
        other.name === name &&
        (other.owner === undefined || (owner !== undefined && other.owner === owner)),
    );

    return clash ? refuse("name_taken", `a toolkit is already named ${name}`) : undefined;
  }

  #resolve(member: string | undefined): Resolution {
    return resolveTools({
      toolkits: this.#toolkits(),
      tools: this.#tools(),
      overrides: this.#store.overrides(),
      member,
    });
  }

  #viewOf(id: string, viewer: Scope): ToolsResult<ToolkitView> {
    const toolkit = this.#toolkit(id);

    return toolkit === undefined
      ? NOT_FOUND
      : ok(this.#view(toolkit, viewer, this.#resolve(this.#servedMember(this.#memberOf(viewer)))));
  }

  #listStatus(
    toolkit: Toolkit,
    tools: ReadonlyArray<StoredTool> = this.#tools(toolkit.id),
  ): ToolsList["tool_list"] {
    return {
      ...(toolkit.listBuiltAt === undefined ? {} : { built_at: iso(toolkit.listBuiltAt) }),
      ...(toolkit.listError === undefined ? {} : { error: toolkit.listError }),
      tools: tools.length,
    };
  }

  /**
   * A credential without its secret. It is inactive (and not used) while the toolkit does not accept its kind, or, for
   * a private one, while the org has private credentials off (an org toolkit's) or private toolkits off (a private
   * toolkit's).
   */
  #credentialView(toolkit: Toolkit, credential: ToolkitCredential): ToolkitCredentialView {
    const slot: CredentialSlot = credential.owner === undefined ? "shared" : "private";

    return {
      kind: credential.kind,
      ...(credential.param === undefined ? {} : { name: credential.param }),
      ...(credential.via === undefined ? {} : { via: credential.via }),
      ...(credential.expiresAt === undefined ? {} : { expires_at: iso(credential.expiresAt) }),
      ...(credential.needsSignIn ? { needs_sign_in: true } : {}),
      connected_at: iso(credential.connectedAt),
      connected_by: credential.connectedBy,
      active: accepts(toolkit, slot) && (slot === "shared" || this.#privateAllowed(toolkit)),
    };
  }

  #view(toolkit: Toolkit, viewer: Scope, resolution: Resolution): ToolkitView {
    const member = this.#memberOf(viewer);
    const credentials = this.#credentialsOf(toolkit);
    const shared = credentials.find((credential) => credential.owner === undefined);

    const mine =
      member === undefined
        ? undefined
        : credentials.find((credential) => credential.owner === member);

    const admin = isOrgAdmin(viewer);

    const privateCount = credentials.filter((credential) => credential.owner !== undefined).length;
    // A member who only reads an org toolkit does not see what its source's (or base URL's) query carries.
    const shown = (url: string) => (reach(toolkit, viewer) === "read" ? maskedSource(url) : url);
    const app = reach(toolkit, viewer) === "full" ? this.#appView(toolkit.id) : undefined;
    const tools = this.#tools(toolkit.id);
    const scopes = scopesOf(tools);

    return {
      id: toolkit.id,
      kind: toolkit.kind,
      name: toolkit.name,
      source: shown(toolkit.source),
      ...(toolkit.baseUrl === undefined ? {} : { base_url: shown(toolkit.baseUrl) }),
      ...(uploaded(toolkit) ? { uploaded: true } : {}),
      ...(scopes.length === 0 ? {} : { scopes }),
      private: toolkit.owner !== undefined,
      accepts: toolkit.accepts,
      revision: toolkit.revision,
      created_at: iso(toolkit.createdAt),
      updated_at: iso(toolkit.updatedAt),
      updated_by: toolkit.updatedBy,
      credentials: {
        ...(shared === undefined ? {} : { shared: this.#credentialView(toolkit, shared) }),
        ...(mine === undefined ? {} : { mine: this.#credentialView(toolkit, mine) }),
        ...(admin && toolkit.owner === undefined ? { private_count: privateCount } : {}),
      },
      tool_list: this.#listStatus(toolkit, tools),
      ...(app === undefined ? {} : { oauth_app: app }),
      ...(toolkit.builtIn || toolkit.catalog === undefined
        ? {}
        : {
            catalog: {
              service: toolkit.catalog.service,
              source: toolkit.catalog.source,
              ...(toolkit.catalog.credential === undefined
                ? {}
                : { credential: toolkit.catalog.credential }),
            },
            ...(this.#managedApps.has(toolkit.catalog.service) &&
            this.#oauth.app(toolkit.id) === undefined
              ? { managed_oauth_app: true }
              : {}),
          }),
      // What a member connecting their own credential must know (a compound template's fields); nothing secret.
      ...settingsField(toolkit),
      ...(toolkit.priceMicros === undefined ? {} : { price_micros: toolkit.priceMicros }),
      ...(resolution.renameSuggested.has(toolkit.id) ? { rename_suggested: true } : {}),
      ...(resolution.shadowed.has(toolkit.id) ? { shadowed: true } : {}),
      ...(toolkit.builtIn ? { built_in: true } : {}),
      ...(toolkit.builtIn && toolkit.kind === "sandbox"
        ? { ...(toolkit.ceiling ?? NO_ALLOWANCE) }
        : {}),
      ...hourPriceView(toolkit),
      ...(toolkit.approvalRules === undefined
        ? {}
        : {
            approval_rules: approvalRulesView(toolkit.id, toolkit.approvalRules, (approver) =>
              this.#nobodyDecides(approver),
            ),
          }),
    };
  }

  /** Whether no one can be `approver` now: a team the org deleted, or a list none of whose members is left. */
  #nobodyDecides(approver: Approver): boolean {
    switch (approver.kind) {
      case "caller":
        return false;
      case "team":
        return this.#core.team(approver.id) === undefined;
      case "members":
        return approver.ids.every((id) => this.#core.member(id) === undefined);
    }
  }

  /**
   * The OAuth app a toolkit's sign-ins and token refreshes use: the org's, else, for a toolkit added from the catalog,
   * Commissary Cloud's managed app with its service (#207), when the deployment has it.
   */
  #appFor(id: string): OAuthApp | undefined {
    return this.#oauth.app(id) ?? this.#managedApp(id);
  }

  /** The managed OAuth app of the catalog service a toolkit was added from (#207), when the deployment has it. */
  #managedApp(id: string): OAuthApp | undefined {
    const catalog = this.#store.toolkit(id)?.catalog;

    return catalog === undefined ? undefined : this.#managedApps.app(catalog.service, id);
  }

  /**
   * Stores the catalog additions' overrides of a new toolkit's tools (#207), as overrides by `catalog` an org admin may
   * change or clear later; a name that is not a tool name is left out (the rest of its override stays).
   */
  #putCatalogOverrides(
    id: string,
    overrides: Readonly<Record<string, CatalogToolOverride>>,
    now: number,
  ): void {
    for (const [tool, override] of Object.entries(overrides)) {
      const name =
        override.name !== undefined && isToolName(override.name) ? override.name : undefined;

      const value = {
        hidden: override.hidden ?? false,
        name,
        description: override.description,
        toolClass: override.class,
        priceMicros: undefined,
        shown: false,
      };

      if (
        value.hidden ||
        name !== undefined ||
        value.description !== undefined ||
        value.toolClass !== undefined
      )
        this.#store.putOverride(id, tool, value, 1, CATALOG_AUTHOR, now);
    }
  }

  /** A toolkit's OAuth app without its secret, for its managers. */
  #appView(id: string): OAuthAppView | undefined {
    const app = this.#oauth.app(id);

    return app === undefined
      ? undefined
      : {
          client_id: app.clientId,
          client_secret: app.clientSecret !== undefined,
          authorize_url: app.authorizeUrl,
          token_url: app.tokenUrl,
          scopes: app.scopes,
          ...(app.issuer === undefined ? {} : { issuer: app.issuer }),
          ...(app.requestTokenUrl === undefined ? {} : { request_token_url: app.requestTokenUrl }),
          updated_at: iso(app.updatedAt),
          updated_by: app.updatedBy,
        };
  }

  #limitedView(toolkit: Toolkit): LimitedToolkitView {
    const owner = toolkit.owner ?? "";
    const email = this.#core.member(owner)?.email;

    return {
      id: toolkit.id,
      private: true,
      limited: true,
      owner: { member_id: owner, ...(email === undefined ? {} : { email }) },
      created_at: iso(toolkit.createdAt),
      revision: toolkit.revision,
    };
  }
}

/** A browser profile as its manager sees it. */
const profileView = (profile: StoredProfile): BrowserProfileView => ({
  id: profile.id,
  name: profile.name,
  private: profile.owner !== undefined,
  saved_at: profile.savedAt === undefined ? null : iso(profile.savedAt),
  revision: profile.revision,
  created_at: iso(profile.createdAt),
  updated_at: iso(profile.updatedAt),
});

/** Where an approval stands as the API says it: `used` once its approved call went through. */
const approvalStatus = (approval: StoredApproval): ApprovalView["status"] =>
  approval.status === "approved" && approval.settled ? "used" : approval.status;

/** A toolkit's view with what connecting its shared credential did to its subject's grants, if it was connected. */
const withGrant = (
  view: ToolsResult<ToolkitView>,
  grant: ConnectedGrant | undefined,
): ToolsResult<ConnectedToolkitView> =>
  view.ok && grant !== undefined ? ok({ ...view.value, grant }) : view;

/** A resolved tool as a grant is asked about it. */
const grantable = (tool: ResolvedTool): GrantableTool => ({
  toolkitId: tool.toolkit.id,
  upstreamName: tool.upstreamName,
  toolClass: tool.toolClass,
});

/** A resolved tool as the management API shows it. */
const toolView = (tool: ResolvedTool): ToolView => {
  const override = tool.override;

  return {
    id: stableId(tool.toolkit.id, tool.upstreamName),
    toolkit_id: tool.toolkit.id,
    upstream_name: tool.upstreamName,
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.tool?.inputSchema === undefined ? {} : { input_schema: tool.tool.inputSchema }),
    ...(tool.tool?.annotations === undefined ? {} : { annotations: tool.tool.annotations }),
    class: tool.toolClass,
    ...(tool.priceMicros === undefined ? {} : { price_micros: tool.priceMicros }),
    flags: {
      shortened: tool.shortened,
      renamed: tool.renamed,
      hidden: tool.hidden,
      clash: tool.clash,
      missing: tool.missing,
      ...(tool.deprecated ? { deprecated: true } : {}),
    },
    ...(override === undefined
      ? {}
      : {
          override: {
            revision: override.revision,
            hidden: override.hidden,
            ...(override.name === undefined ? {} : { name: override.name }),
            ...(override.description === undefined ? {} : { description: override.description }),
            ...(override.toolClass === undefined ? {} : { class: override.toolClass }),
            ...(override.priceMicros === undefined ? {} : { price_micros: override.priceMicros }),
            updated_at: iso(override.updatedAt),
            updated_by: override.updatedBy,
          },
        }),
  };
};
