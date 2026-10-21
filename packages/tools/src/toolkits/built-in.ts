/**
 * Built-in toolkits (ADR 0039, ADR 0040, ADR 0041, #212, #213, #222, #229, #270): the toolkits Commissary provides itself,
 * the browser toolkit, the sandbox toolkit and the agents toolkit. An org connects nothing for one: it exists exactly
 * when the deployment has what it runs on (the browser toolkit: a `browser` binding, so a browser provider; the sandbox
 * toolkit: Dynamic Workers, which every deployment has, ADR 0043; the agents toolkit: the Agents area, which the state
 * Worker composes into the ControlPlane), and is otherwise missing everywhere (the MCP endpoint, toolkit lists, grants).
 *
 * A built-in toolkit is not stored: the Tools part lists it beside the org's stored toolkits, as an org toolkit with a
 * fixed id (its name, which no stored toolkit's `tk_…` id can be) and a fixed tool list from code. Its shared credential
 * is Commissary's own (the binding), of kind `none`, so grants decide who reaches it, and there is no default grant
 * (ADR 0038). What an org says about it is stored by that id like any toolkit's: its tool grants and the overrides on
 * its tools, which stay while the deployment has no binding and apply again when it has one, and its approval rules
 * (and the sandbox toolkit's network ceiling). It cannot be renamed, edited otherwise, refreshed from a source, given a
 * credential or removed, and its name is taken: no other toolkit, org or private, may have it while it exists.
 *
 * Its kind is the kind of service behind it (`browser`, `sandbox`, `agents`) and its source the provider (`browser-run`,
 * `cloudflare`; `commissary` for the agents toolkit, which runs Commissary's own hosted agents): a later toolkit from another provider (ADR 0041) is a stored toolkit of the same kind, whose source
 * names that provider and whose credential is the org's key for it, calling the same tools through that provider's
 * adapter.
 */
import type { UsageRun } from "@commissary/auth";
import { type ComputerMarker, hasComputer, type OutboundPolicy } from "@commissary/core";
import { Effect, Result, Schema } from "effect";
import { AGENTS_TOOLKIT } from "@commissary/contract/api-keys";
import { AGENTS_TOOL_LIST, type AgentDirectory } from "../agents/toolkit.ts";
import { browserRun, type BrowserRunBinding } from "../browser/browser-run.ts";
import { browserRunCrawls, crawlCredentialsOf } from "../browser/browser-run-crawls.ts";
import {
  callCrawlTool,
  type CrawlLog,
  crawlToolList,
  isCrawlTool,
} from "../browser/crawl-tools.ts";
import {
  BROWSER_RUN_CRAWL_MAX_PAGES,
  type BrowserProvider,
  DEFAULT_CRAWL_MAX_PAGES,
  type StorageState,
} from "../browser/provider.ts";
import { type Timed, untimed } from "../browser/browser-time.ts";
import { textResult, toolError } from "../browser/session.ts";
import {
  type BrowserSessionNamespace,
  type BrowserSessions,
  browserSessions,
  type SessionAnswer,
  type SessionCaller,
  type SessionClosed,
  type SessionMetering,
  type SessionProfile,
} from "../browser/session-object.ts";
import {
  type BrowserTimeUse,
  isSessionTool,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS,
  sessionRequestOf,
  type SessionToolName,
} from "../browser/session-tools.ts";
import { BROWSER_TOOLS, callBrowserTool, isQuickAction } from "../browser/toolkit.ts";
import { cloudflareSandbox } from "../sandbox/cloudflare/provider.ts";
import type { SandboxSession, SandboxSessionEnv } from "../sandbox/cloudflare/session.ts";
import { NO_ALLOWANCE } from "../sandbox/network.ts";
import type { ComputerMeter, SandboxProvider } from "../sandbox/provider.ts";
import {
  callSandboxTool,
  NO_PRINCIPAL,
  type SandboxAnswer,
  SANDBOX_TOOLS,
  type SandboxSessionLog,
} from "../sandbox/toolkit.ts";
import type { StoredTool } from "./store.ts";
import type { BuiltInToolkit } from "./toolkit.ts";

