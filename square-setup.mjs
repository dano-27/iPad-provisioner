#!/usr/bin/env node

// ╔══════════════════════════════════════════════════════════════════╗
// ║  Square POS Device Code Entry — Appium + XCUITest                ║
// ║                                                                  ║
// ║  Reads a CSV of serial numbers + device codes, matches them to   ║
// ║  connected iPads, opens Square POS, and enters each device code. ║
// ╚══════════════════════════════════════════════════════════════════╝

import { remote } from 'webdriverio';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ─── Configuration ────────────────────────────────────────────

const APPIUM_HOST = 'localhost';
const APPIUM_PORT = 4723;

// Square POS bundle ID — this is the standard identifier.
// If it doesn't launch, use Appium Inspector to find the correct one,
// or run on the iPad: cfgutil --ecid <ECID> get bundleIDs
const SQUARE_BUNDLE_ID = 'com.squareup.square';

// Path to your CSV file
const CSV_PATH = process.argv[2] || './device-codes.csv';

// How long to wait for UI elements (ms)
const ELEMENT_TIMEOUT = 15000;

// ─── CSV Parsing ──────────────────────────────────────────────

/**
 * Reads a CSV file with columns: serial, device_code
 *
 * Expected format:
 *   serial,device_code
 *   DMXXXXXXXXXXX,ABC-DEF-1234
 *   FMYYYYYYYYYYYY,GHI-JKL-5678
 */
function readDeviceCodes(csvPath) {
  const raw = readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split('\n');
  const header = lines[0].toLowerCase();

  // Find column indices
  const cols = header.split(',').map((c) => c.trim());
  const serialIdx = cols.findIndex((c) =>
    c === 'serial' || c === 'serial_number' || c === 'serialnumber'
  );
  const codeIdx = cols.findIndex((c) =>
    c === 'device_code' || c === 'devicecode' || c === 'code'
  );

  if (serialIdx === -1 || codeIdx === -1) {
    throw new Error(
      `CSV must have "serial" and "device_code" columns.\n` +
      `Found columns: ${cols.join(', ')}`
    );
  }

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',').map((c) => c.trim());
    entries.push({
      serial: parts[serialIdx],
      deviceCode: parts[codeIdx],
    });
  }

  return entries;
}

// ─── Device Discovery ─────────────────────────────────────────

/**
 * Lists connected iPads via cfgutil and returns serial → UDID mapping.
 */
function getConnectedDevices() {
  const cfgutil = '/usr/local/bin/cfgutil';
  const devices = [];

  try {
    const raw = execSync(`${cfgutil} list`, { encoding: 'utf8' }).trim();
    for (const line of raw.split('\n').filter(Boolean)) {
      const ecidMatch = line.match(/ECID:\s*(0x[\dA-Fa-f]+)/i);
      if (!ecidMatch) continue;

      const ecid = ecidMatch[1];
      const getVal = (key) => {
        try {
          return execSync(`${cfgutil} --ecid ${ecid} get ${key}`, {
            encoding: 'utf8', timeout: 5000,
          }).trim();
        } catch { return ''; }
      };

      devices.push({
        ecid,
        serial: getVal('serialNumber'),
        udid: getVal('UDID'),
        name: getVal('deviceName') || 'iPad',
      });
    }
  } catch (err) {
    console.error('Failed to list devices via cfgutil:', err.message);
  }

  return devices;
}

// ─── Appium Session ───────────────────────────────────────────

async function createSession(udid) {
  const browser = await remote({
    hostname: APPIUM_HOST,
    port: APPIUM_PORT,
    path: '/',
    capabilities: {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': udid,
      'appium:bundleId': SQUARE_BUNDLE_ID,

      // Don't reset the app between sessions
      'appium:noReset': true,

      // Wait for the app to be idle before interacting
      'appium:waitForIdleTimeout': 5,

      // Increase the new command timeout for slow networks
      'appium:newCommandTimeout': 120,
    },
  });

  return browser;
}

