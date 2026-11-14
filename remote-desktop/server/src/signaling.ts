import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isDeviceId, type Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { RateLimiter } from "./ratelimit.ts";
import { iceServers } from "./turn.ts";

/*
 * Signaling protocol (JSON over one WebSocket per signed-in device, path /ws).
 *
 * client → server
 *   hello    { token, autoAcceptOwn? }            first message; nothing else is accepted before it
 *   settings { autoAcceptOwn }
 *   connect  { requestId, target, mode }           mode: "control" | "view"
 *   respond  { sessionId, accept, viewOnly? }      host answers an "incoming"
 *   signal   { sessionId, data }                   SDP / ICE, relayed to the other side of an active session
 *   end      { sessionId }
 *
 * server → client
 *   ready         { deviceId, email, deviceName }
 *   auth-failed   {}                                then the socket closes (4401)
 *   replaced      {}                                the same device signed in elsewhere (4000)
 *   connect-error { requestId, target, code, message }
 *   pending       { requestId, sessionId, target }  waiting for the host to accept
 *   incoming      { sessionId, from, mode }         to the host
 *   session-start { sessionId, role, peer, mode, iceServers }
 *   signal        { sessionId, data }
 *   ended         { sessionId, reason }
 */

export type Mode = "control" | "view";

interface Conn {
  ws: WebSocket;
  ip: string;
  email: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  autoAcceptOwn: boolean;
  msgRate: RateLimiter;
  alive: boolean;
}

interface RSession {
  id: string;
  viewer: string;
  host: string;
  viewerEmail: string;
  hostEmail: string;
  mode: Mode;
  state: "pending" | "active";
  startedAt: number;
  timer: NodeJS.Timeout | null;
}

export interface HubOptions {
  /** How long the host has to accept (ms). */
  pendingTimeoutMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
}

type Msg = Record<string, unknown> & { type?: unknown };

const peerInfo = (c: Conn) => ({ email: c.email, deviceId: c.deviceId, deviceName: c.deviceName, platform: c.platform });

export class Hub {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly auth: Auth;
  private readonly wss: WebSocketServer;
  private readonly online = new Map<string, Conn>();
  private readonly sessions = new Map<string, RSession>();
  // Stops connection-prompt spam: per requesting device, per IP, and prompts landing on one host.
  private readonly connectPerDevice = new RateLimiter(5, 10_000);
  private readonly connectPerIp = new RateLimiter(20, 10_000);
  private readonly promptsPerHost = new RateLimiter(10, 60_000);
  private readonly pendingTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly pingTimer: NodeJS.Timeout;
  private closed = false;

  constructor(cfg: Config, store: Store, auth: Auth, opts: HubOptions = {}) {
    this.cfg = cfg;
    this.store = store;
    this.auth = auth;
    this.pendingTimeoutMs = opts.pendingTimeoutMs ?? 60_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.pingTimer = setInterval(() => this.heartbeat(), opts.pingIntervalMs ?? 30_000);
    this.pingTimer.unref();
  }

