"use strict";
const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  shell,
  systemPreferences,
} = require("electron");
const os = require("node:os");
const path = require("node:path");
const store = require("./store");
const { SignalClient } = require("./signal");
const { Injector, unavailableReason } = require("./input");
const bundledConfig = require("../../config.json");

// OFFICEDESK_PROFILE=b runs a second, independent copy (own sign-in and device ID) — handy for testing on one PC.
if (process.env.OFFICEDESK_PROFILE) {
  const profile = process.env.OFFICEDESK_PROFILE.replace(/[^a-z0-9_-]/gi, "");
  app.setPath("userData", path.join(app.getPath("appData"), `OfficeDesk-${profile}`));
}

const RENDERER = path.join(__dirname, "..", "renderer");
const PRELOAD = path.join(__dirname, "..", "preload.cjs");

let mainWindow = null;
let bannerWindow = null;
let injector = null;
/** The session in which this machine is being viewed / controlled, or null. */
let hostSession = null;
let selectedSourceId = null;
let account = null; // { email, device }

// ── server API ─────────────────────────────────────────────────────────────
/** Locked when the build sets "lockServerUrl" in config.json (production) or OFFICEDESK_SERVER is set. */
const serverUrlLocked = () => !!process.env.OFFICEDESK_SERVER || bundledConfig.lockServerUrl === true;

function serverUrl() {
  const chosen = serverUrlLocked() ? "" : store.getSettings().serverUrl;
  return (process.env.OFFICEDESK_SERVER || chosen || bundledConfig.serverUrl).replace(/\/+$/, "");
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, p, body, { auth = true, base = serverUrl() } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) {
    const { token } = store.getSecrets();
    if (!token) throw new ApiError(401, "unauthorized", "Belum masuk");
    headers.authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(base + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ApiError(0, "network", `Tidak bisa menghubungi server ${base} (${e.cause?.code || e.message})`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && auth) signedOut();
    throw new ApiError(res.status, data.error || "error", data.message || `Server menjawab ${res.status}`);
  }
  return data;
}

