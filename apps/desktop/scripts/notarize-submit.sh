#!/bin/bash
# Submits the signed .dmg build to Apple for notarization WITHOUT waiting for the result.
# Run this after `pnpm package:mac` (which signs but does not notarize — see mac.notarize:false
# in package.json). Apple's processing can take anywhere from minutes to hours; this script
# returns immediately with a submission ID, so nothing here blocks or times out.
#
# Submits the .dmg specifically, not the .zip: electron-builder already codesigns the .dmg
# wrapper itself (dmg-builder/dmg.js calls `codesign` on the artifact directly, unconditional on
# notarize:false — that setting only skips the notarize step, not dmg signing). Apple's
# notarization ticket is keyed to the codesigned .app's own hash regardless of which container
# submitted it, so notarizing the .dmg covers both the .app inside AND the .dmg container's own
# ticket in one submission — no need to separately submit a .zip.
#
# Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID exported in your shell.
#
# Usage: bash scripts/notarize-submit.sh
# Then:  bash scripts/notarize-check.sh <submission-id>   (once Apple is done)
set -e

RELEASE_DIR="$(dirname "$0")/../release"

# Fail loudly on zero OR multiple matches rather than silently picking the first — a stale
# artifact from a previous version/build sitting alongside the current one would otherwise get
# submitted or stapled without anyone noticing which one actually happened.
require_one() {
  local pattern="$1" depth="$2" label="$3"
  local matches
  matches=$(find "$RELEASE_DIR" -maxdepth "$depth" -name "$pattern")
  local count
  count=$(echo "$matches" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    echo "No $label found in $RELEASE_DIR — run 'pnpm package:mac' first." >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "Multiple $label found in $RELEASE_DIR — clear old builds before submitting:" >&2
    echo "$matches" >&2
    exit 1
  fi
  echo "$matches"
}

# `|| exit 1` is required here, not decorative: require_one's own `exit 1` only kills the
# subshell that command substitution runs it in — set -e does not auto-trigger on a failed
# command substitution used in an assignment, so without this the script would silently
# continue with an empty variable instead of stopping.
DMG=$(require_one "*.dmg" 1 ".dmg") || exit 1
APP=$(require_one "*.app" 2 ".app") || exit 1
ZIP=$(require_one "*.zip" 1 ".zip") || exit 1

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set." >&2
  exit 1
fi

echo "Submitting $DMG for notarization (not waiting for result)..."
SUBMIT_JSON=$(xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --no-wait \
  --output-format json)

SUBMISSION_ID=$(echo "$SUBMIT_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# Persists exactly which files this submission covers, so notarize-check.sh staples the files
# that were actually submitted instead of independently re-guessing via find — closes the gap
# where a build produced after this submission (different version, different files) could get
# stapled with an old ticket that was never issued for it.
STATE_FILE="$RELEASE_DIR/.notarize-state.json"
python3 -c "
import json
json.dump({'submissionId': '$SUBMISSION_ID', 'dmg': '$DMG', 'app': '$APP', 'zip': '$ZIP'}, open('$STATE_FILE', 'w'), indent=2)
"

echo ""
echo "Submitted: $SUBMISSION_ID"
echo "Check status later with:"
echo "  bash scripts/notarize-check.sh $SUBMISSION_ID"
