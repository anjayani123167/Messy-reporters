import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { DeviceRow, Store } from "./db.ts";
import type { Mailer } from "./mailer.ts";
import { RateLimiter } from "./ratelimit.ts";

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const DEVICE_ID_RE = /^[1-9][0-9]{8}$/;
const PLATFORMS = new Set(["win32", "darwin", "linux"]);

/** Lower-cases and trims; returns null for anything that is not a single plain address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/** The part after "@" must equal one of the allowed domains exactly (no subdomains, no suffix tricks). */
export function domainAllowed(email: string, allowed: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return allowed.includes(email.slice(at + 1));
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function isDeviceId(v: unknown): v is string {
  return typeof v === "string" && DEVICE_ID_RE.test(v);
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return s.slice(0, 64) || "Perangkat tanpa nama";
}

export interface DeviceClaim {
  /** Present when this install was registered before. */
  id?: unknown;
  key?: unknown;
  name?: unknown;
  platform?: unknown;
}

export interface LoginResult {
  token: string;
  email: string;
  device: { id: string; name: string; platform: string };
  /** Only returned when a new device was created: the app must keep it to log in again as the same device. */
  deviceKey?: string;
}

export interface Principal {
  email: string;
  deviceId: string;
  tokenHash: string;
}

export interface AuthOptions {
  now?: () => number;
}

export class Auth {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly mailer: Mailer;
  private readonly now: () => number;
  private readonly secret: string;
  // A real person needs one or two codes; these stop mailbox flooding and code guessing.
  private readonly otpPerEmail: RateLimiter;
  private readonly otpPerIp: RateLimiter;
  private readonly verifyPerIp: RateLimiter;

  constructor(cfg: Config, store: Store, mailer: Mailer, opts: AuthOptions = {}) {
    this.cfg = cfg;
    this.store = store;
    this.mailer = mailer;
    this.now = opts.now ?? Date.now;
    this.secret = store.serverSecret(cfg.serverSecret);
    this.otpPerEmail = new RateLimiter(3, 10 * 60_000, this.now);
    this.otpPerIp = new RateLimiter(20, 60 * 60_000, this.now);
    this.verifyPerIp = new RateLimiter(30, 10 * 60_000, this.now);
  }

  sweep(): void {
    this.otpPerEmail.sweep();
    this.otpPerIp.sweep();
    this.verifyPerIp.sweep();
    this.store.purgeExpired(this.now());
  }

  private codeHash(email: string, code: string): string {
    return createHmac("sha256", this.secret).update(`${email}:${code}`).digest("hex");
  }

  async requestOtp(rawEmail: unknown, ip: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new AuthError("invalid_email", 400, "Alamat email tidak valid");
    if (!domainAllowed(email, this.cfg.allowedDomains)) {
      this.store.audit({ event: "otp_refused_domain", email, ip }, this.now());
      const list = this.cfg.allowedDomains.map((d) => "@" + d).join(", ");
      throw new AuthError("domain_not_allowed", 403, `Hanya email kantor (${list}) yang bisa masuk`);
    }
    if (!this.otpPerIp.hit(ip) || !this.otpPerEmail.hit(email)) {
      throw new AuthError("rate_limited", 429, "Terlalu banyak permintaan kode. Coba lagi beberapa menit lagi");
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.store.putOtp(email, this.codeHash(email, code), this.now() + this.cfg.otpTtlMs);
    try {
      await this.mailer.sendOtp(email, code, Math.round(this.cfg.otpTtlMs / 60_000));
    } catch (e) {
      this.store.deleteOtp(email);
      console.error("[mail] send failed:", (e as Error).message);
      throw new AuthError("mail_failed", 502, "Gagal mengirim email kode. Hubungi admin");
    }
    this.store.audit({ event: "otp_sent", email, ip }, this.now());
  }

  verifyOtp(rawEmail: unknown, rawCode: unknown, claim: DeviceClaim, ip: string): LoginResult {
    const email = normalizeEmail(rawEmail);
    const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
    if (!email || !/^[0-9]{6}$/.test(code)) throw new AuthError("invalid_code", 400, "Kode harus 6 angka");
    if (!domainAllowed(email, this.cfg.allowedDomains)) {
      throw new AuthError("domain_not_allowed", 403, "Email ini tidak diizinkan");
    }
    if (!this.verifyPerIp.hit(ip)) {
      throw new AuthError("rate_limited", 429, "Terlalu banyak percobaan. Coba lagi beberapa menit lagi");
    }

    const row = this.store.getOtp(email);
    const now = this.now();
    if (!row || row.expires_at <= now) {
      if (row) this.store.deleteOtp(email);
      throw new AuthError("code_expired", 400, "Kode sudah kedaluwarsa atau belum diminta. Minta kode baru");
    }
    if (row.attempts >= this.cfg.otpMaxAttempts) {
      this.store.deleteOtp(email);
      throw new AuthError("too_many_attempts", 400, "Terlalu banyak kode salah. Minta kode baru");
    }
    const expected = Buffer.from(row.code_hash, "hex");
    const given = Buffer.from(this.codeHash(email, code), "hex");
    if (!timingSafeEqual(expected, given)) {
      this.store.bumpOtpAttempts(email);
      this.store.audit({ event: "login_failed", email, ip, detail: "wrong code" }, now);
      const left = this.cfg.otpMaxAttempts - row.attempts - 1;
      if (left <= 0) this.store.deleteOtp(email);
      throw new AuthError("wrong_code", 400, left > 0 ? `Kode salah. Sisa ${left} percobaan` : "Kode salah. Minta kode baru");
    }
    this.store.deleteOtp(email);

    const { device, deviceKey } = this.registerDevice(email, claim, now);
    // One account per device: a fresh login replaces whatever was signed in there before.
    this.store.deleteSessionsOfDevice(device.id);
    const token = randomBytes(32).toString("base64url");
    this.store.insertSession({
      token_hash: sha256(token),
      email,
      device_id: device.id,
      created_at: now,
      expires_at: now + this.cfg.sessionTtlMs,
    });
    this.store.audit({ event: "login", email, deviceId: device.id, ip, detail: device.platform }, now);
    return {
      token,
      email,
      device: { id: device.id, name: device.name, platform: device.platform },
      ...(deviceKey ? { deviceKey } : {}),
    };
  }

  /**
   * Re-uses the install's device when it proves it holds the device key, otherwise creates a new one.
   * The key keeps someone from claiming another PC's ID (and with it, that PC's incoming connections).
   */
  private registerDevice(email: string, claim: DeviceClaim, now: number): { device: DeviceRow; deviceKey?: string } {
    const name = cleanName(claim.name);
    const platform = typeof claim.platform === "string" && PLATFORMS.has(claim.platform) ? claim.platform : "unknown";

    if (isDeviceId(claim.id) && typeof claim.key === "string") {
      const existing = this.store.getDevice(claim.id);
      if (existing && timingSafeEqual(Buffer.from(existing.key_hash, "hex"), Buffer.from(sha256(claim.key), "hex"))) {
        this.store.updateDeviceOwner(existing.id, email, name, platform, now);
        return { device: { ...existing, owner_email: email, name, platform, last_seen: now } };
      }
    }

    const deviceKey = randomBytes(32).toString("base64url");
    for (let i = 0; i < 20; i++) {
      const id = String(randomInt(100_000_000, 1_000_000_000));
      if (this.store.getDevice(id)) continue;
      const device: DeviceRow = {
        id,
        key_hash: sha256(deviceKey),
        owner_email: email,
        name,
        platform,
        created_at: now,
        last_seen: now,
      };
      this.store.insertDevice(device);
      return { device, deviceKey };
    }
    throw new AuthError("server_error", 500, "Tidak bisa membuat ID perangkat");
  }

  /** Resolves a bearer token to its account and device, or null when unknown / expired / revoked. */
  authenticate(token: unknown): Principal | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    const tokenHash = sha256(token);
    const s = this.store.getSession(tokenHash);
    if (!s) return null;
    if (s.expires_at <= this.now()) {
      this.store.deleteSession(tokenHash);
      return null;
    }
    return { email: s.email, deviceId: s.device_id, tokenHash };
  }

  logout(p: Principal, ip: string): void {
    this.store.deleteSession(p.tokenHash);
    this.store.audit({ event: "logout", email: p.email, deviceId: p.deviceId, ip }, this.now());
  }
}
