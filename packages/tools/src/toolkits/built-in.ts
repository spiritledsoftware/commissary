/**
 * Built-in toolkits (ADR 0039, ADR 0041, #212, #213, #222): the toolkits Commissary provides itself, the browser toolkit
 * and the sandbox toolkit. An org connects nothing for one: it exists exactly when the deployment has what it runs on (the
 * browser toolkit: a `browser` binding, so a browser provider; the sandbox toolkit: Dynamic Workers, which every
 * deployment has, ADR 0043), and is otherwise missing everywhere (the MCP endpoint, toolkit lists, grants).
 *
 * A built-in toolkit is not stored: the Tools part lists it beside the org's stored toolkits, as an org toolkit with a
 * fixed id (its name, which no stored toolkit's `tk_…` id can be) and a fixed tool list from code. Its shared credential
 * is Commissary's own (the binding), of kind `none`, so grants decide who reaches it, and there is no default grant
 * (ADR 0038). What an org says about it is stored by that id like any toolkit's: its tool grants and the overrides on
 * its tools, which stay while the deployment has no binding and apply again when it has one, and its approval rules
 * (and the sandbox toolkit's network ceiling). It cannot be renamed, edited otherwise, refreshed from a source, given a
 * credential or removed, and its name is taken: no other toolkit, org or private, may have it while it exists.
 *
 * Its kind is the kind of service behind it (`browser`, `sandbox`) and its source the provider (`browser-run`,
 * `cloudflare`): a later toolkit from another provider (ADR 0041) is a stored toolkit of the same kind, whose source
 * names that provider and whose credential is the org's key for it, calling the same tools through that provider's
 * adapter.
 */
import type { OutboundPolicy } from "@commissary/core";
import { Effect, Result, Schema } from "effect";
import { browserRun, type BrowserRunBinding } from "../browser/browser-run.ts";
import type { BrowserProvider } from "../browser/provider.ts";
import { toolError } from "../browser/session.ts";
import {
  type BrowserSessionNamespace,
  type BrowserSessions,
  browserSessions,
} from "../browser/session-object.ts";
import {
  isSessionTool,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS,
  sessionRequestOf,
  type SessionToolName,
} from "../browser/session-tools.ts";
import { BROWSER_TOOLS, callBrowserTool } from "../browser/toolkit.ts";
import { cloudflareSandbox } from "../sandbox/cloudflare/provider.ts";
import type { SandboxSession, SandboxSessionEnv } from "../sandbox/cloudflare/session.ts";
import { NO_NETWORK } from "../sandbox/network.ts";
import type { SandboxProvider } from "../sandbox/provider.ts";
import {
  callSandboxTool,
  NO_PRINCIPAL,
  SANDBOX_TOOLS,
  type SandboxSessionLog,
} from "../sandbox/toolkit.ts";
import type { StoredTool } from "./store.ts";
import type { BuiltInToolkit } from "./toolkit.ts";

/**
 * What the Tools part, and the sandbox's `SandboxSession` objects, read from the state Worker's env: the optional
 * `browser` binding (ADR 0043), the namespace of the browser sessions' Durable Objects (#213), and Dynamic Workers with
 * the sandbox sessions' namespace, which every deployment has (ADR 0043). The browser sessions' objects read their own
 * view (`BrowserSessionEnv`, `session-object.ts`).
 */
export interface ToolsPartEnv extends SandboxSessionEnv {
  /** Browser Run (#212); absent on a deployment with `COMMISSARY_BROWSER=off`, which has no browser toolkit. */
  readonly BROWSER?: BrowserRunBinding | undefined;
  /** The deployment's own hosts, which the part's own requests (its alarm's token refreshes, #202) refuse. */
  readonly OWN_HOSTS?: string | undefined;
  /** One object per browser session (`BrowserSession`); without it the browser toolkit has no session tools. */
  readonly BROWSER_SESSIONS?: BrowserSessionNamespace | undefined;
  /** One object per sandbox session (`SandboxSession`, #222). */
  readonly SANDBOX_SESSION: DurableObjectNamespace<SandboxSession>;
}

/** The services the built-in toolkits run on; one that is missing takes its toolkit (or its tools) with it. */
export interface BuiltInProviders {
  readonly browser?: BrowserProvider | undefined;
  /** The browser sessions' objects, for the session tools of a provider that has sessions. */
  readonly browserSessions?: BrowserSessions | undefined;
  readonly sandbox?: SandboxProvider | undefined;
}

