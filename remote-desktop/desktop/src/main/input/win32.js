"use strict";
// Windows input through user32 (koffi FFI: no native compile, works with any Electron version).
const koffi = require("koffi");
const { lookup, WIN_EXTENDED } = require("./keymap");

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const BUTTON_FLAGS = [
  [0x0002, 0x0004], // left down / up
  [0x0020, 0x0040], // middle
  [0x0008, 0x0010], // right
];

function create() {
  const user32 = koffi.load("user32.dll");
  const MOUSEINPUT = koffi.struct("OD_MOUSEINPUT", {
    dx: "int32",
    dy: "int32",
    mouseData: "int32", // signed so wheel deltas can be negative
    dwFlags: "uint32",
    time: "uint32",
    dwExtraInfo: "uintptr",
  });
  const KEYBDINPUT = koffi.struct("OD_KEYBDINPUT", {
    wVk: "uint16",
    wScan: "uint16",
    dwFlags: "uint32",
    time: "uint32",
    dwExtraInfo: "uintptr",
  });
  const HARDWAREINPUT = koffi.struct("OD_HARDWAREINPUT", { uMsg: "uint32", wParamL: "uint16", wParamH: "uint16" });
  const INPUT_UNION = koffi.union("OD_INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct("OD_INPUT", { type: "uint32", u: INPUT_UNION });
  const SendInput = user32.func("uint32_t __stdcall SendInput(uint32_t cInputs, _In_ OD_INPUT *pInputs, int cbSize)");
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int X, int Y)");
  const MapVirtualKeyW = user32.func("uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)");
  const size = koffi.sizeof(INPUT);

  const mouse = (flags, data = 0) =>
    SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, size);

  let wheelY = 0;
  let wheelX = 0;

  return {
    supported: true,
    /** x, y: physical screen pixels (the caller converts from DIP). */
    move(x, y) {
      SetCursorPos(Math.round(x), Math.round(y));
    },
    button(b, down) {
      const f = BUTTON_FLAGS[b];
      if (f) mouse(down ? f[0] : f[1]);
    },
    /** Pixel deltas as the browser reports them; 120 wheel units ≈ 100 px (one notch). */
    wheel(dx, dy) {
      wheelY += -dy * 1.2;
      wheelX += dx * 1.2;
      const y = Math.trunc(wheelY);
      const x = Math.trunc(wheelX);
      if (y) {
        mouse(MOUSEEVENTF_WHEEL, y);
        wheelY -= y;
      }
      if (x) {
        mouse(MOUSEEVENTF_HWHEEL, x);
        wheelX -= x;
      }
    },
    key(code, down) {
      const k = lookup(code);
      if (!k) return;
      const vk = k[0];
      let flags = down ? 0 : KEYEVENTF_KEYUP;
      if (WIN_EXTENDED.has(code)) flags |= KEYEVENTF_EXTENDEDKEY;
      SendInput(
        1,
        { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: MapVirtualKeyW(vk, 0) & 0xff, dwFlags: flags, time: 0, dwExtraInfo: 0 } } },
        size,
      );
    },
  };
}

module.exports = { create };
