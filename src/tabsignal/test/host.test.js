import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encode, decoder } from "../native/bridge.js";
import { release } from "../extension/release.js";

const bridge = fileURLToPath(new URL("../native/bridge.js", import.meta.url));

test("helper process exchanges native frames and exits cleanly on browser EOF", { skip: process.platform !== "win32", timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [bridge, `chrome-extension://${"a".repeat(32)}/`], { windowsHide: true });
  t.after(() => child.kill());
  const messages = [];
  let stderr = "";
  let hello;
  const echoed = new Promise(resolve => { hello = resolve; });
  const ready = new Promise(resolve => child.stdout.on("data", decoder(message => {
    messages.push(message);
    if (messages.length === 1) resolve();
    if (messages.length === 2) hello();
  })));
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
  await ready;
  assert.deepEqual(messages[0], { status: "Helper ready. Waiting for an allowed page.", connectionState: "ready",
    protocolVersion: release.protocolVersion, helperVersion: release.version });
  child.stdin.write(encode({ type: "hello", protocolVersion: release.protocolVersion }));
  await echoed;
  assert.deepEqual(messages[1], messages[0]);
  const clear = encode({ type: "clear" });
  child.stdin.write(clear.subarray(0, 2));
  child.stdin.end(clear.subarray(2));
  assert.equal(await exit, 0);
  assert.equal(stderr, "");
  assert(messages.some(message => message.connectionState === "hidden" && message.status === "Activity hidden."));
  assert(messages.every(message => message.protocolVersion === release.protocolVersion && message.helperVersion === release.version));
  assert(!messages.some(message => message.connectionState === "shared"));
});

test("helper rejects incompatible protocols and malformed/truncated input without claiming success", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  for (const [name, input, status] of [
    ["incompatible hello", encode({ type: "hello", protocolVersion: release.protocolVersion + 1 }), /incompatible/],
    ["missing hello version", encode({ type: "hello" }), /incompatible/],
    ["invalid JSON", Buffer.from([1, 0, 0, 0, 123]), /Invalid browser message/],
    ["empty frame", Buffer.alloc(4), /Invalid browser message/],
    ["truncated header", Buffer.from([1, 0]), /Incomplete browser message/],
    ["truncated body", Buffer.from([10, 0, 0, 0, 123]), /Incomplete browser message/]
  ]) await t.test(name, async t => {
    const child = spawn(process.execPath, [bridge, `chrome-extension://${"a".repeat(32)}/`], { windowsHide: true });
    t.after(() => child.kill());
    const messages = [];
    let stderr = "";
    child.stdout.on("data", decoder(message => messages.push(message)));
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(input);
    assert.equal(await exit, 1);
    assert.equal(stderr, "");
    assert.equal(messages[0].connectionState, "ready");
    assert.equal(messages.at(-1).connectionState, "error");
    assert.match(messages.at(-1).status, status);
    assert(messages.every(message => message.protocolVersion === release.protocolVersion && message.helperVersion === release.version));
    assert(!messages.some(message => message.connectionState === "shared"));
  });
});

test("helper rejects a non-extension launch origin", async () => {
  const child = spawn(process.execPath, [bridge, "https://untrusted.example"], { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 1);
  assert.match(stderr, /registered browser extension/);
});
