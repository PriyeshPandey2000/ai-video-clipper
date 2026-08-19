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
DMG=$(find "$RELEASE_DIR" -maxdepth 1 -name "*.dmg" | head -1)

if [ -z "$DMG" ]; then
  echo "No .dmg found in $RELEASE_DIR — run 'pnpm package:mac' first." >&2
  exit 1
fi

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set." >&2
  exit 1
fi

echo "Submitting $DMG for notarization (not waiting for result)..."
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --no-wait

echo ""
echo "Submitted. Copy the 'id' value above — check status later with:"
echo "  bash scripts/notarize-check.sh <id>"
