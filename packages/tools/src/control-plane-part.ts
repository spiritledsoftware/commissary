import { RpcTarget } from "cloudflare:workers";
import { Clock, type Duration, Effect, Result, type Schema } from "effect";
import { type Access, accessTo, isFullAccess, type Scope, type Viewer } from "@commissary/auth";
import type {
  ApprovalDecision,
  ApprovalsList,
  ApprovalView,
  Approver,
  ApproverView,
} from "@commissary/contract/approvals";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { GrantSubject, ToolGrant, ToolGrants } from "@commissary/contract/grants";
import type {
  ConnectCredential,
  ConnectedGrant,
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
  ToolkitCredentialView,
  ToolkitDocument,
  ToolkitKind,
  ToolkitSecret,
  ToolkitsList,
  ToolkitView,
  ToolsList,
  ToolView,
  UpdateToolkit,
  UsableTool,
  UsableTools,
} from "@commissary/contract/tools";
import type { ToolCallApproval } from "@commissary/contract/usage";
import {
  CurrentOutboundPolicy,
  OutboundHttpClientLive,
  type OutboundPolicy,
  outboundPolicy,
} from "@commissary/core";
import type { HttpClient } from "effect/http";
import type { ControlPlanePart, OrgCore } from "@commissary/state";
import type { ChargedCredential, Refusal, SpendCredential } from "@commissary/state/spend";
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
  connectGrant,
  type ToolGrantChange,
  type ToolGrantEntry,
  type ToolGrantValue,
} from "./grants/grant.ts";
import { type GrantableTool, grantedTools, inToolScope } from "./grants/reach.ts";
import { cleanToolGrant, ToolGrantStore } from "./grants/store.ts";
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
import { type ClientVia, OAuthStore } from "./oauth/store.ts";
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
import { priceRefusal } from "./toolkits/price.ts";
import {
  type ClientCredentialsSecret,
  type OAuthSecret,
  secretRefusal,
  type StoredSecret,
  type UpstreamSecret,
} from "./toolkits/secret.ts";
import {
  type BuiltIn,
  type BuiltInProviders,
  builtInToolkits,
  COMMISSARY,
} from "./toolkits/built-in.ts";
import type { BuiltInToolkit, StoredToolkit, Toolkit } from "./toolkits/toolkit.ts";
import { NO_NETWORK, networkProblem, normalizedNetwork } from "./sandbox/network.ts";
import type { SandboxProvider } from "./sandbox/provider.ts";
import { SandboxSessionStore, type TrackedSession } from "./sandbox/sessions.ts";

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
  | "sign_in_failed";

export type ToolsResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly error: ToolsErrorCode;
      readonly message: string;
      /** The field an `outbound_refused` URL or a `body_too_large` document came in. */
      readonly path?: string;
    };

const refuse = (error: ToolsErrorCode, message: string) => ({ ok: false, error, message }) as const;

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
const refreshable = (kind: StoredSecret["kind"]): boolean =>
  kind === "oauth" || kind === "client_credentials";

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
}

const ok = <A>(value: A): ToolsResult<A> => ({ ok: true, value });

const NOT_FOUND = refuse("not_found", "toolkit not found");

const BUILT_IN = refuse(
  "built_in",
  "the toolkit is Commissary's own: it cannot be renamed, edited (but for its approval rules, and the sandbox's network), given a credential, refreshed or removed",
);

