import { RpcTarget } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { type Access, accessTo, isFullAccess, type Scope, type Viewer } from "@commissary/auth";
import type {
  CredentialSlot,
  CredentialsAccepted,
  LimitedToolkitView,
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
import { listUpstreamTools } from "./mcp/client.ts";
import { isToolkitName, isToolName, fullToolName, MAX_FULL_NAME } from "./toolkits/names.ts";
import { isServed, type Resolution, resolveTools, stableId } from "./toolkits/resolve.ts";
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
  | "private_credentials_off"
  | "no_credential"
  | "tool_list_failed";

export type ToolsResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ToolsErrorCode; readonly message: string };

const refuse = (error: ToolsErrorCode, message: string) => ({ ok: false, error, message }) as const;

const ok = <A>(value: A): ToolsResult<A> => ({ ok: true, value });

const NOT_FOUND = refuse("not_found", "toolkit not found");

const iso = (at: number): string => new Date(at).toISOString();

/** A new toolkit as the routes hand it over. */
export interface AddToolkitInput {
  /** The source, already checked by the outbound guard. */
  readonly source: string;
  readonly name: string;
  readonly private: boolean;
  readonly accepts: CredentialsAccepted;
  readonly credential?: ToolkitSecret | undefined;
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
}

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
 * with the org's data key, `core.secrets`), their tool lists and the overrides on their tools. An `RpcTarget` the
 * composed `ControlPlane` constructs once per object (`new ToolsPart(ctx, core)`); callers reach it as
 * `stub.tools().x(…)`. A tool list is built here, from the MCP server, so a credential's secret never leaves the object;
 * the caller hands over its outbound guard's policy (ADR 0044), and every request goes through the guard.
 *
 * Who may do what follows `@commissary/auth`'s ownership rules: an org toolkit is read by every member and managed by
 * org admins; a private toolkit is its owner's, and an org admin only sees that it exists (and may remove it). Methods
 * exchange plain data only.
 */
export class ToolsPart extends RpcTarget implements ControlPlanePart {
  readonly #ctx: DurableObjectState;
  readonly #core: OrgCore;
  readonly #store: ToolkitStore;

  constructor(ctx: DurableObjectState, core: OrgCore) {
    super();
    this.#ctx = ctx;
    this.#core = core;
    this.#store = new ToolkitStore(ctx.storage.sql, core.secrets, (body) => core.transaction(body));
  }

  // --- the org-wide base's calls (`ControlPlanePart`, `@commissary/state`) ------------------------------------

  /** Tools sealed its secrets from the start: nothing was stored in plain text. */
  sealPlaintext(): number {
    return 0;
  }

  /** Tools sets no alarm: its tool lists are rebuilt by the cron task. */
  async alarm(): Promise<number | null> {
    return null;
  }

