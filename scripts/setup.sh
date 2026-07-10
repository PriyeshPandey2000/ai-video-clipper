#!/bin/bash
# Full dev environment bootstrap for Clipper.
# Run once after cloning: bash scripts/setup.sh
set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}!${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; exit 1; }
step() { echo -e "\n${BOLD}→ $1${RESET}"; }

echo -e "${BOLD}Clipper — dev setup${RESET}"
echo "─────────────────────────────────────"

# ── 1. Check OS ───────────────────────────────────────────────────────────────
step "Checking platform"
if [[ "$(uname)" != "Darwin" ]]; then
  warn "This script is macOS-only. Windows/Linux support coming in Phase 8."
  warn "You can still install dependencies manually (see README)."
fi
ok "macOS detected"

# ── 2. Homebrew ───────────────────────────────────────────────────────────────
step "Homebrew"
if ! command -v brew &>/dev/null; then
  fail "Homebrew not found. Install from https://brew.sh then re-run."
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

# ── 3. Node.js ────────────────────────────────────────────────────────────────
step "Node.js"
if ! command -v node &>/dev/null; then
  echo "Installing Node.js via Homebrew..."
  brew install node
fi
NODE_VER=$(node --version)
MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [ "$MAJOR" -lt 20 ]; then
  fail "Node.js $NODE_VER detected — v20+ required. Run: brew upgrade node"
fi
ok "Node.js $NODE_VER"

# ── 4. pnpm ───────────────────────────────────────────────────────────────────
step "pnpm"
if ! command -v pnpm &>/dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi
ok "pnpm $(pnpm --version)"

# ── 5. Dependencies ───────────────────────────────────────────────────────────
step "Installing packages"
pnpm install
ok "packages installed"

# ── 6. FFmpeg bundle ──────────────────────────────────────────────────────────
step "FFmpeg bundle"
if [ -f "resources/ffmpeg/ffmpeg" ]; then
  ok "Bundled FFmpeg already present — skipping"
else
  echo "Running FFmpeg setup (this may take a few minutes)..."
  bash scripts/setup-ffmpeg.sh
fi

# ── 7. .env check ─────────────────────────────────────────────────────────────
step ".env file"
if [ ! -f ".env" ]; then
  warn ".env not found — creating from template"
  cat > .env << 'EOF'
# Groq API key — required for AI clip suggestions and social captions
# Get yours free at https://console.groq.com
GROQ_API_KEY=
EOF
  warn "Add your GROQ_API_KEY to .env before running the AI pipeline"
else
  if grep -q "GROQ_API_KEY=$" .env 2>/dev/null || ! grep -q "GROQ_API_KEY" .env 2>/dev/null; then
    warn "GROQ_API_KEY not set in .env — AI features won't work without it"
  else
    ok ".env present with GROQ_API_KEY"
  fi
fi

# ── 8. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}─────────────────────────────────────${RESET}"
echo -e "${GREEN}${BOLD}All done! Start the app:${RESET}"
echo ""
echo "  pnpm dev"
echo ""
