"use strict";
/* global od -- exposed by preload.cjs through contextBridge (a non-configurable global, so never redeclare it) */
const $ = (id) => document.getElementById(id);

const REASONS = {
  rejected: "Permintaan ditolak oleh perangkat tujuan",
  timeout: "Tidak ada jawaban dari perangkat tujuan",
  hangup: "Sesi diakhiri",
  peer_disconnected: "Perangkat lain terputus",
  busy: "Perangkat sedang dipakai sesi lain",
};
const EVENTS = {
  login: "Masuk",
  logout: "Keluar",
  login_failed: "Kode salah",
  otp_sent: "Kode dikirim",
  otp_refused_domain: "Email luar kantor ditolak",
  session_request: "Minta akses",
  session_start: "Sesi dimulai",
  session_end: "Sesi selesai",
  session_refused: "Sesi tidak jadi",
  device_removed: "Perangkat dihapus",
};

let me = null; // app state from main
let pendingSession = null; // { sessionId, target }
let viewer = null; // the session where this app is the viewer
let host = null; // the session where this app is the host

// ── helpers ─────────────────────────────────────────────────────────────────
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

async function call(promise, { quiet = false } = {}) {
  const r = await promise;
  if (!r.ok) {
    if (!quiet) toast(r.error.message, "error");
    throw Object.assign(new Error(r.error.message), { code: r.error.code });
  }
  return r.data;
}

const fmtId = (id) => (id ? `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}` : "— — —");
const platformName = (p) => ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[p] || p;

function show(view) {
  for (const v of ["login", "home", "viewer"]) $(`view-${v}`).hidden = v !== view;
}

// ── boot / login ────────────────────────────────────────────────────────────
async function boot() {
  const r = await od.state();
  if (!r.ok) {
    showLogin(r.error.message);
    return;
  }
  me = r.data;
  if (!me.loggedIn) return showLogin(me.error);
  showHome();
}

async function showLogin(error = "") {
  show("login");
  $("form-email").hidden = false;
  $("form-code").hidden = true;
  $("login-error").textContent = error || "";
  const st = await od.state();
  const url = st.ok ? st.data.serverUrl : "";
  $("server-url").value = url;
  $("server-box").hidden = st.ok && st.data.serverUrlLocked;
  loadServerInfo(url);
  $("email").focus();
}

async function loadServerInfo(url) {
  const r = await od.serverInfo(url);
  if (r.ok) {
    const domains = r.data.allowedDomains.map((d) => "@" + d).join(", ");
    $("login-hint").textContent = `Masuk dengan email kantor (${domains}).`;
    $("email").placeholder = `nama@${r.data.allowedDomains[0]}`;
    $("login-error").textContent = "";
  } else {
    $("login-error").textContent = r.error.message;
    $("server-box").open = true;
  }
}

$("server-url").addEventListener("change", () => loadServerInfo($("server-url").value));

let loginEmail = "";
$("form-email").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginEmail = $("email").value.trim();
  $("btn-send").disabled = true;
  $("login-error").textContent = "";
  const r = await od.requestOtp(loginEmail, $("server-url").value);
  $("btn-send").disabled = false;
  if (!r.ok) {
    $("login-error").textContent = r.error.message;
    return;
  }
  $("code-email").textContent = loginEmail;
  $("form-email").hidden = true;
  $("form-code").hidden = false;
  $("code").value = "";
  $("code").focus();
});

$("form-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("btn-verify").disabled = true;
  $("login-error").textContent = "";
  const r = await od.verify(loginEmail, $("code").value);
  $("btn-verify").disabled = false;
  if (!r.ok) {
    $("login-error").textContent = r.error.message;
    $("code").select();
    return;
  }
  await boot();
});
$("code").addEventListener("input", () => {
  $("code").value = $("code").value.replace(/\D/g, "").slice(0, 6);
  if ($("code").value.length === 6) $("form-code").requestSubmit();
});
$("btn-back").addEventListener("click", () => showLogin());
$("btn-resend").addEventListener("click", async () => {
  const r = await od.requestOtp(loginEmail);
  $("login-error").textContent = r.ok ? "" : r.error.message;
  if (r.ok) toast("Kode baru sudah dikirim");
});

