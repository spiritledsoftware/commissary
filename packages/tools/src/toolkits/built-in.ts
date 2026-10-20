/**
 * Built-in toolkits (ADR 0039, ADR 0041, #212): the toolkits Commissary provides itself, starting with the browser
 * toolkit. An org connects nothing for one: it exists exactly when the deployment has what it runs on (the browser
 * toolkit: a `browser` binding, so a browser provider), and is otherwise missing everywhere (the MCP endpoint, toolkit
 * lists, grants).
 *
 * A built-in toolkit is not stored: the Tools part lists it beside the org's stored toolkits, as an org toolkit with a
 * fixed id (its name, which no stored toolkit's `tk_…` id can be) and a fixed tool list from code. Its shared credential
 * is Commissary's own (the binding), of kind `none`, so grants decide who reaches it, and there is no default grant
 * (ADR 0038). What an org says about it is stored by that id like any toolkit's: its tool grants and the overrides on
 * its tools, which stay while the deployment has no binding and apply again when it has one. It cannot be renamed,
 * edited, refreshed from a source, given a credential or removed, and its name is taken: no other toolkit, org or
 * private, may have it while it exists.
 *
 * Its kind is the kind of service behind it (`browser`) and its source the browser provider (`browser-run`): a later
 * browser toolkit from another provider (ADR 0041) is a stored toolkit of the same kind, whose source names that
 * provider and whose credential is the org's key for it, calling the same tools through that provider's adapter.
 */
import { Effect, Result, Schema } from "effect";
import { browserRun, type BrowserRunBinding } from "../browser/browser-run.ts";
import type { BrowserProvider } from "../browser/provider.ts";
import { toolError } from "../browser/session.ts";
import {
  type BrowserSessionNamespace,
  type BrowserSessions,
  browserSessions,
  type SessionCaller,
} from "../browser/session-object.ts";
import {
  isSessionTool,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS,
  sessionRequestOf,
  type SessionToolName,
} from "../browser/session-tools.ts";
import { BROWSER_TOOLS, callBrowserTool } from "../browser/toolkit.ts";
import type { StoredTool } from "./store.ts";
import type { BuiltInToolkit } from "./toolkit.ts";

/**
 * What the Tools part reads from the state Worker's env: the optional `browser` binding (ADR 0043), and the namespace
 * of the browser sessions' Durable Objects (#213), which the state Worker defines. The sessions' objects read their own
 * view (`BrowserSessionEnv`, `session-object.ts`).
 */
export interface ToolsPartEnv {
  /** Browser Run (#212); absent on a deployment with `COMMISSARY_BROWSER=off`, which has no browser toolkit. */
  readonly BROWSER?: BrowserRunBinding | undefined;
  /** The deployment's own hosts, which the part's own requests (its alarm's token refreshes, #202) refuse. */
  readonly OWN_HOSTS?: string | undefined;
  /** One object per browser session (`BrowserSession`); without it the browser toolkit has no session tools. */
  readonly BROWSER_SESSIONS?: BrowserSessionNamespace | undefined;
}

/** The services the built-in toolkits run on; one that is missing takes its toolkit (or its tools) with it. */
export interface BuiltInProviders {
  readonly browser?: BrowserProvider | undefined;
  /** The browser sessions' objects, for the session tools of a provider that has sessions. */
  readonly browserSessions?: BrowserSessions | undefined;
}

/**
 * The providers a deployment's bindings give: Browser Run's binding, as the browser provider, and the sessions'
 * namespace, whose objects reach the provider's browsers themselves.
 */
export const builtInProviders = (env: ToolsPartEnv): BuiltInProviders =>
  env.BROWSER === undefined
    ? {}
    : {
        browser: browserRun(env.BROWSER),
        browserSessions:
          env.BROWSER_SESSIONS === undefined ? undefined : browserSessions(env.BROWSER_SESSIONS),
      };

/** The id (and name) of the browser toolkit. */
export const BROWSER_TOOLKIT = "browser";

