#!/bin/bash
# Downloads and bundles a portable FFmpeg binary with libass support.
# Run once after cloning: bash scripts/setup-ffmpeg.sh
set -e

DEST="resources/ffmpeg"
mkdir -p "$DEST"

if [ -f "$DEST/ffmpeg" ]; then
  echo "FFmpeg already present at $DEST/ffmpeg — skipping."
  exit 0
fi

if ! command -v brew &>/dev/null; then
  echo "Homebrew required. Install from https://brew.sh then re-run."
  exit 1
fi

echo "Installing ffmpeg-full and dylibbundler..."
brew install ffmpeg-full dylibbundler

SRC="$(brew --prefix ffmpeg-full)/bin/ffmpeg"
cp "$SRC" "$DEST/ffmpeg"
chmod +w "$DEST/ffmpeg"

echo "Bundling dylibs (portable binary)..."
dylibbundler -od -b \
  -x "$DEST/ffmpeg" \
  -d "$DEST/libs/" \
  -p @executable_path/libs/ 2>&1 | grep -v "^$"

echo "Done. Verifying..."
"$DEST/ffmpeg" -filters 2>&1 | grep -q subtitles \
  && echo "✓ subtitles filter present (libass bundled)" \
  || echo "✗ subtitles filter missing — check ffmpeg-full install"