od.onSignedOut(() => {
  closeViewer(null);
  closeHost(null);
  me = null;
  showLogin("Sesi Anda berakhir. Silakan masuk lagi.");
});

// ── home ────────────────────────────────────────────────────────────────────
function showHome() {
  show("home");
  $("my-id").textContent = fmtId(me.device?.id);
  $("my-name").textContent = me.device ? `${me.device.name} · ${platformName(me.platform)}` : "";
  $("me-email").textContent = me.email;
  $("auto-own").checked = me.settings.autoAcceptOwn;
  renderPermissions();
  refreshDevices();
}

function renderPermissions() {
  const box = $("perm-warnings");
  box.textContent = "";
  const p = me.permissions;
  const add = (text, which) => {
    const row = document.createElement("div");
    row.className = "warn perm";
    const span = document.createElement("span");
    span.textContent = text;
    const btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Buka Pengaturan";
    btn.onclick = () => od.openPermissions(which);
    row.append(span, btn);
    box.append(row);
  };
  if (p.screen !== "granted") add("macOS belum mengizinkan perekaman layar: orang lain tidak bisa melihat layar Mac ini. Setelah mengizinkan, buka ulang aplikasi.", "screen");
  if (!p.accessibility) add("macOS belum mengizinkan Aksesibilitas: orang lain bisa melihat tapi tidak bisa mengendalikan Mac ini.", "accessibility");
}

async function refreshDevices() {
  let data;
  try {
    data = await call(od.devices(), { quiet: true });
  } catch {
    return;
  }
  const ul = $("devices");
  ul.textContent = "";
  for (const d of data.devices) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `dot${d.online ? " on" : ""}`;
    dot.title = d.online ? "Online" : "Offline";
    const name = document.createElement("div");
    name.className = "name";
    const b = document.createElement("b");
    b.textContent = d.name + (d.current ? " (perangkat ini)" : "");
    const small = document.createElement("small");
    small.className = "muted";
    small.textContent = `${fmtId(d.id)} · ${platformName(d.platform)}`;
    name.append(b, small);
    li.append(dot, name);
    if (!d.current) {
      const go = document.createElement("button");
      go.className = "small primary";
      go.textContent = "Sambungkan";
      go.disabled = !d.online;
      go.onclick = () => startConnect(d.id, "control");
      const rm = document.createElement("button");
      rm.className = "small ghost";
      rm.textContent = "Hapus";
      rm.title = "Keluarkan perangkat ini dari akun (mis. laptop hilang)";
      rm.onclick = async () => {
        if (!confirm(`Hapus "${d.name}" dari akun Anda? Perangkat itu akan keluar dan ID-nya tidak berlaku lagi.`)) return;
        await call(od.removeDevice(d.id)).catch(() => {});
        refreshDevices();
      };
      li.append(go, rm);
    }
    ul.append(li);
  }
}
setInterval(() => {
  if (me && !$("view-home").hidden) refreshDevices();
}, 15000);

$("audit-box").addEventListener("toggle", async () => {
  if (!$("audit-box").open) return;
  const tbody = $("audit");
  tbody.textContent = "";
  let data;
  try {
    data = await call(od.audit());
  } catch {
    return;
  }
  for (const e of data.entries) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(e.ts).toLocaleString("id-ID"),
      EVENTS[e.event] || e.event,
      e.email || "",
      [e.peer_email, e.peer_device_id && fmtId(e.peer_device_id)].filter(Boolean).join(" · "),
      [e.detail, e.ip].filter(Boolean).join(" · "),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }
});

$("auto-own").addEventListener("change", (e) => od.setSettings({ autoAcceptOwn: e.target.checked }));
$("btn-logout").addEventListener("click", async () => {
  if (host || viewer) {
    if (!confirm("Ada sesi yang sedang berjalan. Keluar tetap?")) return;
  }
  await od.logout();
});

