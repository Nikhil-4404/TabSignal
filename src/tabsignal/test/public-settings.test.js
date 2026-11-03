import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("public releases pin their application across legacy settings, saves and native messages", async t => {
  const work = fileURLToPath(new URL("../../../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const fixture = await mkdtemp(join(work, "public-settings-"));
  const location = relative(work, fixture);
  assert(location && location !== ".." && !location.startsWith(`..${sep}`));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "extension"));
  await mkdir(join(fixture, "native"));
  await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
  for (const source of ["extension/activity.js", "native/bridge.js"]) {
    await copyFile(fileURLToPath(new URL(`../${source}`, import.meta.url)), join(fixture, source));
  }
  const release = { version: "0.4.2", channel: "public", protocolVersion: 1,
    applicationId: "123456789012345678", companionDownloadUrl: "" };
  await writeFile(join(fixture, "extension/release.js"), `export const release = Object.freeze(${JSON.stringify(release)});\n`);
  const { defaults, settingsFor, validateSettings, activityFor } = await import(pathToFileURL(join(fixture, "extension/activity.js")).href);
  const { validateMessage } = await import(pathToFileURL(join(fixture, "native/bridge.js")).href);
  assert.equal(defaults.clientId, release.applicationId);
  for (const clientId of [undefined, "", "223456789012345678", "not-an-id"]) {
    const saved = { enabled: false, clientId, sites: ["example.com"], siteOptions: { "example.com": { artwork: false } } };
    const original = structuredClone(saved);
    const configured = settingsFor(saved);
    assert.equal(configured.clientId, release.applicationId);
    assert.equal(configured.enabled, false, "Migration must not enable sharing");
    assert.deepEqual(configured.sites, saved.sites);
    assert.deepEqual(configured.siteOptions, saved.siteOptions);
    assert.deepEqual(saved, original, "Reading settings must not mutate storage");
    assert.equal(activityFor({ url: "https://example.com/", title: "Example" }, configured), null);
    assert.equal(validateSettings(configured).clientId, release.applicationId);
    assert.throws(() => validateSettings(saved), /managed by this release/);
  }
  const settings = settingsFor({ enabled: true, clientId: "223456789012345678", sites: ["example.com"] });
  assert.equal(validateSettings(settings).clientId, release.applicationId);
  assert.equal(settings.enabled, true, "Migration must preserve existing sharing preferences");
  const message = { type: "activity", clientId: release.applicationId, activity: { host: "example.com", title: "Example" } };
  assert.equal(validateMessage(message).clientId, release.applicationId);
  for (const clientId of [undefined, "", "223456789012345678"]) {
    assert.throws(() => validateMessage({ ...message, clientId }), /Invalid activity message/);
  }
  assert.deepEqual(validateMessage({ type: "clear" }), { type: "clear" });
  assert.deepEqual(validateMessage({ type: "hello", protocolVersion: 1 }), { type: "hello", protocolVersion: 1 });
});
