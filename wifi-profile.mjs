import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './config.mjs';

/**
 * Generates a WiFi .mobileconfig XML payload from the config values.
 * Returns the file path of the generated profile.
 */
export function generateWifiProfile() {
  const { ssid, password, security, hidden } = CONFIG.wifi;

  // Map friendly security names to Apple's EncryptionType values
  const encryptionMap = {
    'WPA2': 'WPA2',
    'WPA3': 'WPA3',
    'WEP': 'WEP',
    'None': 'None',
  };
  const encryption = encryptionMap[security] || 'WPA2';

  const profileUUID = randomUUID().toUpperCase();
  const payloadUUID = randomUUID().toUpperCase();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>AutoJoin</key>
      <true/>
      <key>CaptiveBypass</key>
      <false/>
      <key>EncryptionType</key>
      <string>${encryption}</string>
      <key>HIDDEN_NETWORK</key>
      <${hidden}/>
      <key>IsHotspot</key>
      <false/>
      ${encryption !== 'None' ? `<key>Password</key>
      <string>${escapeXml(password)}</string>` : ''}
      <key>PayloadDescription</key>
      <string>Auto-generated WiFi profile for iPad provisioning</string>
      <key>PayloadDisplayName</key>
      <string>WiFi - ${escapeXml(ssid)}</string>
      <key>PayloadIdentifier</key>
      <string>com.ipad-provisioner.wifi.${payloadUUID}</string>
      <key>PayloadType</key>
      <string>com.apple.wifi.managed</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>ProxyType</key>
      <string>None</string>
      <key>SSID_STR</key>
      <string>${escapeXml(ssid)}</string>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>WiFi - ${escapeXml(ssid)}</string>
  <key>PayloadIdentifier</key>
  <string>com.ipad-provisioner.wifi</string>
  <key>PayloadOrganization</key>
  <string>iPad Provisioner</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;

  mkdirSync(CONFIG.profilesDir, { recursive: true });
  const filePath = join(CONFIG.profilesDir, 'wifi.mobileconfig');
  writeFileSync(filePath, xml, 'utf8');
  return filePath;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
