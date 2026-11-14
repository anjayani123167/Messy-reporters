import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthError, isDeviceId, type Auth, type Principal } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { Hub } from "./signaling.ts";

const MAX_BODY = 8 * 1024;

export function clientIpFor(cfg: Config): (req: IncomingMessage) => string {
  return (req) => {
    if (cfg.trustProxy) {
      // The trusted proxy (Caddy) appends the address it saw; anything to the left is client-supplied.
      const xff = req.headers["x-forwarded-for"];
      const parts = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress ?? "?";
  };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "bad_content_type", "Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "Invalid JSON");
  }
}

export interface HttpDeps {
  cfg: Config;
  store: Store;
  auth: Auth;
  hub: Hub;
}

export function createHttpHandler({ cfg, store, auth, hub }: HttpDeps) {
  const ipOf = clientIpFor(cfg);

  function principal(req: IncomingMessage): Principal {
    const h = req.headers.authorization ?? "";
    const p = h.startsWith("Bearer ") ? auth.authenticate(h.slice(7).trim()) : null;
    if (!p) throw new HttpError(401, "unauthorized", "Sesi berakhir. Silakan masuk lagi");
    return p;
  }

  function ownDevice(p: Principal, id: string) {
    const d = isDeviceId(id) ? store.getDevice(id) : undefined;
    if (!d || d.owner_email !== p.email) throw new HttpError(404, "not_found", "Perangkat tidak ditemukan");
    return d;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = ipOf(req);
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }

      if (method === "GET" && path === "/api/info") {
        return json(res, 200, { appName: cfg.appName, allowedDomains: cfg.allowedDomains });
      }

      if (method === "POST" && path === "/api/auth/request-otp") {
        const body = await readJson(req);
        await auth.requestOtp(body.email, ip);
        return json(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/api/auth/verify-otp") {
        const body = await readJson(req);
        const device = (body.device && typeof body.device === "object" ? body.device : {}) as Record<string, unknown>;
        return json(res, 200, auth.verifyOtp(body.email, body.code, device, ip));
      }

      if (method === "POST" && path === "/api/auth/logout") {
        const p = principal(req);
        auth.logout(p, ip);
        hub.kick(p.deviceId);
        return json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/api/me") {
        const p = principal(req);
        const d = store.getDevice(p.deviceId);
        return json(res, 200, {
          email: p.email,
          device: d ? { id: d.id, name: d.name, platform: d.platform } : null,
        });
      }

      if (method === "GET" && path === "/api/devices") {
        const p = principal(req);
        const devices = store.devicesOf(p.email).map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          lastSeen: d.last_seen,
          online: hub.isOnline(d.id),
          current: d.id === p.deviceId,
        }));
        return json(res, 200, { devices });
      }

      const devMatch = /^\/api\/devices\/([0-9]{9})$/.exec(path);
      if (devMatch && method === "PATCH") {
        const p = principal(req);
        const d = ownDevice(p, devMatch[1]);
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : "";
        if (!name) throw new HttpError(400, "bad_name", "Nama tidak boleh kosong");
        store.renameDevice(d.id, name);
        return json(res, 200, { ok: true });
      }
      if (devMatch && method === "DELETE") {
        // Removing a device (e.g. a lost laptop) signs it out everywhere and frees its ID.
        const p = principal(req);
        const d = ownDevice(p, devMatch[1]);
        hub.kick(d.id);
        store.deleteDevice(d.id);
        store.audit({ event: "device_removed", email: p.email, deviceId: p.deviceId, peerDeviceId: d.id, ip });
        return json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/api/audit") {
        const p = principal(req);
        return json(res, 200, { entries: store.auditFor(p.email) });
      }

      throw new HttpError(404, "not_found", "Not found");
    } catch (e) {
      if (e instanceof AuthError || e instanceof HttpError) {
        return json(res, e.status, { error: e.code, message: e.message });
      }
      console.error("[http]", method, path, e);
      return json(res, 500, { error: "server_error", message: "Terjadi kesalahan di server" });
    }
  };
}
