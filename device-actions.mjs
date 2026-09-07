import { execSync, execFileSync } from 'child_process';
import { CONFIG } from './config.mjs';

const CFG = CONFIG.cfgutil;

// ─── Device Discovery ──────────────────────────────────────────

/**
 * Returns an array of connected devices:
 * [{ ecid, udid, name, model, iosVersion, serial }]
 */
export function listDevices() {
  try {
    const raw = execSync(`${CFG} list`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();

    if (!raw) return [];

    const devices = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      // cfgutil list output format:
      // Type: iPad11,7  ECID: 0x934901A41402E  UDID: 00008020-000934901A41402E Location: 0x2100000 Name: OR1234 (01)
      const ecidMatch = line.match(/ECID:\s*(0x[\dA-Fa-f]+)/i);
      if (!ecidMatch) continue;

      const ecid = ecidMatch[1];
      const udidMatch = line.match(/UDID:\s*(\S+)/i);
      const nameMatch = line.match(/Name:\s*(.+?)(?:\s*$)/i);
      const typeMatch = line.match(/Type:\s*(\S+)/i);

      // Serial requires a separate cfgutil get call
      let serial = '';
      try {
        serial = execSync(`${CFG} --ecid ${ecid} get serialNumber`, {
          encoding: 'utf8', timeout: 5000,
        }).trim();
      } catch {}

      devices.push({
        ecid,
        udid: udidMatch ? udidMatch[1] : '',
        name: nameMatch ? nameMatch[1].trim() : 'Unknown iPad',
        model: typeMatch ? typeMatch[1] : '',
        serial,
        raw: line.trim(),
      });
    }
    return devices;
  } catch (err) {
    if (err.message?.includes('ENOENT') || err.message?.includes('not found')) {
      throw new Error(
        `cfgutil not found at "${CFG}". Install Apple Configurator 2 from the ` +
        `Mac App Store, then: Menu → Install Automation Tools.`
      );
    }
    return [];
  }
}

// ─── Device Actions ────────────────────────────────────────────

/**
 * Erase a device via cfgutil.
 * NOTE: cfgutil erase does NOT have a --preserve-esim flag.
 * The eSIM is generally preserved on a standard "Erase All Content & Settings"
 * (which is what cfgutil erase does), but this is not guaranteed by Apple.
 *
 * For guaranteed eSIM preservation, use eraseViaSimpleMDM() instead.
 */
export function eraseDevice(ecid) {
  execSync(`${CFG} --ecid ${ecid} erase`, {
    encoding: 'utf8',
    timeout: 120000,
    stdio: 'pipe',
  });
}

/**
 * Erase a device via SimpleMDM API with PreserveDataPlan=true.
 * This is the safest way to preserve the eSIM during a wipe.
 *
 * Requires: CONFIG.simpleMDM.apiKey and the SimpleMDM device ID.
 */
export async function eraseViaSimpleMDM(simpleMdmDeviceId) {
  const { apiKey, baseUrl } = CONFIG.simpleMDM;
  if (!apiKey) {
    throw new Error('SimpleMDM API key not configured in config.mjs');
  }

  const url = `${baseUrl}/devices/${simpleMdmDeviceId}/wipe`;
  const auth = Buffer.from(`${apiKey}:`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    // SimpleMDM passes this through as PreserveDataPlan in the
    // Apple MDM EraseDevice command
    body: JSON.stringify({ preserve_data_plan: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SimpleMDM wipe failed (${res.status}): ${body}`);
  }
}

/**
 * Prepare a device: supervise + skip all setup assistant panes.
 * Uses --dep so the device picks up its SimpleMDM enrollment profile
 * from Apple Business Manager.
 */
export function prepareDevice(ecid) {
  // Build the skip flags. cfgutil help prepare shows the full list;
  // these cover everything through iPadOS 18.
  const skipFlags = [
    '--skip-language',
    '--skip-region',
    '--skip-appleid',
    '--skip-applepay',
    '--skip-diagnostics',
    '--skip-display-tone',
    '--skip-home-button-sensitivity',
    '--skip-imessage-and-facetime',
    '--skip-passcode',
    '--skip-privacy',
    '--skip-restore',
    '--skip-screentime',
    '--skip-siri',
    '--skip-tos',
    '--skip-touch-id',
    '--skip-appearance',
    '--skip-watch-migration',
    '--skip-android',
  ];

  const args = [
    '--ecid', ecid,
    'prepare',
    '--dep',
    '--language', 'en',
    '--locale', 'en_US',
    ...skipFlags,
  ];

  execFileSync(CFG, args, {
    encoding: 'utf8',
    timeout: 180000,
    stdio: 'pipe',
  });
}

/**
 * Install a .mobileconfig profile on the device over USB.
 */
export function installProfile(ecid, profilePath) {
  execSync(`${CFG} --ecid ${ecid} install-profile "${profilePath}"`, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: 'pipe',
  });
}

/**
 * Pair/trust the device with this Mac.
 */
export function pairDevice(ecid) {
  try {
    execSync(`${CFG} --ecid ${ecid} pair`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch {
    // Pairing may already be established, not fatal
  }
}
