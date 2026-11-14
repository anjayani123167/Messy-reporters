"use strict";
// Settings (plain JSON) and secrets (session token, device key — encrypted with the OS keychain via safeStorage).
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const dir = () => app.getPath("userData");
const settingsFile = () => path.join(dir(), "settings.json");
const secretsFile = () => path.join(dir(), "secrets.bin");

const DEFAULT_SETTINGS = { serverUrl: "", autoAcceptOwn: true, deviceName: "" };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
}

function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeFileAtomic(settingsFile(), JSON.stringify(next, null, 2), 0o600);
  return next;
}

/** { token?, deviceId?, deviceKey? } */
function getSecrets() {
  let raw;
  try {
    raw = fs.readFileSync(secretsFile());
  } catch {
    return {};
  }
  try {
    if (raw[0] === 0x7b /* "{" — written without keychain */) return JSON.parse(raw.toString("utf8"));
    return JSON.parse(safeStorage.decryptString(raw));
  } catch (e) {
    console.warn("[store] cannot read secrets, signing out:", e.message);
    return {};
  }
}

function setSecrets(patch) {
  const next = { ...getSecrets(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  const json = JSON.stringify(next);
  let data;
  if (safeStorage.isEncryptionAvailable()) {
    data = safeStorage.encryptString(json);
  } else {
    // e.g. Linux without a keyring: fall back to a file only this user can read.
    console.warn("[store] OS keychain unavailable; the session token is stored unencrypted (mode 600)");
    data = Buffer.from(json, "utf8");
  }
  writeFileAtomic(secretsFile(), data, 0o600);
  return next;
}

module.exports = { getSettings, setSettings, getSecrets, setSecrets };
