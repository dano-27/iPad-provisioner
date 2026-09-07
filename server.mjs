#!/usr/bin/env node

// Load .env file if present (no external dependency needed)
import { readFileSync } from 'fs';
try {
  const envFile = readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* no .env file, that's fine */ }

// ╔══════════════════════════════════════════════════════════════════╗
// ║  iPad Provisioner — Web UI Server                                ║
// ║  Provisioning + Square POS setup in one dashboard.               ║
// ╚══════════════════════════════════════════════════════════════════╝

import http from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

import { CONFIG } from './config.mjs';
import {
  listDevices,
  eraseDevice,
  eraseViaSimpleMDM,
  prepareDevice,
  installProfile,
  pairDevice,
} from './device-actions.mjs';
import { generateWifiProfile } from './wifi-profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

// ─── Event bus for SSE progress updates ───────────────────────

const events = new EventEmitter();
events.setMaxListeners(50);

const jobs = new Map();

function emit(type, data) {
  events.emit('progress', JSON.stringify({ type, ...data, ts: Date.now() }));
}

function sleep(sec) {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

// ─── Provisioning logic ───────────────────────────────────────

const STEPS_PROVISION = [
  { id: 'wifi-gen',  label: 'Generate WiFi profile' },
  { id: 'pair',      label: 'Pair device' },
  { id: 'wifi-push', label: 'Push WiFi profile' },
  { id: 'prepare',   label: 'Skip setup panes + DEP enrollment' },
  { id: 'settle',    label: 'Waiting for device to settle' },
];

const STEPS_FULL = [
  { id: 'wifi-gen',  label: 'Generate WiFi profile' },
  { id: 'erase',     label: 'Factory erase (preserve eSIM)' },
  { id: 'reboot',    label: 'Waiting for reboot' },
  { id: 'pair',      label: 'Pair device' },
  { id: 'wifi-push', label: 'Push WiFi profile' },
  { id: 'prepare',   label: 'Skip setup panes + DEP enrollment' },
  { id: 'settle',    label: 'Waiting for device to settle' },
];

async function runProvision(device, mode, eraseMethod, simpleMdmId) {
  const { ecid } = device;
  const doErase = mode === 'full-reset';
  const steps = doErase ? [...STEPS_FULL] : [...STEPS_PROVISION];

  jobs.set(ecid, { status: 'running', steps, currentStep: null, error: null });
  emit('job-start', { ecid, steps, mode });

  const setStep = (stepId, state, detail) => {
    const job = jobs.get(ecid);
    if (job) job.currentStep = stepId;
    emit('step', { ecid, stepId, state, detail });
  };

  try {
    setStep('wifi-gen', 'running');
    const wifiProfilePath = generateWifiProfile();
    setStep('wifi-gen', 'done', wifiProfilePath);

    if (doErase) {
      setStep('erase', 'running');
      if (eraseMethod === 'simplemdm' && simpleMdmId) {
        await eraseViaSimpleMDM(simpleMdmId);
        setStep('erase', 'done', 'Erased via SimpleMDM (eSIM preserved)');
      } else {
        eraseDevice(ecid);
        setStep('erase', 'done', 'Erased via cfgutil');
      }
      setStep('reboot', 'running');
      const total = CONFIG.eraseRebootWaitSec;
      for (let i = total; i > 0; i--) {
        emit('countdown', { ecid, stepId: 'reboot', remaining: i, total });
        await sleep(1);
      }
      setStep('reboot', 'done');
    }

    setStep('pair', 'running');
    try { pairDevice(ecid); setStep('pair', 'done'); }
    catch (err) { setStep('pair', 'warn', err.message); }

    setStep('wifi-push', 'running');
    try {
      installProfile(ecid, wifiProfilePath);
      setStep('wifi-push', 'done', `SSID: ${CONFIG.wifi.ssid}`);
    } catch (err) { setStep('wifi-push', 'warn', err.message); }

    setStep('prepare', 'running');
    prepareDevice(ecid);
    setStep('prepare', 'done');

    setStep('settle', 'running');
    const settleTotal = CONFIG.postPrepareWaitSec;
    for (let i = settleTotal; i > 0; i--) {
      emit('countdown', { ecid, stepId: 'settle', remaining: i, total: settleTotal });
      await sleep(1);
    }
    setStep('settle', 'done');

    jobs.set(ecid, { ...jobs.get(ecid), status: 'done' });
    emit('job-done', { ecid });
  } catch (err) {
    const job = jobs.get(ecid);
    if (job) {
      job.status = 'error'; job.error = err.message;
      if (job.currentStep) setStep(job.currentStep, 'error', err.message);
    }
    emit('job-error', { ecid, error: err.message });
  }
}

// ─── Square POS logic (Gemini Vision powered) ────────────────

const SQUARE_BUNDLE_ID = CONFIG.squareBundleId || 'com.squareup.square';
const APPIUM_PORT_NUM = CONFIG.appiumPort || 4723;

const STEPS_SQUARE = [
  { id: 'sq-devmode', label: 'Check Developer Mode' },
  { id: 'sq-connect', label: 'Connect to device via Appium' },
  { id: 'sq-launch',  label: 'Launch Square POS' },
  { id: 'sq-ai',      label: 'AI navigating Square POS...' },
];

// Path to pymobiledevice3 — auto-detected or configured
const PYMOBILE = CONFIG.pymobiledevice3 || '/Library/Frameworks/Python.framework/Versions/3.12/bin/pymobiledevice3';

async function runSquareSetup(device, deviceCode) {
  const { ecid, udid, name, serial } = device;
  const steps = [...STEPS_SQUARE];

  jobs.set(ecid, { status: 'running', steps, currentStep: null, error: null });
  emit('job-start', { ecid, steps, mode: 'square-setup' });

  const setStep = (stepId, state, detail) => {
    const job = jobs.get(ecid);
    if (job) job.currentStep = stepId;
    emit('step', { ecid, stepId, state, detail });
  };

  let browser;
  try {
    // ── Check Developer Mode ─────────────────────────────────
    setStep('sq-devmode', 'running', 'Checking Developer Mode...');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    let devModeEnabled = false;
    try {
      const { stdout } = await execFileAsync(PYMOBILE, [
        'amfi', 'developer-mode-status', '--udid', udid,
      ], { timeout: 10000 });
      devModeEnabled = stdout.trim().toLowerCase() === 'true';
    } catch (e) {
      console.log(`[DevMode] Status check failed for ${udid}: ${e.message}`);
    }

    if (devModeEnabled) {
      setStep('sq-devmode', 'done', 'Developer Mode is ON');
      console.log(`[DevMode] ${udid}: Developer Mode already enabled ✓`);
    } else {
      // Try to enable Developer Mode automatically
      setStep('sq-devmode', 'running', 'Enabling Developer Mode...');
      console.log(`[DevMode] ${udid}: Developer Mode is OFF — attempting to enable...`);

      try {
        await execFileAsync(PYMOBILE, [
          'amfi', 'enable-developer-mode', '--udid', udid,
        ], { timeout: 60000 });

        // Wait for device to reboot and come back
        setStep('sq-devmode', 'running', 'Device rebooting — waiting...');
        console.log(`[DevMode] ${udid}: Enable command sent, waiting for reboot...`);

        // Wait up to 90 seconds for the device to come back
        let rebooted = false;
        for (let i = 0; i < 18; i++) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const { stdout } = await execFileAsync(PYMOBILE, [
              'amfi', 'developer-mode-status', '--udid', udid,
            ], { timeout: 10000 });
            if (stdout.trim().toLowerCase() === 'true') {
              rebooted = true;
              break;
            }
          } catch { /* device still rebooting */ }
        }

        if (rebooted) {
          setStep('sq-devmode', 'done', 'Developer Mode enabled ✓');
          console.log(`[DevMode] ${udid}: Developer Mode enabled successfully`);
        } else {
          setStep('sq-devmode', 'error', 'Developer Mode could not be enabled — enable manually on the iPad');
          throw new Error(
            'Developer Mode could not be auto-enabled. ' +
            'On the iPad: Settings → Privacy & Security → Developer Mode → ON. ' +
            'Also enable: Settings → Developer → Enable UI Automation.'
          );
        }
      } catch (enableErr) {
        if (enableErr.message.includes('Developer Mode could not be auto-enabled')) throw enableErr;
        // pymobiledevice3 may fail if passcode is set
        console.log(`[DevMode] ${udid}: Auto-enable failed: ${enableErr.message}`);
        setStep('sq-devmode', 'error', 'Enable Developer Mode manually on iPad');
        throw new Error(
          'Developer Mode is OFF and could not be auto-enabled (device may have a passcode). ' +
          'On the iPad: Settings → Privacy & Security → Developer Mode → ON. ' +
          'Also enable: Settings → Developer → Enable UI Automation.'
        );
      }
    }

    // ── Connect via Appium ────────────────────────────────────
    setStep('sq-connect', 'running');
    const { remote } = await import('webdriverio');

    browser = await remote({
      hostname: 'localhost',
      port: APPIUM_PORT_NUM,
      path: '/',
      capabilities: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': udid || 'auto',
        'appium:bundleId': SQUARE_BUNDLE_ID,
        'appium:noReset': true,
        'appium:waitForIdleTimeout': 5,
        'appium:newCommandTimeout': 180,
        'appium:usePrebuiltWDA': true,
        'appium:useNewWDA': true,
        'appium:showXcodeLog': true,
        'appium:wdaStartupRetries': 3,
        'appium:wdaStartupRetryInterval': 15000,
      },
    });
    setStep('sq-connect', 'done', `UDID: ${udid}`);

    // ── Launch app ────────────────────────────────────────────
    setStep('sq-launch', 'running');
    await browser.pause(3000);
    setStep('sq-launch', 'done', 'Square POS launched');

    // ── Sign in via device code (hybrid: element finding + vision fallback) ──
    setStep('sq-ai', 'running', 'Looking for Sign in button...');

    // Helper: try multiple selectors to find & tap an element
    async function findAndTap(browser, selectors, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const sel of selectors) {
          try {
            const el = await browser.$(sel);
            if (await el.isDisplayed()) {
              await el.click();
              console.log(`[SquareFlow] Tapped "${label}" via ${sel}`);
              return true;
            }
          } catch { /* not found, try next */ }
        }
        await browser.pause(1000);
      }
      return false;
    }

    // Helper: wait for an element to appear
    async function waitForElement(browser, selectors, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const sel of selectors) {
          try {
            const el = await browser.$(sel);
            if (await el.isDisplayed()) return el;
          } catch { /* not found */ }
        }
        await browser.pause(1000);
      }
      return null;
    }

    // Step 1: Tap "Sign in" on the welcome screen
      emit('ai-action', { ecid, iteration: 1, action: 'tap', description: 'Looking for Sign in button...' });
      setStep('sq-ai', 'running', 'Step 1: Tap Sign in');

      let found = await findAndTap(browser, [
        '~Sign in',                                        // accessibility id
        '-ios predicate string:label == "Sign in"',        // exact label
        '-ios predicate string:label CONTAINS "Sign in"',  // partial match
        '-ios predicate string:name == "Sign in"',         // by name
      ], 'Sign in', 20000);

      if (!found) {
        // Vision fallback: try using Gemini to find and tap Sign in
        console.log('[SquareFlow] Element finding failed for Sign in, trying vision fallback...');
        emit('ai-action', { ecid, iteration: 1, action: 'tap', description: 'Using vision to find Sign in...' });
        const { runVisionAgent } = await import('./vision-agent.mjs');
        const vResult = await runVisionAgent(browser,
          'Find and tap the "Sign in" button on the Square POS welcome screen. It is at the bottom of the screen, next to "Create account". Just tap it and return done.',
          (i, action) => setStep('sq-ai', 'running', `Vision step ${i+1}: ${action.description || action.action}`),
        );
        if (!vResult.success) throw new Error('Could not find Sign in button');
      }

      await browser.pause(2000);
      emit('ai-action', { ecid, iteration: 2, action: 'tap', description: 'Sign in tapped, looking for Use device code...' });
      setStep('sq-ai', 'running', 'Step 2: Tap Use device code');

      // Step 2: Tap "Use device code"
      found = await findAndTap(browser, [
        '~Use device code',
        '-ios predicate string:label == "Use device code"',
        '-ios predicate string:label CONTAINS "device code"',
        '-ios predicate string:name CONTAINS "device code"',
      ], 'Use device code', 20000);

      if (!found) {
        console.log('[SquareFlow] Element finding failed for Use device code, trying vision fallback...');
        const { runVisionAgent } = await import('./vision-agent.mjs');
        const vResult = await runVisionAgent(browser,
          'Find and tap the "Use device code" option on the Square sign-in screen. Just tap it and return done.',
          (i, action) => setStep('sq-ai', 'running', `Vision step ${i+1}: ${action.description || action.action}`),
        );
        if (!vResult.success) throw new Error('Could not find Use device code');
      }

      await browser.pause(2000);
      emit('ai-action', { ecid, iteration: 3, action: 'type', description: `Entering device code: ${deviceCode}` });
      setStep('sq-ai', 'running', 'Step 3: Enter device code');

      // Step 3: Find the input field and type the device code
      let inputField = await waitForElement(browser, [
        '-ios predicate string:type == "XCUIElementTypeTextField"',
        '-ios predicate string:type == "XCUIElementTypeSecureTextField"',
        '~Device code',
        '-ios predicate string:placeholderValue CONTAINS "code"',
      ], 20000);

      if (inputField) {
        await inputField.click();
        await browser.pause(500);
        // Type character by character to avoid dropped characters on iOS
        for (const char of deviceCode) {
          await browser.keys([char]);
          await browser.pause(100);
        }
        console.log(`[SquareFlow] Typed device code: ${deviceCode}`);
      } else {
        console.log('[SquareFlow] Could not find input field, trying vision fallback...');
        const { runVisionAgent } = await import('./vision-agent.mjs');
        const vResult = await runVisionAgent(browser,
          `Find the device code input field and type this 12-digit code: ${deviceCode}. Tap the input field first, then type the code.`,
          (i, action) => setStep('sq-ai', 'running', `Vision step ${i+1}: ${action.description || action.action}`),
        );
        if (!vResult.success) throw new Error('Could not enter device code');
      }

      await browser.pause(1000);
      emit('ai-action', { ecid, iteration: 4, action: 'tap', description: 'Tapping Sign in to complete' });
      setStep('sq-ai', 'running', 'Step 4: Tap Sign in to complete');

      // Step 4: Tap "Sign in" button to submit
      await findAndTap(browser, [
        '~Sign in',
        '-ios predicate string:label == "Sign in"',
        '-ios predicate string:label == "Sign In"',
        '-ios predicate string:type == "XCUIElementTypeButton" AND label CONTAINS "Sign"',
      ], 'Sign in (submit)', 15000);

      await browser.pause(5000);

      // Step 5: Check if we reached the dashboard or got an error
      setStep('sq-ai', 'running', 'Checking sign-in result...');
      const { runVisionAgent: runVisionCheck } = await import('./vision-agent.mjs');
      const checkResult = await runVisionCheck(browser,
        'Check the current screen. If you see the Square POS dashboard, home screen, or any main app screen (Checkout, Items, Orders, etc.), return done with success=true. If you see "Signing in..." or a loading screen, wait a few seconds. If you see an error message, return error. If you see any popups or dialogs, dismiss them.',
        (i, action) => setStep('sq-ai', 'running', `Verify: ${action.description || action.action}`),
      );

      if (checkResult.success) {
        setStep('sq-ai', 'done', `Sign-in completed successfully`);
      } else {
        throw new Error(checkResult.error || 'Sign-in verification failed');
      }

      jobs.set(ecid, { ...jobs.get(ecid), status: 'done' });
      emit('job-done', { ecid });

  } catch (err) {
    const job = jobs.get(ecid);
    if (job) {
      job.status = 'error'; job.error = err.message;
      if (job.currentStep) setStep(job.currentStep, 'error', err.message);
    }
    emit('job-error', { ecid, error: err.message });
  } finally {
    if (browser) {
      try { await browser.deleteSession(); } catch {}
    }
  }
}