// ─── Square POS Interaction ───────────────────────────────────
//
// IMPORTANT: The selectors below are educated guesses based on
// typical Square POS UI structure. You MUST verify them using
// Appium Inspector (see instructions at the bottom of this file).
//
// The flow for Square device code sign-in is typically:
//   1. App opens → Sign In screen (or "Get Started")
//   2. Choose "Sign in with device code" (or "Use a device code")
//   3. Enter the device code in the text field
//   4. Tap "Sign In" / "Submit"

async function enterDeviceCode(browser, deviceCode, label) {
  console.log(`  [${label}] Launching Square POS...`);

  // Wait for the app to load
  await browser.pause(3000);

  // ── Step 1: Look for "Sign In" or "Use a device code" button ──
  //
  // Try multiple selector strategies — Square may use accessibility
  // IDs, labels, or you may need XPath. Uncomment the one that works.

  console.log(`  [${label}] Looking for sign-in / device code option...`);

  // Strategy A: By accessibility ID (best — stable)
  // const signInBtn = await browser.$('~Sign In');
  // const signInBtn = await browser.$('~Use a device code');

  // Strategy B: By button label text (common)
  // const signInBtn = await browser.$('-ios predicate string:label == "Sign In"');

  // Strategy C: By partial text match (flexible)
  // const signInBtn = await browser.$('-ios predicate string:label CONTAINS "device code"');

  // Strategy D: By XPath (last resort — slowest)
  // const signInBtn = await browser.$('//XCUIElementTypeButton[@name="Sign In"]');

  // ── For now, use a flexible predicate that matches common labels ──
  const deviceCodeBtn = await browser.$(
    '-ios predicate string:label CONTAINS[c] "device code" OR label CONTAINS[c] "Device Code"'
  );

  if (await deviceCodeBtn.isExisting()) {
    await deviceCodeBtn.waitForDisplayed({ timeout: ELEMENT_TIMEOUT });
    await deviceCodeBtn.click();
    console.log(`  [${label}] Tapped "device code" option`);
    await browser.pause(1500);
  } else {
    console.log(`  [${label}] No "device code" button found — may already be on the input screen`);
  }

  // ── Step 2: Find the device code input field ──────────────
  console.log(`  [${label}] Looking for device code input field...`);

  // Try finding a text field — Square typically has one input field
  // on the device code screen
  let inputField = await browser.$('-ios class chain:**/XCUIElementTypeTextField');

  // If no TextField, try SecureTextField (in case it's masked)
  if (!(await inputField.isExisting())) {
    inputField = await browser.$('-ios class chain:**/XCUIElementTypeSecureTextField');
  }

  // Fallback: any text input
  if (!(await inputField.isExisting())) {
    inputField = await browser.$('//XCUIElementTypeTextField | //XCUIElementTypeSecureTextField');
  }

  await inputField.waitForDisplayed({ timeout: ELEMENT_TIMEOUT });
  await inputField.click();
  await browser.pause(500);

  // Clear any existing text and type the device code
  await inputField.clearValue();
  await inputField.setValue(deviceCode);
  console.log(`  [${label}] Entered device code: ${deviceCode}`);

  // ── Step 3: Submit ────────────────────────────────────────
  console.log(`  [${label}] Submitting...`);

  // Try finding a submit/sign-in button
  const submitBtn = await browser.$(
    '-ios predicate string:label CONTAINS[c] "sign in" OR label CONTAINS[c] "submit" OR label CONTAINS[c] "continue"'
  );

  if (await submitBtn.isExisting()) {
    await submitBtn.waitForDisplayed({ timeout: ELEMENT_TIMEOUT });
    await submitBtn.click();
    console.log(`  [${label}] Tapped submit button`);
  } else {
    // Fallback: press Return/Enter on the keyboard
    console.log(`  [${label}] No submit button found — pressing Return key`);
    await browser.keys('\n');
  }

  // Wait a moment for the app to process
  await browser.pause(3000);
  console.log(`  [${label}] ✅ Device code entry complete`);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  📱 Square POS — Device Code Entry');
  console.log('  ──────────────────────────────────');
  console.log('');

  // Read CSV
  console.log(`  Reading CSV: ${CSV_PATH}`);
  let csvEntries;
  try {
    csvEntries = readDeviceCodes(CSV_PATH);
  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }
  console.log(`  Found ${csvEntries.length} entries in CSV\n`);

  // Get connected devices
  console.log('  Scanning connected iPads...');
  const connectedDevices = getConnectedDevices();
  console.log(`  Found ${connectedDevices.length} device(s) connected\n`);

  if (connectedDevices.length === 0) {
    console.error('  ❌ No iPads connected via USB');
    process.exit(1);
  }

  // Match CSV entries to connected devices by serial number
  const matched = [];
  const unmatched = [];

  for (const entry of csvEntries) {
    const device = connectedDevices.find(
      (d) => d.serial.toLowerCase() === entry.serial.toLowerCase()
    );
    if (device) {
      matched.push({ ...entry, ...device });
    } else {
      unmatched.push(entry);
    }
  }

  console.log(`  Matched: ${matched.length} device(s)`);
  if (unmatched.length > 0) {
    console.log(`  ⚠  Unmatched (not connected): ${unmatched.length}`);
    for (const u of unmatched) {
      console.log(`     - Serial: ${u.serial}`);
    }
  }
  console.log('');

  if (matched.length === 0) {
    console.error('  ❌ No CSV entries match connected devices');
    process.exit(1);
  }

  // Process each matched device
  let success = 0;
  let fail = 0;

  for (const device of matched) {
    const label = `${device.name} (${device.serial})`;
    console.log(`\n  ─── ${label} ───`);

    let browser;
    try {
      console.log(`  [${label}] Connecting via Appium (UDID: ${device.udid})...`);
      browser = await createSession(device.udid);

      await enterDeviceCode(browser, device.deviceCode, label);
      success++;
    } catch (err) {
      console.error(`  [${label}] ❌ Failed: ${err.message}`);
      fail++;
    } finally {
      if (browser) {
        try { await browser.deleteSession(); } catch {}
      }
    }
  }

  // Summary
  console.log('\n  ══════════════════════════════════');
  console.log(`  ✅ Succeeded: ${success}`);
  if (fail > 0) console.log(`  ❌ Failed:    ${fail}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}\n`);
  process.exit(1);
});