od.onSocket((state) => {
  const el = $("status");
  el.className = `status ${state === "online" ? "online" : state === "connecting" ? "" : "offline"}`;
  $("status-text").textContent =
    { online: "Online", connecting: "Menghubungkan…", offline: "Terputus, mencoba lagi…", replaced: "Masuk di jendela lain" }[state] || state;
  if (state === "online") refreshDevices();
});

// ── connecting as viewer ────────────────────────────────────────────────────
$("target").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
  e.target.value = digits.replace(/(\d{3})(?=\d)/g, "$1 ");
});

$("form-connect").addEventListener("submit", (e) => {
  e.preventDefault();
  startConnect($("target").value.replace(/\D/g, ""), $("mode").value);
});

let requestSeq = 0;
async function startConnect(target, mode) {
  if (viewer || pendingSession) return toast("Masih ada sesi yang berjalan", "error");
  const requestId = `r${++requestSeq}`;
  pendingSession = { requestId, target, sessionId: null };
  $("btn-connect").disabled = true;
  $("pending-box").hidden = false;
  $("pending-text").textContent = `Menghubungi ${fmtId(target)}…`;
  try {
    await call(od.send({ type: "connect", requestId, target, mode }));
  } catch {
    clearPending();
  }
}

function clearPending() {
  pendingSession = null;
  $("btn-connect").disabled = false;
  $("pending-box").hidden = true;
}

$("btn-cancel").addEventListener("click", () => {
  if (pendingSession?.sessionId) od.send({ type: "end", sessionId: pendingSession.sessionId });
  clearPending();
});

// ── signaling messages ──────────────────────────────────────────────────────
od.onSignal((m) => {
  switch (m.type) {
    case "pending":
      if (pendingSession && pendingSession.requestId === m.requestId) {
        pendingSession.sessionId = m.sessionId;
        $("pending-text").textContent = `Menunggu persetujuan dari ${fmtId(m.target)}…`;
      }
      return;
    case "connect-error":
      if (pendingSession && pendingSession.requestId === m.requestId) clearPending();
      toast(m.message, "error");
      return;
    case "incoming":
      return showIncoming(m);
    case "session-start":
      if (m.role === "viewer") {
        clearPending();
        startViewer(m);
      } else {
        closeIncoming(m.sessionId);
        startHost(m);
      }
      return;
    case "signal":
      if (viewer && viewer.id === m.sessionId) viewer.onSignal(m.data);
      else if (host && host.id === m.sessionId) host.onSignal(m.data);
      return;
    case "ended": {
      const why = REASONS[m.reason] || m.reason;
      if (pendingSession && pendingSession.sessionId === m.sessionId) {
        clearPending();
        toast(why, "error");
      }
      closeIncoming(m.sessionId);
      if (viewer && viewer.id === m.sessionId) closeViewer(why);
      if (host && host.id === m.sessionId) closeHost(why);
      return;
    }
  }
});

// ── incoming request (host side) ────────────────────────────────────────────
let incomingId = null;
function showIncoming(m) {
  incomingId = m.sessionId;
  $("in-email").textContent = m.from.email;
  $("in-device").textContent = `${m.from.deviceName}, ${platformName(m.from.platform)}`;
  $("in-mode").textContent = m.mode === "view" ? "melihat layar" : "mengendalikan";
  $("in-view").hidden = m.mode === "view";
  const dlg = $("incoming");
  if (!dlg.open) dlg.showModal();
}
function answerIncoming(accept, viewOnly = false) {
  if (incomingId) od.send({ type: "respond", sessionId: incomingId, accept, viewOnly });
  incomingId = null;
  $("incoming").close();
}
function closeIncoming(sessionId) {
  if (incomingId === sessionId) {
    incomingId = null;
    $("incoming").close();
  }
}
$("in-accept").addEventListener("click", () => answerIncoming(true));
$("in-view").addEventListener("click", () => answerIncoming(true, true));
$("in-reject").addEventListener("click", () => answerIncoming(false));
$("incoming").addEventListener("cancel", (e) => {
  e.preventDefault();
  answerIncoming(false);
});