/**
 * What the Tools part, and the sandbox's `SandboxSession` objects, read from the state Worker's env: the optional
 * `browser` binding (ADR 0043) with the optional account and API token of its crawls (#270), the namespace of the
 * browser sessions' Durable Objects (#213), and Dynamic Workers with the sandbox sessions' namespace, which every
 * deployment has (ADR 0043), and the marker that the deployment attached the sandbox's computer to them (#223,
 * `COMPUTER`). The browser sessions' objects read their own view (`BrowserSessionEnv`, `session-object.ts`).
 */
export interface ToolsPartEnv extends SandboxSessionEnv, ComputerMarker {
  /** Browser Run (#212); absent on a deployment with `COMMISSARY_BROWSER=off`, which has no browser toolkit. */
  readonly BROWSER?: BrowserRunBinding | undefined;
  /**
   * The Cloudflare account Browser Run's crawls run under (#270), with {@link BROWSER_RUN_API_TOKEN}: `/crawl` is on
   * Browser Run's REST API only. Both are optional; without either, the browser toolkit has no crawl tools.
   */
  readonly BROWSER_RUN_ACCOUNT_ID?: string | undefined;
  /** An API token of that account with "Browser Run - Edit" (a secret), for its crawls. */
  readonly BROWSER_RUN_API_TOKEN?: string | undefined;
  /** The most pages one crawl may take (#270), a whole number; unset, {@link DEFAULT_CRAWL_MAX_PAGES}. */
  readonly COMMISSARY_CRAWL_MAX_PAGES?: string | undefined;
  /** The deployment's own hosts, which the part's own requests (its alarm's token refreshes, #202) refuse. */
  readonly OWN_HOSTS?: string | undefined;
  /** One object per browser session (`BrowserSession`); without it the browser toolkit has no session tools. */
  readonly BROWSER_SESSIONS?: BrowserSessionNamespace | undefined;
  /** One object per sandbox session (`SandboxSession`, #222). */
  readonly SANDBOX_SESSION: DurableObjectNamespace<SandboxSession>;
  /**
   * `cloud` on Commissary Cloud (ADR 0026), the one deployment with managed OAuth apps (#207): their client secrets are
   * the bindings the toolkit catalog additions name (`TOOLKIT_OAUTH_*`), read by name (`catalog/managed-apps.ts`), each
   * optional.
   */
  readonly COMMISSARY_MODE?: string | undefined;
}

/** The services the built-in toolkits run on; one that is missing takes its toolkit (or its tools) with it. */
export interface BuiltInProviders {
  readonly browser?: BrowserProvider | undefined;
  /** The browser sessions' objects, for the session tools of a provider that has sessions. */
  readonly browserSessions?: BrowserSessions | undefined;
  /** The most pages one crawl of the browser provider's may take; unset, {@link DEFAULT_CRAWL_MAX_PAGES}. */
  readonly crawlMaxPages?: number | undefined;
  readonly sandbox?: SandboxProvider | undefined;
  /**
   * The agents a caller may run, from the Agents part of the same ControlPlane: given where the state Worker composes
   * the Agents area (`apps/state/src/control-plane.ts`), and with it the agents toolkit (#229).
   */
  readonly agents?: AgentDirectory | undefined;
}

/**
 * `COMMISSARY_CRAWL_MAX_PAGES` as a number of pages: a whole number from 1 to Browser Run's own ceiling, else (unset,
 * or a value the deploy would have refused) {@link DEFAULT_CRAWL_MAX_PAGES}.
 */
const crawlMaxPagesOf = (setting: string | undefined): number => {
  const text = setting?.trim() ?? "";
  const pages = text === "" ? Number.NaN : Number(text);

  return Number.isSafeInteger(pages) && pages >= 1 && pages <= BROWSER_RUN_CRAWL_MAX_PAGES
    ? pages
    : DEFAULT_CRAWL_MAX_PAGES;
};

/**
 * The providers a deployment's bindings give: Browser Run's binding, as the browser provider, with its crawls when the
 * deployment has an API token for them, and with the browser sessions' namespace, whose objects reach the provider's
 * browsers themselves; and Cloudflare's sandbox on the sandbox sessions' namespace, always, with the computer when
 * the deployment has its container (#223, the `COMPUTER` marker).
 */