/** Who a built-in toolkit is by, and who renamed a stored toolkit that had its name. */
export const COMMISSARY = "commissary";

/** A built-in toolkit with its tools, and how a tool of it is called. */
export interface BuiltIn {
  readonly toolkit: BuiltInToolkit;
  readonly tools: ReadonlyArray<StoredTool>;
  /**
   * Calls the tool of upstream name `tool` for `caller` (the org, and the member and principal of the call, when it has
   * one: a browser session's owner); never fails (a failure is a tool result with `isError`).
   */
  readonly call: (
    tool: string,
    args: Schema.JsonObject | undefined,
    caller: ToolCaller,
  ) => Effect.Effect<Schema.JsonObject>;
}

/** Who calls a built-in tool: a session's caller, whose call may have no principal. */
type ToolCaller = Omit<SessionCaller, "principal"> & { readonly principal: string | undefined };

/** A tool of the browser toolkit as it lists it: a Quick Action's or a session tool's. */
interface ListedTool {
  /** Its upstream name (the full name is `browser_<name>`). */
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

/**
 * Calls the session tool `name` in `sessions` for `caller`, on the browsers of the provider `source`: its Durable
 * Object's answer, never a failure. A session belongs to its caller's principal, so a call without one opens or reaches
 * none.
 */
const callSessionTool = (
  sessions: BrowserSessions,
  source: string,
  name: SessionToolName,
  args: Schema.JsonObject | undefined,
  caller: ToolCaller,
): Effect.Effect<Schema.JsonObject> => {
  const { principal } = caller;

  if (principal === undefined)
    return Effect.succeed(
      toolError(
        "Browser sessions need a caller with an identity: an API key or a signed-in person.",
      ),
    );

  const request = sessionRequestOf(name, args ?? {});

  if (Result.isFailure(request))
    return Effect.succeed(toolError(`Invalid arguments: ${request.failure}`));
  const decoded = request.success;
  const owner = { org: caller.org, member: caller.member, principal };

  return Effect.tryPromise(() =>
    decoded.tool === "open"
      ? sessions.open(owner, source, decoded.args.url)
      : sessions.operate(owner, decoded),
  ).pipe(
    Effect.catch(() =>
      Effect.logWarning("browser session could not be reached").pipe(
        Effect.annotateLogs({ tool: name }),
        Effect.as(toolError("The browser session could not be reached; try again.")),
      ),
    ),
  );
};

const browserToolkit = (
  provider: BrowserProvider,
  sessions: BrowserSessions | undefined,
): BuiltIn => {
  const withSessions = sessions !== undefined && provider.sessions ? sessions : undefined;

  const tools: ReadonlyArray<ListedTool> =
    withSessions === undefined ? BROWSER_TOOLS : [...BROWSER_TOOLS, ...SESSION_BROWSER_TOOLS];

  return {
    toolkit: {
      id: BROWSER_TOOLKIT,
      kind: "browser",
      name: BROWSER_TOOLKIT,
      source: provider.id,
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
      // The org's rules, if it set any, are the part's to add (`ToolkitStore.builtInSettings`).
      approvalRules: undefined,
      baseUrl: undefined,
      builtIn: true,
    },
    tools: tools.map((tool, position) => ({
      toolkitId: BROWSER_TOOLKIT,
      upstreamName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      operation: undefined,
      // Before any tool of a stored toolkit: a built-in tool keeps its full name against them.
      firstSeen: 0,
      position,
    })),
    call: (tool, args, caller) =>
      withSessions !== undefined && isSessionTool(tool)
        ? callSessionTool(withSessions, provider.id, tool, args, caller)
        : callBrowserTool(provider, tool, args),
  };
};

/** The built-in toolkits `providers` give. */
export const builtInToolkits = (providers: BuiltInProviders): ReadonlyArray<BuiltIn> =>
  providers.browser === undefined
    ? []
    : [browserToolkit(providers.browser, providers.browserSessions)];
