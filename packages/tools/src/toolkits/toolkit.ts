/**
 * A toolkit as the Tools part sees it: one of the org's, stored in its ControlPlane (`store.ts`), or one Commissary
 * provides itself, built from code whenever the deployment has what it runs on (`built-in.ts`, #212). `builtIn` tells
 * them apart: what only a stored toolkit has (a source to build its list from, a credential to connect, a row to edit
 * or remove) is reached through the {@link StoredToolkit} the part's resolver answers.
 */
import type { CredentialsAccepted } from "@commissary/contract/tools";

/** What every toolkit has, stored or built in. */
interface ToolkitFields {
  readonly id: string;
  readonly name: string;
  /** The MCP server's URL; a built-in toolkit's provider. */
  readonly source: string;
  /** The member of a private toolkit; undefined for an org toolkit. */
  readonly owner: string | undefined;
  readonly accepts: CredentialsAccepted;
  readonly revision: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly listBuiltAt: number | undefined;
  readonly listError: string | undefined;
  /** What a call of its tools costs, in micro-USD, unless a tool's override says otherwise (#199); undefined: free. */
  readonly priceMicros: number | undefined;
}

/** A toolkit of the org's `toolkits` table: an MCP server's (ADR 0036). */
export interface StoredToolkit extends ToolkitFields {
  readonly kind: "mcp";
  readonly builtIn: false;
}

/**
 * A toolkit Commissary provides itself (`built-in.ts`), never stored: an org toolkit of the kind of service behind it,
 * taking its shared credential only (Commissary's own binding), with no list to build and no price of its own.
 */
export interface BuiltInToolkit extends ToolkitFields {
  readonly kind: "browser";
  readonly owner: undefined;
  readonly accepts: "shared";
  readonly listBuiltAt: undefined;
  readonly listError: undefined;
  readonly priceMicros: undefined;
  readonly builtIn: true;
}

export type Toolkit = StoredToolkit | BuiltInToolkit;
