import { createHmac, randomBytes } from "node:crypto";
import type { Config } from "./config.ts";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * STUN + short-lived TURN credentials (coturn `use-auth-secret`, the "TURN REST API" scheme).
 * The username is "<expiry>:<random tag>" — never the email or device ID, because TURN sends it in clear text.
 * The shared secret never leaves the server.
 */
export function iceServers(cfg: Config, now: number = Date.now()): IceServer[] {
  const out: IceServer[] = [];
  if (cfg.stunUrls.length) out.push({ urls: cfg.stunUrls });
  if (cfg.turn) {
    const t = cfg.turn;
    const username = `${Math.floor(now / 1000) + t.ttlSec}:${randomBytes(6).toString("hex")}`;
    const credential = createHmac("sha1", t.secret).update(username).digest("base64");
    const urls = [`turn:${t.host}:${t.port}?transport=udp`, `turn:${t.host}:${t.port}?transport=tcp`];
    // TURN over TLS on 443 looks like HTTPS and gets through strict office firewalls.
    if (t.tlsPort) urls.push(`turns:${t.host}:${t.tlsPort}?transport=tcp`);
    out.push({ urls, username, credential });
  }
  return out;
}