export const builtInProviders = (env: ToolsPartEnv): BuiltInProviders => {
  const crawls = crawlCredentialsOf(env);

  return {
    ...(env.BROWSER === undefined
      ? {}
      : {
          browser: browserRun(
            env.BROWSER,
            crawls === undefined ? undefined : browserRunCrawls(crawls),
          ),
          browserSessions:
            env.BROWSER_SESSIONS === undefined ? undefined : browserSessions(env.BROWSER_SESSIONS),
          crawlMaxPages: crawlMaxPagesOf(env.COMMISSARY_CRAWL_MAX_PAGES),
        }),
    sandbox: cloudflareSandbox(env.SANDBOX_SESSION, { computer: hasComputer(env) }),
  };
};

/** The id (and name) of the browser toolkit. */
export const BROWSER_TOOLKIT = "browser";

/** The id (and name) of the sandbox toolkit. */
export const SANDBOX_TOOLKIT = "sandbox";

/** Who a built-in toolkit is by, and who renamed a stored toolkit that had its name. */
export const COMMISSARY = "commissary";

/**
 * The browser profiles (#215) as the caller of a browser session tool reaches them, which the Tools part answers for
 * them: what the caller may use and save into.
 */
export interface CallerProfiles {
  /**
   * The profile of `name` the caller may open a session from, with its state; undefined when there is none they may
   * use, whether it does not exist or it is not theirs to use (a session cannot tell which). Throws when its stored
   * state does not open.
   */
  readonly usable: (
    name: string,
  ) => { readonly id: string; readonly state: StorageState | undefined } | undefined;
  /** The names of the profiles the caller may use, and whether each is private. */
  readonly list: () => ReadonlyArray<{ readonly name: string; readonly private: boolean }>;
  /** Saves `state` into the profile `id` for the caller: why it was not saved, when the caller may not, else nothing. */
  readonly save: (id: string, state: StorageState) => Promise<string | undefined>;
}

/**
 * Who calls a built-in tool, and with what: the org, the call's member and principal (a browser or sandbox session's
 * owner; absent from a call that names none, which sessions refuse), the browser profiles the caller reaches, the Tools
 * part's logs of the org's sandbox and browser sessions and of the caller's browser crawls, the outbound guard's policy,
 * the Tools part's time, and the toolkit with what the org set on it (its network ceiling and whether it allows the
 * computer, its price per browser hour).
 */
export interface BuiltInCall {
  readonly org: string;
  readonly member: string | undefined;
  readonly principal: string | undefined;
  /** The agent run making the call (#228), which a browser or sandbox session's usage record names. */
  readonly run?: UsageRun | undefined;
  readonly profiles: CallerProfiles;
  readonly sessions: SandboxSessionLog;
  /** The call opens an agent run's own sandbox session (#230, `SandboxCall.runSession`). */
  readonly runSession?: boolean | undefined;
  /** A sandbox session's computer time's metering (#224); absent for other toolkits. */
  readonly computer?: ComputerMeter | undefined;
  /** The org's open browser sessions (#214), which the org's deletion deletes. */
  readonly browserSessions: BrowserSessionLog;
  /**
   * How the caller answered the elicitation that asked them to act in a browser session (#216), when the call is made
   * again with their answer: `accept` (they went to act) waits on the handoff, anything else declines it. Absent: no
   * elicitation was answered.
   */
  readonly handoffAnswer?: "accept" | "decline" | "cancel" | undefined;
  /**
   * The Tools part let a `browser_ask_human` through its approvals as one that continues a handoff (#216): it may wait
   * on one or answer how one ended, but start none.
   */
  readonly continuesHandoff?: true | undefined;
  /** The crawls of the call's member and principal (#270). */
  readonly crawls: CrawlLog;
  readonly policy: OutboundPolicy;
  readonly now: number;
  readonly toolkit: BuiltInToolkit;
}

/**
 * The Tools part's log of the org's open browser sessions (#214): a session opened (from a browser profile, #215), a
 * call closed it, or a handoff in it waits for its person until a time, or no longer does (#216: `undefined`).
 */
