/**
 * Tool grants (ADR 0038, GLOSSARY "Grant"): which tools of which org toolkits' shared credentials a member may use.
 *
 * The same grant as for models (ADR 0023), kept by the Tools area: a subject (everyone, one member or one team, the
 * subjects of `@commissary/contract/grants`), one org toolkit, and its tools: all of them, its read tools (by tool
 * class) or named tools by stable id (`<toolkit id>:<upstream name>`). A member's reach is the union of the grants that
 * name them; there is no deny, and no default grant: a toolkit's shared credential reaches nobody until an org admin
 * grants it (connecting it names who may use it).
 */
import type { GrantSubject, ToolSelection } from "@commissary/contract/grants";

/** What a tool grant says: who, which org toolkit, which of its tools. */
export interface ToolGrantValue {
  readonly subject: GrantSubject;
  /** The org toolkit's id. */
  readonly toolkit: string;
  /** Named ids are trimmed, de-duplicated and at least one once stored. */
  readonly tools: ToolSelection;
}

/** A stored tool grant. */
export interface ToolGrantEntry extends ToolGrantValue {
  readonly id: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** A tool grant write: `value` `null` deletes it; no `id` creates one (`revision` 0). */
export interface ToolGrantChange {
  readonly id?: string | undefined;
  readonly revision: number;
  readonly value: ToolGrantValue | null;
}

/** The grant connecting a toolkit's shared credential creates for the subject it names: every tool. */
export const connectGrant = (subject: GrantSubject, toolkit: string): ToolGrantValue => ({
  subject,
  toolkit,
  tools: { kind: "all" },
});
