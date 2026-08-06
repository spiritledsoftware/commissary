# Contributing to Commissary

Thank you for contributing to Commissary.

## Conduct and license

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.

By submitting a contribution, you agree that it is provided under the project’s [MIT license](LICENSE). The project does not require a CLA or DCO sign-off.

## Set up the repository

Requirements:

- Node.js 22.14 or later
- pnpm 11.16
- The current stable Bun and Deno releases for runtime conformance

Install dependencies and the read-only reference repositories:

```sh
pnpm run bootstrap
```

Install Chromium before you run browser conformance:

```sh
pnpm exec playwright install chromium
```

## Make a change

1. Create a branch from `main`.
2. Keep the change focused.
3. Add tests for changed behavior.
4. Add or update documentation when a public contract changes.
5. Add a Changeset for a user-visible package change.

Create a Changeset with:

```sh
pnpm changeset
```

Choose each affected package and the correct semantic version change. Write the summary for package users. Tests, documentation, CI changes, and internal refactoring can omit a Changeset. Explain the reason in the pull request so a maintainer can apply the `no-changeset` label.

## Documentation-only changes

CI treats a change as documentation-only only when every changed file is in one of these locations:

- `docs/**`
- Root Markdown files or `LICENSE`
- `packages/*/README.md`, `packages/*/CONTEXT.md`, or `packages/*/docs/**`
- Markdown files under `.github/**` or `.agents/**`
- `.changeset/README.md`

A release entry under `.changeset/*.md`, an unknown documentation path, or a change that mixes documentation and other files requires full CI verification.

For a documentation-only change, run:

```sh
pnpm run format:check
```

## Check the change

Run the same commands used by CI for every other change:

```sh
pnpm run verify
pnpm run build
pnpm run check:imports
pnpm run conformance:node
pnpm run conformance:bun
pnpm run conformance:deno
pnpm run conformance:browser
pnpm run conformance:cloudflare
pnpm run pack:check
```

## Open a pull request

Use a Conventional Commit pull request title. The title becomes the squash commit on `main`.

Examples:

```text
feat(core): add durable retries
fix(stream): preserve terminal errors
chore: update dependencies
```

The subject after the colon must start with a lowercase letter. Complete the pull request template and resolve all review conversations before merge.

Do not report a vulnerability in a public issue or pull request. Follow [SECURITY.md](SECURITY.md) instead.
