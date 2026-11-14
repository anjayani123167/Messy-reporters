"use strict";
// Linux input through the X11 XTest extension (koffi FFI). Wayland sessions do not allow it: view-only there.
const koffi = require("koffi");
const { lookup } = require("./keymap");

// Browser button (0 left, 1 middle, 2 right) → X11 button number.
const X_BUTTONS = [1, 2, 3];
const NOTCH_PX = 100;

function create() {
  if (process.env.XDG_SESSION_TYPE === "wayland" || (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY)) {
    return { supported: false, reason: "Sesi Linux ini memakai Wayland; kendali jarak jauh butuh sesi X11 (Xorg). Mode lihat saja." };
  }
  let x11, xtst;
  try {
    x11 = koffi.load("libX11.so.6");
    xtst = koffi.load("libXtst.so.6");
  } catch (e) {
    return { supported: false, reason: "libX11 / libXtst tidak ditemukan (pasang paket libxtst6)." };
  }
  const XOpenDisplay = x11.func("void *XOpenDisplay(const char *name)");
  const XFlush = x11.func("int XFlush(void *display)");
  const XStringToKeysym = x11.func("unsigned long XStringToKeysym(const char *s)");
  const XKeysymToKeycode = x11.func("uint8_t XKeysymToKeycode(void *display, unsigned long keysym)");
  const XTestFakeMotionEvent = xtst.func("int XTestFakeMotionEvent(void *display, int screen, int x, int y, unsigned long delay)");
  const XTestFakeButtonEvent = xtst.func("int XTestFakeButtonEvent(void *display, unsigned int button, int is_press, unsigned long delay)");
  const XTestFakeKeyEvent = xtst.func("int XTestFakeKeyEvent(void *display, unsigned int keycode, int is_press, unsigned long delay)");

  const dpy = XOpenDisplay(null);
  if (!dpy) return { supported: false, reason: "Tidak bisa membuka display X11." };

  const keycodes = new Map();
  const keycodeOf = (code) => {
    if (keycodes.has(code)) return keycodes.get(code);
    const k = lookup(code);
    const kc = k ? XKeysymToKeycode(dpy, XStringToKeysym(k[2])) : 0;
    keycodes.set(code, kc);
    return kc;
  };
  const click = (button) => {
    XTestFakeButtonEvent(dpy, button, 1, 0);
    XTestFakeButtonEvent(dpy, button, 0, 0);
  };
  let accY = 0;
  let accX = 0;

  return {
    supported: true,
    /** x, y: X root-window pixels. */
    move(x, y) {
      XTestFakeMotionEvent(dpy, -1, Math.round(x), Math.round(y), 0);
      XFlush(dpy);
    },
    button(b, down) {
      const xb = X_BUTTONS[b];
      if (!xb) return;
      XTestFakeButtonEvent(dpy, xb, down ? 1 : 0, 0);
      XFlush(dpy);
    },
    /** X11 scrolls in notches: buttons 4/5 (vertical) and 6/7 (horizontal). */
    wheel(dx, dy) {
      accY += dy;
      accX += dx;
      while (Math.abs(accY) >= NOTCH_PX) {
        click(accY > 0 ? 5 : 4);
        accY -= Math.sign(accY) * NOTCH_PX;
      }
      while (Math.abs(accX) >= NOTCH_PX) {
        click(accX > 0 ? 7 : 6);
        accX -= Math.sign(accX) * NOTCH_PX;
      }
      XFlush(dpy);
    },
    key(code, down) {
      const kc = keycodeOf(code);
      if (!kc) return;
      XTestFakeKeyEvent(dpy, kc, down ? 1 : 0, 0);
      XFlush(dpy);
    },
  };
}

module.exports = { create };
