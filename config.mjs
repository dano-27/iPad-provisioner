// ─── Configuration ──────────────────────────────────────────────
// Edit these values for your environment before running.
// ─────────────────────────────────────────────────────────────────

export const CONFIG = {

  // ── Gemini API (powers the AI vision agent for app navigation) ──
  // Get your key: https://aistudio.google.com/app/apikey
  geminiApiKey: process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE',

  // ── WiFi ────────────────────────────────────────────────────────
  wifi: {
    ssid: 'YourNetworkName',
    password: 'YourNetworkPassword',
    security: 'WPA2',      // WPA2 | WPA3 | WEP | None
    hidden: false,
  },

  // ── SimpleMDM (optional — for eSIM-safe erase via MDM API) ────
  // If set, the tool can trigger an erase via SimpleMDM's API with
  // PreserveDataPlan=true instead of cfgutil erase (which can't
  // guarantee eSIM preservation).
  //
  // Get your API key: SimpleMDM → Settings → API → Secret Access Key
  simpleMDM: {
    apiKey: '',             // Leave empty to use local cfgutil erase
    baseUrl: 'https://a.simplemdm.com/api/v1',
  },

  // ── cfgutil paths ──────────────────────────────────────────────
  cfgutil: '/usr/local/bin/cfgutil',

  // ── Timing ─────────────────────────────────────────────────────
  // Seconds to wait after erase for device to reboot to Setup Assistant
  eraseRebootWaitSec: 45,

  // Seconds to wait after prepare for device to settle
  postPrepareWaitSec: 10,

  // ── Profiles directory ─────────────────────────────────────────
  profilesDir: './profiles',

  // ── Logging ────────────────────────────────────────────────────
  logDir: './logs',

  // ── Square POS (for device code entry) ─────────────────────────
  squareBundleId: 'com.squareup.square',
  appiumPort: 4723,

  // How many iPads to process simultaneously via Appium.
  // Each session uses ~200MB RAM + CPU. For a Mac with 16GB RAM,
  // 5 is safe. For 32GB+ or Apple Silicon, try 8-10.
  appiumConcurrency: 5,

  // ── pymobiledevice3 (for Developer Mode auto-enable) ────────
  // pip3 install pymobiledevice3
  pymobiledevice3: '/Library/Frameworks/Python.framework/Versions/3.12/bin/pymobiledevice3',
};
