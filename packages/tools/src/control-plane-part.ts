import { RpcTarget } from "cloudflare:workers";
import { type Duration, Effect, Result, type Schema } from "effect";
import { type Access, accessTo, isFullAccess, type Scope, type Viewer } from "@commissary/auth";
import type { GrantSubject, ToolGrant, ToolGrants } from "@commissary/contract/grants";
import type {
  ConnectCredential,
  ConnectedGrant,
  ConnectedToolkitView,
  CredentialSlot,
  CredentialsAccepted,
  LimitedToolkitView,
  ToolClass,
  RemovedToolOverride,
  SetToolOverride,
  ToolkitCredentialView,
  ToolkitSecret,
  ToolkitsList,
  ToolkitView,
  ToolsList,
  ToolView,
} from "@commissary/contract/tools";
import {
  CurrentOutboundPolicy,
  OutboundHttpClientLive,
  type OutboundPolicy,
} from "@commissary/core";
import type { ControlPlanePart, OrgCore } from "@commissary/state";
import type { SpendCredential } from "@commissary/state/spend";
import {
  connectGrant,
  type ToolGrantChange,
  type ToolGrantEntry,
  type ToolGrantValue,
} from "./grants/grant.ts";
import { type GrantableTool, grantedTools } from "./grants/reach.ts";
import { cleanToolGrant, ToolGrantStore } from "./grants/store.ts";
import { callUpstreamTool, LISTING_TIMEOUT, listUpstreamTools } from "./mcp/client.ts";
import { isToolkitName, isToolName, fullToolName, MAX_FULL_NAME } from "./toolkits/names.ts";
import {
  isServed,
  type Resolution,
  type ResolvedTool,
  resolveTools,
  stableId,
} from "./toolkits/resolve.ts";
import {
  freshToolkitId,
  type Toolkit,
  type ToolkitCredential,
  ToolkitStore,
  TOOLS_TABLES,
} from "./toolkits/store.ts";
import { secretRefusal } from "./toolkits/secret.ts";

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
  | "tool_list_failed";

export type ToolsResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ToolsErrorCode; readonly message: string };

const refuse = (error: ToolsErrorCode, message: string) => ({ ok: false, error, message }) as const;

const ok = <A>(value: A): ToolsResult<A> => ({ ok: true, value });

const NOT_FOUND = refuse("not_found", "toolkit not found");

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
  /** The source, already checked by the outbound guard. */
  readonly source: string;
  readonly name: string;
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
  readonly kind: "mcp";
  readonly source: string;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  readonly credentials: ReadonlyArray<{
    readonly slot: CredentialSlot;
    readonly kind: ToolkitSecret["kind"];
    readonly name?: string;
  }>;
  readonly overrides: ReadonlyArray<{
    readonly tool: string;
    readonly hidden: boolean;
    readonly name?: string;
    readonly description?: string;
    readonly class?: "read" | "write";
  }>;
  /** An org toolkit's tool grants, in an org admin's export only. */
  readonly grants?: ReadonlyArray<ExportedToolGrant>;
}

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
}

/**
 * What a call came to: `unknown`, a tool the member does not reach (answered as a tool that does not exist);
 * `connect`, a tool that needs a private credential the member has not connected; the upstream's `result`, an `isError`
 * one included; or `failed`, an upstream or transport failure, with a short message that quotes neither the source nor
 * the server's answer.
 */
export type ToolCallOutcome =
  | { readonly outcome: "unknown" }
  | {
      readonly outcome: "connect";
      readonly toolkit: { readonly id: string; readonly name: string };
    }
  | { readonly outcome: "result"; readonly result: Schema.JsonObject }
  | { readonly outcome: "failed"; readonly message: string };

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
 */
export class ToolsPart extends RpcTarget implements ControlPlanePart {
  readonly #ctx: DurableObjectState;
  readonly #core: OrgCore;
  readonly #store: ToolkitStore;
  readonly #grants: ToolGrantStore;

  constructor(ctx: DurableObjectState, core: OrgCore) {
    super();
    this.#ctx = ctx;
    this.#core = core;
    this.#store = new ToolkitStore(ctx.storage.sql, core.secrets, (body) => core.transaction(body));
    this.#grants = new ToolGrantStore(ctx.storage.sql, (body) => core.transaction(body));
  }

