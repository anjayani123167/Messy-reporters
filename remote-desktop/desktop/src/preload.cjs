"use strict";
// The only bridge between the page and the main process. The page never sees the session token.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld("od", {
  state: () => invoke("app:state"),
  serverInfo: (url) => invoke("auth:info", url),
  requestOtp: (email, url) => invoke("auth:request-otp", email, url),
  verify: (email, code) => invoke("auth:verify", email, code),
  logout: () => invoke("auth:logout"),
  devices: () => invoke("devices:list"),
  removeDevice: (id) => invoke("devices:remove", id),
  renameDevice: (id, name) => invoke("devices:rename", id, name),
  audit: () => invoke("audit:list"),
  setSettings: (patch) => invoke("settings:set", patch),
  send: (msg) => invoke("signal:send", msg),
  screens: () => invoke("capture:screens"),
  selectScreen: (id) => invoke("capture:select", id),
  hostInputStatus: () => invoke("host:input-status"),
  endHosting: () => invoke("host:end"),
  openPermissions: (which) => invoke("permissions:open", which),
  input: (ev) => ipcRenderer.send("input:event", ev),
  onSignal: on("signal"),
  onSocket: on("socket"),
  onSignedOut: on("signed-out"),
});
