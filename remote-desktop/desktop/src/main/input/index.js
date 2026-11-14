"use strict";
// Turns the viewer's input events (validated here, coordinates normalized 0..1 over the shared screen)
// into real mouse and keyboard events on this machine.
const { screen, systemPreferences } = require("electron");
const { lookup } = require("./keymap");

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const finite = (v, lim) => (Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);

let backend = null;

function loadBackend() {
  if (backend) return backend;
  try {
    const mod =
      process.platform === "win32" ? require("./win32") : process.platform === "darwin" ? require("./darwin") : require("./linux");
    backend = mod.create();
  } catch (e) {
    console.error("[input] backend failed:", e);
    backend = { supported: false, reason: `Modul input gagal dimuat: ${e.message}` };
  }
  return backend;
}

/** null when input can be injected, else a human-readable reason (shown to both sides). */
function unavailableReason({ prompt = false } = {}) {
  const b = loadBackend();
  if (!b.supported) return b.reason;
  if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(prompt)) {
    return "macOS belum memberi izin Aksesibilitas ke aplikasi ini (Pengaturan Sistem → Privasi & Keamanan → Aksesibilitas).";
  }
  return null;
}

class Injector {
  constructor() {
    this.display = screen.getPrimaryDisplay();
    this.keys = new Set();
    this.buttons = new Set();
  }

  setDisplay(display) {
    if (display) this.display = display;
  }

  toNative(nx, ny) {
    const b = this.display.bounds;
    const p = { x: b.x + clamp01(nx) * (b.width - 1), y: b.y + clamp01(ny) * (b.height - 1) };
    if (process.platform === "win32") return screen.dipToScreenPoint(p);
    if (process.platform === "linux") {
      const s = this.display.scaleFactor || 1;
      return { x: p.x * s, y: p.y * s };
    }
    return p; // macOS: CoreGraphics uses points, like Electron's DIP
  }

  handle(ev) {
    if (!ev || typeof ev !== "object") return;
    const b = loadBackend();
    if (!b.supported) return;
    try {
      switch (ev.t) {
        case "m": {
          const p = this.toNative(Number(ev.x), Number(ev.y));
          b.move(p.x, p.y);
          return;
        }
        case "b": {
          const btn = Number(ev.b);
          if (![0, 1, 2].includes(btn)) return;
          if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) {
            const p = this.toNative(ev.x, ev.y);
            b.move(p.x, p.y);
          }
          const down = ev.d === true;
          if (down) this.buttons.add(btn);
          else this.buttons.delete(btn);
          b.button(btn, down);
          return;
        }
        case "w":
          b.wheel(finite(Number(ev.dx), 5000), finite(Number(ev.dy), 5000));
          return;
        case "k": {
          if (!lookup(ev.code)) return;
          const down = ev.d === true;
          if (down) this.keys.add(ev.code);
          else this.keys.delete(ev.code);
          b.key(ev.code, down);
          return;
        }
      }
    } catch (e) {
      console.error("[input]", e);
    }
  }

  /** Lets go of everything the viewer was holding (session ended or connection dropped mid-press). */
  releaseAll() {
    const b = loadBackend();
    if (!b.supported) return;
    for (const code of this.keys) {
      try {
        b.key(code, false);
      } catch {}
    }
    for (const btn of this.buttons) {
      try {
        b.button(btn, false);
      } catch {}
    }
    this.keys.clear();
    this.buttons.clear();
  }
}

module.exports = { Injector, unavailableReason };
