#!/usr/bin/env node

// ╔══════════════════════════════════════════════════════════════════╗
// ║  iPad Provisioner                                                ║
// ║  Two modes:                                                      ║
// ║    1. Provision Only — WiFi → skip setup panes (device already   ║
// ║       reset and sitting at Hello screen)                         ║
// ║    2. Full Reset + Provision — erase (preserve eSIM) → WiFi →   ║
// ║       skip setup panes                                           ║
// ╚══════════════════════════════════════════════════════════════════╝

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

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

// ─── Helpers ───────────────────────────────────────────────────

function sleep(sec) {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  mkdirSync(CONFIG.logDir, { recursive: true });
  const logFile = join(CONFIG.logDir, `provision-${new Date().toISOString().slice(0, 10)}.log`);
  appendFileSync(logFile, line + '\n');
}

function banner() {
  console.log('');
  console.log(chalk.cyan.bold('  ┌──────────────────────────────────────┐'));
  console.log(chalk.cyan.bold('  │') + chalk.white.bold('     📱  iPad Provisioner  📱          ') + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('  └──────────────────────────────────────┘'));
  console.log('');
}

// ─── Provisioning Pipeline ────────────────────────────────────

async function provisionDevice(device, mode, eraseMethod) {
  const { ecid, name, serial } = device;
  const label = `${name} (${serial || ecid})`;
  const doErase = mode === 'full-reset';

  console.log('');
  log(chalk.bold(`═══ Starting: ${label} [${doErase ? 'Full Reset + Provision' : 'Provision Only'}] ═══`));

  const spinner = ora({ color: 'cyan' });

  // ── Step 1: Generate WiFi profile ───────────────────────────
  spinner.start('Generating WiFi profile...');
  let wifiProfilePath;
  try {
    wifiProfilePath = generateWifiProfile();
    spinner.succeed(`WiFi profile generated → ${chalk.dim(wifiProfilePath)}`);
  } catch (err) {
    spinner.fail(`WiFi profile generation failed: ${err.message}`);
    return false;
  }

  // ── Step 2: Erase (only in full-reset mode) ─────────────────
  if (doErase) {
    spinner.start('Erasing device (preserving eSIM)...');
    try {
      if (eraseMethod === 'simplemdm') {
        const { simpleMdmId } = await inquirer.prompt([{
          type: 'input',
          name: 'simpleMdmId',
          message: `Enter SimpleMDM Device ID for ${label}:`,
          validate: (v) => v.length > 0 || 'Required',
        }]);
        spinner.start('Sending erase via SimpleMDM (PreserveDataPlan=true)...');
        await eraseViaSimpleMDM(simpleMdmId);
        spinner.succeed('Erase sent via SimpleMDM (eSIM preserved)');
      } else {
        eraseDevice(ecid);
        spinner.succeed('Device erased via cfgutil');
      }
    } catch (err) {
      spinner.fail(`Erase failed: ${err.message}`);
      log(`ERROR during erase: ${err.message}`);
      return false;
    }

    // Wait for reboot
    spinner.start(`Waiting ${CONFIG.eraseRebootWaitSec}s for device to reboot...`);
    for (let i = CONFIG.eraseRebootWaitSec; i > 0; i--) {
      spinner.text = `Waiting for device to reboot... ${chalk.yellow(i + 's')} remaining`;
      await sleep(1);
    }
    spinner.succeed('Reboot wait complete');
  } else {
    spinner.info(chalk.dim('Skipping erase — device already at Setup Assistant'));
  }

  // ── Step 3: Pair ────────────────────────────────────────────
  spinner.start('Pairing with device...');
  try {
    pairDevice(ecid);
    spinner.succeed('Device paired');
  } catch (err) {
    spinner.warn(`Pair attempt: ${err.message} (continuing anyway)`);
  }

  // ── Step 4: Install WiFi profile ────────────────────────────
  spinner.start('Pushing WiFi profile over USB...');
  try {
    installProfile(ecid, wifiProfilePath);
    spinner.succeed(`WiFi profile installed (SSID: ${chalk.green(CONFIG.wifi.ssid)})`);
  } catch (err) {
    spinner.fail(`WiFi profile install failed: ${err.message}`);
    log(`ERROR during WiFi install: ${err.message}`);
    console.log(chalk.yellow('  ⚠  Device may still connect via eSIM cellular data'));
  }

  // ── Step 5: Prepare — skip setup panes + DEP enrollment ────
  spinner.start('Preparing device (skipping setup panes + DEP enrollment)...');
  try {
    prepareDevice(ecid);
    spinner.succeed('Device prepared — setup panes skipped');
  } catch (err) {
    spinner.fail(`Prepare failed: ${err.message}`);
    log(`ERROR during prepare: ${err.message}`);
    console.log(chalk.yellow('  ℹ  The device may need manual interaction for remaining panes.'));
    console.log(chalk.yellow('  ℹ  SimpleMDM enrollment should still proceed if WiFi is connected.'));
    return false;
  }

  // ── Step 6: Settle ──────────────────────────────────────────
  spinner.start(`Waiting ${CONFIG.postPrepareWaitSec}s for device to settle...`);
  await sleep(CONFIG.postPrepareWaitSec);
  spinner.succeed('Device settled');

  // Done!
  console.log('');
  console.log(chalk.green.bold(`  ✅  ${label} — PROVISIONING COMPLETE`));
  console.log(chalk.dim(`      Device should now be enrolling in SimpleMDM`));
  console.log(chalk.dim(`      and landing on the home screen shortly.`));
  console.log('');
  log(`COMPLETE: ${label}`);
  return true;
}

