#!/bin/bash
# Apply a mutation to a throwaway copy of the repo and require the test suite
# to FAIL. A mutation check that reverts code in the working tree (git checkout,
# sed -i on src/) can wipe unstaged work — this script never touches the
# current tree: it detaches a temp worktree at HEAD, mutates that, runs tests
# there, and deletes it.
#
# Usage: scripts/mutation-check.sh '<mutation shell command>' <test command...>
#
#   scripts/mutation-check.sh \
#     'sed -i "" "s/return collected.events.filter((e) => tsMs(e) === null).length;/return 0;/" src/reports/providers.ts' \
#     bun test tests/providers.test.ts
#
# The mutation runs with cwd set to the throwaway worktree. Uncommitted
# changes are NOT copied — commit (or stage) first, or the check measures HEAD.
set -euo pipefail

MUTATION=${1:?usage: mutation-check.sh '<mutation shell command>' <test command...>}
shift

REPO=$(git rev-parse --show-toplevel)
WT=$(mktemp -d "${TMPDIR:-/tmp}/token-scope-mutation-XXXXXX")
cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"; }
trap cleanup EXIT

git -C "$REPO" worktree add --detach "$WT" HEAD >/dev/null

if ! (cd "$WT" && bash -c "$MUTATION"); then
  echo "mutation-check: the mutation command itself failed — fix it before trusting a pass" >&2
  exit 2
fi

echo "mutation applied in $WT"
if (cd "$WT" && "$@"); then
  echo "mutation-check FAILED: tests passed with the mutation applied — they do not guard the fix" >&2
  exit 1
fi
echo "mutation-check ok: tests fail under mutation"
