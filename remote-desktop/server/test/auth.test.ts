import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Auth, domainAllowed, normalizeEmail } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { iceServers } from "../src/turn.ts";
import { api, fakeMailer, login, start, testConfig, type Running } from "./helpers.ts";

describe("email rules", () => {
  it("normalizes case and whitespace", () => {
    assert.equal(normalizeEmail("  Budi.Santoso@Kantor.CO.ID "), "budi.santoso@kantor.co.id");
  });

  it("rejects things that are not a single address", () => {
    for (const bad of ["", "budi", "budi@", "@kantor.co.id", "a@b@kantor.co.id", "budi@kantor", "budi @kantor.co.id", 42, null]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });

  it("only allows the exact office domain", () => {
    const allowed = ["kantor.co.id"];
    assert.ok(domainAllowed("budi@kantor.co.id", allowed));
    assert.ok(!domainAllowed("budi@gmail.com", allowed));
    assert.ok(!domainAllowed("budi@kantor.co.id.evil.com", allowed));
    assert.ok(!domainAllowed("budi@evilkantor.co.id", allowed));
    assert.ok(!domainAllowed("budi@sub.kantor.co.id", allowed));
  });

  it("refuses to start without allowed domains", () => {
    assert.throws(() => loadConfig({}), /ALLOWED_EMAIL_DOMAINS/);
    assert.throws(() => loadConfig({ ALLOWED_EMAIL_DOMAINS: "not a domain" }), /not a domain/);
  });

  it("requires SMTP in production", () => {
    assert.throws(() => loadConfig({ ALLOWED_EMAIL_DOMAINS: "kantor.co.id", NODE_ENV: "production" }), /SMTP_HOST/);
  });
});

describe("OTP sign-in (unit, controllable clock)", () => {
  let t = 1_000_000;
  const cfg = testConfig();
  const store = new Store(":memory:");
  const mail = fakeMailer();
  const auth = new Auth(cfg, store, mail, { now: () => t });
  after(() => store.close());

  it("expires codes after the TTL", async () => {
    await auth.requestOtp("expire@kantor.co.id", "1.1.1.1");
    const code = mail.codes.get("expire@kantor.co.id")!;
    t += cfg.otpTtlMs + 1;
    assert.throws(() => auth.verifyOtp("expire@kantor.co.id", code, {}, "1.1.1.1"), { code: "code_expired" });
  });

  it("burns the code after too many wrong guesses", async () => {
    await auth.requestOtp("guess@kantor.co.id", "1.1.1.2");
    const code = mail.codes.get("guess@kantor.co.id")!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < cfg.otpMaxAttempts; i++) {
      assert.throws(() => auth.verifyOtp("guess@kantor.co.id", wrong, {}, "1.1.1.2"), { code: "wrong_code" });
    }
    // Even the right code no longer works.
    assert.throws(() => auth.verifyOtp("guess@kantor.co.id", code, {}, "1.1.1.2"), { code: "code_expired" });
  });

  it("a code works only once", async () => {
    await auth.requestOtp("once@kantor.co.id", "1.1.1.3");
    const code = mail.codes.get("once@kantor.co.id")!;
    assert.ok(auth.verifyOtp("once@kantor.co.id", code, {}, "1.1.1.3").token);
    assert.throws(() => auth.verifyOtp("once@kantor.co.id", code, {}, "1.1.1.3"), { code: "code_expired" });
  });

  it("rate-limits code requests per address", async () => {
    for (let i = 0; i < 3; i++) await auth.requestOtp("flood@kantor.co.id", `2.2.2.${i}`);
    await assert.rejects(auth.requestOtp("flood@kantor.co.id", "2.2.2.9"), { code: "rate_limited" });
    t += 10 * 60_000 + 1;
    await auth.requestOtp("flood@kantor.co.id", "2.2.2.9");
  });

  it("sessions expire", async () => {
    await auth.requestOtp("sess@kantor.co.id", "3.3.3.3");
    const { token } = auth.verifyOtp("sess@kantor.co.id", mail.codes.get("sess@kantor.co.id")!, {}, "3.3.3.3");
    assert.ok(auth.authenticate(token));
    t += cfg.sessionTtlMs + 1;
    assert.equal(auth.authenticate(token), null);
  });
});