  /** Deletes the part's tables: the org was deleted (`wipeOrg`). */
  wipe(): void {
    for (const table of TOOLS_TABLES) this.#ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  /** Zero data retention (ADR 0027): a member's private toolkits and private credentials go with them. */
  async memberLeft(member: string): Promise<void> {
    this.#store.deleteMember(member);
  }

  teamDeleted(): void {}

  teamMembersChanged(): void {}

  apiKeysDeleted(): void {}

  /** Read on every use: nothing to forget. */
  privateCredentialsChanged(): void {}

  // --- toolkits ---------------------------------------------------------------------------------------------------

  /** The toolkits `viewer` reaches; an org admin also gets the other members' private toolkits, as existence only. */
  listToolkits(viewer: Scope): ToolkitsList {
    const resolution = this.#resolve(this.#memberOf(viewer));
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
  ): Promise<ToolsResult<ToolkitView>> {
    const owner = input.private ? viewer.member : undefined;

    if (input.private && owner === undefined)
      return refuse("forbidden", "only a member can add a private toolkit");

    if (!input.private && !viewer.admin)
      return refuse("forbidden", "only an org admin can add an org toolkit");

    if (input.private && input.accepts !== "private")
      return refuse("invalid", "a private toolkit takes its owner's credential only");

    const refused = this.#nameRefusal(input.name, owner, undefined);

    if (refused !== undefined) return refused;

    if (input.credential !== undefined) {
      const slot: CredentialSlot = input.private ? "private" : "shared";

      const credentialRefusal = this.#credentialRefusal(
        { owner, accepts: input.accepts },
        slot,
        input.credential,
      );

      if (credentialRefusal !== undefined) return credentialRefusal;
    }

    const now = Date.now();
    const id = freshToolkitId();

    this.#core.transaction(() => {
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
        this.#store.putCredential(id, owner, input.credential, by, now);
    });

    if (input.credential !== undefined) await this.#buildFor(id, viewer.member, policy);

    return this.#viewOf(id, viewer);
  }

  /** Renames a toolkit, or changes which credentials an org toolkit accepts (dropping the ones it no longer does). */
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

    const accepted = change.accepts ?? current.accepts;

    this.#core.transaction(() => {
      this.#store.updateToolkit(id, { name, accepts: accepted }, by, Date.now());

      if (current.owner === undefined) {
        if (accepted === "private") this.#store.deleteCredential(id, undefined);

        if (accepted === "shared")
          for (const credential of this.#store.credentials(id))
            if (credential.owner !== undefined) this.#store.deleteCredential(id, credential.owner);
      }
    });

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

    this.#store.deleteToolkit(id);

    return ok({ id });
  }

  // --- credentials ------------------------------------------------------------------------------------------------

  /**
   * Connects the toolkit's shared credential (org admins) or the caller's private one, replacing what was there, and
   * builds the tool list if it was never built.
   */
  async connectCredential(
    viewer: Viewer,
    id: string,
    slot: CredentialSlot,
    secret: ToolkitSecret,
    by: string,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<ToolkitView>> {
    const target = this.#credentialTarget(viewer, id, slot);

    if (!target.ok) return target;
    const { toolkit, owner } = target.value;

    const refused = this.#credentialRefusal(toolkit, slot, secret);

    if (refused !== undefined) return refused;

    this.#store.putCredential(id, owner, secret, by, Date.now());

    if (toolkit.listBuiltAt === undefined) await this.#buildFor(id, viewer.member, policy);

    return this.#viewOf(id, viewer);
  }

  disconnectCredential(viewer: Viewer, id: string, slot: CredentialSlot): ToolsResult<ToolkitView> {
    const target = this.#credentialTarget(viewer, id, slot);

    if (!target.ok) return target;

    if (!this.#store.deleteCredential(id, target.value.owner))
      return refuse("not_found", "no such credential is connected");

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

    if (slot === "private" && !this.#core.privateCredentials())
      return refuse("private_credentials_off", "the org has turned private credentials off");

    const invalid = secretRefusal(secret);

    return invalid === undefined ? undefined : refuse("invalid", invalid);
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

    if (access === "read" && this.#store.credential(id, undefined) !== undefined)
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
    let built = 0;
    let failed = 0;
    let skipped = 0;

    for (const toolkit of this.#store.toolkits()) {
      if (this.#secretFor(toolkit, toolkit.owner) === undefined) {
        skipped += 1;
        continue;
      }

      const outcome = await this.#buildFor(toolkit.id, toolkit.owner, policy);

      if (outcome.ok) built += 1;
      else failed += 1;
    }

    return { built, failed, skipped };
  }

  /**
   * The credential a build of `toolkit` asked for by `member` uses: the shared credential, or, if there is none, the
   * member's private one (a private toolkit's is its owner's). Private credentials count only while the org allows
   * them.
   */
  #secretFor(toolkit: Toolkit, member: string | undefined): ToolkitSecret | undefined {
    if (toolkit.owner === undefined && accepts(toolkit, "shared")) {
      const shared = this.#store.secret(toolkit.id, undefined);

      if (shared !== undefined) return shared;
    }

    if (member === undefined || !accepts(toolkit, "private") || !this.#core.privateCredentials())
      return undefined;

    if (toolkit.owner !== undefined && toolkit.owner !== member) return undefined;

    return this.#store.secret(toolkit.id, member);
  }

  /** Builds the tool list of the toolkit `id` from its MCP server and stores it, or records why it failed. */
  async #buildFor(
    id: string,
    member: string | undefined,
    policy: OutboundPolicy,
  ): Promise<ToolsResult<true>> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const secret = this.#secretFor(toolkit, member);

    if (secret === undefined)
      return refuse("no_credential", "the toolkit has no credential to list its tools with");

    const listed = await Effect.runPromise(
      listUpstreamTools(toolkit.source, secret).pipe(
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
   * org's and its owner's.
   */
  listTools(viewer: Scope, id: string): ToolsResult<ToolsList> {
    const toolkit = this.#store.toolkit(id);

    if (toolkit === undefined) return NOT_FOUND;
    const access = reach(toolkit, viewer);

    if (access === "none" || access === "limited") return NOT_FOUND;
    const resolution = this.#resolve(toolkit.owner);

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
  servedTools(member: string | undefined): ReadonlyArray<ToolView> {
    return this.#resolve(member).tools.filter(isServed).map(toolView);
  }

  // --- overrides --------------------------------------------------------------------------------------------------

  /**
   * Writes the whole override of one tool, named by its stable id (the toolkit and the upstream name), at `revision` (0
   * for a new one). One that sets nothing is deleted. A rename to a full name another tool of the same set holds is
   * refused.
   */
  setOverride(
    viewer: Viewer,
    id: string,
    revision: number,
    input: SetToolOverride,
    by: string,
  ): ToolsResult<ToolView> {
    const managed = this.#managed(id, viewer);

    if (!managed.ok) return managed;
    const toolkit = managed.value;
    const tool = input.tool;
    const current = this.#store.override(id, tool);

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

    this.#store.putOverride(id, tool, empty ? undefined : value, revision + 1, by, Date.now());

    const resolved = this.#resolve(toolkit.owner).tools.find(
      (entry) => entry.toolkit.id === id && entry.upstreamName === tool,
    );

    if (resolved === undefined)
      return refuse("not_found", "the toolkit's tool list has no such tool");

    return ok(toolView(resolved));
  }

  // --- export -----------------------------------------------------------------------------------------------------

  /** The toolkits `viewer` reaches, with what their credentials are (never their secrets) and their overrides. */
  exportToolkits(viewer: Scope): ReadonlyArray<ToolkitExport> {
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
        },
      ];
    });
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
      : ok(this.#view(toolkit, viewer, this.#resolve(this.#memberOf(viewer))));
  }

  #listStatus(toolkit: Toolkit): ToolsList["tool_list"] {
    return {
      ...(toolkit.listBuiltAt === undefined ? {} : { built_at: iso(toolkit.listBuiltAt) }),
      ...(toolkit.listError === undefined ? {} : { error: toolkit.listError }),
      tools: this.#store.tools(toolkit.id).length,
    };
  }

  #credentialView(credential: ToolkitCredential): ToolkitCredentialView {
    return {
      kind: credential.kind,
      ...(credential.param === undefined ? {} : { name: credential.param }),
      connected_at: iso(credential.connectedAt),
      connected_by: credential.connectedBy,
      active: credential.owner === undefined || this.#core.privateCredentials(),
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
      source: toolkit.source,
      private: toolkit.owner !== undefined,
      accepts: toolkit.accepts,
      revision: toolkit.revision,
      created_at: iso(toolkit.createdAt),
      updated_at: iso(toolkit.updatedAt),
      updated_by: toolkit.updatedBy,
      credentials: {
        ...(shared === undefined ? {} : { shared: this.#credentialView(shared) }),
        ...(mine === undefined ? {} : { mine: this.#credentialView(mine) }),
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
    };
  }
}

/** A resolved tool as the management API shows it. */
const toolView = (tool: ReturnType<typeof resolveTools>["tools"][number]): ToolView => {
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