// ─── HOW TO FIND THE CORRECT SELECTORS ────────────────────────
//
// The selectors in enterDeviceCode() are best-effort guesses.
// To find the real ones for YOUR version of Square POS:
//
// 1. Install Appium Inspector:
//    https://github.com/appium/appium-inspector/releases
//
// 2. Start Appium:
//    appium --relaxed-security
//
// 3. In Appium Inspector, connect with these capabilities:
//    {
//      "platformName": "iOS",
//      "appium:automationName": "XCUITest",
//      "appium:udid": "<YOUR_IPAD_UDID>",
//      "appium:bundleId": "com.squareup.square",
//      "appium:noReset": true
//    }
//
// 4. Once connected, you'll see a live screenshot of the iPad.
//    Click on any element to see its properties:
//      - accessibility-id  → use with:  $('~the-id')
//      - label             → use with:  $('-ios predicate string:label == "the label"')
//      - type + name       → use with:  $('//XCUIElementTypeButton[@name="the name"]')
//
// 5. Navigate through the sign-in flow manually on the iPad
//    and note the selector for each element:
//      a. The "Use a device code" button
//      b. The device code text input field
//      c. The "Sign In" / "Submit" button
//
// 6. Update the selectors in enterDeviceCode() above.
//
// ──────────────────────────────────────────────────────────────
