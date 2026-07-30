---
name: reference-repos
description: Reference repositories for projects. Use when the user wants external source code cloned locally for agent consultation and kept synchronized.
argument-hint: "<repository URL> [useful for ...]"
---

# Reference Repositories

Install external repositories as disposable, read-only references under `.repos/`.

## 1. Inventory

For every requested reference repository, establish:

- its canonical clone URL;
- a unique local name, normally the repository basename without `.git`;
- what its code is useful for in this project, stated as concrete APIs,
  patterns, behavior, or implementation areas;
- the project's established directory for maintenance scripts. Use `scripts/`
  at the project root when none exists.
- the project's tracked bootstrap command or lifecycle. Prefer the entrypoint
  contributors already run after cloning.

Derive missing details from the current project and the reference repository.
When project and repository evidence cannot settle a detail, ask the user.

This step is complete when every requested repository has a URL, unique
`.repos/<name>` path, project-specific “useful for” statement, one script
destination, and one bootstrap integration point.

## 2. Install the sync script

Create `.repos/` at the project root. Add the exact line `.repos/` to the root
`.gitignore`, creating that file when needed and preserving its organization.

Create an executable `sync-reference-repos.sh` in the selected scripts
directory. Use this shape, adding one `sync_repo` call per reference repository:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
REPOS_DIR="$PROJECT_ROOT/.repos"

mkdir -p "$REPOS_DIR"

sync_repo() {
  local name="$1"
  local url="$2"
  local destination="$REPOS_DIR/$name"

  if [[ ! -e "$destination" ]]; then
    git clone -- "$url" "$destination"
    return
  fi

  if [[ ! -d "$destination/.git" ]]; then
    printf 'error: %s exists but is not a Git repository\n' "$destination" >&2
    return 1
  fi

  local actual_url
  actual_url="$(git -C "$destination" remote get-url origin)"
  if [[ "$actual_url" != "$url" ]]; then
    printf 'error: %s has origin %s; expected %s\n' \
      "$destination" "$actual_url" "$url" >&2
    return 1
  fi

  if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
    printf 'error: %s has local changes; preserve or discard before syncing\n' \
      "$destination" >&2
    return 1
  fi

  git -C "$destination" pull --ff-only --prune
}

sync_repo "<name>" "<clone-url>"
```

Keep repository names and URLs explicit in the script; it is the single source
of truth for what gets cloned. Match an established executable naming
convention only when the project already has one, while preserving the behavior
above.

This step is complete when `.repos/` exists, `.gitignore` contains one
`.repos/` entry, and the executable script accounts for every requested
repository exactly once.

## 3. Wire repository bootstrap

Make the sync script part of the project's tracked bootstrap path. Select the
integration in this order:

1. Add it to the established setup, bootstrap, dependency-install, devcontainer,
   task-runner, or environment-provisioning entrypoint contributors already use.
2. When Husky is established, use its installed hooks to refresh references
   after relevant checkout or update events, and keep initial materialization in
   the tracked bootstrap command that installs Husky.
3. When no bootstrap path exists, create an executable
   `<scripts-dir>/bootstrap.sh` that invokes the sync script and document it as
   the repository setup command.

Keep the sync script as the only implementation of clone and update behavior;
bootstrap commands and hooks call it rather than reproducing its Git commands.
Preserve existing bootstrap behavior and ensure the sync invocation runs once.

Git hooks become active only after installation, so a Husky hook can maintain
references after setup but cannot materialize them during the initial clone by
itself.

This step is complete when the repository has a tracked bootstrap command that
invokes the sync script, and any Husky hook is an additional refresh path rather
than the sole initial setup path.

## 4. Materialize the references

Run the sync script from the project root. Resolve every clone, origin,
dirty-worktree, or fast-forward failure.

This step is complete when the script exits successfully and every
`.repos/<name>` is a Git checkout whose `origin` matches the script.

## 5. Document the references

Add or update a root instruction block. Update every independent `AGENTS.md`
and `CLAUDE.md` that exists. When one is a symlink or explicitly imports the
other, edit only the source. Create `AGENTS.md` when neither exists.

Use this form and retain one row per repository:

```markdown
## Reference repositories

The `<bootstrap-command>` materializes these read-only references in `.repos/`.
Run `./<script-path>/sync-reference-repos.sh` to refresh them directly.

| Repository | Path | Useful for |
| --- | --- | --- |
| [`<owner>/<repo>`](<url>) | `.repos/<name>` | <project-specific use> |
```

Use the project-specific “useful for” statements established during inventory.
Update an existing block in place.

This step is complete when every active root instruction file either contains
this block or resolves to it, and the block defines the bootstrap command,
direct sync command, every reference repository, local path, and project-specific
use exactly once.

## 6. Verify

Run the repository bootstrap entrypoint, not only the sync script. Confirm:

- a disposable checkout with `.repos/` absent clones every reference;
- a second bootstrap run fast-forwards references without recloning;
- any configured Husky refresh hook invokes the same sync script;
- each documented path, bootstrap command, and script entry agree;
- `.repos/` is ignored by the project's Git configuration;
- the script passes `bash -n` and is executable;
- every requested repository appears in the script and instruction block.

The installation is complete only when every check passes for every requested
repository.
