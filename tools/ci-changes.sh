#!/usr/bin/env bash
# Tells CI whether a pull request or a push to main changes more than documentation (Markdown files anywhere, and
# everything under docs/), so that a docs-only change skips the checks and deploys. On a closed pull request it also
# tells whether a preview is still deployed, so that its destroy still runs.
# Writes `code=true|false` and `previewed=true|false` to $GITHUB_OUTPUT (stdout without it). When in doubt, code=true.
# Usage: GH_TOKEN=… GITHUB_REPOSITORY=… EVENT=<event name> [PR=<number> ACTION=<action>] [BEFORE=<sha> SHA=<sha>] \
#   tools/ci-changes.sh
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
event="${EVENT:?EVENT is required}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

is_docs() {
  case "$1" in
  *.md | docs/*) return 0 ;;
  *) return 1 ;;
  esac
}

files=""
known=false
case "$event" in
pull_request)
  # The listing stops at 3,000 files, so a listing that long may be missing code.
  files="$(gh api --paginate "repos/$repo/pulls/${PR:?PR is required}/files" --jq '.[].filename')"
  if [ "$(grep -c . <<<"$files")" -lt 3000 ]; then
    known=true
  fi
  ;;
push)
  # A new branch has no previous commit to compare with; a comparison lists at most 300 files.
  if [[ ! "${BEFORE:-}" =~ ^0*$ ]]; then
    compare="$(gh api "repos/$repo/compare/$BEFORE...${SHA:?SHA is required}")"
    if [ "$(jq '.files | length' <<<"$compare")" -lt 300 ]; then
      files="$(jq -r '.files[].filename' <<<"$compare")"
      known=true
    fi
  fi
  ;;
esac

code=true
if [ "$known" = true ] && [ -n "$files" ]; then
  code=false
  while IFS= read -r file; do
    if ! is_docs "$file"; then
      code=true
      break
    fi
  done <<<"$files"
fi

# A preview is still deployed when this workflow's preview comment exists and does not say it was destroyed.
previewed=false
if [ "$event" = pull_request ] && [ "${ACTION:-}" = closed ]; then
  marker="<!-- commissary-preview -->"
  if [ -n "$(gh api --paginate "repos/$repo/issues/$PR/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\")) and (.body | contains(\"destroyed.\") | not)) | .id")" ]; then
    previewed=true
  fi
fi

echo "code=$code" >>"$out"
echo "previewed=$previewed" >>"$out"
if [ "$code" = false ]; then
  echo "::notice::documentation only: skipping the checks and deploys"
fi