export interface BrowserSessionLog {
  readonly opened: (id: string, profile: string | undefined) => void;
  readonly closed: (id: string) => void;
  readonly handoff: (id: string, until: number | undefined) => void;
}

/**
 * What a built-in tool's call answers: its tool result, and the browser time it used with its cost at the toolkit's
 * price per browser hour (#214), which the call charges. A Quick Action's is its own, which its usage record carries; a
 * browser session's (`inSession`) is the session's since the call before, which the session's own record carries.
 */
export interface BuiltInAnswer extends Timed {
  readonly inSession?: true | undefined;
  /**
   * A sandbox session's computer time since its call before (#224), which the call charges and the session's own
   * record carries; and, when the session refused the call for want of room, that its command needed the computer, and
   * whether the call stopped the computer, which ran, first.
   */
  readonly computerTime?: SandboxAnswer["computerTime"];
  readonly computer?: SandboxAnswer["computer"];
  readonly computerStopped?: SandboxAnswer["computerStopped"];
  /**
   * The call started a handoff in a browser session (#216), which waits for its person until `until` (epoch ms), with
   * what they are asked (`reason`): the MCP endpoint reaches them (an elicitation, or a link to the session's page in the
   * panel).
   */
  readonly handoff?:
    | { readonly sessionId: string; readonly reason: string; readonly until: number }
    | undefined;
}

/**
 * What a call of the browser toolkit's tool `tool` does with browser time (#214): a Quick Action uses it, a session tool
 * says (`SESSION_TOOLS`), and a crawl's is not metered yet (#270: Browser Run reports it per crawl job, a follow-up).
 */
export const browserTimeOf = (tool: string): BrowserTimeUse =>
  isSessionTool(tool) ? SESSION_TOOLS[tool].browserTime : isQuickAction(tool) ? "uses" : "none";

/** A built-in toolkit whose calls the Tools part makes: the browser and sandbox toolkits. */
export interface CalledBuiltIn {
  readonly calledBy: "part";
  readonly toolkit: BuiltInToolkit;
  readonly tools: ReadonlyArray<StoredTool>;
  /** Calls the tool of upstream name `tool`; never fails (a failure is a tool result with `isError`). */
  readonly call: (
    tool: string,
    args: Schema.JsonObject | undefined,
    call: BuiltInCall,
  ) => Effect.Effect<BuiltInAnswer>;
}

/**
 * A built-in toolkit whose calls the MCP endpoint's Worker makes (the agents toolkit, #229, `agents/toolkit.ts`): the
 * part decides who reaches its tools and charges them, and answers the call `delegated`.
 */
export interface DelegatedBuiltIn {
  readonly calledBy: "worker";
  readonly toolkit: BuiltInToolkit;
  readonly tools: ReadonlyArray<StoredTool>;
}

/** A built-in toolkit with its tools, and who makes its calls. */
export type BuiltIn = CalledBuiltIn | DelegatedBuiltIn;

/** A tool of a built-in toolkit as it lists it. */
interface ListedTool {
  /** Its upstream name (the full name is `<toolkit>_<name>`). */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  /** `readOnlyHint` gives a tool the class `read` (ADR 0038). */
  readonly annotations: Schema.JsonObject;
}

/** The session tools as the toolkit lists them: write tools unless they only read (ADR 0038). */
const SESSION_BROWSER_TOOLS: ReadonlyArray<ListedTool> = SESSION_TOOL_NAMES.map((name) => ({
  name,
  description: SESSION_TOOLS[name].description,
  // SAFETY: a JSON Schema document's schema is a JSON object.
  inputSchema: Schema.toJsonSchemaDocument(SESSION_TOOLS[name].arguments)
    .schema as Schema.JsonObject,
  annotations: { readOnlyHint: SESSION_TOOLS[name].toolClass === "read" },
}));

/** What `browser_open` answers for a profile the caller may not use, whether or not it exists. */
const unknownProfile = (name: string): Schema.JsonObject =>
  toolError(
    `Unknown browser profile ${name}. browser_profile_list lists the profiles you may open a session from.`,
  );

