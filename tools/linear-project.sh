#!/usr/bin/env bash
# Puts the Linear issue that Linear's GitHub Issues sync created for a GitHub issue into the Linear project
# LINEAR_PROJECT (docs/agents/issue-tracker.md): the sync copies GitHub issues into the team, but in no project. Waits
# for the copy (found by its GitHub URL, an attachment the sync adds) up to WAIT_SECONDS, then sets the project only
# when the issue has none, so a project someone already chose is kept. Exits 0 when nothing is left to do (set, kept),
# 1 when the copy never appeared, Linear refused the key (at once) or Linear kept failing (other errors are retried).
# Usage: LINEAR_API_KEY=… LINEAR_PROJECT=<project id> ISSUE_URL=https://github.com/<owner>/<repo>/issues/<n> \
#   [WAIT_SECONDS=600] tools/linear-project.sh
set -euo pipefail

key="${LINEAR_API_KEY:?LINEAR_API_KEY is required}"
project="${LINEAR_PROJECT:?LINEAR_PROJECT is required}"
url="${ISSUE_URL:?ISSUE_URL is required}"
wait_seconds="${WAIT_SECONDS:-600}"

# One GraphQL request; `$1` is the document, `$2` its variables as JSON. Prints `.data`; fails with 2 when Linear
# rejects the key, which no retry fixes, and with 1 on any other error.
graphql() {
  local response status body
  response="$(
    jq -n --arg query "$1" --argjson variables "$2" '{query: $query, variables: $variables}' |
      curl -sS -w '\n%{http_code}' https://api.linear.app/graphql \
        -H "Content-Type: application/json" \
        -H "Authorization: $key" \
        --data-binary @-
  )" || return 1
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$status" in
  401 | 403)
    echo "Linear rejected LINEAR_API_KEY (HTTP $status)." >&2
    return 2
    ;;
  2??) ;;
  *)
    echo "Linear answered HTTP $status." >&2
    return 1
    ;;
  esac
  if jq -e '(.errors // []) | length > 0' <<<"$body" >/dev/null; then
    echo "Linear refused the request: $(jq -c '.errors' <<<"$body")" >&2
    return 1
  fi
  jq -c '.data' <<<"$body"
}

find_issue() {
  # shellcheck disable=SC2016 # GraphQL variables, not shell ones.
  graphql 'query($url: String!) { attachmentsForURL(url: $url) { nodes { issue { id identifier project { id name } } } } }' \
    "$(jq -n --arg url "$url" '{url: $url}')" |
    jq -c '.attachmentsForURL.nodes | map(.issue) | first // empty'
}

deadline=$((SECONDS + wait_seconds))
issue=""
while true; do
  status=0
  issue="$(find_issue)" || status=$?
  if [ "$status" -eq 2 ]; then exit 1; fi
  if [ "$status" -eq 0 ] && [ -n "$issue" ]; then break; fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "No Linear issue carries $url after ${wait_seconds}s: did the GitHub Issues sync run?" >&2
    exit 1
  fi
  sleep 15
done

identifier="$(jq -r '.identifier' <<<"$issue")"
current="$(jq -r '.project.name // empty' <<<"$issue")"
if [ -n "$current" ]; then
  echo "$identifier is already in project $current; kept."
  exit 0
fi

# shellcheck disable=SC2016 # GraphQL variables, not shell ones.
graphql 'mutation($id: String!, $project: String!) { issueUpdate(id: $id, input: {projectId: $project}) { success } }' \
  "$(jq -n --arg id "$(jq -r '.id' <<<"$issue")" --arg project "$project" '{id: $id, project: $project}')" |
  jq -e '.issueUpdate.success' >/dev/null
echo "$identifier ($url) is now in project $project."
