import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { encode, decoder, validateMessage, DiscordRpc, Publisher } from "../native/bridge.js";
import { release } from "../extension/release.js";

test("native framing handles split, combined and UTF-8 messages; rejects oversized or malformed input", () => {
  const seen = [];
  const read = decoder(value => seen.push(value));
  const one = encode({ title: "日本語 😀" });
  const two = encode({ type: "clear" });
  read(one.subarray(0, 2));
  read(one.subarray(2, 8));
  read(Buffer.concat([one.subarray(8), two]));
  read.end();
  assert.deepEqual(seen, [{ title: "日本語 😀" }, { type: "clear" }]);
  const large = Buffer.alloc(4); large.writeUInt32LE(20000);
  assert.throws(() => decoder(() => {})(large), /size/);
  assert.throws(() => decoder(() => {})(Buffer.from([1, 0, 0, 0, 123])), /JSON/);
  for (const bytes of [one.subarray(0, 2), one.subarray(0, one.length - 1)]) {
    const incomplete = decoder(() => assert.fail("Incomplete frame was accepted."));
    incomplete(bytes);
    assert.throws(() => incomplete.end(), /Incomplete/);
  }
});

test("protocol hello requires the exact supported version and does not start or clear publication", () => {
  assert.deepEqual(validateMessage({ type: "hello", protocolVersion: release.protocolVersion }),
    { type: "hello", protocolVersion: release.protocolVersion });
  for (const protocolVersion of [undefined, null, "1", 0, release.protocolVersion + 1]) {
    assert.throws(() => validateMessage({ type: "hello", protocolVersion }), /Incompatible/);
  }
  const statuses = [];
  const publisher = new Publisher(status => statuses.push(status), () => assert.fail("Hello connected to Discord."));
  const desired = { type: "activity", clientId: "123456789012345678", activity: { host: "example.com", title: "Private title" } };
  publisher.desired = desired;
  publisher.accept({ type: "hello", protocolVersion: release.protocolVersion });
  assert.equal(publisher.desired, desired);
  assert.equal(publisher.lastSeen, undefined);
  assert.equal(publisher.timer, null);
  assert.deepEqual(statuses, []);
});

test("RPC traverses a real local pipe, handles ping, waits for ack, and surfaces Discord rejection", async t => {
  const pipe = process.platform === "win32" ? `\\\\?\\pipe\\tabsignal-test-${randomUUID()}` : `/tmp/tabsignal-${randomUUID()}.sock`;
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", decoder((message, opcode) => {
      received.push({ message, opcode });
      if (opcode === 0) {
        const ready = encode({ evt: "READY", data: {} }, 1);
        socket.write(ready.subarray(0, 3));
        socket.write(Buffer.concat([ready.subarray(3), encode({ ping: true }, 3)]));
      } else if (opcode === 1 && message.cmd === "SET_ACTIVITY") {
        const reject = message.args.activity?.details === "reject me";
        socket.write(encode({ cmd: "SET_ACTIVITY", nonce: message.nonce, evt: reject ? "ERROR" : null,
          data: reject ? { code: 4000 } : {} }, 1));
      }
    }, true));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  const rpc = new DiscordRpc([`${pipe}-missing`, pipe]);
  t.after(async () => {
    rpc.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await rpc.connect("123456789012345678");
  await rpc.setActivity({ details: "A real pipe, simulated Discord" });
  await assert.rejects(rpc.setActivity({ details: "reject me" }), /code 4000/);
  assert.equal(received.find(frame => frame.opcode === 0).message.client_id, "123456789012345678");
  assert(received.some(frame => frame.opcode === 4 && frame.message.ping));
  assert(received.some(frame => frame.message.args?.pid === process.pid));
});

const message = title => ({ type: "activity", clientId: "123456789012345678", activity: { host: "example.com", title } });
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Timed out waiting for publisher.");
}

test("publisher coalesces changes, suppresses duplicates, and clears queued private activity", async t => {
  const sent = [];
  const statuses = [];
  let closed = 0;
  const publisher = new Publisher((status, connectionState) => statuses.push({ status, connectionState }), () => ({
    ready: false,
    async connect() { this.ready = true; },
    async setActivity(value) { sent.push(value); },
    close() { this.ready = false; closed++; }
  }), 30);
  t.after(() => publisher.clear());
  publisher.accept(message("First"));
  await until(() => sent.length === 1);
  publisher.accept(message("First"));
  await delay(40);
  assert.equal(sent.length, 1);
  publisher.accept(message("Second"));
  publisher.accept(message("Latest"));
  await until(() => sent.length === 2);
  assert.equal(sent[1].details, "Latest");
  publisher.accept(message("Must never appear"));
  publisher.accept({ type: "clear" });
  await delay(50);
  assert.equal(sent.length, 2);
  assert.equal(closed, 1);
  assert.deepEqual(statuses.at(-1), { status: "Activity hidden.", connectionState: "hidden" });
  assert(statuses.some(status => status.connectionState === "updating"));
  assert(statuses.some(status => status.connectionState === "shared"));
});

test("publisher reports shared only after acknowledgement and distinguishes connection failures from rejection", async t => {
  const statuses = [];
  let acknowledge;
  const publisher = new Publisher((status, connectionState) => statuses.push({ status, connectionState }), () => ({
    ready: false,
    async connect() { this.ready = true; },
    setActivity() { return new Promise(resolve => { acknowledge = resolve; }); },
    close() { this.ready = false; }
  }), 1);
  t.after(() => publisher.clear());
  publisher.accept(message("Waiting for acknowledgement"));
  await until(() => acknowledge);
  assert.equal(statuses.at(-1).connectionState, "updating");
  assert(!statuses.some(status => status.connectionState === "shared"));
  acknowledge();
  await until(() => statuses.at(-1).connectionState === "shared");

  for (const connected of [false, true]) {
    const failures = [];
    const failing = new Publisher((status, connectionState) => failures.push({ status, connectionState }), () => ({
      ready: false,
      async connect() { if (!connected) throw new Error("Discord is closed."); this.ready = true; },
      async setActivity() { throw new Error("Discord rejected the activity."); },
      close() { this.ready = false; }
    }), 1);
    t.after(() => failing.clear());
    failing.accept(message("Never acknowledged"));
    await until(() => failures.some(status => status.connectionState === (connected ? "error" : "discord-unavailable")));
    assert(!failures.some(status => status.connectionState === "shared"));
    failing.clear();
  }
});

test("clearing during connection prevents stale activity from being sent", async t => {
  let finish;
  const sent = [];
  const publisher = new Publisher(() => {}, () => ({
    ready: false,
    connect() { return new Promise(resolve => { finish = resolve; }); },
    async setActivity(value) { sent.push(value); },
    close() {}
  }), 1);
  t.after(() => publisher.clear());
  publisher.accept(message("Old private title"));
  await until(() => finish);
  publisher.accept({ type: "clear" });
  finish();
  await delay(20);
  assert.deepEqual(sent, []);
});
