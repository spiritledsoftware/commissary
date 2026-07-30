# Identify Agents by installed composition

## Identity

The caller gives each Agent a stable Agent ID. Agent Installation computes the Agent Revision from static composition and stable contracts. Durable work records both values as an Agent Reference.

Dynamic Hook subscriptions do not change the Agent Revision. They are process-local host policy. [ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) defines their Execution capture rule.

## Installation

`CommissaryInstance.agent(definition)` installs and binds an Agent when the host first requests it. The Instance caches the Agent and returns its typed Agent Client.

The Instance rejects a different definition that reuses an installed Agent ID. The `commissary` constructor does not require an eager Agent list.

The typed Agent Client binds every accepted Run ID to the Agent definition that created it. A Run ID decoded from storage is unbound. Any Agent Client can accept an unbound ID, but the Thread Store checks the complete stored Agent Reference in the same read, control, resume, or claim operation.

## Authority and compatibility

Only the exact Agent Reference that created a Run can read, control, resume, or execute it. A different Agent ID or Revision is a wrong Agent. Reads return `undefined`; Steering, Redirect, and abort return `not-active`; resume returns its Tool resume conflict; and execute rejects with `ExecutionUnavailableError` and `wrong-agent`.

Compatibility checks still apply to process-bound dynamic Tool contracts within that Agent Reference. Core resolves each dynamic Tool from its recorded Provider ID and Tool name. A missing Tool, missing Suspension, invalid stored effective input, or continuation decode failure produces a Stale Agent Interruption. Core does not start a new Run or silently reinterpret incompatible state.

For a Tool Suspension, the current continuation Codec can support versioned encoded values and migrations. Unrelated process-local changes do not change the Agent Revision. Dynamic Hook subscriptions remain outside durable identity.
