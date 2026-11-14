"use strict";
// Smoke check that runs without moving the mouse: koffi loads and this OS's input functions resolve.
// Run with:  npm run check   (uses Electron's own Node, the same runtime the app uses)
const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (!process.versions.electron) {
  const electron = require("electron");
  const r = spawnSync(electron, [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  process.exit(r.status ?? 1);
}

const koffi = require("koffi");
console.log(`electron ${process.versions.electron}, node ${process.versions.node}, koffi ${koffi.version}, ${process.platform}-${process.arch}`);

const keymap = require(path.join(__dirname, "../src/main/input/keymap.js"));
const codes = keymap.codes();
for (const c of codes) {
  const k = keymap.lookup(c);
  if (!Array.isArray(k) || k.length !== 3 || !Number.isInteger(k[0]) || !Number.isInteger(k[1]) || typeof k[2] !== "string") {
    throw new Error(`bad keymap entry ${c}`);
  }
}
console.log(`keymap: ${codes.length} keys OK`);

// Load the platform backend; create() only binds functions, it does not send any event.
const mod = require(path.join(__dirname, `../src/main/input/${process.platform === "win32" ? "win32" : process.platform}.js`));
const backend = mod.create();
console.log(`input backend: ${backend.supported ? "OK, functions bound" : `unsupported: ${backend.reason}`}`);