/** `browser_profile_list`'s answer: the profiles the caller may use, by name. */
const profileList = (profiles: CallerProfiles): Schema.JsonObject => {
  const usable = profiles.list();

  return textResult(
    usable.length === 0
      ? "You may use no browser profile."
      : usable
          .map((profile) => `- ${profile.name} (${profile.private ? "private" : "shared"})`)
          .join("\n"),
  );
};

/**
 * The profile `name` the caller may use, through `profiles`; `unreadable` when its stored state does not open (sealed
 * for another row or org, or with another key), which is logged without the state.
 */
const readProfile = async (
  profiles: CallerProfiles,
  name: string,
): Promise<ReturnType<CallerProfiles["usable"]> | "unreadable"> => {
  try {
    return profiles.usable(name);
  } catch (error) {
    await Effect.runPromise(
      Effect.logWarning("browser profile not read").pipe(
        Effect.annotateLogs({ reason: error instanceof Error ? error.name : "unknown" }),
      ),
    );

    return "unreadable";
  }
};

/** What closing the session `id` answers once it closed (`closed`): whether its state was saved, when asked. */
const closedAnswer = async (
  profiles: CallerProfiles,
  id: string,
  save: boolean,
  closed: Extract<SessionClosed, { readonly kind: "closed" }>,
): Promise<Schema.JsonObject> => {
  if (!save) return textResult(`Browser session ${id} is closed.`);

  const notSaved = (why: string) =>
    toolError(`Browser session ${id} is closed, but its state was not saved: ${why}.`);

  if (closed.profile === undefined || closed.saved === undefined)
    return notSaved("it was not opened from a browser profile");

  if ("failed" in closed.saved) return notSaved(closed.saved.failed);
  const refused = await profiles.save(closed.profile, closed.saved.state);

  if (refused !== undefined) return notSaved(refused);

  return textResult(
    closed.saved.reconnected
      ? `Browser session ${id} is closed, and its cookies are saved into its browser profile; the local storage of sites visited before the browser was reconnected was not.`
      : `Browser session ${id} is closed, and its state is saved into its browser profile.`,
  );
};

/**
 * Closes a session for `owner` and, when `save` was asked, saves its state into the profile it was opened from through
 * `profiles`: a session opened from none, a state that could not be read and a save the caller may not make answer a
 * tool error, and the session is closed all the same. A save over a browser reached again since it opened says that the
 * local storage of the sites visited before was not saved (`SavedState`).
 */
const closeSession = async (
  sessions: BrowserSessions,
  owner: SessionCaller,
  profiles: CallerProfiles,
  id: string,
  save: boolean,
  metering: SessionMetering,
  log: BrowserSessionLog,
): Promise<SessionAnswer> => {
  const closed = await sessions.close(owner, id, save, metering);

  if (closed.kind === "answer") return untimed(closed.result);
  log.closed(id);
  const result = await closedAnswer(profiles, id, save, closed);

  return closed.browserTime === undefined
    ? untimed(result)
    : { result, browserTime: closed.browserTime };
};

/**
 * Calls the session tool `name` in `sessions` for `caller`, on the browsers of the provider `source`: its Durable
 * Object's answer, with the session's browser time since the call before costed at the toolkit's price per browser hour
 * (#214), never a failure; it logs the sessions it opens and closes (`BrowserSessionLog`). A session belongs to its caller's principal, so a call without one opens or reaches none. A
 * session opens from a browser profile only when the caller may use it (#215), and saves into one only when the caller
 * may save into it (`CallerProfiles`, the Tools part's answers).
 */