// ── WebRTC plumbing shared by both roles ────────────────────────────────────
function makePeer(sessionId, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  const queued = [];
  const signal = (data) => od.send({ type: "signal", sessionId, data });
  pc.onicecandidate = (e) => {
    if (e.candidate) signal({ candidate: e.candidate.toJSON() });
  };
  async function onSignal(data) {
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of queued.splice(0)) await pc.addIceCandidate(c);
        if (data.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          signal({ sdp: pc.localDescription.toJSON() });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else queued.push(data.candidate);
      }
    } catch (e) {
      console.error("signal", e);
    }
  }
  return { pc, signal, onSignal };
}

/** "Langsung" when the media flows peer-to-peer, "Relay" when it goes through TURN. */
async function routeOf(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && (pair = s));
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
  const rtt = pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null;
  return { relay, rtt };
}

// ── host: share this screen ─────────────────────────────────────────────────
async function startHost(m) {
  closeHost(null);
  const { pc, signal, onSignal } = makePeer(m.sessionId, m.iceServers);
  host = { id: m.sessionId, peer: m.peer, mode: m.mode, pc, onSignal, stream: null };
  $("hosting-box").hidden = false;
  $("hosting-text").textContent = `${m.mode === "view" ? "Layar dilihat oleh" : "Dikendalikan oleh"} ${m.peer.email}`;

  let inputReason = null;
  if (m.mode === "control") {
    const st = await od.hostInputStatus();
    inputReason = st.ok ? st.data.reason : "Status input tidak diketahui";
  }

  let screens = [];
  try {
    screens = await call(od.screens(), { quiet: true }).catch(() => []);
    const first = screens.find((s) => s.primary) || screens[0];
    if (first) await od.selectScreen(first.id);
    host.screenId = first?.id;
    host.stream = await captureScreen();
  } catch (e) {
    console.error(e);
    toast("Tidak bisa merekam layar. Di macOS, izinkan Perekaman Layar untuk aplikasi ini.", "error");
    od.send({ type: "end", sessionId: m.sessionId });
    closeHost(null);
    return;
  }
  const track = host.stream.getVideoTracks()[0];
  host.sender = pc.addTrack(track, host.stream);
  tuneSender(host.sender);

  const ctrl = pc.createDataChannel("ctrl", { ordered: true });
  const move = pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 });
  const fromViewer = (raw) => {
    if (!host) return;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev.t === "screen") return switchScreen(ev.id); // allowed in view-only too
    if (host.mode === "control") od.input(ev); // main checks the session mode again
  };
  ctrl.onopen = () =>
    ctrl.send(
      JSON.stringify({
        t: "hello",
        platform: me.platform,
        screens: screens.map(({ id, name }) => ({ id, name })),
        screen: host.screenId,
        inputReason,
      }),
    );
  ctrl.onmessage = (e) => fromViewer(e.data);
  move.onmessage = (e) => fromViewer(e.data);
  host.ctrl = ctrl;

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      toast("Koneksi ke penonton gagal", "error");
      od.send({ type: "end", sessionId: m.sessionId });
      closeHost(null);
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  signal({ sdp: pc.localDescription.toJSON() });
}

function captureScreen() {
  if (me.fakeCapture) return Promise.resolve(fakeScreen());
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false }).then((s) => {
    const t = s.getVideoTracks()[0];
    if (t) t.contentHint = "detail"; // favour sharp text over motion smoothness
    return s;
  });
}

/** OFFICEDESK_FAKE_CAPTURE=1 (development): a moving test picture, so WebRTC can be tested without screen permission. */
function fakeScreen() {
  const c = document.createElement("canvas");
  c.width = 1280;
  c.height = 720;
  const g = c.getContext("2d");
  let n = 0;
  setInterval(() => {
    g.fillStyle = "#1e3a8a";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "bold 64px system-ui";
    g.fillText(`Layar uji ${me.device?.id || ""}`, 80, 160);
    g.font = "32px system-ui";
    g.fillText(new Date().toLocaleTimeString("id-ID") + `  frame ${n++}`, 80, 240);
    g.fillStyle = "#f59e0b";
    g.fillRect(80 + ((n * 8) % 1100), 320, 100, 100);
  }, 33);
  return c.captureStream(30);
}

