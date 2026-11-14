import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client, login, start, testConfig, type Running } from "./helpers.ts";

describe("signaling", () => {
  let r: Running;
  before(async () => (r = await start(testConfig(), { hub: { pendingTimeoutMs: 300 } })));
  after(() => r.close());

  async function online(email: string, extra: object = {}) {
    const s = await login(r, email);
    const c = await Client.open(r.wsUrl, s.token, extra);
    const ready = await c.next("ready");
    assert.equal(ready.deviceId, s.device.id);
    return { s, c, id: s.device.id as string };
  }

  it("refuses a socket with a bad token", async () => {
    const c = await Client.open(r.wsUrl, "nope-nope-nope-nope-nope-nope");
    await c.next("auth-failed");
    assert.equal(await c.closed, 4401);
  });

  it("another account must be accepted by the host; signals flow only after that", async () => {
    const host = await online("host1@kantor.co.id");
    const viewer = await online("viewer1@kantor.co.id");

    viewer.c.send({ type: "connect", requestId: "r1", target: host.id, mode: "control" });
    const pending = await viewer.c.next("pending");
    assert.equal(pending.requestId, "r1");
    const incoming = await host.c.next("incoming");
    assert.equal(incoming.from.email, "viewer1@kantor.co.id");
    assert.equal(incoming.sessionId, pending.sessionId);

    // Not relayed while pending.
    viewer.c.send({ type: "signal", sessionId: pending.sessionId, data: { early: true } });
    assert.equal(await host.c.gets("signal"), false);

    host.c.send({ type: "respond", sessionId: incoming.sessionId, accept: true });
    const vs = await viewer.c.next("session-start");
    const hs = await host.c.next("session-start");
    assert.equal(vs.role, "viewer");
    assert.equal(hs.role, "host");
    assert.equal(vs.peer.email, "host1@kantor.co.id");
    assert.equal(vs.mode, "control");

    viewer.c.send({ type: "signal", sessionId: vs.sessionId, data: { sdp: "offer" } });
    assert.deepEqual((await host.c.next("signal")).data, { sdp: "offer" });
    host.c.send({ type: "signal", sessionId: vs.sessionId, data: { sdp: "answer" } });
    assert.deepEqual((await viewer.c.next("signal")).data, { sdp: "answer" });

    // A third party cannot inject into or end the session.
    const intruder = await online("intruder@kantor.co.id");
    intruder.c.send({ type: "signal", sessionId: vs.sessionId, data: { evil: true } });
    intruder.c.send({ type: "end", sessionId: vs.sessionId });
    assert.equal(await host.c.gets("signal"), false);
    assert.equal(await host.c.gets("ended"), false);

    // A second viewer is told the host is busy.
    intruder.c.send({ type: "connect", requestId: "r2", target: host.id });
    assert.equal((await intruder.c.next("connect-error")).code, "busy");

    viewer.c.send({ type: "end", sessionId: vs.sessionId });
    assert.equal((await host.c.next("ended")).reason, "hangup");
    assert.equal((await viewer.c.next("ended")).reason, "hangup");

    const audit = r.app.store.auditFor("viewer1@kantor.co.id").map((e) => e.event);
    assert.ok(audit.includes("session_request") && audit.includes("session_start") && audit.includes("session_end"));
    for (const x of [host, viewer, intruder]) x.c.close();
  });

  it("host can reject, or downgrade to view-only", async () => {
    const host = await online("host2@kantor.co.id");
    const viewer = await online("viewer2@kantor.co.id");

    viewer.c.send({ type: "connect", requestId: "a", target: host.id });
    host.c.send({ type: "respond", sessionId: (await host.c.next("incoming")).sessionId, accept: false });
    assert.equal((await viewer.c.next("ended")).reason, "rejected");

    viewer.c.send({ type: "connect", requestId: "b", target: host.id, mode: "control" });
    host.c.send({ type: "respond", sessionId: (await host.c.next("incoming")).sessionId, accept: true, viewOnly: true });
    assert.equal((await viewer.c.next("session-start")).mode, "view");
    host.c.close();
    assert.equal((await viewer.c.next("ended")).reason, "peer_disconnected");
    viewer.c.close();
  });

  it("only the host may answer a request", async () => {
    const host = await online("host3@kantor.co.id");
    const viewer = await online("viewer3@kantor.co.id");
    viewer.c.send({ type: "connect", requestId: "a", target: host.id });
    const { sessionId } = await viewer.c.next("pending");
    viewer.c.send({ type: "respond", sessionId, accept: true });
    assert.equal(await viewer.c.gets("session-start"), false);
    host.c.close();
    viewer.c.close();
  });

  it("unanswered requests time out", async () => {
    const host = await online("host4@kantor.co.id");
    const viewer = await online("viewer4@kantor.co.id");
    viewer.c.send({ type: "connect", requestId: "a", target: host.id });
    assert.equal((await viewer.c.next("ended", 2000)).reason, "timeout");
    host.c.close();
    viewer.c.close();
  });

  it("same account connects without a prompt, unless the host turned that off", async () => {
    const home = await login(r, "own@kantor.co.id", "Laptop rumah");
    const office = await login(r, "own@kantor.co.id", "PC kantor");
    const host = await Client.open(r.wsUrl, office.token);
    await host.next("ready");
    const viewer = await Client.open(r.wsUrl, home.token);
    await viewer.next("ready");

    viewer.send({ type: "connect", requestId: "a", target: office.device.id });
    assert.equal((await viewer.next("session-start")).role, "viewer");
    assert.equal(await host.gets("incoming"), false);
    const hs = await host.next("session-start");
    viewer.send({ type: "end", sessionId: hs.sessionId });
    await host.next("ended");

    host.send({ type: "settings", autoAcceptOwn: false });
    viewer.send({ type: "connect", requestId: "b", target: office.device.id });
    await host.next("incoming");
    host.close();
    viewer.close();
  });

  it("validates targets and rate-limits connection requests", async () => {
    const viewer = await online("spammer@kantor.co.id");
    viewer.c.send({ type: "connect", requestId: "x", target: "12345" });
    assert.equal((await viewer.c.next("connect-error")).code, "bad_target");
    viewer.c.send({ type: "connect", requestId: "x", target: viewer.id });
    assert.equal((await viewer.c.next("connect-error")).code, "self");
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      viewer.c.send({ type: "connect", requestId: String(i), target: "999999999" });
      codes.push((await viewer.c.next("connect-error")).code);
    }
    assert.ok(codes.includes("offline"));
    assert.equal(codes.at(-1), "rate_limited");
    viewer.c.close();
  });

  it("a second login of the same device replaces the first socket", async () => {
    const s = await login(r, "dup@kantor.co.id");
    const a = await Client.open(r.wsUrl, s.token);
    await a.next("ready");
    const b = await Client.open(r.wsUrl, s.token);
    await b.next("ready");
    await a.next("replaced");
    assert.equal(await a.closed, 4000);
    b.close();
  });
});
