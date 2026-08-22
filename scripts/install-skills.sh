#!/usr/bin/env bash
# Put the third-party design skills back into .claude/skills/.
#
# They are not ours to redistribute, so .gitignore keeps them out of the repo.
# Only the dashboard design work needs them; the tool itself does not.
#
# Usage:
#   scripts/install-skills.sh <dir>     copy from a checkout that already has them
#                                       (looks in <dir>/.claude/skills/<name>, then <dir>/<name>)
#   scripts/install-skills.sh --clone   clone each upstream repo instead
#
# Either way a manifest lands in .claude/skills/VENDORED.md.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"
DEST=.claude/skills
MANIFEST="$DEST/VENDORED.md"

# name|repo|path in repo
SKILLS='
frontend-design|https://github.com/anthropics/skills|skills/frontend-design
create-design-md|https://github.com/ibelick/ui-skills|skills/create-design-md
baseline-ui|https://github.com/ibelick/ui-skills|skills/baseline-ui
improve-ui|https://github.com/ibelick/ui-skills|skills/improve-ui
fixing-motion-performance|https://github.com/ibelick/ui-skills|skills/fixing-motion-performance
fixing-accessibility|https://github.com/ibelick/ui-skills|skills/fixing-accessibility
fixing-metadata|https://github.com/ibelick/ui-skills|skills/fixing-metadata
web-design-guidelines|https://github.com/vercel-labs/agent-skills|skills/web-design-guidelines
ui-ux-pro-max|https://github.com/nextlevelbuilder/ui-ux-pro-max-skill|.claude/skills/ui-ux-pro-max
'

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

MODE=""
SRC=""
case "${1:-}" in
  --clone) MODE=clone ;;
  -h|--help|'') usage 0 ;;
  -*) echo "unknown option $1" >&2; usage ;;
  *) MODE=copy; SRC=${1%/} ;;
esac

if [ "$MODE" = copy ] && [ ! -d "$SRC" ]; then
  echo "error: $SRC is not a directory" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
{
  echo "# Vendored skills"
  echo
  echo "Installed by scripts/install-skills.sh on $(date -u +%F). Not tracked by git."
  echo "Do not edit in place; re-run the script to update. Licenses: see each upstream repo."
  echo
  echo "| skill | source | path in source | commit |"
  echo "|---|---|---|---|"
} > "$MANIFEST"

install_one() { # install_one <name> <repo> <subpath>
  local name=$1 repo=$2 sub=$3 from ref dir
  if [ "$MODE" = copy ]; then
    for candidate in "$SRC/.claude/skills/$name" "$SRC/$name"; do
      [ -f "$candidate/SKILL.md" ] && from=$candidate && break
    done
    if [ -z "${from:-}" ]; then
      echo "  !! $name: no SKILL.md under $SRC"
      return
    fi
    ref="copied from $SRC"
  else
    dir="$TMP/$(echo "$repo" | tr '/:' '__')"
    [ -d "$dir" ] || git clone -q --depth 1 "$repo" "$dir"
    from="$dir/$sub"
    if [ ! -f "$from/SKILL.md" ]; then
      echo "  !! $name: $sub/SKILL.md not found in $repo (upstream layout changed?)"
      return
    fi
    ref=$(git -C "$dir" rev-parse --short HEAD)
  fi
  rm -rf "${DEST:?}/$name"
  mkdir -p "$DEST/$name"
  cp -R "$from/." "$DEST/$name/"
  echo "| $name | $repo | $sub | $ref |" >> "$MANIFEST"
  echo "  + $name"
  unset from
}

echo "installing design skills into $DEST ..."
echo "$SKILLS" | while IFS='|' read -r name repo sub; do
  [ -n "$name" ] || continue
  install_one "$name" "$repo" "$sub"
done
echo
echo "done. Restart Claude Code to pick them up."
