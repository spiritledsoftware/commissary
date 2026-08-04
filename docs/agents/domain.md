# Domain Docs

How engineering skills must use this repository's domain documentation.

## Before exploring, read these

- Read `CONTEXT-MAP.md` at the repository root when it exists.
- Use the map to find each context that is relevant to the task.
- Read the relevant `packages/<package>/CONTEXT.md` files.
- Read system-wide decisions in `docs/adr/`.
- Read package decisions in `packages/<package>/docs/adr/` when that directory exists.
- Until `CONTEXT-MAP.md` exists, use the root `CONTEXT.md`.

If a listed file does not exist, proceed silently. Domain documentation is created when the related terms or decisions become stable.

## File structure

The repository uses this multi-context layout:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
└── packages/
    ├── core/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── store/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── store-memory/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── effect/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── stream/
        ├── CONTEXT.md
        └── docs/adr/
```

`docs/adr/` contains system-wide decisions. Package ADR directories contain decisions that apply only to that package.

## Read only relevant contexts

Start with `CONTEXT-MAP.md`. Read the context for the package being changed and each context that owns a contract used by that package.

Do not read every context by default.

## Use the glossary vocabulary

Use each context's defined terms in issues, plans, APIs, tests, and documentation. Do not replace a defined term with a synonym that the context rejects.

If a required concept is not defined, reconsider the term or record the gap for domain modeling.

## Flag ADR conflicts

If proposed work conflicts with an accepted ADR, report the conflict. Do not silently replace the decision.