const callSessionTool = (
  sessions: BrowserSessions,
  source: string,
  name: SessionToolName,
  args: Schema.JsonObject | undefined,
  caller: BuiltInCall,
): Effect.Effect<BuiltInAnswer> => {
  const { principal, profiles, toolkit } = caller;

  if (principal === undefined)
    return Effect.succeed({
      result: toolError(
        "Browser sessions need a caller with an identity: an API key or a signed-in person.",
      ),
    });

  const request = sessionRequestOf(name, args ?? {});

  if (Result.isFailure(request))
    return Effect.succeed({ result: toolError(`Invalid arguments: ${request.failure}`) });
  const decoded = request.success;
  const owner = { org: caller.org, member: caller.member, principal };
  const metering = { hourPriceMicros: toolkit.hourPriceMicros ?? 0 };
  const log = caller.browserSessions;

  const opened = async (url: string | undefined, profile?: SessionProfile) => {
    const answer = await sessions.open(
      owner,
      source,
      url,
      {
        ...metering,
        toolkitId: toolkit.id,
        ...(caller.run === undefined ? {} : { run: caller.run }),
      },
      profile,
    );

    if (answer.session === "opened") log.opened(answer.id, profile?.id);

    return answer;
  };

  /**
   * `browser_ask_human` (#216): a call that starts a handoff answers at once that it did, and the endpoint reaches the
   * person; a call made while one waits (the same call again, or the client's retry once the person went to act) waits
   * on it a while (`HANDOFF_WAIT_MS`) and answers how it ended, or that it still waits; a call after it ended answers
   * how; a declined elicitation declines it. The log keeps until when a handoff waits while one does, so the panel's
   * list flags it.
   */
  const askHuman = async (
    sessionId: string,
    reason: string,
  ): Promise<SessionAnswer & { readonly handoff?: BuiltInAnswer["handoff"] }> => {
    if (caller.handoffAnswer !== undefined && caller.handoffAnswer !== "accept") {
      const declined = await sessions.declineHandoff(owner, sessionId, metering);

      log.handoff(sessionId, undefined);

      return declined;
    }

    // A call let through the approvals as one that continues a handoff starts none (the session decides, in turn).
    const { handoff, ...asked } = await sessions.askHuman(owner, sessionId, reason, metering, {
      mayStart: caller.continuesHandoff !== true,
    });

    if (asked.session === "closed") log.closed(sessionId);

    if (handoff === undefined) {
      log.handoff(sessionId, undefined);

      return asked;
    }

    log.handoff(sessionId, handoff.until);

    if (handoff.state === "started")
      return { ...asked, handoff: { sessionId, reason, until: handoff.until } };
    const { handoff: still, ...waited } = await sessions.awaitHandoff(owner, sessionId, metering);

    log.handoff(sessionId, still?.until);

    return waited;
  };

  const answer = async (): Promise<
    SessionAnswer & { readonly handoff?: BuiltInAnswer["handoff"] }
  > => {
    switch (decoded.tool) {
      case "profile_list":
        return untimed(profileList(profiles));
      case "open": {
        const { profile } = decoded.args;

        if (profile === undefined) return await opened(decoded.args.url);
        const usable = await readProfile(profiles, profile);

        if (usable === "unreadable")
          return untimed(toolError(`The browser profile ${profile} could not be read.`));

        return usable === undefined
          ? untimed(unknownProfile(profile))
          : await opened(decoded.args.url, usable);
      }

      case "ask_human":
        return await askHuman(decoded.args.sessionId, decoded.args.reason);
      case "close":
        return await closeSession(
          sessions,
          owner,
          profiles,
          decoded.args.sessionId,
          decoded.args.save === true,
          metering,
          log,
        );
      default: {
        const operated = await sessions.operate(owner, decoded, metering);

        if (operated.session === "closed") log.closed(decoded.args.sessionId);
        // The call dropped how a handoff ended: none waits in the session any more.
        else if (operated.handoffCleared === true) log.handoff(decoded.args.sessionId, undefined);

        return operated;
      }
    }
  };

  return Effect.tryPromise(answer).pipe(
    Effect.map(({ result, browserTime, handoff }): BuiltInAnswer => ({
      result,
      ...(browserTime === undefined ? {} : { browserTime, inSession: true as const }),
      ...(handoff === undefined ? {} : { handoff }),
    })),
    Effect.catch(() =>
      Effect.logWarning("browser session could not be reached").pipe(
        Effect.annotateLogs({ tool: name }),
        Effect.as({ result: toolError("The browser session could not be reached; try again.") }),
      ),
    ),
  );
};