describe("HTTP API", () => {
  let r: Running;
  before(async () => (r = await start()));
  after(() => r.close());

  it("refuses non-office addresses without sending mail", async () => {
    const res = await api(r.base, "POST", "/api/auth/request-otp", { email: "someone@gmail.com" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "domain_not_allowed");
    assert.equal(r.mail.codes.size, 0);
  });

  it("signs in an office address and lists its device", async () => {
    const s = await login(r, "Ani@Kantor.co.id", "Laptop Ani");
    assert.equal(s.email, "ani@kantor.co.id");
    assert.match(s.device.id, /^[1-9][0-9]{8}$/);
    assert.ok(s.deviceKey);

    const me = await api(r.base, "GET", "/api/me", undefined, s.token);
    assert.equal(me.body.email, "ani@kantor.co.id");
    const list = await api(r.base, "GET", "/api/devices", undefined, s.token);
    assert.equal(list.body.devices.length, 1);
    assert.equal(list.body.devices[0].name, "Laptop Ani");
    assert.equal(list.body.devices[0].current, true);
  });

  it("keeps the device ID on re-login only with the device key", async () => {
    const first = await login(r, "dodi@kantor.co.id");
    await api(r.base, "POST", "/api/auth/request-otp", { email: "dodi@kantor.co.id" });
    const again = await api(r.base, "POST", "/api/auth/verify-otp", {
      email: "dodi@kantor.co.id",
      code: r.mail.codes.get("dodi@kantor.co.id"),
      device: { id: first.device.id, key: first.deviceKey, name: "PC", platform: "win32" },
    });
    assert.equal(again.body.device.id, first.device.id);
    assert.equal(again.body.deviceKey, undefined);
    // The old session on that device is replaced.
    assert.equal((await api(r.base, "GET", "/api/me", undefined, first.token)).status, 401);

    // Claiming the ID without the key gets a brand-new device instead.
    await api(r.base, "POST", "/api/auth/request-otp", { email: "eko@kantor.co.id" });
    const thief = await api(r.base, "POST", "/api/auth/verify-otp", {
      email: "eko@kantor.co.id",
      code: r.mail.codes.get("eko@kantor.co.id"),
      device: { id: first.device.id, key: "guess", name: "PC" },
    });
    assert.notEqual(thief.body.device.id, first.device.id);
  });

  it("logout revokes the token", async () => {
    const s = await login(r, "fajar@kantor.co.id");
    assert.equal((await api(r.base, "POST", "/api/auth/logout", {}, s.token)).status, 200);
    assert.equal((await api(r.base, "GET", "/api/me", undefined, s.token)).status, 401);
  });

  it("can only remove its own devices", async () => {
    const a = await login(r, "gita@kantor.co.id");
    const b = await login(r, "hadi@kantor.co.id");
    assert.equal((await api(r.base, "DELETE", `/api/devices/${a.device.id}`, undefined, b.token)).status, 404);
    assert.equal((await api(r.base, "DELETE", `/api/devices/${a.device.id}`, undefined, a.token)).status, 200);
    assert.equal((await api(r.base, "GET", "/api/me", undefined, a.token)).status, 401);
  });

  it("rejects requests without a token", async () => {
    assert.equal((await api(r.base, "GET", "/api/devices")).status, 401);
    assert.equal((await api(r.base, "GET", "/api/devices", undefined, "x".repeat(43))).status, 401);
  });
});

describe("TURN credentials", () => {
  it("are HMAC-signed, time-limited and carry no identity", () => {
    const cfg = testConfig({ TURN_SECRET: "s3cret", TURN_HOST: "turn.kantor.co.id", TURN_PORT: "3478", TURN_TLS_PORT: "443" });
    const servers = iceServers(cfg, 1_700_000_000_000);
    const turn = servers.find((s) => s.username)!;
    const [expiry, tag] = turn.username!.split(":");
    assert.equal(Number(expiry), 1_700_000_000 + cfg.turn!.ttlSec);
    assert.match(tag, /^[0-9a-f]{12}$/);
    assert.ok((turn.urls as string[]).includes("turns:turn.kantor.co.id:443?transport=tcp"));
    assert.ok(servers.some((s) => (s.urls as string[]).includes("stun:turn.kantor.co.id:3478")) === false); // STUN_URLS="" in tests
  });
});
