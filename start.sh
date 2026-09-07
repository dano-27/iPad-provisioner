#!/bin/bash

# ╔══════════════════════════════════════════════════════════════════╗
# ║  iPad Provisioner — Start                                        ║
# ║  Launches Appium + the web UI. One command to run everything.    ║
# ╚══════════════════════════════════════════════════════════════════╝

cd "$(dirname "$0")"

# Source nvm if available
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh" 2>/dev/null
fi

# Check node exists
if ! command -v node &>/dev/null; then
  echo ""
  echo "  ❌ Node.js not found. Run ./setup.sh first."
  echo ""
  exit 1
fi

# Check deps installed
if [[ ! -d "node_modules" ]]; then
  echo ""
  echo "  ⚠  Dependencies not installed. Running setup..."
  echo ""
  bash ./setup.sh
fi

# Ensure Xcode CLI path is set to full Xcode
if [[ -d "/Applications/Xcode.app" ]]; then
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer 2>/dev/null || true
fi

# ── Start Appium in the background ────────────────────────────
echo ""
echo "  📱 iPad Provisioner"
echo "  ─────────────────────────────"

APPIUM_PID=""
if command -v appium &>/dev/null; then
  echo "  → Starting Appium on port 4723..."
  appium --relaxed-security --log-no-colors > /tmp/appium.log 2>&1 &
  APPIUM_PID=$!
  sleep 2

  if kill -0 "$APPIUM_PID" 2>/dev/null; then
    echo "  ✅ Appium running (PID $APPIUM_PID, log: /tmp/appium.log)"
  else
    echo "  ❌ Appium failed to start. Check /tmp/appium.log"
    echo "     You can start it manually: appium --relaxed-security"
  fi
else
  echo "  ⚠  Appium not found — start it manually in another terminal:"
  echo "     appium --relaxed-security"
fi

echo ""

# ── Cleanup on exit ───────────────────────────────────────────
cleanup() {
  echo ""
  echo "  Shutting down..."
  if [[ -n "$APPIUM_PID" ]] && kill -0 "$APPIUM_PID" 2>/dev/null; then
    kill "$APPIUM_PID" 2>/dev/null
    echo "  ✅ Appium stopped"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Open browser ──────────────────────────────────────────────
(sleep 2 && open "http://localhost:3456" 2>/dev/null) &

# ── Start the provisioner server ──────────────────────────────
echo "  → Starting provisioner server on http://localhost:3456"
echo "  → Press Ctrl+C to stop everything"
echo ""
exec node server.mjs
