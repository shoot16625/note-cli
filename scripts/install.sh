#!/usr/bin/env bash
# Put note-cli on PATH (npm link) and register this repo as a Claude Code plugin marketplace.
# Skills are shipped as the `note-cli` plugin (note-cli:draft, note-cli:research, note-cli:my-stats).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$repo" && npm install --no-fund --no-audit && npm link --no-fund --no-audit)
echo "note-cli -> $(command -v note-cli || echo 'not on PATH (check npm global bin)')"

# Remove symlinks left by older versions that linked skills/note-* directly.
for dir in "$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.agents/skills"; do
  for name in note-draft note-research note-my-stats; do
    link="$dir/$name"
    if [ -L "$link" ] && [[ "$(readlink "$link")" == "$repo/"* ]]; then
      rm "$link"
      echo "removed legacy link $link"
    fi
  done
done

if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add "$repo" || true
  claude plugin install note-cli@note-cli || true
else
  echo "Claude Code not found; skip plugin install."
fi

cat <<EOF

Codex: add this repo as a local plugin marketplace, then enable note-cli:
  ~/.codex/config.toml
    [marketplaces.note-cli]
    source_type = "local"
    source = "$repo"

    [plugins."note-cli@note-cli"]
    enabled = true
EOF
