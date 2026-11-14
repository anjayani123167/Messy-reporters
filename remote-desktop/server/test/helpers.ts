import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createApp, type App, type AppOptions } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";

export function testConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    ALLOWED_EMAIL_DOMAINS: "kantor.co.id",
    DB_PATH: ":memory:",
    STUN_URLS: "",
    ...extra,
  });
}

/** A mailer that keeps the last code per address instead of sending mail. */
export function fakeMailer() {
  const codes = new Map<string, string>();
  return {
    codes,
    async sendOtp(to: string, code: string) {
      codes.set(to, code);
    },
  };
}

export interface Running {
  app: App;
  base: string;
  wsUrl: string;
  mail: ReturnType<typeof fakeMailer>;
  close(): Promise<void>;
}

export async function start(cfg: Config = testConfig(), opts: AppOptions = {}): Promise<Running> {
  const mail = fakeMailer();
  const app = createApp(cfg, { mailer: mail, ...opts });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, mail, close: () => app.close() };
}

export async function api(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Full OTP sign-in; returns the token and the device the server created. */
export async function login(r: Running, email: string, name = "PC") {
  const a = await api(r.base, "POST", "/api/auth/request-otp", { email });
  if (a.status !== 200) throw new Error(`request-otp ${a.status} ${JSON.stringify(a.body)}`);
  const code = r.mail.codes.get(email.toLowerCase())!;
  const b = await api(r.base, "POST", "/api/auth/verify-otp", { email, code, device: { name, platform: "darwin" } });
  if (b.status !== 200) throw new Error(`verify-otp ${b.status} ${JSON.stringify(b.body)}`);
  return b.body as { token: string; email: string; device: { id: string }; deviceKey: string };
}

/** A signaling client that queues every message so tests can await the next one of a type. */
export class Client {
  readonly ws: WebSocket;
  private readonly queue: any[] = [];
  private waiters: { type: string; resolve: (m: any) => void }[] = [];
  closed: Promise<number>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closed = new Promise((r) => this.ws.on("close", (code) => r(code)));
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.queue.push(m);
    });
  }

  static async open(url: string, token: string, extra: object = {}): Promise<Client> {
    const c = new Client(url);
    await new Promise((r, j) => {
      c.ws.once("open", r);
      c.ws.once("error", j);
    });
    c.send({ type: "hello", token, ...extra });
    return c;
  }

  send(m: object): void {
    this.ws.send(JSON.stringify(m));
  }

  next(type: string, timeoutMs = 2000): Promise<any> {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { type, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for "${type}"; queued: ${JSON.stringify(this.queue.map((m) => m.type))}`));
      }, timeoutMs);
    });
  }

  /** Resolves true if a message of this type arrives within the window. */
  async gets(type: string, windowMs = 200): Promise<boolean> {
    try {
      await this.next(type, windowMs);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.ws.close();
  }
}
