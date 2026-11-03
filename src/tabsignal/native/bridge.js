import net from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { publicHost, cleanTitle, validClientId, siteIcon, serviceName, mediaDetails, applyPresentation } from "../extension/activity.js";
import { release } from "../extension/release.js";

export function encode(value, opcode = null) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(opcode === null ? 4 : 8);
  if (opcode !== null) header.writeUInt32LE(opcode);
  header.writeUInt32LE(body.length, opcode === null ? 0 : 4);
  return Buffer.concat([header, body]);
}

export function decoder(onFrame, rpc = false, maxBytes = 16384) {
  let buffer = Buffer.alloc(0);
  const headerSize = rpc ? 8 : 4;
  const read = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= headerSize) {
      const size = buffer.readUInt32LE(rpc ? 4 : 0);
      if (!size || size > maxBytes) throw new Error("Invalid message size.");
      if (buffer.length < headerSize + size) return;
      const opcode = rpc ? buffer.readUInt32LE(0) : null;
      const payload = JSON.parse(buffer.subarray(headerSize, headerSize + size).toString("utf8"));
      buffer = buffer.subarray(headerSize + size);
      onFrame(payload, opcode);
    }
  };
  read.end = () => { if (buffer.length) throw new Error("Incomplete message."); };
  return read;
}

export function validateMessage(value) {
  if (value?.type === "hello") {
    if (value.protocolVersion !== release.protocolVersion) throw new Error("Incompatible extension protocol.");
    return { type: "hello", protocolVersion: release.protocolVersion };
  }
  if (value?.type === "clear") return { type: "clear" };
  if (value?.type !== "activity" || !validClientId(value.clientId) ||
      (release.channel === "public" && value.clientId !== release.applicationId) ||
      !value.activity || typeof value.activity.host !== "string" || publicHost(value.activity.host) !== value.activity.host ||
      typeof value.activity.title !== "string" || value.activity.title.length > 512 ||
      (value.activity.mode !== undefined && !["watching", "browsing"].includes(value.activity.mode))) {
    throw new Error("Invalid activity message.");
  }
  const presentation = value.activity.presentation;
  if (presentation !== undefined && (!presentation || typeof presentation !== "object" || Array.isArray(presentation) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(presentation)) ||
      Object.entries(presentation).some(([key, option]) => !["artwork", "progress", "links"].includes(key) || typeof option !== "boolean"))) {
    throw new Error("Invalid activity presentation.");
  }
  return { type: "activity", clientId: value.clientId,
    activity: applyPresentation({ host: value.activity.host, title: cleanTitle(value.activity.title, value.activity.host),
      iconUrl: siteIcon(value.activity.host), mode: value.activity.mode || "browsing",
      ...(value.activity.media ? { media: mediaDetails(value.activity.media, value.activity.host) } : {}) }, presentation) };
}

export function discordActivity(activity) {
  activity = applyPresentation(activity, activity.presentation);
  const watching = activity.mode === "watching";
  const media = watching ? mediaDetails(activity.media, activity.host) : null;
  const title = media?.title || activity.title;
  const result = { name: watching ? media?.service || serviceName(activity.host) : "Browsing", type: watching ? 3 : 0,
    details: title, state: media?.subtitle || activity.host.slice(0, 128) };
  if (activity.presentation?.artwork !== false) result.assets = {
    large_image: media?.artworkUrl || siteIcon(activity.host), large_text: title };
  if (result.assets && media?.artworkUrl) {
    result.assets.small_image = siteIcon(activity.host);
    result.assets.small_text = `${media.playback?.paused ? "Paused · " : ""}${media.service}`.slice(0, 128);
  }
  const p = media?.playback;
  // shortcut: Discord has no pause or speed field, omit running timestamps for paused/non-1x players.
  if (p && !p.paused && p.rate === 1 && p.position < p.duration) {
    result.timestamps = { start: Math.floor(p.observedAt / 1000 - p.position), end: Math.floor(p.observedAt / 1000 + p.duration - p.position) };
  }
  if (media?.pageUrl) {
    result.buttons = [{ label: /youtube\.com$/.test(activity.host) ? "Watch Video" : activity.host === "hianime.at" ? "Watch Episode" : "Watch Now", url: media.pageUrl }];
    if (media.secondaryUrl) result.buttons.push({ label: media.secondaryLabel, url: media.secondaryUrl });
  }
  return result;
}

