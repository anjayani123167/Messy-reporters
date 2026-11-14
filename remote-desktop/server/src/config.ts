export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface TurnConfig {
  secret: string;
  host: string;
  /** Plain TURN port (UDP + TCP). */
  port: number;
  /** TURN-over-TLS port, if coturn has a certificate. 443 passes almost every firewall. */
  tlsPort: number | null;
  ttlSec: number;
}

export interface Config {
  port: number;
  bindHost: string;
  /** Exact domains whose addresses may sign in, lower-case, e.g. ["kantor.co.id"]. */
  allowedDomains: string[];
  otpTtlMs: number;
  otpMaxAttempts: number;
  sessionTtlMs: number;
  /** Null = no SMTP: codes are printed to the console (development only). */
  smtp: SmtpConfig | null;
  mailFrom: string;
  appName: string;
  turn: TurnConfig | null;
  stunUrls: string[];
  dbPath: string;
  /** Behind Caddy / another reverse proxy: take the client IP from X-Forwarded-For. */
  trustProxy: boolean;
  /** Secret used to hash OTP codes; generated and stored in the DB when not set. */
  serverSecret: string | null;
}

function int(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${v}"`);
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedDomains = list(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
  if (allowedDomains.length === 0) {
    throw new Error("ALLOWED_EMAIL_DOMAINS is required, e.g. ALLOWED_EMAIL_DOMAINS=kantor.co.id");
  }
  for (const d of allowedDomains) {
    if (!DOMAIN_RE.test(d)) throw new Error(`ALLOWED_EMAIL_DOMAINS: "${d}" is not a domain name`);
  }

  const production = env.NODE_ENV === "production";
  const smtp: SmtpConfig | null = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: int(env.SMTP_PORT, 465),
        secure: (env.SMTP_SECURE ?? (int(env.SMTP_PORT, 465) === 465 ? "true" : "false")) === "true",
        user: env.SMTP_USER ?? "",
        pass: env.SMTP_PASS ?? "",
      }
    : null;
  if (!smtp && production) {
    throw new Error("SMTP_HOST is required in production (NODE_ENV=production): sign-in codes are sent by email");
  }

  const turn: TurnConfig | null =
    env.TURN_SECRET && env.TURN_HOST
      ? {
          secret: env.TURN_SECRET,
          host: env.TURN_HOST,
          port: int(env.TURN_PORT, 3478),
          tlsPort: env.TURN_TLS_PORT ? int(env.TURN_TLS_PORT, 443) : null,
          ttlSec: int(env.TURN_TTL_SEC, 4 * 3600),
        }
      : null;

  return {
    port: int(env.PORT, 8080),
    bindHost: env.BIND_HOST ?? "0.0.0.0",
    allowedDomains,
    otpTtlMs: int(env.OTP_TTL_MIN, 10) * 60_000,
    otpMaxAttempts: int(env.OTP_MAX_ATTEMPTS, 5),
    sessionTtlMs: int(env.SESSION_TTL_DAYS, 30) * 86_400_000,
    smtp,
    mailFrom: env.MAIL_FROM ?? (smtp?.user || `noreply@${allowedDomains[0]}`),
    appName: env.APP_NAME ?? "OfficeDesk",
    turn,
    // Default: the TURN host doubles as STUN; without TURN fall back to a public STUN server.
    stunUrls:
      env.STUN_URLS !== undefined
        ? list(env.STUN_URLS)
        : turn
          ? [`stun:${turn.host}:${turn.port}`]
          : ["stun:stun.l.google.com:19302"],
    dbPath: env.DB_PATH ?? "./data/officedesk.db",
    trustProxy: env.TRUST_PROXY === "true",
    serverSecret: env.SERVER_SECRET || null,
  };
}