  attach(server: Server, clientIp: (req: IncomingMessage) => string): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, clientIp(req)));
    });
  }

  isOnline(deviceId: string): boolean {
    return this.online.has(deviceId);
  }

  /** Disconnects a device right away (it was removed or signed out). */
  kick(deviceId: string): void {
    const c = this.online.get(deviceId);
    if (c) c.ws.close(4401, "signed out");
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const s of this.sessions.values()) if (s.timer) clearTimeout(s.timer);
    this.sessions.clear();
    for (const c of this.online.values()) c.ws.terminate();
    this.online.clear();
    this.wss.close();
  }

  // ── connection lifecycle ───────────────────────────────────────────────
  private onSocket(ws: WebSocket, ip: string): void {
    let conn: Conn | null = null;
    const helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), this.helloTimeoutMs);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: Msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (!conn) {
        if (msg.type !== "hello") return;
        clearTimeout(helloTimer);
        conn = this.hello(ws, ip, msg);
        return;
      }
      if (!conn.msgRate.hit("m")) return;
      this.dispatch(conn, msg);
    });

    ws.on("pong", () => {
      if (conn) conn.alive = true;
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (conn) this.onClose(conn);
    });
    ws.on("error", () => {});
  }

  private hello(ws: WebSocket, ip: string, msg: Msg): Conn | null {
    const p = this.auth.authenticate(msg.token);
    const device = p ? this.store.getDevice(p.deviceId) : undefined;
    if (!p || !device) {
      send(ws, { type: "auth-failed" });
      ws.close(4401, "auth failed");
      return null;
    }
    const old = this.online.get(device.id);
    if (old) {
      send(old.ws, { type: "replaced" });
      old.ws.close(4000, "replaced");
      this.onClose(old);
    }
    const conn: Conn = {
      ws,
      ip,
      email: p.email,
      deviceId: device.id,
      deviceName: device.name,
      platform: device.platform,
      autoAcceptOwn: msg.autoAcceptOwn !== false,
      msgRate: new RateLimiter(200, 1000),
      alive: true,
    };
    this.online.set(device.id, conn);
    this.store.touchDevice(device.id, Date.now());
    send(ws, { type: "ready", deviceId: device.id, email: p.email, deviceName: device.name });
    return conn;
  }

  private onClose(conn: Conn): void {
    if (this.closed || this.online.get(conn.deviceId) !== conn) return;
    this.online.delete(conn.deviceId);
    this.store.touchDevice(conn.deviceId, Date.now());
    for (const s of [...this.sessions.values()]) {
      if (s.viewer === conn.deviceId || s.host === conn.deviceId) this.endSession(s, "peer_disconnected", conn.deviceId);
    }
  }

  private heartbeat(): void {
    for (const c of this.online.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {}
    }
    this.connectPerDevice.sweep();
    this.connectPerIp.sweep();
    this.promptsPerHost.sweep();
  }

  // ── messages ───────────────────────────────────────────────────────────
  private dispatch(c: Conn, msg: Msg): void {
    switch (msg.type) {
      case "settings":
        if (typeof msg.autoAcceptOwn === "boolean") c.autoAcceptOwn = msg.autoAcceptOwn;
        return;
      case "connect":
        return this.onConnect(c, msg);
      case "respond":
        return this.onRespond(c, msg);
      case "signal":
        return this.onSignal(c, msg);
      case "end": {
        const s = this.sessionOf(c, msg.sessionId);
        if (s) this.endSession(s, "hangup", c.deviceId);
        return;
      }
    }
  }

  private onConnect(c: Conn, msg: Msg): void {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 64) : "";
    const target = msg.target;
    const mode: Mode = msg.mode === "view" ? "view" : "control";
    const fail = (code: string, message: string) =>
      send(c.ws, { type: "connect-error", requestId, target: typeof target === "string" ? target : "", code, message });

    if (!isDeviceId(target)) return fail("bad_target", "ID perangkat harus 9 angka");
    if (target === c.deviceId) return fail("self", "Itu ID perangkat ini sendiri");
    if (!this.connectPerDevice.hit(c.deviceId) || !this.connectPerIp.hit(c.ip)) {
      return fail("rate_limited", "Terlalu banyak permintaan. Tunggu sebentar");
    }
    const host = this.online.get(target);
    if (!host) return fail("offline", "Perangkat tidak online atau ID salah");
    for (const s of this.sessions.values()) {
      if (s.host === target && s.state === "active") return fail("busy", "Perangkat sedang dikendalikan orang lain");
      if (s.host === target && s.viewer === c.deviceId) return fail("already_pending", "Permintaan sudah dikirim");
    }

    const s: RSession = {
      id: randomBytes(16).toString("hex"),
      viewer: c.deviceId,
      host: target,
      viewerEmail: c.email,
      hostEmail: host.email,
      mode,
      state: "pending",
      startedAt: Date.now(),
      timer: null,
    };

    // The same account on both ends (e.g. reaching your own office PC from home) may skip the prompt,
    // unless the host turned that off.
    if (host.email === c.email && host.autoAcceptOwn) {
      this.sessions.set(s.id, s);
      send(c.ws, { type: "pending", requestId, sessionId: s.id, target });
      this.startSession(s, true);
      return;
    }

    if (!this.promptsPerHost.hit(target)) return fail("target_rate_limited", "Perangkat itu menerima terlalu banyak permintaan");
    this.sessions.set(s.id, s);
    s.timer = setTimeout(() => this.endSession(s, "timeout", null), this.pendingTimeoutMs);
    send(c.ws, { type: "pending", requestId, sessionId: s.id, target });
    send(host.ws, { type: "incoming", sessionId: s.id, from: peerInfo(c), mode });
    this.store.audit({
      event: "session_request",
      email: c.email,
      peerEmail: host.email,
      deviceId: c.deviceId,
      peerDeviceId: host.deviceId,
      ip: c.ip,
      detail: mode,
    });
  }

  private onRespond(c: Conn, msg: Msg): void {
    const s = this.sessionOf(c, msg.sessionId);
    if (!s || s.host !== c.deviceId || s.state !== "pending") return;
    if (msg.accept !== true) {
      this.endSession(s, "rejected", c.deviceId);
      return;
    }
    for (const other of this.sessions.values()) {
      if (other !== s && other.host === s.host && other.state === "active") {
        this.endSession(s, "busy", null);
        return;
      }
    }
    if (msg.viewOnly === true) s.mode = "view";
    this.startSession(s, false);
  }

  private startSession(s: RSession, auto: boolean): void {
    const viewer = this.online.get(s.viewer);
    const host = this.online.get(s.host);
    if (!viewer || !host) {
      this.endSession(s, "peer_disconnected", null);
      return;
    }
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.state = "active";
    s.startedAt = Date.now();
    // Each side gets its own TURN credential, issued only for an accepted session.
    send(viewer.ws, {
      type: "session-start",
      sessionId: s.id,
      role: "viewer",
      peer: peerInfo(host),
      mode: s.mode,
      iceServers: iceServers(this.cfg),
    });
    send(host.ws, {
      type: "session-start",
      sessionId: s.id,
      role: "host",
      peer: peerInfo(viewer),
      mode: s.mode,
      iceServers: iceServers(this.cfg),
    });
    this.store.audit({
      event: "session_start",
      email: s.viewerEmail,
      peerEmail: s.hostEmail,
      deviceId: s.viewer,
      peerDeviceId: s.host,
      ip: viewer.ip,
      detail: `${s.mode}${auto ? " (own account, no prompt)" : ""}`,
    });
  }

  private onSignal(c: Conn, msg: Msg): void {
    const s = this.sessionOf(c, msg.sessionId);
    if (!s || s.state !== "active" || msg.data === undefined) return;
    const other = this.online.get(s.viewer === c.deviceId ? s.host : s.viewer);
    if (other) send(other.ws, { type: "signal", sessionId: s.id, data: msg.data });
  }

  /** The session with this id, only if the connection is one of its two parties. */
  private sessionOf(c: Conn, id: unknown): RSession | null {
    if (typeof id !== "string") return null;
    const s = this.sessions.get(id);
    if (!s || (s.viewer !== c.deviceId && s.host !== c.deviceId)) return null;
    return s;
  }

  private endSession(s: RSession, reason: string, by: string | null): void {
    if (!this.sessions.delete(s.id)) return;
    if (s.timer) clearTimeout(s.timer);
    for (const id of [s.viewer, s.host]) {
      const c = this.online.get(id);
      if (c) send(c.ws, { type: "ended", sessionId: s.id, reason });
    }
    const wasActive = s.state === "active";
    this.store.audit({
      event: wasActive ? "session_end" : "session_refused",
      email: s.viewerEmail,
      peerEmail: s.hostEmail,
      deviceId: s.viewer,
      peerDeviceId: s.host,
      detail: wasActive
        ? `${reason}; ${Math.round((Date.now() - s.startedAt) / 1000)}s${by ? `; by ${by}` : ""}`
        : reason,
    });
  }
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