/** IPC handlers return {ok, data} / {ok:false, error} so the page can show the server's message. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!isOurPage(e.senderFrame)) return { ok: false, error: { code: "forbidden", message: "forbidden" } };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(`[ipc ${channel}]`, err);
      return { ok: false, error: { code: err.code || "error", message: err.message } };
    }
  });
}

function isOurPage(frame) {
  return !!frame && frame.url.startsWith("file://") && frame.url.includes("/renderer/");
}

// ── signaling ──────────────────────────────────────────────────────────────
const signal = new SignalClient(
  () => ({ url: serverUrl(), token: store.getSecrets().token, autoAcceptOwn: store.getSettings().autoAcceptOwn }),
  onServerMessage,
  (state) => {
    toRenderer("socket", state);
    if (state === "auth-failed") signedOut();
  },
);

function toRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function onServerMessage(msg) {
  if (msg.type === "session-start" && msg.role === "host") {
    hostSession = { id: msg.sessionId, peer: msg.peer, mode: msg.mode };
    showBanner();
  } else if (msg.type === "ended" && hostSession && msg.sessionId === hostSession.id) {
    endHostLocal();
  } else if (msg.type === "incoming") {
    // Bring the window forward so the person at this PC sees the request.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.flashFrame(true);
    }
  }
  toRenderer("signal", msg);
}

function endHostLocal() {
  if (injector) injector.releaseAll();
  hostSession = null;
  if (bannerWindow && !bannerWindow.isDestroyed()) bannerWindow.close();
  bannerWindow = null;
}

function signedOut() {
  signal.stop();
  endHostLocal();
  store.setSecrets({ token: null });
  account = null;
  toRenderer("signed-out", null);
}

// ── host banner: always visible while someone is connected ────────────────
function showBanner() {
  if (bannerWindow && !bannerWindow.isDestroyed()) bannerWindow.close();
  const area = screen.getPrimaryDisplay().workArea;
  const width = 460;
  bannerWindow = new BrowserWindow({
    width,
    height: 46,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 8,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: "#b42318",
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  bannerWindow.setAlwaysOnTop(true, "screen-saver");
  bannerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the banner itself out of the stream where the OS allows it.
  bannerWindow.setContentProtection(true);
  bannerWindow.loadFile(path.join(RENDERER, "banner.html"), {
    query: { email: hostSession.peer.email, mode: hostSession.mode },
  });
}

// ── screen capture ─────────────────────────────────────────────────────────
async function listScreens() {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id);
    return {
      id: s.id,
      name: d ? `Layar ${i + 1} (${d.size.width}×${d.size.height})` : s.name || `Layar ${i + 1}`,
      displayId: s.display_id,
      primary: d ? d.id === primary.id : i === 0,
    };
  });
}

function displayForSource(sourceDisplayId) {
  const displays = screen.getAllDisplays();
  return displays.find((d) => String(d.id) === String(sourceDisplayId)) || screen.getPrimaryDisplay();
}

// ── windows ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 820,
    minHeight: 560,
    title: "OfficeDesk",
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(RENDERER, "index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc === mainWindow?.webContents && (permission === "media" || permission === "display-capture"));
  });
  // getDisplayMedia() from the page captures the screen chosen in the app, without the system picker.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      const src = sources.find((s) => s.id === selectedSourceId) || sources[0];
      if (!src) return cb({});
      if (injector) injector.setDisplay(displayForSource(src.display_id));
      cb({ video: src });
    } catch (e) {
      console.error("[capture]", e);
      cb({});
    }
  });
}

// ── IPC ────────────────────────────────────────────────────────────────────
function deviceClaim() {
  const { deviceId, deviceKey } = store.getSecrets();
  const s = store.getSettings();
  return {
    id: deviceId,
    key: deviceKey,
    name: s.deviceName || os.hostname().replace(/\.local$/, ""),
    platform: process.platform,
  };
}

function permissions() {
  if (process.platform !== "darwin") return { screen: "granted", accessibility: true };
  return {
    screen: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

function registerIpc() {
  handle("app:state", async () => {
    const { token } = store.getSecrets();
    if (token && !account) {
      try {
        account = await api("GET", "/api/me");
      } catch (e) {
        if (e.code !== "network") throw e;
        return { loggedIn: false, offline: true, serverUrl: serverUrl(), error: e.message };
      }
    }
    if (account && !signal.ws && signal.stopped) signal.start();
    return {
      loggedIn: !!account,
      email: account?.email,
      device: account?.device,
      settings: store.getSettings(),
      platform: process.platform,
      serverUrl: serverUrl(),
      serverUrlLocked: serverUrlLocked(),
      permissions: permissions(),
      version: app.getVersion(),
      // Development-only test mode: share a generated test picture instead of the real screen.
      fakeCapture: process.env.OFFICEDESK_FAKE_CAPTURE === "1",
    };
  });

  handle("auth:info", async (url) => {
    const base = (typeof url === "string" && url.trim() && !serverUrlLocked() ? url.trim() : serverUrl()).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new ApiError(400, "bad_url", "Alamat server harus diawali http:// atau https://");
    return api("GET", "/api/info", undefined, { auth: false, base });
  });

  handle("auth:request-otp", async (email, url) => {
    if (typeof url === "string" && url.trim() && !serverUrlLocked()) {
      store.setSettings({ serverUrl: url.trim().replace(/\/+$/, "") });
    }
    return api("POST", "/api/auth/request-otp", { email }, { auth: false });
  });

  handle("auth:verify", async (email, code) => {
    const r = await api("POST", "/api/auth/verify-otp", { email, code, device: deviceClaim() }, { auth: false });
    store.setSecrets({ token: r.token, deviceId: r.device.id, ...(r.deviceKey ? { deviceKey: r.deviceKey } : {}) });
    account = { email: r.email, device: r.device };
    signal.start();
    return account;
  });

  handle("auth:logout", async () => {
    try {
      await api("POST", "/api/auth/logout", {});
    } catch {}
    signedOut();
  });

  handle("devices:list", () => api("GET", "/api/devices"));
  handle("devices:remove", (id) => api("DELETE", `/api/devices/${encodeURIComponent(String(id))}`));
  handle("devices:rename", async (id, name) => {
    await api("PATCH", `/api/devices/${encodeURIComponent(String(id))}`, { name });
    if (account && account.device && account.device.id === id) {
      account.device.name = name;
      store.setSettings({ deviceName: name });
    }
  });
  handle("audit:list", () => api("GET", "/api/audit"));

  handle("settings:set", (patch) => {
    const allowed = {};
    if (typeof patch?.autoAcceptOwn === "boolean") allowed.autoAcceptOwn = patch.autoAcceptOwn;
    const s = store.setSettings(allowed);
    signal.send({ type: "settings", autoAcceptOwn: s.autoAcceptOwn });
    return s;
  });

  const FROM_PAGE = new Set(["connect", "respond", "signal", "end"]);
  handle("signal:send", (msg) => {
    if (!msg || !FROM_PAGE.has(msg.type)) throw new ApiError(400, "bad_message", "Pesan tidak dikenal");
    if (!signal.send(msg)) throw new ApiError(0, "offline", "Tidak terhubung ke server");
  });

  handle("capture:screens", listScreens);
  handle("capture:select", async (sourceId) => {
    selectedSourceId = typeof sourceId === "string" ? sourceId : null;
    const screens = await listScreens();
    const s = screens.find((x) => x.id === selectedSourceId);
    if (injector && s) injector.setDisplay(displayForSource(s.displayId));
    return true;
  });

  handle("host:input-status", () => ({
    reason: process.env.OFFICEDESK_FAKE_INPUT === "1" ? null : unavailableReason({ prompt: true }),
  }));
  handle("host:end", () => {
    if (hostSession) signal.send({ type: "end", sessionId: hostSession.id });
    endHostLocal();
  });
  handle("permissions:open", (which) => {
    if (process.platform !== "darwin") return;
    const pane = which === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });

  // Input from the viewer, relayed by this machine's own page. Only honoured while a control session is active.
  ipcMain.on("input:event", (e, ev) => {
    if (!hostSession || hostSession.mode !== "control") return;
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    // Development-only test mode: log what would be injected instead of moving the real mouse.
    if (process.env.OFFICEDESK_FAKE_INPUT === "1") return console.log("[input:fake]", JSON.stringify(ev));
    injector.handle(ev);
  });
}

// ── startup ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    injector = new Injector();
    setupSession();
    registerIpc();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    endHostLocal();
    signal.stop();
  });
}
