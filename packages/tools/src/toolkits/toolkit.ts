/**
 * A toolkit as the Tools part sees it: one of the org's, stored in its ControlPlane (`store.ts`), or one Commissary
 * provides itself, built from code whenever the deployment has what it runs on (`built-in.ts`, #212). `builtIn` tells
 * them apart: what only a stored toolkit has (a source to build its list from, a credential to connect, a row to edit
 * or remove) is reached through the {@link StoredToolkit} the part's resolver answers.
 */
import type { CredentialSettings, CredentialsAccepted } from "@commissary/contract/tools";
import type { SandboxAllowance } from "../sandbox/network.ts";
import type { StoredApprovalRules } from "../approvals/rules.ts";

/** What every toolkit has, stored or built in. */
interface ToolkitFields {
  readonly id: string;
  readonly name: string;
  /**
   * The MCP server's URL, the OpenAPI or Discovery document's (empty for an uploaded one) or the GraphQL endpoint's; a
   * built-in toolkit's provider.
   */
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
  /**
   * Which calls of its tools wait for approval, and whose (#201); undefined: none. A built-in toolkit's are stored
   * apart from it (`ToolkitStore.builtInSettings`), as it has no row of its own.
   */
  readonly approvalRules: StoredApprovalRules | undefined;
  /** An OpenAPI toolkit's base URL, which an org admin may set in place of the document's servers. */
  readonly baseUrl: string | undefined;
}

/**
 * A toolkit of the org's `toolkits` table: an MCP server's, an OpenAPI document's (ADR 0036, #203), a GraphQL
 * endpoint's (#204) or a Google Discovery document's (#205).
 */
export interface StoredToolkit extends ToolkitFields {
  readonly kind: "mcp" | "openapi" | "graphql" | "discovery";
  readonly builtIn: false;
  /**
   * It is built from an uploaded document the part keeps (an OpenAPI or Discovery document, a GraphQL schema's SDL),
   * not from its source: set when it is added with one, or when a GraphQL toolkit's first schema is uploaded.
   */
  readonly uploaded: boolean;
  /** The settings of its credential types (#206); undefined: none. */
  readonly credentialSettings: CredentialSettings | undefined;
}

/**
 * A toolkit Commissary provides itself (`built-in.ts`), never stored: an org toolkit of the kind of service behind it,
 * taking its shared credential only (Commissary's own binding), with no list to build and no price of its own.
 */
export interface BuiltInToolkit extends ToolkitFields {
  readonly kind: "browser" | "sandbox";
  readonly owner: undefined;
  readonly accepts: "shared";
  readonly listBuiltAt: undefined;
  readonly listError: undefined;
  readonly priceMicros: undefined;
  readonly baseUrl: undefined;
  readonly builtIn: true;
  /**
   * The sandbox toolkit's (#222, #223): the most a session may ask for, its network and the computer, as the org set it
   * (stored apart, as its approval rules are); undefined: no network and no computer, the default. The browser toolkit
   * has none.
   */
  readonly ceiling: SandboxAllowance | undefined;
  /**
   * The browser toolkit's (#214): what an hour of its browser time costs in micro-USD, prorated, as the org set it
   * (stored apart, as its approval rules are); undefined: browser time is free. The sandbox toolkit has none.
   */
  readonly browserHourPriceMicros: number | undefined;
}

export type Toolkit = StoredToolkit | BuiltInToolkit;