const iso = (at: number): string => new Date(at).toISOString();

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
  /** The source, already checked by the outbound guard; empty for an uploaded OpenAPI document. */
  readonly source: string;
  /** An OpenAPI toolkit's uploaded document, or a GraphQL toolkit's uploaded schema (SDL). */
  readonly document?: string | undefined;
  /** An OpenAPI toolkit's base URL, already checked by the outbound guard. */
  readonly baseUrl?: string | undefined;
  /** Undefined: an OpenAPI toolkit's default, from its document ({@link openApiName}). */
  readonly name: string | undefined;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  /** Connected at once; an org toolkit's shared credential names who may use it (`subject`). */
  readonly credential?: ConnectCredential | undefined;
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
  /** Empty for an uploaded OpenAPI document, which the export does not hold (`uploaded`). */
  readonly source: string;
  readonly base_url?: string;
  /**
   * An OpenAPI toolkit built from an uploaded document, or a GraphQL toolkit from an uploaded schema: its managers
   * download it on its own route.
   */
  readonly uploaded?: true;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  /** Micro-USD per call of an org toolkit's tools (#199). */
  readonly price_micros?: number;
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
}

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
  /** Micro-USD charged: the tool's price on a result, 0 when free, refused or failed upstream. */
  readonly costMicros: number;
  /** How an approval rule decided the call (#201); `none` when no rule made it wait. */
  readonly approval: ToolCallApproval;
}

/**
 * What a call came to: `unknown`, a tool the member does not reach (answered as a tool that does not exist);
 * `connect`, a tool that needs a private credential the member has not connected; `refused`, a priced call that a
 * Spend limit without room keeps from the upstream (#199); under an approval rule (#201), `approve`, a call its caller
 * approves on a form first (the client makes it again with their answer), `pending`, a call that waits for its
 * approver in the panel, or `not_approved`, one that was denied (or that no one could approve); the upstream's
 * `result`, an `isError` one included; or `failed`, an upstream or transport failure, with a short message that
 * quotes neither the source nor the server's answer. All but `unknown` and `approve` say what the call's usage record
 * holds (a call on a form writes its record once it ends). The approval outcomes go only to a call that says it
 * understands them (`ToolCall.approvalOutcomes`).
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
  | { readonly outcome: "refused"; readonly refusal: Refusal; readonly usage: CallUsage }
  | { readonly outcome: "result"; readonly result: Schema.JsonObject; readonly usage: CallUsage }
  | { readonly outcome: "failed"; readonly message: string; readonly usage: CallUsage };

/** What an API key's view says of its tools (#200): how many it may use now, and what its scope names that is gone. */
export interface KeyToolSummary {
  readonly toolCount: number;
  readonly missing: ReadonlyArray<string>;
}

/** A tool the MCP endpoint serves a member, and how they reach it. */
interface ReachableTool {
  readonly tool: ResolvedTool;
  /** As themselves: their private toolkit, or an org toolkit that takes private credentials (no grant needed). */
  readonly asMember: boolean;
  /** Through a grant of the org toolkit's shared credential. */
  readonly granted: boolean;
}

