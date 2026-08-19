#!/bin/bash
# Downloads and bundles a portable whisper-cli binary (whisper.cpp).
# Run once after cloning: bash scripts/setup-whisper.sh
# pipefail: without it, `dylibbundler ... | grep -v "^$"` below reports grep's exit status, not
# dylibbundler's — a failed bundling step that still printed a non-blank line would look
# successful and leave an incomplete (missing dylibs) whisper-cli binary with no error.
set -eo pipefail

DEST="resources/whisper"
mkdir -p "$DEST"

# Existence alone isn't enough to trust — a run that got killed mid-bundle (e.g. dylibbundler
# interrupted) can leave a whisper-cli file present but unable to actually load its dylibs. Run
# it for real before deciding to skip; if it fails, wipe the stale bundle and rebuild.
if [ -f "$DEST/whisper-cli" ]; then
  if "$DEST/whisper-cli" --help >/dev/null 2>&1; then
    echo "whisper-cli already present at $DEST/whisper-cli — skipping."
    exit 0
  fi
  echo "Existing $DEST/whisper-cli is present but doesn't run (stale/incomplete bundle) — rebuilding."
  rm -rf "$DEST"
  mkdir -p "$DEST"
fi

if ! command -v brew &>/dev/null; then
  echo "Homebrew required. Install from https://brew.sh then re-run."
  exit 1
fi

echo "Installing whisper-cpp and dylibbundler..."
brew install whisper-cpp dylibbundler

SRC="$(brew --prefix whisper-cpp)/bin/whisper-cli"
cp "$SRC" "$DEST/whisper-cli"
chmod +w "$DEST/whisper-cli"

# whisper-cli's own lib (libwhisper.1.dylib) is referenced via a relative rpath
# (@loader_path/../lib) computed from its ORIGINAL homebrew location — once copied out to $DEST,
# that relative path no longer resolves. -s tells dylibbundler explicitly where to still find it,
# instead of relying on rpath math relative to the binary's new location.
echo "Bundling dylibs (portable binary)..."
dylibbundler -od -b \
  -x "$DEST/whisper-cli" \
  -d "$DEST/libs/" \
  -p @executable_path/libs/ \
  -s "$(brew --prefix whisper-cpp)/lib" 2>&1 | grep -v "^$"

echo "Done. Verifying..."
if ! "$DEST/whisper-cli" --help >/dev/null 2>&1; then
  echo "✗ whisper-cli failed to run — check dylib bundling" >&2
  exit 1
fi
echo "✓ whisper-cli runs standalone (dylibs bundled correctly)"