  // --- the org-wide base's calls (`ControlPlanePart`, `@commissary/state`) ------------------------------------

  /** Tools sealed its secrets from the start: nothing was stored in plain text. */
  sealPlaintext(): number {
    return 0;
  }

  /**
   * Forgets the upstream sessions older than seven days (ADR 0038) and wakes up when the next one is. Tool lists are
   * rebuilt by the cron task.
   */
  async alarm(now: number): Promise<number | null> {
    return this.#store.pruneSessions(now);
  }

  /** Deletes the part's tables: the org was deleted (`wipeOrg`). */
  wipe(): void {
    for (const table of TOOLS_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  /**
   * Zero data retention (ADR 0027): a member's private toolkits and private credentials go with them, and so do the
   * tool grants that named them.
   */
  async memberLeft(member: string): Promise<void> {
    this.#core.transaction(() => {
      this.#store.deleteMember(member);
      this.#grants.forget({ kind: "member", id: member });
    });
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
        kind: "toolkit",
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

    for (const toolkit of this.#store.toolkits()) {
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

    const refused = this.#nameRefusal(input.name, owner, undefined);

    if (refused !== undefined) return refused;

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

    const now = Date.now();

    const connected = this.#core.transaction(() => {
      this.#store.insertToolkit({
        id,
        kind: "mcp",
        name: input.name,
        source: input.source,
        owner,
        accepts: input.accepts,
        revision: 1,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        updatedBy: by,
      });

      if (input.credential !== undefined)
        this.#store.putCredential(id, owner, secretOf(input.credential), by, now);

