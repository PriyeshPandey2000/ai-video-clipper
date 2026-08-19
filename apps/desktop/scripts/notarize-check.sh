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

RELEASE_DIR="$(dirname "$0")/../release"
APP=$(find "$RELEASE_DIR" -maxdepth 2 -name "*.app" | head -1)
DMG=$(find "$RELEASE_DIR" -maxdepth 1 -name "*.dmg" | head -1)

echo "Accepted. Stapling ticket..."
[ -n "$APP" ] && xcrun stapler staple "$APP" && echo "Stapled: $APP"
[ -n "$DMG" ] && xcrun stapler staple "$DMG" && echo "Stapled: $DMG"

echo "Done. Verify with: spctl -a -vvv -t install \"$DMG\""
