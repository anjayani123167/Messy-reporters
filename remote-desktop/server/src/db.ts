import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface DeviceRow {
  id: string;
  key_hash: string;
  owner_email: string;
  name: string;
  platform: string;
  created_at: number;
  last_seen: number;
}

export interface OtpRow {
  email: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
}

export interface SessionRow {
  token_hash: string;
  email: string;
  device_id: string;
  created_at: number;
  expires_at: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: string;
  email: string | null;
  peer_email: string | null;
  device_id: string | null;
  peer_device_id: string | null;
  ip: string | null;
  detail: string | null;
}

export interface AuditEntry {
  event: string;
  email?: string | null;
  peerEmail?: string | null;
  deviceId?: string | null;
  peerDeviceId?: string | null;
  ip?: string | null;
  detail?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_owner ON devices(owner_email);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions(device_id);
CREATE TABLE IF NOT EXISTS audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  event          TEXT NOT NULL,
  email          TEXT,
  peer_email     TEXT,
  device_id      TEXT,
  peer_device_id TEXT,
  ip             TEXT,
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS audit_email ON audit(email);
CREATE INDEX IF NOT EXISTS audit_peer_email ON audit(peer_email);
`;

/** Thin typed wrapper over the SQLite file. Every method is synchronous (node:sqlite). */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** The secret used to hash OTP codes: from config, else generated once and kept in the DB. */
  serverSecret(fromConfig: string | null): string {
    if (fromConfig) return fromConfig;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'server_secret'").get() as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const secret = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('server_secret', ?)").run(secret);
    return secret;
  }

  // ── OTP ────────────────────────────────────────────────────────────────
  putOtp(email: string, codeHash: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO otps (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(email, codeHash, expiresAt);
  }

  getOtp(email: string): OtpRow | undefined {
    return this.db.prepare("SELECT * FROM otps WHERE email = ?").get(email) as OtpRow | undefined;
  }

  bumpOtpAttempts(email: string): void {
    this.db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE email = ?").run(email);
  }

  deleteOtp(email: string): void {
    this.db.prepare("DELETE FROM otps WHERE email = ?").run(email);
  }

  // ── Devices ────────────────────────────────────────────────────────────
  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  }

  insertDevice(d: DeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, key_hash, owner_email, name, platform, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.key_hash, d.owner_email, d.name, d.platform, d.created_at, d.last_seen);
  }

  updateDeviceOwner(id: string, ownerEmail: string, name: string, platform: string, now: number): void {
    this.db
      .prepare("UPDATE devices SET owner_email = ?, name = ?, platform = ?, last_seen = ? WHERE id = ?")
      .run(ownerEmail, name, platform, now, id);
  }

  touchDevice(id: string, now: number): void {
    this.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now, id);
  }

  renameDevice(id: string, name: string): void {
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
  }

  devicesOf(email: string): DeviceRow[] {
    return this.db
      .prepare("SELECT * FROM devices WHERE owner_email = ? ORDER BY last_seen DESC")
      .all(email) as unknown as DeviceRow[];
  }

  deleteDevice(id: string): void {
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  }

  // ── Sessions ───────────────────────────────────────────────────────────
  insertSession(s: SessionRow): void {
    this.db
      .prepare("INSERT INTO sessions (token_hash, email, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(s.token_hash, s.email, s.device_id, s.created_at, s.expires_at);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteSessionsOfDevice(deviceId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
  }

  purgeExpired(now: number): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM otps WHERE expires_at <= ?").run(now);
  }

  // ── Audit ──────────────────────────────────────────────────────────────
  audit(e: AuditEntry, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, event, email, peer_email, device_id, peer_device_id, ip, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        e.event,
        e.email ?? null,
        e.peerEmail ?? null,
        e.deviceId ?? null,
        e.peerDeviceId ?? null,
        e.ip ?? null,
        e.detail ?? null,
      );
  }

  /** Audit entries in which this account took part, newest first. */
  auditFor(email: string, limit = 200): AuditRow[] {
    return this.db
      .prepare("SELECT * FROM audit WHERE email = ? OR peer_email = ? ORDER BY id DESC LIMIT ?")
      .all(email, email, limit) as unknown as AuditRow[];
  }
}
