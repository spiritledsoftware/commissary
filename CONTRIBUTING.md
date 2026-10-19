# Contributing to Commissary

Commissary is licensed under [FSL-1.1-ALv2](LICENSE) by Spirit-Led Software LLC. Thank you for helping with it.

## Contributor License Agreement

Every pull request needs a signed [Contributor License Agreement](CLA.md). It grants Spirit-Led Software LLC a perpetual, worldwide, irrevocable licence to your contribution, including the right to sublicense it and to relicense it under any terms, so that Commissary's licence can still change. It is not a copyright assignment: you keep your own rights.

To sign, open your pull request. The CLA bot comments on it if you haven't signed yet. Reply with this exact comment:

```text
I have read the CLA Document and I hereby sign the CLA
```

The bot records your signature once, on a `cla-signatures` branch of this repository, and the `cla` check then passes on all your pull requests. If the check doesn't update, comment `recheck`. Bots and the maintainer are exempt.

If you contribute on behalf of an employer, make sure they allow it (section 4 of the CLA).

### Maintainer notes

The `cla-signatures` branch must exist and stay unprotected (no branch protection or ruleset), because the bot pushes to it with the default `GITHUB_TOKEN`.

## Working on the code

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the workspace, scripts and conventions; [AGENTS.md](AGENTS.md) the commands to run before a pull request:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) with a lowercase subject (`feat(tools): ...`). Husky hooks format and lint staged files and check the message.

A change that copies from CLIProxyAPI names the Go source it copies at the top of the module; [NOTICE](NOTICE) explains why that matters.

To report a vulnerability, follow [SECURITY.md](SECURITY.md) rather than opening an issue.