async function tuneSender(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 8_000_000;
    p.degradationPreference = "maintain-resolution";
    await sender.setParameters(p);
  } catch (e) {
    console.warn("setParameters", e);
  }
}

async function switchScreen(id) {
  if (!host || typeof id !== "string" || id === host.screenId) return;
  try {
    await call(od.selectScreen(id), { quiet: true });
    const stream = await captureScreen();
    await host.sender.replaceTrack(stream.getVideoTracks()[0]);
    for (const t of host.stream.getTracks()) t.stop();
    host.stream = stream;
    host.screenId = id;
    if (host.ctrl?.readyState === "open") host.ctrl.send(JSON.stringify({ t: "screen", screen: id }));
  } catch (e) {
    console.error("switchScreen", e);
  }
}

function closeHost(why) {
  if (!host) return;
  const h = host;
  host = null;
  try {
    h.stream?.getTracks().forEach((t) => t.stop());
    h.pc.close();
  } catch {}
  od.endHosting();
  $("hosting-box").hidden = true;
  if (why) toast(why);
}
$("btn-host-end").addEventListener("click", () => {
  if (host) od.send({ type: "end", sessionId: host.id });
  closeHost(null);
});

// ── viewer: show and control the remote screen ──────────────────────────────
function startViewer(m) {
  closeViewer(null);
  const { pc, onSignal } = makePeer(m.sessionId, m.iceServers);
  viewer = { id: m.sessionId, peer: m.peer, mode: m.mode, pc, onSignal, ctrl: null, move: null, keys: new Set(), buttons: new Set() };
  const video = $("remote");
  video.srcObject = null;
  video.classList.toggle("control", m.mode === "control");
  $("overlay").hidden = false;
  $("overlay").textContent = "Menunggu gambar…";
  $("peer-label").textContent = `${m.peer.deviceName} · ${m.peer.email}`;
  $("mode-badge").textContent = m.mode === "view" ? "Lihat saja" : "Kendali penuh";
  $("net-badge").textContent = "Menyambung…";
  $("screen-select").hidden = true;
  // Mac ⇄ PC: by default the key under your thumb (Cmd on Mac, Ctrl on PC) does the same job on the other side.
  $("swap-mods").checked = (me.platform === "darwin") !== (m.peer.platform === "darwin");
  show("viewer");

  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  video.onloadeddata = () => {
    $("overlay").hidden = true;
    video.focus();
  };
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    if (ch.label === "move") viewer.move = ch;
    if (ch.label === "ctrl") {
      viewer.ctrl = ch;
      ch.onmessage = (ev) => onHostMessage(JSON.parse(ev.data));
    }
  };
  pc.onconnectionstatechange = () => {
    if (!viewer) return;
    if (pc.connectionState === "connected") updateRoute();
    if (pc.connectionState === "failed") {
      toast("Koneksi gagal. Jaringan kedua perangkat mungkin butuh relay TURN di server.", "error");
      disconnectViewer();
    }
  };
  viewer.routeTimer = setInterval(updateRoute, 3000);
}

async function updateRoute() {
  if (!viewer) return;
  const r = await routeOf(viewer.pc).catch(() => null);
  if (!r) return;
  $("net-badge").textContent = `${r.relay ? "Lewat relay" : "Langsung (P2P)"}${r.rtt !== null ? ` · ${r.rtt} ms` : ""}`;
}

function onHostMessage(msg) {
  if (!viewer) return;
  if (msg.t === "hello") {
    const sel = $("screen-select");
    sel.textContent = "";
    for (const s of msg.screens || []) sel.append(new Option(s.name, s.id, false, s.id === msg.screen));
    sel.hidden = (msg.screens || []).length < 2;
    if (msg.inputReason && viewer.mode === "control") {
      toast(`Kendali tidak tersedia di perangkat itu: ${msg.inputReason}`, "error");
      viewer.mode = "view";
      $("mode-badge").textContent = "Lihat saja";
      $("remote").classList.remove("control");
    }
  } else if (msg.t === "screen") {
    $("screen-select").value = msg.screen;
  }
}

