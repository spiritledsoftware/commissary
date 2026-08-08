# Commissary Project Instructions

## Engineering

### TypeScript

Before TypeScript design or implementation, use the project-local `coding-standards` skill and read the references it selects.

### Domain and architecture

Before work on a package, domain term, contract, or architecture, follow `docs/agents/domain.md` to select the relevant context documents and ADRs.

Before changing a public API, package boundary, runtime state, or repository-wide architecture, read every ADR in `docs/adr/`. Accepted ADRs are authoritative. Update or supersede a conflicting ADR before implementation.

### Reference implementations

Before work on Effect, authentication, persistence, agent runtimes, model or tool protocols, HTTP, or Cloudflare state, select and consult the matching repository in `docs/agents/reference-repositories.md`. Treat `.repos/` as read-only and adapt patterns to this project's domain and conventions.

## Repository workflows

- **Issues and PRDs:** For issue or PRD operations, follow `docs/agents/issue-tracker.md`.
- **Triage labels:** When a skill names a triage role, resolve its repository label through `docs/agents/triage-labels.md`.

## Git conventions

Use Conventional Commits for commit messages and PR titles:

```text
<type>[optional scope][!]: <description>
```

Use a short, lowercase, imperative description with no final period. Add a scope only when it identifies a useful package or subsystem. For a breaking change, use `!` and add a `BREAKING CHANGE:` footer. A PR title describes the net effect of the complete PR.

## Verification

After source, test, package, or build configuration changes, `pnpm run verify` must pass.

After documentation-only changes, `pnpm run format:check` must pass.