const builtInToolkit = (
  id: string,
  kind: BuiltInToolkit["kind"],
  source: string,
  tools: ReadonlyArray<ListedTool>,
): Pick<BuiltIn, "toolkit" | "tools"> => ({
  toolkit: {
    id,
    kind,
    name: id,
    source,
    owner: undefined,
    accepts: "shared",
    revision: 1,
    createdAt: 0,
    createdBy: COMMISSARY,
    updatedAt: 0,
    updatedBy: COMMISSARY,
    listBuiltAt: undefined,
    listError: undefined,
    priceMicros: undefined,
    // The org's rules and ceiling, if it set any, are the part's to add (`ToolkitStore.builtInSettings`).
    approvalRules: undefined,
    baseUrl: undefined,
    ceiling: undefined,
    hourPriceMicros: undefined,
    builtIn: true,
  },
  tools: tools.map((tool, position) => ({
    toolkitId: id,
    upstreamName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    operation: undefined,
    graphql: undefined,
    // Before any tool of a stored toolkit: a built-in tool keeps its full name against them.
    firstSeen: 0,
    position,
  })),
});

/** A crawl belongs to its caller's principal, as a session does: a call without one starts or reaches none. */
const NO_CRAWL_PRINCIPAL = toolError(
  "Browser crawls need a caller with an identity: an API key or a signed-in person.",
);

/**
 * The browser toolkit on `provider`: its Quick Actions, its crawl tools when the provider has crawls (#270), and its
 * session tools when it has sessions and the deployment their objects.
 */
const browserToolkit = (
  provider: BrowserProvider,
  sessions: BrowserSessions | undefined,
  maxPages: number,
): CalledBuiltIn => {
  const withSessions = sessions !== undefined && provider.sessions ? sessions : undefined;
  const { crawls } = provider;

  const tools: ReadonlyArray<ListedTool> = [
    ...BROWSER_TOOLS,
    ...(crawls === undefined ? [] : crawlToolList(maxPages)),
    ...(withSessions === undefined ? [] : SESSION_BROWSER_TOOLS),
  ];

  return {
    calledBy: "part",
    ...builtInToolkit(BROWSER_TOOLKIT, "browser", provider.id, tools),
    call: (tool, args, caller) => {
      if (withSessions !== undefined && isSessionTool(tool))
        return callSessionTool(withSessions, provider.id, tool, args, caller);

      if (crawls !== undefined && isCrawlTool(tool))
        return (
          caller.principal === undefined
            ? Effect.succeed(NO_CRAWL_PRINCIPAL)
            : callCrawlTool(crawls, tool, args, {
                policy: caller.policy,
                log: caller.crawls,
                maxPages,
              })
        ).pipe(Effect.map((result): BuiltInAnswer => ({ result })));

      return callBrowserTool(provider, tool, args, caller.toolkit.hourPriceMicros ?? 0);
    },
  };
};

const sandboxToolkit = (provider: SandboxProvider): CalledBuiltIn => ({
  calledBy: "part",
  ...builtInToolkit(SANDBOX_TOOLKIT, "sandbox", provider.id, SANDBOX_TOOLS),
  call: (
    tool,
    args,
    { org, principal, member, run, sessions, runSession, policy, now, toolkit, computer },
  ) =>
    principal === undefined
      ? Effect.succeed({ result: NO_PRINCIPAL })
      : callSandboxTool(
          provider,
          {
            owner: { org, principal },
            sessions,
            runSession,
            policy,
            now,
            ceiling: toolkit.ceiling ?? NO_ALLOWANCE,
            meter: computer,
            opener: { toolkitId: toolkit.id, member, run },
          },
          tool,
          args,
        ),
});

/** The agents toolkit (#229): its tools from code, its calls made by the MCP endpoint's Worker. */
const agentsToolkit = (): DelegatedBuiltIn => ({
  calledBy: "worker",
  ...builtInToolkit(AGENTS_TOOLKIT, "agents", COMMISSARY, AGENTS_TOOL_LIST),
});

/** The built-in toolkits `providers` give. */
export const builtInToolkits = (providers: BuiltInProviders): ReadonlyArray<BuiltIn> => [
  ...(providers.browser === undefined
    ? []
    : [
        browserToolkit(
          providers.browser,
          providers.browserSessions,
          providers.crawlMaxPages ?? DEFAULT_CRAWL_MAX_PAGES,
        ),
      ]),
  ...(providers.sandbox === undefined ? [] : [sandboxToolkit(providers.sandbox)]),
  ...(providers.agents === undefined ? [] : [agentsToolkit()]),
];
