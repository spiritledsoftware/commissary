# Identify Agents by installed composition

## Identity

The caller gives each Agent a stable Agent ID. Agent Installation computes the Agent Revision from static composition and stable contracts. Durable work records both values as an Agent Reference.

Dynamic Hook subscriptions do not change the Agent Revision. They are process-local host policy. [ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) defines their Execution capture rule.

## Installation

`CommissaryInstance.agent(definition)` installs and binds an Agent when the host first requests it. The Instance caches the Agent and returns its typed Agent Client.

The Instance rejects a different definition that reuses an installed Agent ID. The `commissary` constructor does not require an eager Agent list.

## Compatibility

Normal continuation renders the current Agent because stored Messages use the stable Commissary protocol. Core checks Agent Compatibility only for deferred work that must keep earlier semantics.

Compatibility uses the specific deferred contract. It does not require equal Agent Revisions. An incompatible contract produces a Stale Agent Interruption. Core does not start a new Run or silently use incompatible behavior.

For a Tool Suspension, the stored Agent ID and Tool name select the current Tool. The current continuation Codec must decode the stored state. A declared decode failure produces a Stale Agent Interruption.

A Tool can use a versioned encoded value and Codec migrations. Unrelated Agent changes do not prevent Tool resumption.
