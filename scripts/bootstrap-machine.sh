#!/usr/bin/env bash
# Make this machine run pi-omp-advisor from a local, editable checkout.
#
# Why not `pi install npm:` or `pi install git:`? Because both give you a
# pi-managed copy you must not edit: the git updater runs `git reset --hard` and
# `git clean -fdx` inside its clone, so local changes are destroyed on update, and
# npm means a publish round-trip for every change. A local-path package entry
# instead points pi at a checkout you own.
#
# The settings entry is `../../git/pi-omp-advisor`, resolved by pi against
# ~/.pi/agent, i.e. $HOME/git/pi-omp-advisor. That is home-relative, so the SAME
# entry works on every machine — which is what lets a synced settings.json carry
# this install everywhere without naming any one machine's paths.
#
# Idempotent: safe to re-run. Updates an existing checkout instead of clobbering.
#
#   curl -fsSL <raw-url>/scripts/bootstrap-machine.sh | bash
#   # or, from an existing checkout:
#   ./scripts/bootstrap-machine.sh

set -euo pipefail

REPO_URL="${PI_ADVISOR_REPO_URL:-https://github.com/Scott-Meyer/pi-omp-advisor.git}"
CHECKOUT="${PI_ADVISOR_CHECKOUT:-$HOME/git/pi-omp-advisor}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"
# Must stay relative so one synced settings.json works on every machine.
ENTRY="../../git/pi-omp-advisor"

info() { printf '  %s\n' "$*"; }

command -v git >/dev/null || { echo "bootstrap: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "bootstrap: node is required (pi needs >=22.19)" >&2; exit 1; }
command -v npm >/dev/null || { echo "bootstrap: npm is required" >&2; exit 1; }

echo "==> checkout at $CHECKOUT"
if [ -d "$CHECKOUT/.git" ]; then
  info "already a git checkout; fetching"
  git -C "$CHECKOUT" fetch --quiet --tags origin
  if [ -n "$(git -C "$CHECKOUT" status --porcelain)" ]; then
    info "local changes present — NOT touching them (skipping fast-forward)"
  else
    branch="$(git -C "$CHECKOUT" symbolic-ref --quiet --short HEAD || echo)"
    if [ -n "$branch" ] && git -C "$CHECKOUT" rev-parse --quiet --verify "origin/$branch" >/dev/null; then
      git -C "$CHECKOUT" merge --ff-only --quiet "origin/$branch" && info "fast-forwarded $branch"
    else
      info "detached or no upstream branch; leaving HEAD alone"
    fi
  fi
elif [ -e "$CHECKOUT" ]; then
  echo "bootstrap: $CHECKOUT exists but is not a git checkout; move it aside first" >&2
  exit 1
else
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --quiet "$REPO_URL" "$CHECKOUT"
  info "cloned"
fi

echo "==> dependencies"
# pi does NOT install dependencies for local-path packages (only for npm/git
# specs), so the checkout needs its own node_modules or `yaml` will not resolve
# and WATCHDOG.yml files are silently ignored.
if [ -f "$CHECKOUT/package-lock.json" ]; then
  ( cd "$CHECKOUT" && npm ci --omit=dev --silent ) && info "npm ci (prod only)"
else
  ( cd "$CHECKOUT" && npm install --omit=dev --silent ) && info "npm install (prod only)"
fi

echo "==> pi settings"
mkdir -p "$AGENT_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
ENTRY="$ENTRY" SETTINGS="$SETTINGS" node -e '
const fs = require("node:fs");
const file = process.env.SETTINGS, entry = process.env.ENTRY;
let settings;
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
} catch (err) {
  console.error(`  refusing to edit ${file}: ${err.message}`);
  console.error(`  add "${entry}" to its "packages" array by hand.`);
  process.exit(1);
}
const packages = Array.isArray(settings.packages) ? settings.packages : [];
const has = packages.some(p => (typeof p === "string" ? p : p && p.source) === entry);
// A git/npm spec for this same project would load a SECOND copy: pi keys package
// identity separately for local paths vs git URLs vs npm names, so both would
// register /advisor and conflict.
const rival = packages.filter(p => {
  const s = typeof p === "string" ? p : p && p.source;
  return typeof s === "string" && s !== entry && /pi-omp-advisor/.test(s);
});
if (rival.length) {
  console.error(`  WARNING: other pi-omp-advisor entries present: ${rival.join(", ")}`);
  console.error("  remove them, or you will load the extension twice and conflict on /advisor.");
}
if (has) {
  console.log("  entry already present");
} else {
  packages.push(entry);
  settings.packages = packages;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  added "${entry}" to packages`);
}
'

echo "==> done"
info "restart pi, then run /advisor status"
info "no advisor runs until a WATCHDOG.yml exists (see README)"
info "edit code directly in $CHECKOUT — it is the live install"