      return grant === undefined ? undefined : this.#grantOnConnect(grant, by, now);
    });

    if (input.credential !== undefined) await this.#buildFor(id, viewer.member, policy);

    return withGrant(this.#viewOf(id, viewer), connected);
  }

  /**
   * Renames a toolkit, or changes which credentials an org toolkit accepts. A credential it no longer accepts is kept,
   * shown inactive and not used, until it accepts that kind again or its holder removes it.
   */
  updateToolkit(
    viewer: Viewer,
    id: string,
    revision: number,
    change: {
      readonly name?: string | undefined;
      readonly accepts?: CredentialsAccepted | undefined;
    },
    by: string,
  ): ToolsResult<ToolkitView> {
    const toolkit = this.#managed(id, viewer);

    if (!toolkit.ok) return toolkit;
    const current = toolkit.value;

    if (current.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${current.revision}, not ${revision}`);

    if (change.accepts !== undefined && current.owner !== undefined && change.accepts !== "private")
      return refuse("invalid", "a private toolkit takes its owner's credential only");

    const name = change.name ?? current.name;

    if (name !== current.name) {
      const refused = this.#nameRefusal(name, current.owner, current.id);

      if (refused !== undefined) return refused;
    }

    this.#store.updateToolkit(
      id,
      { name, accepts: change.accepts ?? current.accepts },
      by,
      Date.now(),
    );

    return this.#viewOf(id, viewer);
  }

  /** Removes a toolkit with all it holds; an org admin may remove a member's private toolkit too. */
  removeToolkit(viewer: Scope, id: string, revision: number): ToolsResult<{ readonly id: string }> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none") return NOT_FOUND;

    if (access === "read")
      return refuse("forbidden", "only an org admin can remove an org toolkit");

    if (toolkit.revision !== revision)
      return refuse("conflict", `the toolkit is at revision ${toolkit.revision}, not ${revision}`);

    this.#core.transaction(() => {
      this.#store.deleteToolkit(id);
      this.#core.spend.forget("toolkit", id);
    });

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
    const now = Date.now();

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
      if (target.value.owner === undefined) this.#core.spend.forget("toolkit", id);

      return true;
    });

    if (!removed) return refuse("not_found", "no such credential is connected");

    return this.#viewOf(id, viewer);
  }

  /** The toolkit and the owner of the credential `viewer` reaches in `slot`, or why not. */
  #credentialTarget(
    viewer: Viewer,
    id: string,
    slot: CredentialSlot,
  ): ToolsResult<{ readonly toolkit: Toolkit; readonly owner: string | undefined }> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

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

    const invalid = secretRefusal(secret);

    return invalid === undefined ? undefined : refuse("invalid", invalid);
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
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;

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
   * its owner's. An org toolkit with private credentials only waits for a member to refresh it.
   */
  async refreshToolLists(policy: OutboundPolicy): Promise<RefreshSummary> {
    const toolkits = this.#store.toolkits();

    const due = toolkits.filter((toolkit) => this.#secretFor(toolkit, toolkit.owner) !== undefined);

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
  #secretFor(toolkit: Toolkit, member: string | undefined): ToolkitSecret | undefined {
    if (toolkit.owner === undefined && accepts(toolkit, "shared")) {
      const shared = this.#store.secret(toolkit.id, undefined);

      if (shared !== undefined) return shared;
    }

    if (member === undefined || !accepts(toolkit, "private") || !this.#privateAllowed(toolkit))
      return undefined;

    if (toolkit.owner !== undefined && toolkit.owner !== member) return undefined;

    return this.#store.secret(toolkit.id, member);
  }

  /** Builds the tool list of the toolkit `id` from its MCP server and stores it, or records why it failed. */
  async #buildFor(
    id: string,
    member: string | undefined,
    policy: OutboundPolicy,
    timeout: Duration.Input = LISTING_TIMEOUT,
  ): Promise<ToolsResult<true>> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const secret = this.#secretFor(toolkit, member);

    if (secret === undefined)
      return refuse("no_credential", "the toolkit has no credential to list its tools with");

    const listed = await Effect.runPromise(
      listUpstreamTools(toolkit.source, secret, timeout).pipe(
        Effect.provide(OutboundHttpClientLive),
        Effect.provideService(CurrentOutboundPolicy, policy),
        Effect.result,
      ),
    );

    // The toolkit may have gone while its server answered.
    if (this.#store.toolkit(id) === undefined) return NOT_FOUND;

    if (Result.isFailure(listed)) {
      this.#store.setListStatus(id, { error: listed.failure.message });

      return refuse("tool_list_failed", listed.failure.message);
    }

    this.#core.transaction(() => {
      this.#store.replaceTools(id, listed.success);
      this.#store.setListStatus(id, { builtAt: Date.now() });
    });

    return ok(true);
  }

  /**
   * The tools of a toolkit, with their flags: an org toolkit's among the org's toolkits, a private toolkit's among the
   * org's and its owner's (none while the org does not serve private toolkits).
   */
  listTools(viewer: Scope, id: string): ToolsResult<ToolsList> {
    const toolkit = this.#store.toolkit(id);

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
   * tool grant.
   */
  clientTools(viewer: Viewer): ReadonlyArray<ClientTool> {
    return this.#reachable(viewer).map(({ tool }) => ({
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
   * is asked to connect theirs. The upstream session the call opens is kept for the next call on that credential, at
   * most seven days; a call that fails in a kept session drops it, so the next call opens a new one. A failure is
   * logged with the toolkit and the reason only.
   */
  async callTool(viewer: Viewer, call: ToolCall, policy: OutboundPolicy): Promise<ToolCallOutcome> {
    const reached = this.#reachable(viewer).find(
      ({ tool }) =>
        tool.name === call.name &&
        (call.toolkits === undefined || call.toolkits.includes(tool.toolkit.name)),
    );

    if (reached === undefined) return { outcome: "unknown" };
    const { tool, asMember, granted } = reached;
    const toolkit = tool.toolkit;

    const own =
      asMember &&
      viewer.member !== undefined &&
      this.#store.credential(toolkit.id, viewer.member) !== undefined;

    // The member's own credential, or else the shared one a grant gives them.
    const owner = own ? viewer.member : undefined;
    const secret = own || granted ? this.#store.secret(toolkit.id, owner) : undefined;

    if (secret === undefined)
      return { outcome: "connect", toolkit: { id: toolkit.id, name: toolkit.name } };

    const connectedAt = this.#store.credential(toolkit.id, owner)?.connectedAt;
    // Sessions are the calling member's, also on the shared credential: an upstream's session state never carries over.
    const caller = viewer.member ?? "";
    const known = this.#store.session(toolkit.id, owner, caller, Date.now());

    const called = await Effect.runPromise(
      callUpstreamTool(toolkit.source, secret, known, {
        name: tool.upstreamName,
        arguments: call.arguments,
        inputSchema: tool.tool?.inputSchema,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("upstream tool call failed").pipe(
            Effect.annotateLogs({
              toolkit: toolkit.id,
              reason: error.reason,
              ...(error.status === undefined ? {} : { status: error.status }),
            }),
          ),
        ),
        Effect.provide(OutboundHttpClientLive),
        Effect.provideService(CurrentOutboundPolicy, policy),
        Effect.result,
      ),
    );

    // The sessions kept are the credential's that opened them; one that changed (or went) meanwhile dropped them.
    const sameCredential = this.#store.credential(toolkit.id, owner)?.connectedAt === connectedAt;

    if (Result.isFailure(called)) {
      // The session the call failed in may be lost; the next call opens a new one, unless another call already did.
      if (known !== undefined && sameCredential) {
        const kept = this.#store.session(toolkit.id, owner, caller, Date.now());

        if (kept?.protocolVersion === known.protocolVersion && kept.sessionId === known.sessionId)
          this.#store.deleteSession(toolkit.id, owner, caller);
      }

      return { outcome: "failed", message: called.failure.message };
    }

    const { result, session } = called.success;

    if (session !== known && sameCredential) {
      this.#store.putSession(toolkit.id, owner, caller, session, Date.now());
      await this.#core.wakeUpChanged(this.#store.pruneSessions(Date.now()));
    }

    return { outcome: "result", result };
  }

  /**
   * The served tools `viewer` reaches ({@link clientTools}), sorted by full name, and how. A private toolkit counts
   * only while the org lets members add them: otherwise it is kept, but not served, and does not shadow an org toolkit
   * of its name.
   */
  #reachable(viewer: Viewer): ReadonlyArray<ReachableTool> {
    const member = viewer.member;

    const shared = new Set(
      this.#store
        .credentials()
        .filter((credential) => credential.owner === undefined)
        .map((credential) => credential.toolkitId),
    );

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
      .filter((reachable) => reachable.asMember || reachable.granted)
      .toSorted((a, b) => (a.tool.name < b.tool.name ? -1 : 1));
  }

  // --- tool grants (ADR 0038) -------------------------------------------------------------------------------------

  /**
   * Every tool grant of the org (org admins; the route's policy checks), each with the named tools its toolkit's tool
   * list no longer has (`missing`).
   */
  listGrants(): ToolGrants {
    const listed = new Set(
      this.#store.tools().map((tool) => stableId(tool.toolkitId, tool.upstreamName)),
    );

    return {
      grants: this.#grants.entries().map((entry): ToolGrant => {
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

    const written = this.#grants.write({ ...change, value }, by, Date.now());

    return written.ok ? ok({ id: written.id, revision: written.revision }) : written;
  }

  /** What a grant names that the org does not have, if anything. */
  #grantRefusal(grant: ToolGrantValue): string | undefined {
    const missing = this.#subjectRefusal(grant.subject);

    if (missing !== undefined) return missing;
    const toolkit = this.#store.toolkit(grant.toolkit);

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

    const known = this.#store.tools(id).some((listed) => listed.upstreamName === tool);

    if (!known && current === undefined)
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

    const value = {
      hidden: input.hidden ?? false,
      name,
      description: input.description ?? undefined,
      toolClass: input.class ?? undefined,
    };

    const empty =
      !value.hidden &&
      value.name === undefined &&
      value.description === undefined &&
      value.toolClass === undefined;

    // Past every revision the row reached, a tombstone's included.
    const next = (stored?.revision ?? 0) + 1;

    this.#store.putOverride(id, tool, empty ? undefined : value, next, by, Date.now());

    const resolved = this.#resolve(toolkit.owner).tools.find(
      (entry) => entry.toolkit.id === id && entry.upstreamName === tool,
    );

    // Only a cleared override of a missing tool leaves nothing to show.
    return resolved === undefined
      ? ok({ id: stableId(id, tool), removed: true })
      : ok(toolView(resolved));
  }

  // --- export -----------------------------------------------------------------------------------------------------

  /**
   * The toolkits `viewer` reaches, with what their credentials are (never their secrets) and their overrides, and, for
   * an org admin, each org toolkit's tool grants.
   */
  exportToolkits(viewer: Scope): ReadonlyArray<ToolkitExport> {
    const admin = isFullAccess(viewer) || viewer.admin;
    const grants = admin ? this.#grants.entries() : [];

    return this.#store.toolkits().flatMap((toolkit) => {
      const access = reach(toolkit, viewer);

      if (access === "none" || access === "limited") return [];

      const member = this.#memberOf(viewer);

      // The shared credential and the viewer's own private one.
      const credentials = this.#store
        .credentials(toolkit.id)
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
          private: toolkit.owner !== undefined,
          accepts: toolkit.accepts,
          credentials,
          overrides: this.#store.overrides(toolkit.id).map((override) => ({
            tool: override.upstreamName,
            hidden: override.hidden,
            ...(override.name === undefined ? {} : { name: override.name }),
            ...(override.description === undefined ? {} : { description: override.description }),
            ...(override.toolClass === undefined ? {} : { class: override.toolClass }),
          })),
          ...(admin && toolkit.owner === undefined
            ? {
                grants: grants
                  .filter((grant) => grant.toolkit === toolkit.id)
                  .map((grant) => this.#exportedGrant(grant)),
              }
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

  #exportedSubject(subject: GrantSubject): ExportedToolGrant["subject"] {
    if (subject.kind === "member")
      return { kind: "member", email: this.#core.member(subject.id)?.email ?? "" };

    if (subject.kind === "team")
      return { kind: "team", name: this.#core.team(subject.id)?.name ?? "" };

    return { kind: "everyone" };
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  #memberOf(viewer: Scope): string | undefined {
    return isFullAccess(viewer) ? undefined : viewer.member;
  }

  /** The toolkit `id` if `viewer` manages it (an org admin an org toolkit, a member their private one). */
  #managed(id: string, viewer: Scope): ToolsResult<Toolkit> {
    const toolkit = this.#store.toolkit(id);

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

    const clash = this.#store
      .toolkits()
      .some(
        (other) =>
          other.id !== except &&
          other.name === name &&
          (other.owner === undefined || (owner !== undefined && other.owner === owner)),
      );

    return clash ? refuse("name_taken", `a toolkit is already named ${name}`) : undefined;
  }

  #resolve(member: string | undefined): Resolution {
    return resolveTools({
      toolkits: this.#store.toolkits(),
      tools: this.#store.tools(),
      overrides: this.#store.overrides(),
      member,
    });
  }

  #viewOf(id: string, viewer: Scope): ToolsResult<ToolkitView> {
    const toolkit = this.#store.toolkit(id);

    return toolkit === undefined
      ? NOT_FOUND
      : ok(this.#view(toolkit, viewer, this.#resolve(this.#servedMember(this.#memberOf(viewer)))));
  }

  #listStatus(toolkit: Toolkit): ToolsList["tool_list"] {
    return {
      ...(toolkit.listBuiltAt === undefined ? {} : { built_at: iso(toolkit.listBuiltAt) }),
      ...(toolkit.listError === undefined ? {} : { error: toolkit.listError }),
      tools: this.#store.tools(toolkit.id).length,
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
      connected_at: iso(credential.connectedAt),
      connected_by: credential.connectedBy,
      active: accepts(toolkit, slot) && (slot === "shared" || this.#privateAllowed(toolkit)),
    };
  }

  #view(toolkit: Toolkit, viewer: Scope, resolution: Resolution): ToolkitView {
    const member = this.#memberOf(viewer);
    const credentials = this.#store.credentials(toolkit.id);
    const shared = credentials.find((credential) => credential.owner === undefined);

    const mine =
      member === undefined
        ? undefined
        : credentials.find((credential) => credential.owner === member);

    const admin = isFullAccess(viewer) || viewer.admin;

    const privateCount = credentials.filter((credential) => credential.owner !== undefined).length;

    return {
      id: toolkit.id,
      kind: toolkit.kind,
      name: toolkit.name,
      // A member who only reads an org toolkit does not see what its source's query carries.
      source: reach(toolkit, viewer) === "read" ? maskedSource(toolkit.source) : toolkit.source,
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
      ...(resolution.renameSuggested.has(toolkit.id) ? { rename_suggested: true } : {}),
      ...(resolution.shadowed.has(toolkit.id) ? { shadowed: true } : {}),
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
    flags: {
      shortened: tool.shortened,
      renamed: tool.renamed,
      hidden: tool.hidden,
      clash: tool.clash,
      missing: tool.missing,
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
            updated_at: iso(override.updatedAt),
            updated_by: override.updatedBy,
          },
        }),
  };
};
