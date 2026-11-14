"use strict";
// KeyboardEvent.code (physical key position) → [Windows virtual-key, macOS virtual keycode, X11 keysym name].
// Positional codes mean the host's own keyboard layout decides which character a key produces.

const MAP = {
  Enter: [0x0d, 36, "Return"],
  Escape: [0x1b, 53, "Escape"],
  Backspace: [0x08, 51, "BackSpace"],
  Tab: [0x09, 48, "Tab"],
  Space: [0x20, 49, "space"],
  Minus: [0xbd, 27, "minus"],
  Equal: [0xbb, 24, "equal"],
  BracketLeft: [0xdb, 33, "bracketleft"],
  BracketRight: [0xdd, 30, "bracketright"],
  Backslash: [0xdc, 42, "backslash"],
  IntlBackslash: [0xe2, 10, "less"],
  Semicolon: [0xba, 41, "semicolon"],
  Quote: [0xde, 39, "apostrophe"],
  Backquote: [0xc0, 50, "grave"],
  Comma: [0xbc, 43, "comma"],
  Period: [0xbe, 47, "period"],
  Slash: [0xbf, 44, "slash"],
  CapsLock: [0x14, 57, "Caps_Lock"],
  PrintScreen: [0x2c, 105, "Print"],
  ScrollLock: [0x91, 107, "Scroll_Lock"],
  Pause: [0x13, 113, "Pause"],
  Insert: [0x2d, 114, "Insert"],
  Home: [0x24, 115, "Home"],
  PageUp: [0x21, 116, "Prior"],
  Delete: [0x2e, 117, "Delete"],
  End: [0x23, 119, "End"],
  PageDown: [0x22, 121, "Next"],
  ArrowRight: [0x27, 124, "Right"],
  ArrowLeft: [0x25, 123, "Left"],
  ArrowDown: [0x28, 125, "Down"],
  ArrowUp: [0x26, 126, "Up"],
  NumLock: [0x90, 71, "Num_Lock"],
  NumpadDivide: [0x6f, 75, "KP_Divide"],
  NumpadMultiply: [0x6a, 67, "KP_Multiply"],
  NumpadSubtract: [0x6d, 78, "KP_Subtract"],
  NumpadAdd: [0x6b, 69, "KP_Add"],
  NumpadEnter: [0x0d, 76, "KP_Enter"],
  NumpadDecimal: [0x6e, 65, "KP_Decimal"],
  ShiftLeft: [0xa0, 56, "Shift_L"],
  ShiftRight: [0xa1, 60, "Shift_R"],
  ControlLeft: [0xa2, 59, "Control_L"],
  ControlRight: [0xa3, 62, "Control_R"],
  AltLeft: [0xa4, 58, "Alt_L"],
  AltRight: [0xa5, 61, "Alt_R"],
  MetaLeft: [0x5b, 55, "Super_L"],
  MetaRight: [0x5c, 54, "Super_R"],
  ContextMenu: [0x5d, 110, "Menu"],
};

const MAC_LETTERS = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46 };
for (const [ch, mac] of Object.entries(MAC_LETTERS)) MAP[`Key${ch}`] = [ch.charCodeAt(0), mac, ch.toLowerCase()];

const MAC_DIGITS = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
const MAC_NUMPAD = [82, 83, 84, 85, 86, 87, 88, 89, 91, 92];
for (let d = 0; d <= 9; d++) {
  MAP[`Digit${d}`] = [0x30 + d, MAC_DIGITS[d], String(d)];
  MAP[`Numpad${d}`] = [0x60 + d, MAC_NUMPAD[d], `KP_${d}`];
}

const MAC_F = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
for (let i = 1; i <= 12; i++) MAP[`F${i}`] = [0x6f + i, MAC_F[i - 1], `F${i}`];

/** Windows keys that need KEYEVENTF_EXTENDEDKEY, or Windows treats them as their numpad twins. */
const WIN_EXTENDED = new Set([
  "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "NumpadDivide", "NumpadEnter", "ControlRight", "AltRight",
  "MetaLeft", "MetaRight", "ContextMenu", "NumLock", "PrintScreen",
]);

/** macOS modifier flag bits (CGEventFlags) per modifier key. */
const MAC_MOD_FLAGS = {
  ShiftLeft: 0x20000, ShiftRight: 0x20000,
  ControlLeft: 0x40000, ControlRight: 0x40000,
  AltLeft: 0x80000, AltRight: 0x80000,
  MetaLeft: 0x100000, MetaRight: 0x100000,
};

function lookup(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(MAP, code) ? MAP[code] : null;
}

module.exports = { lookup, WIN_EXTENDED, MAC_MOD_FLAGS, codes: () => Object.keys(MAP) };