// ─── Interactive UI ───────────────────────────────────────────

async function main() {
  banner();

  // Check cfgutil exists
  const spinner = ora('Checking for cfgutil...').start();
  let devices;
  try {
    devices = listDevices();
    spinner.succeed(`cfgutil found — ${devices.length} device(s) connected`);
  } catch (err) {
    spinner.fail(err.message);
    process.exit(1);
  }

  if (devices.length === 0) {
    console.log(chalk.yellow('\n  No iPads detected via USB.'));
    console.log(chalk.gray('  Connect an iPad and try again.\n'));
    process.exit(0);
  }

  // Show connected devices
  console.log('');
  console.log(chalk.bold('  Connected devices:'));
  for (const d of devices) {
    console.log(
      chalk.white(`    • ${d.name}`) +
      chalk.gray(` — Serial: ${d.serial || 'N/A'}, ECID: ${d.ecid}`) +
      (d.iosVersion ? chalk.dim(` (${d.iosVersion})`) : '')
    );
  }
  console.log('');

  // ── Pick mode ───────────────────────────────────────────────
  const { mode } = await inquirer.prompt([{
    type: 'list',
    name: 'mode',
    message: 'What would you like to do?',
    choices: [
      {
        name: `${chalk.green('Provision Only')}  — Device is already reset, push WiFi + skip setup panes`,
        value: 'provision-only',
      },
      {
        name: `${chalk.red('Full Reset + Provision')}  — Factory erase (preserve eSIM), then WiFi + skip setup`,
        value: 'full-reset',
      },
    ],
  }]);

  // ── Pick devices ────────────────────────────────────────────
  const { selectedEcids } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selectedEcids',
    message: 'Select device(s):',
    choices: devices.map((d) => ({
      name: `${d.name} — ${d.serial || d.ecid}`,
      value: d.ecid,
      checked: devices.length === 1,
    })),
    validate: (v) => v.length > 0 || 'Select at least one device',
  }]);

  const selectedDevices = devices.filter((d) => selectedEcids.includes(d.ecid));

  // ── Erase method (only relevant in full-reset mode) ─────────
  let eraseMethod = 'cfgutil';
  if (mode === 'full-reset') {
    const hasApiKey = CONFIG.simpleMDM.apiKey?.length > 0;

    if (hasApiKey) {
      const { method } = await inquirer.prompt([{
        type: 'list',
        name: 'method',
        message: 'How should the device be erased?',
        choices: [
          {
            name: 'SimpleMDM API (guaranteed eSIM preservation)',
            value: 'simplemdm',
          },
          {
            name: 'cfgutil erase (local USB — eSIM usually preserved)',
            value: 'cfgutil',
          },
        ],
      }]);
      eraseMethod = method;
    } else {
      console.log(
        chalk.dim('\n  ℹ  No SimpleMDM API key — using local cfgutil erase.')
      );
      console.log(
        chalk.dim('     eSIM is typically preserved (unlike a DFU restore).\n')
      );
    }
  }

  // ── Confirmation ────────────────────────────────────────────
  console.log('');
  if (mode === 'full-reset') {
    console.log(chalk.red.bold('  ⚠  THIS WILL FACTORY ERASE THE SELECTED DEVICE(S)'));
    console.log(chalk.red('     All data will be deleted. eSIM will be preserved.'));
  } else {
    console.log(chalk.cyan.bold('  ℹ  Provision only — no data will be erased'));
    console.log(chalk.cyan('     WiFi will be pushed and setup panes will be skipped.'));
  }
  console.log('');

  const confirmMsg = mode === 'full-reset'
    ? `Erase and provision ${selectedDevices.length} device(s)?`
    : `Provision ${selectedDevices.length} device(s)?`;

  const { confirmed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    message: confirmMsg,
    default: mode === 'provision-only',  // default yes for provision-only
  }]);

  if (!confirmed) {
    console.log(chalk.yellow('\n  Cancelled.\n'));
    process.exit(0);
  }

  // ── Run ─────────────────────────────────────────────────────
  console.log('');
  console.log(chalk.cyan.bold('  🚀 Starting provisioning pipeline...\n'));

  let successCount = 0;
  let failCount = 0;

  for (const device of selectedDevices) {
    const ok = await provisionDevice(device, mode, eraseMethod);
    if (ok) successCount++;
    else failCount++;
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold('  ═══════════════════════════════════'));
  console.log(chalk.bold('  Summary'));
  console.log(chalk.bold('  ═══════════════════════════════════'));
  console.log(chalk.green(`    ✅ Succeeded: ${successCount}`));
  if (failCount > 0) {
    console.log(chalk.red(`    ❌ Failed:    ${failCount}`));
  }
  console.log(chalk.dim(`    📋 Logs:      ${CONFIG.logDir}/`));
  console.log('');
}

main().catch((err) => {
  console.error(chalk.red(`\nFatal error: ${err.message}\n`));
  process.exit(1);
});
