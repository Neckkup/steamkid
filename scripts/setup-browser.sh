#!/usr/bin/env bash
#
# One command to get a working Chromium on a rootless runner.
#
# Builds the Debian sysroot (scripts/chromium-sysroot.ts), then installs the
# browser build that this repo's pinned Playwright expects. Both steps are
# idempotent and cached inside .cache/chromium-sysroot.
#
#   eval "$(bash scripts/setup-browser.sh)"    # set up, then export the env
#   bash scripts/setup-browser.sh --check      # also prove a browser launches
#
# Everything the browser needs is printed to stdout as shell `export` lines;
# all progress output goes to stderr, so `eval "$(...)"` is safe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

npx tsx scripts/chromium-sysroot.ts >/dev/null

ENV_FILE="${CHROMIUM_SYSROOT_DIR:-$REPO_ROOT/.cache/chromium-sysroot}/env.sh"
# shellcheck source=/dev/null
source "$ENV_FILE"

# PLAYWRIGHT_BROWSERS_PATH comes from env.sh, so this lands in the same cache.
if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH/chromium-"* ] 2>/dev/null; then
  echo "[setup-browser] installing chromium for the pinned playwright" >&2
  npx playwright install chromium >&2
fi

if [ "${1:-}" = "--check" ]; then
  echo "[setup-browser] launching chromium to verify" >&2
  npx tsx scripts/browser-check.ts >&2
fi

cat "$ENV_FILE"
