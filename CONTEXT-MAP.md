# Context Map

Commissary is split into package-aligned contexts. Read the context that owns the contract being changed and each context named in its relationships.

## Contexts

- [Core](./packages/core/CONTEXT.md) — defines Agents, provider-neutral Models and Tools, durable Threads and Runs, and Runtime extension seams
- [Store](./packages/store/CONTEXT.md) — defines typed persistence contracts, Records, Collections, expressions, and transactions
- [Memory Store](./packages/store-memory/CONTEXT.md) — implements process-local Store and Thread Store adapters
- [Effect Integration](./packages/effect/CONTEXT.md) — adapts Commissary and Effect AI to Effect-native interfaces
- [Stream Adapter](./packages/stream/CONTEXT.md) — exposes bounded JavaScript and Effect streams of Execution Events

## Relationships

- **Core → Store**: Core specializes Store contracts as Thread Store operations and persists its durable Records through them.
- **Memory Store → Store**: Memory Store implements the generic Store and Transaction Store contracts.
- **Memory Store → Core**: Memory Store composes its Transaction Store with Core's Thread Store operations.
- **Effect Integration → Core**: Effect Integration wraps Core interfaces and bridges Effect AI Models to the provider-neutral Model protocol.
- **Stream Adapter → Core**: Stream Adapter captures Core Execution Events without controlling the Execution.
- **Stream Adapter → Effect Integration**: The Effect stream adapter accepts Effect Agent Clients and exposes Effect Streams.