/** A credential's secret, without the subject it was connected for. */
const secretOf = (credential: ConnectCredential): ToolkitSecret => {
  const { subject: _subject, ...secret } = credential;

  return secret;
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
 * Whether `toolkit` is built from an uploaded document the part keeps (an OpenAPI document, a GraphQL schema's SDL).
 */
const uploaded = (toolkit: Toolkit): boolean => !toolkit.builtIn && toolkit.uploaded;

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
  /** What the part reads the time from: the live clock, or a test's (`useClock`). */
  #clock: Clock.Clock = Clock.Clock.defaultValue();

  /** `ownHosts`: the deployment's own hosts (`OWN_HOSTS`), which the part's own requests refuse. */
  constructor(
    ctx: DurableObjectState,
    core: OrgCore,
    providers: BuiltInProviders = {},
    ownHosts?: string,
  ) {
    super();
    this.#ctx = ctx;
    this.#core = core;
    this.#builtIns = builtInToolkits(providers);
    this.#store = new ToolkitStore(ctx.storage.sql, core.secrets, (body) => core.transaction(body));
    this.#grants = new ToolGrantStore(ctx.storage.sql, (body) => core.transaction(body));
    this.#approvals = new ApprovalStore(ctx.storage.sql, core.secrets);
    this.#oauth = new OAuthStore(ctx.storage.sql, core.secrets);
    this.#outbound = outboundPolicy({ hosts: [ownHosts] });
    this.#sandboxSessions = new SandboxSessionStore(ctx.storage.sql);
    this.#sandbox = providers.sandbox;
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
   * Forgets the upstream sessions older than seven days (ADR 0038) and the sandbox sessions the sandbox ended for want
   * of use (#222), deletes the pending approvals (and forms) that expired (#201) and refreshes the tokens of the OAuth
   * credentials that expire soon (#202), then wakes up when the next of these is due. Tool lists are rebuilt by the
   * cron task. Each token refresh stands alone: one that throws is logged and tried again after {@link
   * REFRESH_RETRY_MS}, and the others, the pruning and the next wake-up go on.
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
   * the approvals' and the credentials' token refreshes (none before `refreshFrom`).
   */
  #nextWakeUp(now: number, refreshFrom = now): number | null {
    const refresh = this.#store.nextRefreshAt();

    const wakes = [
      this.#store.pruneSessions(now),
      this.#sandboxSessions.prune(now),
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
    for (const table of TOOLS_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    this.#schemas.forget();
  }

  /**
   * Zero data retention (ADR 0027): a member's private toolkits and private credentials go with them, and so do the
   * tool grants that named them and the pending approvals of their calls (#201). They leave every list of approvers.
   * Their open sandbox sessions (#222) are deleted at once, with their files.
   */
  async memberLeft(member: string): Promise<void> {
    await this.#purgeSandboxSessions(this.#sandboxSessions.sessions({ member }));

    this.#core.transaction(() => {
      this.#store.deleteMember(member);
      this.#oauth.deleteMember(member);
      this.#grants.forget({ kind: "member", id: member });

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
   * Deletes `sessions` in their sandbox, and their rows once deleted; answers how many it asked the sandbox to delete.
   * One the sandbox could not reach keeps its row, for the next try (it ends by itself after a day without use).
   */
  async #purgeSandboxSessions(sessions: ReadonlyArray<TrackedSession>): Promise<number> {
    const sandbox = this.#sandbox;

    if (sandbox === undefined || sessions.length === 0) return 0;

    const purged = await Promise.all(
      sessions.map(async (session) =>
        Effect.runPromise(
          sandbox.purge(this.#core.org, session.id).pipe(
            Effect.as(session.id),
            Effect.catchTag("SandboxError", (error) =>
              Effect.logWarning("sandbox session not purged").pipe(
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

  /** The tool grants that named the team go with it. */
  teamDeleted(team: string): void {
    this.#grants.forget({ kind: "team", id: team });
  }

  /** Read on every use (`core.teamIdsOf`): nothing to forget. */
  teamMembersChanged(): void {}

  apiKeysDeleted(): void {}

  /** Read on every use: nothing to forget. */
  privateCredentialsChanged(): void {}

  /** Tools holds no agents: no Spend limit names one of its. */
  spendAgents(): readonly [] {
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

  /** The toolkits `viewer` reaches; an org admin also gets the other members' private toolkits, as existence only. */
  listToolkits(viewer: Scope): ToolkitsList {
    const resolution = this.#resolve(this.#servedMember(this.#memberOf(viewer)));
    const toolkits: Array<ToolkitView> = [];
    const others: Array<LimitedToolkitView> = [];

    for (const toolkit of this.#toolkits()) {
      const access = reach(toolkit, viewer);

      if (access === "limited") others.push(this.#limitedView(toolkit));
      else if (access !== "none") toolkits.push(this.#view(toolkit, viewer, resolution));
    }

    return isFullAccess(viewer) || viewer.admin ? { toolkits, others } : { toolkits };
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

    const id = freshToolkitId();
    let grant: ToolGrantValue | undefined;

    if (input.credential !== undefined) {
      const slot: CredentialSlot = input.private ? "private" : "shared";

      const credentialRefusal = this.#credentialRefusal(
        { owner, accepts: input.accepts },
        slot,
        secretOf(input.credential),
      );

      if (credentialRefusal !== undefined) return credentialRefusal;
      const granted = this.#connectGrant(id, slot, input.credential.subject);

      if (!granted.ok) return granted;
      grant = granted.value;
    }

    const driver = KIND_DRIVERS[kind];

    const listSource = { uploaded: input.document !== undefined };

    // A source read without a credential (an OpenAPI document, an uploaded GraphQL schema) is read before the toolkit
    // is added: an OpenAPI document names the toolkit by default. One that cannot be read does not keep the toolkit
    // from being added, as a list that cannot be built does not.
    const listing = driver.listsWithCredential(listSource)
      ? undefined
      : await this.#listing(driver, {
          toolkit: { source: input.source, baseUrl: input.baseUrl },
          secret: NO_SECRET,
          document: input.document,
          timeout: LISTING_TIMEOUT,
          policy,
        });

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
        owner,
        accepts: input.accepts,
        revision: 1,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        updatedBy: by,
      });

      if (input.document !== undefined) this.#store.putDocument(id, input.document);

      if (listing !== undefined) this.#storeListing(id, listing);

      if (input.credential !== undefined)
        this.#store.putCredential(id, owner, secretOf(input.credential), by, now);

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
   * ceiling (#222), the widest network its sessions may ask for (an org admin's: the toolkit is an org toolkit). Nothing
   * else of it changes (`403 built_in` for a name, what it accepts or a price; a network on the browser toolkit too).
   * Open sessions keep the network they opened with.
   */
  #updateBuiltIn(
    viewer: Viewer,
    current: BuiltInToolkit,
    revision: number,
    change: UpdateToolkit,
    by: string,
  ): ToolsResult<ToolkitView> {
    const { approval_rules: _rules, network, ...rest } = change;

    if (
      Object.values(rest).some((value) => value !== undefined) ||
      (network !== undefined && current.kind !== "sandbox")
    )
      return BUILT_IN;

    if (current.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${current.revision}, not ${revision}`);
    const rules = this.#rulesChange(current, change.approval_rules);

    if (!rules.ok) return rules;
    const problem = network === undefined ? undefined : networkProblem(network);

    if (problem !== undefined) return refuse("invalid", problem);

    this.#store.updateBuiltIn(
      current.id,
      current.revision,
      {
        approvalRules: rules.value,
        network: network === undefined ? current.network : normalizedNetwork(network),
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
   * Replaces an uploaded document (managers): an OpenAPI document, a GraphQL schema's SDL (#204), and builds its tool
   * list from it. A GraphQL toolkit built from introspection takes a first SDL file too (an endpoint that stopped
   * answering introspection), and is built from uploaded files from then on: the cron task leaves it alone, and a build
   * needs no credential. A document that cannot be read replaces nothing.
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

    if (Result.isFailure(listing)) return refuse("invalid", listing.failure.message);

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
   * A toolkit's uploaded document (an OpenAPI document, a GraphQL schema's SDL), for its managers only: a document may
   * describe more of an API than its tools show (a member who reads the toolkit sees its tool list).
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
    const secret = secretOf(credential);

    const refused = this.#credentialRefusal(toolkit, slot, secret);

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

    this.#oauth.putApp({
      toolkitId: id,
      clientId,
      clientSecret: app.client_secret === "" ? undefined : app.client_secret,
      authorizeUrl: app.authorize_url,
      tokenUrl: app.token_url,
      scopes,
      issuer: issuer === "" ? undefined : issuer,
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
   * MCP server's client (`prepareSignIn`). Answers the URL the browser opens; the callback finishes it
   * ({@link completeSignIn}).
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

    const prepared = await this.#outboundRun(
      prepareSignIn({
        toolkitId: id,
        source: toolkit.source,
        app: this.#oauth.app(id),
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
        flow: { ...flow, verifier: pkce.verifier, by, subject: input.subject },
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
   * then, in place of the one before. A failure is the sign-in's, for its starter to read.
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

    if (Result.isFailure(exchanged)) return fail(exchanged.failure.message);

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
      this.#store.putCredential(toolkitId, owner, exchanged.success, flow.by, now);

      if (registered !== undefined) this.#oauth.putClient(registered, now);

      if (grant.value !== undefined) this.#grantOnConnect(grant.value, flow.by, now);
      this.#oauth.complete(session.state, now);
    });

    await this.#wake();

    if (toolkit.listBuiltAt === undefined) await this.#buildFor(toolkitId, owner, policy);

    return { outcome: "completed" };
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
    toolkit: Pick<Toolkit, "owner" | "accepts">,
    slot: CredentialSlot,
    secret: ToolkitSecret,
  ): ToolsResult<never> | undefined {
    const refused = this.#slotRefusal(toolkit, slot);

    if (refused !== undefined) return refused;

    if (secret.kind === "client_credentials" && slot === "private")
      return refuse("invalid", "a client credentials grant is a shared credential only");

    const invalid = secretRefusal(secret);

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
   * token refresh first when it expires within {@link EXPIRY_MARGIN_MS} (a client credentials grant mints its first one).
   */
  async #signedIn(
    toolkit: Toolkit,
    credential: ToolkitCredential,
    policy: OutboundPolicy,
  ): Promise<Signed> {
    if (credential.needsSignIn) return NEEDS_SIGN_IN;
    const secret = this.#store.secret(credential.toolkitId, credential.owner);

    if (secret === undefined) return NEEDS_SIGN_IN;

    switch (secret.kind) {
      case "oauth":
        return fresh(secret.expires_at, this.#now())
          ? bearer(secret.access_token)
          : await this.#refresh(toolkit, credential, policy);
      case "client_credentials":
        return secret.access_token !== undefined && fresh(secret.expires_at, this.#now())
          ? bearer(secret.access_token)
          : await this.#refresh(toolkit, credential, policy);
      default:
        return { kind: "signed", secret };
    }
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
      OAuthSecret | (ClientCredentialsSecret & { readonly access_token: string }),
      OAuthError,
      HttpClient.HttpClient
    >;

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
      refresh = mintClientCredentials(secret, toolkit.source, this.#now());
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

    const client = via === "app" ? this.#oauth.app(toolkitId) : this.#oauth.client(toolkitId);

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
   * org's and its owner's (none while the org does not serve private toolkits).
   */
  listTools(viewer: Scope, id: string): ToolsResult<ToolsList> {
    const toolkit = this.#toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
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
   * (#200), read from the key on every request, so a change to the scope applies at once.
   */
  clientTools(viewer: Viewer, apiKeyId?: string): ReadonlyArray<ClientTool> {
    return this.#reachable(viewer, this.#keyScope(apiKeyId)).map(({ tool }) => ({
      name: tool.name,
      toolkit: tool.toolkit.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.tool?.inputSchema === undefined ? {} : { inputSchema: tool.tool.inputSchema }),
      toolClass: tool.toolClass,
    }));
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
    const outcome = await this.#callTool(viewer, call, policy);

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
  ): Promise<ToolCallOutcome> {
    const reached = this.#reachable(viewer, this.#keyScope(call.apiKeyId)).find(
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
    ): CallUsage => ({
      toolkitId: toolkit.id,
      toolId: stableId(toolkit.id, tool.upstreamName),
      credential: used,
      private: used === "private" || toolkit.owner !== undefined,
      costMicros,
      approval,
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
    const spender = { memberId: viewer.member, apiKeyId: call.apiKeyId };

    // The toolkit's shared credential is a `toolkit_credential` limit's; a private one counts toward the API key's limits only.
    const charged: ChargedCredential = {
      id: toolkit.id,
      shared: slot === "shared",
      kind: "toolkit_credential",
    };

    if (price > 0) {
      const refusal = ledger.refusal(spender, charged, this.#now());

      if (refusal !== undefined) return { outcome: "refused", refusal, usage: usage(slot) };
    }

    const approval = await this.#approvalOf(viewer, call, tool, slot);

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

    // A built-in tool always answers a result, a failure as one with `isError`; it is charged like an upstream's. A
    // browser or sandbox session's tools (#213, #222) act for the org, member and principal of the call: the session's
    // owner (a call without a principal reaches no session).
    if ("builtIn" in serving) {
      const now = this.#now();
      const { builtIn } = serving;
      const { principalId } = call;
      let opened = false;

      const result = await Effect.runPromise(
        builtIn.call(tool.upstreamName, call.arguments, {
          // A sandbox session is its principal's (a member, or one API key of theirs): a call without one may not use
          // the sandbox.
          org: this.#core.org,
          member: viewer.member,
          principal: principalId,
          sessions: {
            opened: (id) => {
              opened = true;
              this.#sandboxSessions.opened({
                id,
                toolkitId: builtIn.toolkit.id,
                member: viewer.member,
                principal: principalId ?? "",
                openedAt: now,
              });
            },
            used: (id) => this.#sandboxSessions.used(id, now),
            ended: (id) => this.#sandboxSessions.ended([id]),
          },
          policy,
          now,
          // The toolkit with what the org set on it (its network ceiling).
          toolkit: this.#withSettings(builtIn.toolkit),
        }),
      );

      // A new sandbox session ends a day after its last use: the part wakes up then to forget it.
      if (opened) await this.#core.wakeUpChanged(this.#nextWakeUp(now));

      if (price > 0) ledger.charge(ledger.scopes(spender, charged), price, this.#now());

      return { outcome: "result", result, usage: usage(slot, price, approved) };
    }

    const attempt = await this.#callUpstream(serving.stored, {
      tool,
      owner,
      caller: viewer.member ?? "",
      credential: serving.credential,
      args: call.arguments,
      policy,
    });

    if (attempt.kind === "sign_in") return signIn(approved);
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
   * Whether a call goes on to the upstream under the toolkit's approval rules (#201), and how it was approved. No rule:
   * it goes (`none`). A rule whose approver is the caller, from a client that shows forms: the caller is asked
   * (`approve`, with a `requestState` that binds the form to this call), and the call made again with their answer and
   * that state goes (`approved_elicitation`) or is denied; an answer without a state this part issued for this very call
   * (the same caller, tool and arguments, within the hour, once) is no answer, and the caller is asked again. Otherwise
   * the call is matched with its pending approval (same caller, tool and arguments' hash, within the hour): an approved
   * one lets it through once (`approved_panel`) and is settled; a denied one answers so and is settled, so the next
   * identical call asks anew; an undecided one answers pending again. Without one (none, or it expired), a pending
   * approval is created, the arguments sealed. A caller without a member under a rule of the caller, without a form,
   * cannot be approved by anyone.
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

    const key: ApprovalKey = {
      toolkitId: tool.toolkit.id,
      upstreamName: tool.upstreamName,
      argsHash: argumentsHash(call.arguments),
      callerMember: viewer.member,
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

    if (approver.kind === "caller" && viewer.member === undefined)
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
   * The served tools `viewer` reaches ({@link clientTools}), sorted by full name, and how. A private toolkit counts
   * only while the org lets members add them: otherwise it is kept, but not served, and does not shadow an org toolkit
   * of its name. `scope` (an API key's tool scope, #200) narrows them further; `undefined`: no narrowing.
   */
  #reachable(viewer: Viewer, scope?: ToolScope): ReadonlyArray<ReachableTool> {
    const member = viewer.member;

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
        granted:
          tool.toolkit.owner === undefined &&
          accepts(tool.toolkit, "shared") &&
          shared.has(tool.toolkit.id) &&
          granted(grantable(tool)),
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
   * endpoint lists for them without a key's scope, with each tool's stable id and class.
   */
  usableTools(viewer: Viewer): UsableTools {
    const toolkits = new Map<string, { id: string; name: string; tools: Array<UsableTool> }>();

    for (const { tool } of this.#reachable(viewer)) {
      const toolkit = toolkits.get(tool.toolkit.id) ?? {
        id: tool.toolkit.id,
        name: tool.toolkit.name,
        tools: [],
      };

      toolkit.tools.push({
        id: stableId(tool.toolkit.id, tool.upstreamName),
        name: tool.name,
        tool_class: tool.toolClass,
      });
      toolkits.set(tool.toolkit.id, toolkit);
    }

    return {
      toolkits: [...toolkits.values()].toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    };
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
        toolCount: this.#reachable({ member: key.memberId, admin: false }, key.toolScope).length,
        missing,
      };
    });
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

  /** Whether `viewer` may decide `approval` now (its approver, the teams they are in now). */
  #mayDecide(approval: StoredApproval, viewer: Viewer): boolean {
    const member = viewer.member;

    return mayDecide(approval.approver, approval.callerMember, {
      member,
      teams: member === undefined ? [] : this.#core.teamIdsOf(member),
    });
  }

  /**
   * An approval as `viewer` sees it at `now`, or undefined when they may not see it: its eligible approvers and its
   * caller see it; only the former get its arguments, while it keeps them.
   */
  #approvalView(approval: StoredApproval, viewer: Viewer, now: number): ApprovalView | undefined {
    const decides = this.#mayDecide(approval, viewer);

    const caller = viewer.member !== undefined && approval.callerMember === viewer.member;

    if (!decides && !caller) return undefined;

    const pending = approval.status === "pending";
    const args = decides && pending ? this.#approvals.arguments(approval.id, now) : undefined;

    const callerEmail =
      approval.callerMember === undefined
        ? undefined
        : this.#core.member(approval.callerMember)?.email;

    return {
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
   * an org admin, each org toolkit's tool grants.
   */
  exportToolkits(viewer: Scope): ReadonlyArray<ToolkitExport> {
    const admin = isFullAccess(viewer) || viewer.admin;
    const grants = admin ? this.#grants.entries() : [];

    return this.#toolkits().flatMap((toolkit) => {
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
            ? { network: toolkit.network ?? NO_NETWORK }
            : {}),
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

  /** Every toolkit of the org: the built-in ones, then the stored ones. */
  #toolkits(): ReadonlyArray<Toolkit> {
    return [
      ...this.#builtIns.map((builtIn) => this.#withSettings(builtIn.toolkit)),
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

  #listStatus(toolkit: Toolkit): ToolsList["tool_list"] {
    return {
      ...(toolkit.listBuiltAt === undefined ? {} : { built_at: iso(toolkit.listBuiltAt) }),
      ...(toolkit.listError === undefined ? {} : { error: toolkit.listError }),
      tools: this.#tools(toolkit.id).length,
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

    const admin = isFullAccess(viewer) || viewer.admin;

    const privateCount = credentials.filter((credential) => credential.owner !== undefined).length;
    // A member who only reads an org toolkit does not see what its source's (or base URL's) query carries.
    const shown = (url: string) => (reach(toolkit, viewer) === "read" ? maskedSource(url) : url);
    const app = reach(toolkit, viewer) === "full" ? this.#appView(toolkit.id) : undefined;

    return {
      id: toolkit.id,
      kind: toolkit.kind,
      name: toolkit.name,
      source: shown(toolkit.source),
      ...(toolkit.baseUrl === undefined ? {} : { base_url: shown(toolkit.baseUrl) }),
      ...(uploaded(toolkit) ? { uploaded: true } : {}),
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
      tool_list: this.#listStatus(toolkit),
      ...(app === undefined ? {} : { oauth_app: app }),
      ...(toolkit.priceMicros === undefined ? {} : { price_micros: toolkit.priceMicros }),
      ...(resolution.renameSuggested.has(toolkit.id) ? { rename_suggested: true } : {}),
      ...(resolution.shadowed.has(toolkit.id) ? { shadowed: true } : {}),
      ...(toolkit.builtIn ? { built_in: true } : {}),
      ...(toolkit.builtIn && toolkit.kind === "sandbox"
        ? { network: toolkit.network ?? NO_NETWORK }
        : {}),
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