$("screen-select").addEventListener("change", (e) => sendCtrl({ t: "screen", id: e.target.value }));

function sendCtrl(ev) {
  if (viewer?.ctrl?.readyState === "open") viewer.ctrl.send(JSON.stringify(ev));
}
function sendMove(ev) {
  const ch = viewer?.move?.readyState === "open" ? viewer.move : viewer?.ctrl;
  if (ch?.readyState === "open") ch.send(JSON.stringify(ev));
}

function disconnectViewer() {
  if (viewer) od.send({ type: "end", sessionId: viewer.id });
  closeViewer(null);
}

function closeViewer(why) {
  if (!viewer) return;
  releaseAll();
  const v = viewer;
  viewer = null;
  clearInterval(v.routeTimer);
  try {
    v.pc.close();
  } catch {}
  $("remote").srcObject = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (me) showHome();
  if (why) toast(why);
}

$("btn-disconnect").addEventListener("click", disconnectViewer);
$("btn-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("stage").requestFullscreen();
});

// Input capture. Coordinates are normalized to the visible video picture (object-fit: contain leaves bars).
const video = $("remote");
const controlling = () => viewer && viewer.mode === "control";

function norm(e) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s;
  const h = vh * s;
  const left = r.left + (r.width - w) / 2;
  const top = r.top + (r.height - h) / 2;
  const x = (e.clientX - left) / w;
  const y = (e.clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: +x.toFixed(5), y: +y.toFixed(5) };
}

let lastMove = 0;
video.addEventListener("pointermove", (e) => {
  if (!controlling()) return;
  const now = performance.now();
  if (now - lastMove < 8) return; // ~120 Hz is plenty
  lastMove = now;
  const p = norm(e);
  if (p) sendMove({ t: "m", ...p });
});
video.addEventListener("pointerdown", (e) => {
  video.focus();
  if (!controlling() || e.button > 2) return;
  const p = norm(e);
  if (!p) return;
  e.preventDefault();
  video.setPointerCapture(e.pointerId);
  viewer.buttons.add(e.button);
  sendCtrl({ t: "b", b: e.button, d: true, ...p });
});
video.addEventListener("pointerup", (e) => {
  if (!controlling() || !viewer.buttons.has(e.button)) return;
  e.preventDefault();
  viewer.buttons.delete(e.button);
  const p = norm(e) || {};
  sendCtrl({ t: "b", b: e.button, d: false, ...p });
});
video.addEventListener("contextmenu", (e) => e.preventDefault());
video.addEventListener(
  "wheel",
  (e) => {
    if (!controlling()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    sendCtrl({ t: "w", dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) });
  },
  { passive: false },
);

const SWAP = { ControlLeft: "MetaLeft", ControlRight: "MetaRight", MetaLeft: "ControlLeft", MetaRight: "ControlRight" };
function keyCode(e) {
  return $("swap-mods").checked && SWAP[e.code] ? SWAP[e.code] : e.code;
}
function onKey(e, down) {
  if (!controlling() || document.activeElement !== video) return;
  e.preventDefault();
  e.stopPropagation();
  const code = keyCode(e);
  if (!code) return;
  if (down) viewer.keys.add(code);
  else viewer.keys.delete(code);
  sendCtrl({ t: "k", code, d: down });
}
window.addEventListener("keydown", (e) => onKey(e, true), true);
window.addEventListener("keyup", (e) => onKey(e, false), true);

/** Never leave a key or button stuck down on the other machine. */
function releaseAll() {
  if (!viewer) return;
  for (const code of viewer.keys) sendCtrl({ t: "k", code, d: false });
  for (const b of viewer.buttons) sendCtrl({ t: "b", b, d: false });
  viewer.keys.clear();
  viewer.buttons.clear();
}
window.addEventListener("blur", releaseAll);
video.addEventListener("blur", releaseAll);

boot();