/**
 * The providers a deployment's bindings give: Browser Run's binding, as the browser provider, with the browser
 * sessions' namespace, whose objects reach the provider's browsers themselves; and Cloudflare's sandbox on the sandbox
 * sessions' namespace, always.
 */
export const builtInProviders = (env: ToolsPartEnv): BuiltInProviders => ({
  ...(env.BROWSER === undefined
    ? {}
    : {
        browser: browserRun(env.BROWSER),
        browserSessions:
          env.BROWSER_SESSIONS === undefined ? undefined : browserSessions(env.BROWSER_SESSIONS),
      }),
  sandbox: cloudflareSandbox(env.SANDBOX_SESSION),
});

/** The id (and name) of the browser toolkit. */
export const BROWSER_TOOLKIT = "browser";

/** The id (and name) of the sandbox toolkit. */
export const SANDBOX_TOOLKIT = "sandbox";

/** Who a built-in toolkit is by, and who renamed a stored toolkit that had its name. */
export const COMMISSARY = "commissary";

/**
 * Who calls a built-in tool, and with what: the org, the call's member and principal (a browser or sandbox session's
 * owner; absent from a call that names none, which sessions refuse), the Tools part's log of the org's sandbox
 * sessions, the outbound guard's policy, the Tools part's time, and the toolkit with what the org set on it (its
 * network ceiling).
 */
export interface BuiltInCall {
  readonly org: string;
  readonly member: string | undefined;
  readonly principal: string | undefined;
  readonly sessions: SandboxSessionLog;
  readonly policy: OutboundPolicy;
  readonly now: number;
  readonly toolkit: BuiltInToolkit;
}

/** A built-in toolkit with its tools, and how a tool of it is called. */
export interface BuiltIn {
  readonly toolkit: BuiltInToolkit;
  readonly tools: ReadonlyArray<StoredTool>;
  /** Calls the tool of upstream name `tool`; never fails (a failure is a tool result with `isError`). */
  readonly call: (
    tool: string,
    args: Schema.JsonObject | undefined,
    call: BuiltInCall,
  ) => Effect.Effect<Schema.JsonObject>;
}

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
  caller: BuiltInCall,
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

const builtInToolkit = (
  id: string,
  kind: BuiltInToolkit["kind"],
  source: string,
  tools: ReadonlyArray<ListedTool>,
): Omit<BuiltIn, "call"> => ({
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
    network: undefined,
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

const browserToolkit = (
  provider: BrowserProvider,
  sessions: BrowserSessions | undefined,
): BuiltIn => {
  const withSessions = sessions !== undefined && provider.sessions ? sessions : undefined;

  const tools: ReadonlyArray<ListedTool> =
    withSessions === undefined ? BROWSER_TOOLS : [...BROWSER_TOOLS, ...SESSION_BROWSER_TOOLS];

  return {
    ...builtInToolkit(BROWSER_TOOLKIT, "browser", provider.id, tools),
    call: (tool, args, caller) =>
      withSessions !== undefined && isSessionTool(tool)
        ? callSessionTool(withSessions, provider.id, tool, args, caller)
        : callBrowserTool(provider, tool, args),
  };
};

const sandboxToolkit = (provider: SandboxProvider): BuiltIn => ({
  ...builtInToolkit(SANDBOX_TOOLKIT, "sandbox", provider.id, SANDBOX_TOOLS),
  call: (tool, args, { org, principal, sessions, policy, now, toolkit }) =>
    principal === undefined
      ? Effect.succeed(NO_PRINCIPAL)
      : callSandboxTool(
          provider,
          {
            owner: { org, principal },
            sessions,
            policy,
            now,
            ceiling: toolkit.network ?? NO_NETWORK,
          },
          tool,
          args,
        ),
});

/** The built-in toolkits `providers` give. */
export const builtInToolkits = (providers: BuiltInProviders): ReadonlyArray<BuiltIn> => [
  ...(providers.browser === undefined
    ? []
    : [browserToolkit(providers.browser, providers.browserSessions)]),
  ...(providers.sandbox === undefined ? [] : [sandboxToolkit(providers.sandbox)]),
];
