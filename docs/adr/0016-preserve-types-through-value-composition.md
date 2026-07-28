# Preserve types through value composition

## Core inference

Public constructors use const generics and readonly tuples. Literal Agent IDs, Tool names, schemas, Codecs, Hook Points, and Fragment order survive composition.

Users do not need explicit generic arguments, `as const`, or `satisfies` for ordinary authoring.

Agent Fragments keep composition metadata in an inaccessible type channel. Named helpers such as `Agent.Tools`, `Tool.Input`, and `Tool.ResumeInput` expose inferred types.

Public interfaces contain no runtime `$Infer` member, global augmentation, or public `any`. A callback infers its input from the schema or Codec that defines it.

Core-owned IDs are opaque branded strings. `app.agent(agent)` returns a client that keeps that Agent's Events, Failures, suspensions, and resume inputs.

The `commissary` constructor does not need an eager Agent tuple. Unbound Runtime Operations and explicit dynamic Tool types remain honest advanced interfaces.

Compile-time contract tests cover successful inference and rejected misuse. Agent Installation checks cross-Fragment identity conflicts at runtime, as defined in [ADR 0001](0001-render-installed-agents-into-execution-plans.md).

## Dynamic Hooks

The same point-specific Hook type supports static installation and `client.subscribe(hook)`.

The bound Agent Client checks a dynamic Hook against the Agent's closed Hook Point contract. A dynamic Hook cannot add Tools, suspensions, requirements, or new declared result variants.

## Effect requirements

The hidden Fragment type channel also carries open Effect requirements from `@commissary/effect/ai`. Agent composition forms the union of these requirements.

`EffectCommissary.layer({ threadStore, ... })` requires only the base Commissary dependencies. `EffectCommissary.agent(agent)` reads that Agent's requirements when it installs the Agent.

The returned Effect Agent Client keeps the Agent's inferred contract. No Effect type enters the plain JavaScript constructors or inference helpers.
