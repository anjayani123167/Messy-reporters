"use strict";
// macOS input through CoreGraphics events (koffi FFI). Needs the Accessibility permission.
const koffi = require("koffi");
const { lookup, MAC_MOD_FLAGS } = require("./keymap");

const kCGHIDEventTap = 0;
const kCGMouseEventClickState = 1;
const kCGScrollEventUnitPixel = 0;
const MOVED = 5;
// [down, up, dragged] event types and CGMouseButton per browser button (0 left, 1 middle, 2 right).
const BUTTONS = [
  { down: 1, up: 2, drag: 6, cg: 0 },
  { down: 25, up: 26, drag: 27, cg: 2 },
  { down: 3, up: 4, drag: 7, cg: 1 },
];
const DOUBLE_CLICK_MS = 450;

function create() {
  const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const CGPoint = koffi.struct("OD_CGPoint", { x: "double", y: "double" });
  const CGEventCreateMouseEvent = cg.func("void *CGEventCreateMouseEvent(void *source, uint32_t type, OD_CGPoint pos, uint32_t button)");
  const CGEventCreateKeyboardEvent = cg.func("void *CGEventCreateKeyboardEvent(void *source, uint16_t keycode, bool keyDown)");
  const CGEventCreateScrollWheelEvent2 = cg.func(
    "void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t w1, int32_t w2, int32_t w3)",
  );
  const CGEventSetFlags = cg.func("void CGEventSetFlags(void *event, uint64_t flags)");
  const CGEventSetIntegerValueField = cg.func("void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)");
  const CGEventPost = cg.func("void CGEventPost(uint32_t tap, void *event)");
  const CFRelease = cf.func("void CFRelease(void *cf)");

  let pos = { x: 0, y: 0 };
  const held = new Set(); // browser button numbers currently down
  const mods = new Set(); // modifier codes currently down
  let last = { b: -1, t: 0, x: 0, y: 0, count: 0 };

  const flags = () => {
    let f = 0;
    for (const m of mods) f |= MAC_MOD_FLAGS[m] || 0;
    return f;
  };
  const post = (ev) => {
    if (!ev) return;
    CGEventSetFlags(ev, flags());
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
  };

  return {
    supported: true,
    /** x, y: global points (same space as Electron DIP). */
    move(x, y) {
      pos = { x, y };
      const b = [...held][0];
      const spec = b !== undefined ? BUTTONS[b] : null;
      post(CGEventCreateMouseEvent(null, spec ? spec.drag : MOVED, pos, spec ? spec.cg : 0));
    },
    button(b, down) {
      const spec = BUTTONS[b];
      if (!spec) return;
      const ev = CGEventCreateMouseEvent(null, down ? spec.down : spec.up, pos, spec.cg);
      if (down) {
        const now = Date.now();
        const near = Math.abs(pos.x - last.x) < 5 && Math.abs(pos.y - last.y) < 5;
        last = { b, t: now, x: pos.x, y: pos.y, count: last.b === b && near && now - last.t < DOUBLE_CLICK_MS ? last.count + 1 : 1 };
        held.add(b);
      } else {
        held.delete(b);
      }
      // macOS needs the click count on the event itself for double / triple clicks to register.
      CGEventSetIntegerValueField(ev, kCGMouseEventClickState, last.count || 1);
      post(ev);
    },
    wheel(dx, dy) {
      post(CGEventCreateScrollWheelEvent2(null, kCGScrollEventUnitPixel, 2, Math.round(-dy), Math.round(-dx), 0));
    },
    key(code, down) {
      const k = lookup(code);
      if (!k) return;
      if (MAC_MOD_FLAGS[code]) {
        if (down) mods.add(code);
        else mods.delete(code);
      }
      post(CGEventCreateKeyboardEvent(null, k[1], down));
    },
  };
}

module.exports = { create };