// ─── Batched Concurrency ──────────────────────────────────────

/**
 * Process devices in batches to avoid overwhelming the Mac.
 * Each batch runs `batchSize` devices in parallel, waits for
 * all to complete, then starts the next batch.
 */
async function runSquareBatched(matched, batchSize) {
  const totalBatches = Math.ceil(matched.length / batchSize);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * batchSize;
    const batch = matched.slice(start, start + batchSize);
    const batchNum = b + 1;

    emit('batch-progress', {
      batch: batchNum,
      totalBatches,
      devices: batch.length,
      message: `Batch ${batchNum}/${totalBatches} — starting ${batch.length} device(s)`,
    });

    // Run all devices in this batch in parallel
    const promises = batch.map((device) =>
      runSquareSetup(device, device.deviceCode)
    );

    // Wait for the entire batch to finish before starting the next
    await Promise.allSettled(promises);

    emit('batch-progress', {
      batch: batchNum,
      totalBatches,
      devices: batch.length,
      message: `Batch ${batchNum}/${totalBatches} — complete`,
    });
  }

  emit('batch-done', {
    total: matched.length,
    message: `All ${totalBatches} batch(es) complete — ${matched.length} devices processed`,
  });
}

// ─── HTTP Server ──────────────────────────────────────────────

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Static ─────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(join(__dirname, 'public', 'index.html'), 'utf8'));
    return;
  }

  // ── API: List devices ──────────────────────────────────────
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    try { sendJson(res, 200, { devices: listDevices() }); }
    catch (err) { sendJson(res, 500, { error: err.message }); }
    return;
  }

  // ── API: Config ────────────────────────────────────────────
  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      wifi: { ssid: CONFIG.wifi.ssid, security: CONFIG.wifi.security },
      hasSimpleMdmKey: (CONFIG.simpleMDM.apiKey?.length || 0) > 0,
    });
    return;
  }

  // ── API: Jobs ──────────────────────────────────────────────
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const result = {};
    for (const [ecid, job] of jobs) result[ecid] = job;
    sendJson(res, 200, result);
    return;
  }

  // ── API: Start provisioning ────────────────────────────────
  if (url.pathname === '/api/provision' && req.method === 'POST') {
    const body = await parseBody(req);
    const { ecids, mode, eraseMethod, simpleMdmIds } = body;
    if (!ecids?.length) { sendJson(res, 400, { error: 'No devices selected' }); return; }

    const devices = listDevices();
    const selected = devices.filter((d) => ecids.includes(d.ecid));
    if (selected.length === 0) { sendJson(res, 400, { error: 'Devices not found' }); return; }

    for (const d of selected) {
      if (jobs.get(d.ecid)?.status === 'running') {
        sendJson(res, 409, { error: `${d.name} already running` }); return;
      }
    }

    for (const device of selected) {
      const mdmId = simpleMdmIds?.[device.ecid] || '';
      runProvision(device, mode || 'provision-only', eraseMethod || 'cfgutil', mdmId);
    }
    sendJson(res, 202, { message: `Provisioning started for ${selected.length} device(s)` });
    return;
  }

  // ── API: Start Square setup ────────────────────────────────
  if (url.pathname === '/api/square' && req.method === 'POST') {
    const body = await parseBody(req);
    const { assignments } = body;

    if (!assignments?.length) {
      sendJson(res, 400, { error: 'No assignments provided' }); return;
    }

    const devices = listDevices();
    const matched = [];
    const unmatched = [];

    for (const a of assignments) {
      const serial = a.serial.toLowerCase();
      const dev = devices.find(
        (d) => (d.serial && d.serial.toLowerCase() === serial) ||
               (d.ecid && d.ecid.toLowerCase() === serial)
      );
      if (dev) {
        matched.push({ ...dev, deviceCode: a.deviceCode });
      } else {
        unmatched.push(a.serial);
      }
    }

    if (matched.length === 0) {
      sendJson(res, 400, {
        error: `No CSV serials match connected devices. Unmatched: ${unmatched.join(', ')}`,
      });
      return;
    }

    for (const d of matched) {
      if (jobs.get(d.ecid)?.status === 'running') {
        sendJson(res, 409, { error: `${d.name} already running` }); return;
      }
    }

    // Launch with batched concurrency (don't await — runs in background)
    const batchSize = CONFIG.appiumConcurrency || 5;
    const totalBatches = Math.ceil(matched.length / batchSize);
    emit('batch-info', {
      total: matched.length,
      batchSize,
      totalBatches,
      message: `Processing ${matched.length} devices in ${totalBatches} batch(es) of ${batchSize}`,
    });

    runSquareBatched(matched, batchSize);

    sendJson(res, 202, {
      message: `Square setup queued for ${matched.length} device(s) — processing ${batchSize} at a time (${totalBatches} batches)`,
      matched: matched.map((d) => ({ serial: d.serial, name: d.name })),
      unmatched,
    });
    return;
  }

  // ── API: SSE event stream ──────────────────────────────────
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: {"type":"connected"}\n\n');
    const handler = (data) => res.write(`data: ${data}\n\n`);
    events.on('progress', handler);
    req.on('close', () => events.off('progress', handler));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`  📱 iPad Provisioner UI running at:`);
  console.log(`     ${'\x1b[36m'}http://localhost:${PORT}${'\x1b[0m'}`);
  console.log('');
  console.log('  Open that URL in your browser to get started.');
  console.log('  Press Ctrl+C to stop.\n');
});
