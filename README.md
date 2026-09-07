# 📱 iPad Provisioner

Batch-provision iPads for Square POS with one click. Connects via USB, launches Square POS, signs in with device codes automatically using AI vision — handles up to 90 iPads in concurrent batches.

## Quick Start (new Mac)

```bash
# 1. Clone or copy this folder to the new Mac
# 2. Run setup (installs Node.js, Appium, XCUITest driver, npm deps)
chmod +x setup.sh start.sh
./setup.sh

# 3. Configure
#    Edit config.mjs — set your Gemini API key and WiFi credentials
#    Or set the GEMINI_API_KEY environment variable

# 4. Run
./start.sh
#    → Opens http://localhost:3456 automatically
```

## Prerequisites

| Requirement | Purpose | Install |
|------------|---------|---------|
| **macOS** | Required OS | — |
| **Xcode** (full app) | WDA signing & deployment | Mac App Store |
| **Apple Configurator 2** | `cfgutil` for device detection | Mac App Store → Install Automation Tools |
| **Node.js** ≥ 18 | Runtime | Auto-installed by `setup.sh` via nvm |
| **Appium** + **XCUITest driver** | UI automation on iPads | Auto-installed by `setup.sh` |
| **Gemini API key** | AI vision for app navigation | [aistudio.google.com](https://aistudio.google.com/app/apikey) |

## iPad Requirements

Each iPad needs:
1. **No passcode** during provisioning (for fully automated Developer Mode + UI Automation)
2. **Square POS** app installed (via MDM or App Store)
3. Connected via **USB** to the Mac

> **Zero-touch flow:** If iPads have no passcode, Developer Mode is auto-enabled via `pymobiledevice3`. MDM can push a passcode policy *after* provisioning completes.
>
> **If a passcode is set:** Developer Mode and UI Automation must be enabled manually on each iPad before running. The provisioner will detect this and show instructions.

## Performance

Benchmarked on iPad 8th Gen (iPadOS 26.5):

| Scenario | Time per iPad | 90 iPads (5 concurrent) |
|----------|--------------|------------------------|
| **First run** (Developer Mode + WDA deploy + sign-in) | ~2 min 20 sec | ~42 min |
| **Re-provision** (Developer Mode already on) | ~1 min 30 sec | ~27 min |

Breakdown of a first run:
- Pre-flight (passcode + Developer Mode check): ~10s
- WDA fresh deploy (`useNewWDA`): ~30-45s
- Square POS launch: ~3s
- Sign-in flow (element finding + typing): ~20s
- Verification (AI vision): ~5s
- Pauses and waits: ~30s

## Configuration

Edit `config.mjs`:

```javascript
export const CONFIG = {
  geminiApiKey: 'your-key-here',     // or set GEMINI_API_KEY env var
  wifi: {
    ssid: 'YourNetwork',
    password: 'YourPassword',
  },
  squareBundleId: 'com.squareup.square',
  appiumPort: 4723,
  appiumConcurrency: 5,              // iPads processed simultaneously
};
```

## CSV Format

Upload a CSV with device codes. Supported columns:

```csv
serial,device_code
DMPXXXXXX,ygsy-mbvx-ey8q
```

Or use ECID instead of serial:

```csv
ecid,device_code
0x934901A41402E,ygsy-mbvx-ey8q
```

## How It Works

1. Detects connected iPads via `cfgutil list`
2. Matches each iPad to its device code from the CSV
3. For each iPad (in batches of 5):
   - Connects via Appium → WebDriverAgent
   - Launches Square POS
   - Taps "Sign in" → "Use device code" (native element finding)
   - Types the device code character-by-character
   - Taps "Sign in" to complete
   - Verifies success via AI vision

## File Structure

```
ipad-provisioner/
├── setup.sh            # One-time setup script
├── start.sh            # Launch everything (Appium + server)
├── server.mjs          # Web UI server + Square sign-in flow
├── vision-agent.mjs    # Gemini AI vision agent
├── device-actions.mjs  # Device detection via cfgutil
├── config.mjs          # Configuration (edit this!)
├── public/
│   └── index.html      # Web UI
├── package.json
├── .env.example        # Environment variable template
└── .gitignore
```

## Troubleshooting

### "Not authorized for performing UI testing actions"
→ On the iPad: Settings → Developer → Enable UI Automation → toggle OFF, wait 3s, toggle ON

### "Tunnel registry port not found"
→ Warning only, does not block functionality. Appium falls back to usbmux.

### Characters dropped when typing device code
→ Already fixed: types character-by-character with 100ms delays.

### Appium can't find the device
→ Ensure the iPad is connected via USB, unlocked, and you've tapped "Trust" on the trust dialog.

## Moving to Another Mac

1. Copy the entire `ipad-provisioner/` folder (excluding `node_modules/`)
2. Run `./setup.sh` on the new Mac
3. Edit `config.mjs` with the new environment's settings
4. Run `./start.sh`
