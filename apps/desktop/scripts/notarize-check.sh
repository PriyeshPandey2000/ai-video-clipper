#!/bin/bash
# Checks the status of a notarization submission and, once Apple has accepted it, staples the
# notarization ticket onto both the .app and the .dmg so they work offline (Gatekeeper checks
# the stapled ticket first, only falling back to an online check if it's missing). Both staples
# succeed because notarize-submit.sh submits the .dmg itself (already codesigned by
# electron-builder) — Apple's ticket is keyed to the codesigned .app's hash regardless of
# container, so notarizing the .dmg covers the .app inside it too.
#
# Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID exported in your shell.
#
# Usage: bash scripts/notarize-check.sh <submission-id>
set -e

SUBMISSION_ID="$1"
if [ -z "$SUBMISSION_ID" ]; then
  echo "Usage: bash scripts/notarize-check.sh <submission-id>" >&2
  echo "(the id printed by notarize-submit.sh)" >&2
  exit 1
fi

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set." >&2
  exit 1
fi

# Load the exact files notarize-submit.sh actually submitted for THIS id, rather than
# independently re-guessing via find — a build produced after this submission (different
# version, different files sitting in release/) must not get stapled with a ticket that was
# never issued for it.
RELEASE_DIR="$(dirname "$0")/../release"
STATE_FILE="$RELEASE_DIR/.notarize-state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "No submission state found at $STATE_FILE — run notarize-submit.sh first." >&2
  exit 1
fi

STATE_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['submissionId'])")
if [ "$STATE_ID" != "$SUBMISSION_ID" ]; then
  echo "Submission id mismatch: given $SUBMISSION_ID, but $STATE_FILE was written for $STATE_ID." >&2
  echo "Re-run notarize-submit.sh if you meant to submit a newer build." >&2
  exit 1
fi

DMG=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['dmg'])")
APP=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['app'])")
ZIP=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['zip'])")

# --output-format json is far more robust than parsing the "normal" text format, whose exact
# wording isn't a stable contract to grep against.
INFO_JSON=$(xcrun notarytool info "$SUBMISSION_ID" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --output-format json)

STATUS=$(echo "$INFO_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")

echo "Status: $STATUS"

# Only "Accepted" is treated as success. Apple's documented terminal failure states are
# "Invalid" and "Rejected" — anything else (including "In Progress", exact casing unverified
# without a live submission) is treated as "not done yet" rather than guessed as a failure, so
# this doesn't misfire into dumping a log for a submission that's still processing.
case "$STATUS" in
  Accepted) ;;
  Invalid | Rejected)
    echo "Notarization failed. Full log:"
    xcrun notarytool log "$SUBMISSION_ID" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID"
    exit 1
    ;;
  *)
    echo "Not finished yet — check again later."
    exit 0
    ;;
esac

echo "Accepted. Stapling ticket..."
xcrun stapler staple "$APP" && echo "Stapled: $APP"
xcrun stapler staple "$DMG" && echo "Stapled: $DMG"

# Stapling the standalone .app does NOT reach into the .zip — that .zip was archived at build
# time and holds its own separate, now-stale (unstapled) copy of the .app. Rebuild it from the
# just-stapled .app so anyone who distributes the .zip instead of the .dmg also gets a properly
# stapled, offline-verifiable copy (electron-updater's mac autoUpdater uses the .zip, not the
# .dmg, so this matters once auto-update is wired up).
echo "Rebuilding $ZIP from the stapled .app..."
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Rebuilt: $ZIP"

echo "Done. Verify with: spctl -a -vvv -t execute \"$APP\""
