#!/usr/bin/env bash
# Creates or updates the mcp-policy-server label taxonomy (the label axes
# only). Types (Bug/Feature/Chore/Security/Idea) and Priority are native
# org-level GitHub fields, not labels, and are configured in org settings, not
# here.
#
# The areas below are this repository's own, derived from its structure. They
# deliberately differ from rill-cli's: copying that list would create labels
# for a bundler and an extension manager this repository does not contain.
#
# One signal per axis; label text is the load-bearing distinction (WCAG 1.4.1).
# area:* uniform blue; on-hold gray (parked); needs-triage yellow (pending).
#
# Usage: .github/scripts/sync-labels.sh     (defaults to rcrsr/mcp-policy-server)
#        REPO=owner/name .github/scripts/sync-labels.sh
#
# Idempotent: `gh label create --force` upserts, so re-running only updates
# color/description drift. Requires: gh, authenticated with repo scope.
set -euo pipefail

REPO="${REPO:-rcrsr/mcp-policy-server}"

AREA_COLOR="1d76db"   # blue, uniform across every area
HOLD_COLOR="d2dae1"   # gray, parked/inactive
TRIAGE_COLOR="fbca04" # yellow, pending/triage

declare -a AREAS=(
  "area:server|MCP server: stdio entry, tool and prompt definitions, handlers, chunking"
  "area:cli|policy-cli binary: subcommands, flag parsing, exit codes"
  "area:hook|policy-hook binary: PreToolUse pipeline, agent lookup, prompt injection"
  "area:core|§ notation engine: parser, resolver, indexer, validator, checker, config"
  "area:docs|documentation content: README, CHANGELOG, CLAUDE.md, docs/"
  "area:dx|CI, toolchain, lint rules, root config"
)

for entry in "${AREAS[@]}"; do
  name="${entry%%|*}"
  desc="${entry#*|}"
  gh label create "$name" --repo "$REPO" --color "$AREA_COLOR" --description "$desc" --force
done

gh label create "on-hold" --repo "$REPO" --color "$HOLD_COLOR" \
  --description "Shaped work deliberately parked; not low priority, not blocked-by a specific issue" --force

gh label create "needs-triage" --repo "$REPO" --color "$TRIAGE_COLOR" \
  --description "Enforcer-managed: missing an area label or an Issue Type. Never hand-apply." --force

echo "Label taxonomy synced to $REPO."
