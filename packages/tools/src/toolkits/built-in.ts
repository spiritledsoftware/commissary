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
import type { Effect, Schema } from "effect";
import { browserRun, type BrowserRunBinding } from "../browser/browser-run.ts";
import type { BrowserProvider } from "../browser/provider.ts";
import { BROWSER_TOOLS, callBrowserTool } from "../browser/toolkit.ts";
import type { StoredTool } from "./store.ts";
import type { BuiltInToolkit } from "./toolkit.ts";

/** What the Tools part reads from the state Worker's env: the optional `browser` binding (ADR 0043). */
export interface ToolsPartEnv {
  /** Browser Run (#212); absent on a deployment with `COMMISSARY_BROWSER=off`, which has no browser toolkit. */
  readonly BROWSER?: BrowserRunBinding | undefined;
}

/** The services the built-in toolkits run on; one that is missing takes its toolkit with it. */
export interface BuiltInProviders {
  readonly browser?: BrowserProvider | undefined;
}

/** The providers a deployment's bindings give: Browser Run's binding, as the browser provider. */
export const builtInProviders = (env: ToolsPartEnv): BuiltInProviders =>
  env.BROWSER === undefined ? {} : { browser: browserRun(env.BROWSER) };

/** The id (and name) of the browser toolkit. */
export const BROWSER_TOOLKIT = "browser";

/** Who a built-in toolkit is by, and who renamed a stored toolkit that had its name. */
export const COMMISSARY = "commissary";

/** A built-in toolkit with its tools, and how a tool of it is called. */
export interface BuiltIn {
  readonly toolkit: BuiltInToolkit;
  readonly tools: ReadonlyArray<StoredTool>;
  /** Calls the tool of upstream name `tool`; never fails (a failure is a tool result with `isError`). */
  readonly call: (
    tool: string,
    args: Schema.JsonObject | undefined,
  ) => Effect.Effect<Schema.JsonObject>;
}

const browserToolkit = (provider: BrowserProvider): BuiltIn => ({
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
  tools: BROWSER_TOOLS.map((tool, position) => ({
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
  call: (tool, args) => callBrowserTool(provider, tool, args),
});

/** The built-in toolkits `providers` give. */
export const builtInToolkits = (providers: BuiltInProviders): ReadonlyArray<BuiltIn> =>
  providers.browser === undefined ? [] : [browserToolkit(providers.browser)];
