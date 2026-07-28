# Render installed Agents into Execution Plans

## Decision

Public authoring starts with `Agent.define({ id, fragments })`. Binding this value to a Commissary Instance performs Agent Installation.

Users do not construct Agent Trees, Execution Plans, or an installed-Agent wrapper. Named Context, Model, and Tool constructors return opaque Agent Fragments. [ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) defines the equivalent Hook behavior.

`Agent.combine(...fragments)` is the variadic and associative composition operation. `Agent.define` accepts its readonly result directly.

For each Model invocation, Render uses the current Transcript and Run identity. It derives one Agent Tree. Core resolves Model, Context, and Tools in that order. Core then validates and freezes one Execution Plan.

## Composition rules

Each named module owns the rules for its contributions. Core has no generic slot, feature, behavior, or third-party contribution type.

Agent Fragments have no generic inspection, removal, replacement, override, or precedence API. Duplicate non-Hook identities cause an Agent Installation error. The error identifies the contribution positions.

Reusable integrations must expose their supported changes through options or smaller factories. A consumer must replace or fork an integration when those interfaces are not sufficient.
