#!/usr/bin/env bash
# Merge official master into the Linux branch; never rewrite fork history.
set -euo pipefail

branch=${LINUX_BRANCH:-linux-desktop-build}
upstream_url=${UPSTREAM_REMOTE_URL:-https://github.com/deepseek-ai/deepseek-harness.git}
upstream_branch=${UPSTREAM_BRANCH:-master}
git check-ref-format --branch "$branch" >/dev/null
git check-ref-format --branch "$upstream_branch" >/dev/null

git fetch --no-tags origin "refs/heads/$branch"
git checkout -B "$branch" FETCH_HEAD
before=$(git rev-parse HEAD)
git fetch --no-tags "$upstream_url" "refs/heads/$upstream_branch:refs/remotes/linux-upstream/source"
upstream=$(git rev-parse refs/remotes/linux-upstream/source)
if ! git merge-base --is-ancestor "$upstream" HEAD; then
  git -c core.hooksPath=/dev/null merge --no-edit --no-ff --no-commit "$upstream" || test -f "$(git rev-parse --git-path MERGE_HEAD)"
  # Workflow definitions belong to the fork; GITHUB_TOKEN cannot modify them.
  if [[ -n $(git ls-files -- .github/workflows) ]]; then
    git restore --source="$before" --staged --worktree -- .github/workflows
  fi
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ -n $conflicts ]] || ! git rev-parse --quiet --verify MERGE_HEAD >/dev/null; then
    git merge --abort
    printf 'Upstream merge failed; no fork branch was pushed.\n%s\n' "$conflicts" >&2
    if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
      printf '### Upstream merge needs attention\n\nNo remote branch was changed. Resolve the conflicts on `%s` and rerun this workflow.\n\n```text\n%s\n```\n' "$branch" "$conflicts" >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 1
  fi
  git -c core.hooksPath=/dev/null commit --no-edit
fi
sha=$(git rev-parse HEAD)
version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  printf 'Invalid package version: %s\n' "$version" >&2
  exit 1
fi
if [[ $sha != "$before" ]]; then
  # A concurrent fork push is rejected by the server instead of being overwritten.
  git -c core.hooksPath=/dev/null push origin "HEAD:refs/heads/$branch"
fi
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'sha=%s\nupstream=%s\nversion=%s\ntag=linux-%s-%s\n' "$sha" "$upstream" "$version" "$version" "${sha:0:12}" >> "$GITHUB_OUTPUT"
fi
printf 'Linux source: %s; upstream: %s\n' "$sha" "$upstream"
