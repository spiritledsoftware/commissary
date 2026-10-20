// `@commissary/agents/testing`: what the Worker's tests need of Agents (docs/DEVELOPMENT.md, "Tests"). Test files only.
// The Worker's tests go through its router, creating agents with this body.
import type { CreateAgent } from "@commissary/contract/agents";

/** A definition of an agent `name` on `model`, with no tools; `extra` replaces or adds fields. */
export const agentBody = (
  name: string,
  model: string,
  extra: Partial<CreateAgent> = {},
): CreateAgent => ({
  name,
  description: `The ${name} agent`,
  instructions: "Answer briefly.",
  model,
  tool_scope: [],
  ...extra,
});
