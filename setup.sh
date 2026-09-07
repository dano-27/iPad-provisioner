#!/bin/bash
set -euo pipefail

# ╔══════════════════════════════════════════════════════════════════╗
# ║  iPad Provisioner — One-Time Setup                               ║
# ║  Run this once on each new Mac to install everything needed.     ║
# ╚══════════════════════════════════════════════════════════════════╝

echo ""
echo "  📱 iPad Provisioner — Setup"
echo "  ─────────────────────────────"
echo ""

cd "$(dirname "$0")"
ERRORS=0
WARNINGS=0

# ── Check: macOS ───────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "  ❌ This tool only runs on macOS."
  exit 1
fi
echo "  ✅ macOS $(sw_vers -productVersion) detected"

# ── Check: Xcode ──────────────────────────────────────────────
if xcode-select -p &>/dev/null; then
  XCODE_PATH=$(xcode-select -p)
  echo "  ✅ Xcode tools: $XCODE_PATH"
  if [[ "$XCODE_PATH" != *"Xcode.app"* ]]; then
    echo "  ⚠  Full Xcode.app is recommended for WDA signing."
    echo "     Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    WARNINGS=$((WARNINGS + 1))
  fi
else
  echo "  ❌ Xcode not installed. Install from the Mac App Store."
  echo "     Then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  ERRORS=$((ERRORS + 1))
fi

# ── Check: Apple Configurator 2 / cfgutil ─────────────────────
CFGUTIL=""
for p in "$(command -v cfgutil 2>/dev/null)" "/usr/local/bin/cfgutil"; do
  if [[ -n "$p" && -x "$p" ]]; then CFGUTIL="$p"; break; fi
done

if [[ -n "$CFGUTIL" ]]; then
  echo "  ✅ cfgutil: $CFGUTIL"
else
  echo "  ⚠  cfgutil not found (needed for device listing/erase)."
  echo "     Install Apple Configurator 2 → Menu → Install Automation Tools..."
  WARNINGS=$((WARNINGS + 1))
fi

# ── Check / Install: Node.js ──────────────────────────────────
NODE_CMD=""
if command -v node &>/dev/null; then
  NODE_CMD="node"
  echo "  ✅ Node.js: $(node --version)"
elif [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  if command -v node &>/dev/null; then
    NODE_CMD="node"
    echo "  ✅ Node.js (nvm): $(node --version)"
  fi
fi

if [[ -z "$NODE_CMD" ]]; then
  echo "  → Installing Node.js via nvm..."
  if [[ ! -f "$HOME/.nvm/nvm.sh" ]]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm install --lts && nvm use --lts
  if command -v node &>/dev/null; then
    NODE_CMD="node"
    echo "  ✅ Node.js installed: $(node --version)"
  else
    echo "  ❌ Failed to install Node.js"; ERRORS=$((ERRORS + 1))
  fi
fi

# ── npm dependencies ──────────────────────────────────────────
if [[ -n "$NODE_CMD" ]]; then
  echo "  → Installing npm dependencies..."
  npm install --production 2>&1 | tail -1
  echo "  ✅ npm dependencies installed"
fi

# ── Appium ────────────────────────────────────────────────────
# Source nvm in case appium was installed globally via nvm's npm
[[ -f "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh" 2>/dev/null

if command -v appium &>/dev/null; then
  echo "  ✅ Appium: v$(appium --version 2>/dev/null || echo '?')"
else
  echo "  → Installing Appium globally..."
  npm install -g appium
  if command -v appium &>/dev/null; then
    echo "  ✅ Appium installed: v$(appium --version)"
  else
    echo "  ❌ Failed to install Appium"; ERRORS=$((ERRORS + 1))
  fi
fi

# ── XCUITest driver ──────────────────────────────────────────
if appium driver list --installed 2>/dev/null | grep -q "xcuitest"; then
  echo "  ✅ Appium XCUITest driver installed"
else
  echo "  → Installing XCUITest driver..."
  appium driver install xcuitest 2>&1 | tail -3
  echo "  ✅ XCUITest driver installed"
fi

# ── Config check ─────────────────────────────────────────────
echo ""
if grep -q "YOUR_GEMINI_API_KEY_HERE" config.mjs 2>/dev/null; then
  echo "  ⚠  Gemini API key not set in config.mjs"
  echo "     Get one at: https://aistudio.google.com/app/apikey"
  WARNINGS=$((WARNINGS + 1))
else
  echo "  ✅ config.mjs looks configured"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "  ─────────────────────────────"
if [[ $ERRORS -gt 0 ]]; then
  echo "  ❌ Setup incomplete — fix $ERRORS error(s) above and re-run."
  exit 1
elif [[ $WARNINGS -gt 0 ]]; then
  echo "  ⚠  Setup done with $WARNINGS warning(s). Review above."
else
  echo "  ✅ Setup complete!"
fi
echo ""
echo "  Next steps:"
echo "    1. Edit config.mjs — set Gemini API key & WiFi credentials"
echo "    2. On each iPad: Settings → Developer → Enable UI Automation = ON"
echo "    3. Run:  ./start.sh"
echo "    4. Open: http://localhost:3456"
echo ""
