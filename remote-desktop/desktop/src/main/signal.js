"use strict";
// One WebSocket to the server per signed-in device, kept alive with reconnect + backoff.
// It lives in the main process so the session token never reaches the web page.
const WebSocket = require("ws");

class SignalClient {
  /**
   * @param {() => {url: string, token: string, autoAcceptOwn: boolean}} params
   * @param {(msg: object) => void} onMessage
   * @param {(state: string) => void} onState  "connecting" | "online" | "offline" | "auth-failed" | "replaced"
   */
  constructor(params, onMessage, onState) {
    this.params = params;
    this.onMessage = onMessage;
    this.onState = onState;
    this.ws = null;
    this.stopped = true;
    this.retry = 0;
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.retry = 0;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {}
    }
    this.ws = null;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  open() {
    const { url, token, autoAcceptOwn } = this.params();
    const wsUrl = url.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
    this.onState("connecting");
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    this.ws = ws;
    let terminal = false;

    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, autoAcceptOwn })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.retry = 0;
        this.onState("online");
      } else if (msg.type === "auth-failed" || msg.type === "replaced") {
        terminal = true;
        this.stopped = true;
        this.onState(msg.type);
      }
      this.onMessage(msg);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || terminal) return;
      this.onState("offline");
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++) + Math.random() * 500;
      this.timer = setTimeout(() => !this.stopped && this.open(), delay);
    });
  }
}

module.exports = { SignalClient };