export class DiscordRpc {
  constructor(paths = Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)) {
    this.paths = paths;
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.pending = new Map();
  }

  async connect(clientId) {
    for (const path of this.paths) {
      if (this.closed) throw new Error("Connection cancelled.");
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(path);
          this.socket = socket;
          let settled = false;
          const timer = setTimeout(() => fail(new Error("Discord handshake timed out.")), 2500);
          const fail = error => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(error); }
            socket.destroy();
          };
          const read = decoder((payload, opcode) => {
            if (opcode === 3) { socket.write(encode(payload, 4)); return; }
            if (opcode === 2) { fail(new Error("Discord closed the connection.")); return; }
            if (opcode !== 1) return;
            if (payload.evt === "READY" && !settled) {
              clearTimeout(timer);
              settled = true;
              this.ready = true;
              resolve();
            } else if (payload.nonce && this.pending.has(payload.nonce)) {
              const pending = this.pending.get(payload.nonce);
              this.pending.delete(payload.nonce);
              clearTimeout(pending.timer);
              if (payload.evt === "ERROR") pending.reject(new Error(`Discord rejected activity (code ${Number(payload.data?.code) || "unknown"}).`));
              else pending.resolve(payload);
            } else if (payload.evt === "ERROR" && !settled) fail(new Error("Discord rejected the Application ID."));
          }, true, 1048576);
          socket.on("connect", () => socket.write(encode({ v: 1, client_id: clientId }, 0)));
          socket.on("data", chunk => { try { read(chunk); } catch { fail(new Error("Invalid Discord response.")); } });
          socket.on("error", fail);
          socket.on("close", () => {
            fail(new Error("Discord disconnected."));
            if (this.socket === socket) { this.ready = false; this.rejectPending(); }
          });
        });
        return;
      } catch (error) {
        if (this.closed) throw error;
      }
    }
    throw new Error("Cannot connect to Discord. Open the Discord desktop app and check your Application ID.");
  }

  setActivity(activity) {
    if (!this.ready || !this.socket || this.closed) return Promise.reject(new Error("Discord is disconnected."));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error("Discord did not confirm the activity."));
      }, 5000);
      this.pending.set(nonce, { resolve, reject, timer });
      this.socket.write(encode({ cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce }, 1));
    });
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Discord disconnected."));
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.socket?.destroy();
    this.rejectPending();
  }
}

export class Publisher {
  constructor(report, createRpc = () => new DiscordRpc(), interval = 5000) {
    this.report = report;
    this.createRpc = createRpc;
    this.interval = interval;
    this.desired = null;
    this.rpc = null;
    this.timer = null;
    this.inFlight = false;
    this.revision = 0;
    this.lastSent = 0;
    this.confirmed = "";
    this.clientId = "";
  }

  accept(message) {
    const next = validateMessage(message);
    if (next.type === "hello") return;
    this.lastSeen = Date.now();
    if (next.type === "clear") { this.clear(); return; }
    if (JSON.stringify(next) !== JSON.stringify(this.desired)) {
      ++this.revision;
      this.report("Updating Discord activity…", "updating");
    }
    if (this.clientId !== next.clientId) {
      this.rpc?.close();
      this.rpc = null;
      this.confirmed = "";
      this.clientId = next.clientId;
    }
    this.desired = next;
    this.schedule();
  }

  schedule(delay = Math.max(0, this.lastSent + this.interval - Date.now())) {
    if (!this.desired || this.timer || this.inFlight) return;
    if (this.rpc?.ready && this.confirmed === JSON.stringify(this.desired)) return;
    this.timer = setTimeout(() => { this.timer = null; this.publish(); }, delay);
  }

  async publish() {
    if (!this.desired) return;
    this.inFlight = true;
    const revision = this.revision;
    const desired = this.desired;
    const rpc = this.rpc ||= this.createRpc();
    let failed = false;
    try {
      if (!rpc.ready) await rpc.connect(desired.clientId);
      if (revision !== this.revision) return;
      this.lastSent = Date.now();
      await rpc.setActivity(discordActivity(desired.activity));
      if (revision === this.revision) {
        this.confirmed = JSON.stringify(desired);
        this.report("Shared on Discord.", "shared");
      }
    } catch (error) {
      failed = true;
      const connectionState = rpc.ready ? "error" : "discord-unavailable";
      rpc.close();
      if (this.rpc === rpc) this.rpc = null;
      if (revision === this.revision) this.report(error.message, connectionState);
    } finally {
      this.inFlight = false;
      this.schedule(failed ? 10000 : undefined);
    }
  }

  clear() {
    ++this.revision;
    this.desired = null;
    this.confirmed = "";
    clearTimeout(this.timer);
    this.timer = null;
    // Closing the RPC session removes this helper process's presence and cancels queued updates.
    this.rpc?.close();
    this.rpc = null;
    this.report("Activity hidden.", "hidden");
  }
}

function main() {
  if (process.platform !== "win32" || !/^chrome-extension:\/\/[a-p]{32}\/?$/.test(process.argv[2] || "")) {
    process.stderr.write("Start this Windows helper through the registered browser extension.\n");
    process.exitCode = 1;
    return;
  }
  let current = { status: "Helper ready. Waiting for an allowed page.", connectionState: "ready" };
  const report = (status, connectionState) => {
    current = { status, connectionState, protocolVersion: release.protocolVersion, helperVersion: release.version };
    process.stdout.write(encode(current));
  };
  const publisher = new Publisher(report);
  const watchdog = setInterval(() => {
    if (publisher.desired && Date.now() - publisher.lastSeen > 45000) publisher.clear();
  }, 5000);
  function stop(code = 0, error = "") {
    publisher.clear();
    if (error) report(error, "error");
    clearInterval(watchdog);
    process.exit(code);
  }
  const read = decoder(message => {
    if (message?.type === "hello") {
      validateMessage(message);
      report(current.status, current.connectionState);
    } else publisher.accept(message);
  });
  process.stdin.on("data", chunk => {
    try { read(chunk); } catch (error) {
      stop(1, error.message === "Incompatible extension protocol."
        ? "Extension and helper versions are incompatible. Update the companion and reload the extension."
        : "Invalid browser message. Reconnect the extension.");
    }
  });
  process.stdin.on("end", () => {
    try { read.end(); stop(); } catch { stop(1, "Incomplete browser message. Reconnect the extension."); }
  });
  process.stdin.on("error", () => stop(1));
  process.stdout.on("error", () => process.exit(1));
  process.on("SIGTERM", () => stop());
  report(current.status, current.connectionState);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
