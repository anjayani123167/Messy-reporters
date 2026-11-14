import nodemailer from "nodemailer";
import type { Config } from "./config.ts";

export interface Mailer {
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<void>;
}

/** Sends sign-in codes through the office mailbox's SMTP; without SMTP (dev) it prints them to the console. */
export function createMailer(cfg: Config): Mailer {
  if (!cfg.smtp) {
    console.warn("[mail] SMTP_HOST not set: sign-in codes are printed here instead of emailed (development only)");
    return {
      async sendOtp(to, code) {
        console.log(`[mail:dev] sign-in code for ${to}: ${code}`);
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });

  return {
    async sendOtp(to, code, ttlMinutes) {
      const app = cfg.appName;
      await transport.sendMail({
        from: `"${app}" <${cfg.mailFrom}>`,
        to,
        subject: `${code} adalah kode masuk ${app} Anda`,
        text:
          `Kode masuk ${app}: ${code}\n\n` +
          `Kode berlaku ${ttlMinutes} menit. Jangan berikan kode ini kepada siapa pun, ` +
          `termasuk yang mengaku dari IT.\n\n` +
          `Jika Anda tidak sedang masuk ke ${app}, abaikan email ini.`,
        html:
          `<p>Kode masuk <b>${app}</b>:</p>` +
          `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>` +
          `<p>Kode berlaku ${ttlMinutes} menit. Jangan berikan kode ini kepada siapa pun, termasuk yang mengaku dari IT.</p>` +
          `<p style="color:#666">Jika Anda tidak sedang masuk ke ${app}, abaikan email ini.</p>`,
      });
    },
  };
}
