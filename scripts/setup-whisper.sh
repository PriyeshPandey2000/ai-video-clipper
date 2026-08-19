#!/bin/bash
# Builds and bundles a portable whisper-cli binary (whisper.cpp), from source.
# Run once after cloning: bash scripts/setup-whisper.sh
#
# Built from source rather than `brew install whisper-cpp` deliberately. Homebrew's formula
# builds with GGML_BACKEND_DL=ON, which loads the CPU/BLAS/Metal compute backends as separate
# plugins via dlopen() from a path baked into the binary AT COMPILE TIME
# (/opt/homebrew/Cellar/ggml/<version>/libexec) — not computed relative to the binary's own
# location, so bundling/relocating the files does nothing to fix it. That "worked" during
# development purely because this machine happens to have that exact Homebrew path present, and
# crashed with a segfault on real audio the moment it needed those backends for real compute
# work (confirmed empirically: relocating the Homebrew build reproduced the exact crash from a
# packaged app; the pristine Homebrew binary did not crash; a from-source build with static
# backend linking does not crash either — isolated by testing all three against the same file).
#
# GGML_BACKEND_DL defaults to OFF upstream — a default build statically links CPU/Metal directly
# into the binary/core lib, no dlopen, no external path dependency at all.
set -eo pipefail

DEST="resources/whisper"
WHISPER_CPP_TAG="v1.9.2"
# Fingerprint of how this bundle was built. Bump this (or WHISPER_CPP_TAG) whenever the build
# config below changes, so a stale bundle from before that change gets rebuilt automatically
# instead of silently kept. This matters because `--help` alone is NOT proof of a working
# bundle: it never touches model loading or backend init at all, so the exact segfaulting
# Homebrew-based (GGML_BACKEND_DL=ON) bundle this from-source migration fixed would ALSO pass
# `--help` fine — the crash only happened during real transcription compute work. Existence +
# `--help` was the old, insufficient check.
BUILD_PROVENANCE="${WHISPER_CPP_TAG}:metal=on,blas=off,native=off,arch=armv8.5-a+dotprod"
mkdir -p "$DEST"

if [ -f "$DEST/whisper-cli" ] \
  && [ -f "$DEST/.build-provenance" ] \
  && [ "$(cat "$DEST/.build-provenance")" = "$BUILD_PROVENANCE" ] \
  && "$DEST/whisper-cli" --help >/dev/null 2>&1; then
  echo "whisper-cli already present and up to date at $DEST/whisper-cli — skipping."
  exit 0
fi
if [ -f "$DEST/whisper-cli" ]; then
  echo "Existing $DEST/whisper-cli is stale (provenance mismatch) or doesn't run — rebuilding."
  rm -rf "$DEST"
  mkdir -p "$DEST"
fi

if ! command -v brew &>/dev/null; then
  echo "Homebrew required. Install from https://brew.sh then re-run." >&2
  exit 1
fi

echo "Installing cmake and dylibbundler..."
brew install cmake dylibbundler

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Cloning whisper.cpp ${WHISPER_CPP_TAG}..."
git clone --depth 1 --branch "$WHISPER_CPP_TAG" https://github.com/ggml-org/whisper.cpp.git "$BUILD_DIR" \
  --quiet

echo "Configuring (static backends, Metal on, BLAS off)..."
# GGML_NATIVE=OFF + explicit GGML_CPU_ARM_ARCH: without this, ggml auto-detects and compiles for
# THIS machine's exact CPU (e.g. every extension an M4 has, including sme/i8mm), which would
# crash with an illegal instruction on an M1/M2/M3 that doesn't support those extensions.
# armv8.5-a+dotprod is supported by every Apple Silicon chip since the M1.
# GGML_BLAS=OFF: avoids depending on a system BLAS library at all — ggml's own CPU backend
# (NEON/SIMD) is sufficient, one less external dependency to bundle.
cmake -B "$BUILD_DIR/build" -S "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DGGML_BLAS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_CPU_ARM_ARCH="armv8.5-a+dotprod" \
  -DWHISPER_BUILD_EXAMPLES=ON \
  >/dev/null

echo "Building whisper-cli (this takes a few minutes)..."
cmake --build "$BUILD_DIR/build" --config Release --target whisper-cli -j >/dev/null

cp "$BUILD_DIR/build/bin/whisper-cli" "$DEST/whisper-cli"
chmod +w "$DEST/whisper-cli"

echo "Bundling dylibs (portable binary)..."
dylibbundler -od -b \
  -x "$DEST/whisper-cli" \
  -d "$DEST/libs/" \
  -p @executable_path/libs/ \
  -s "$BUILD_DIR/build/bin" 2>&1 | grep -v "^$"

echo "Done. Verifying..."
if ! "$DEST/whisper-cli" --help >/dev/null 2>&1; then
  echo "✗ whisper-cli failed to run — check dylib bundling" >&2
  exit 1
fi
echo -n "$BUILD_PROVENANCE" > "$DEST/.build-provenance"
echo "✓ whisper-cli runs standalone (dylibs bundled correctly)"
