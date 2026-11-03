import test from "node:test";
import assert from "node:assert/strict";
import { defaults, settingsFor, validateSettings, activityFor } from "../extension/activity.js";
import { release } from "../extension/release.js";
import { companionDownload, onboardingFor } from "../extension/onboarding.js";

test("preview application defaults need no user ID and preserve custom IDs, websites and preferences", () => {
  assert.equal(defaults.enabled, false);
  assert.match(defaults.clientId, /^[1-9]\d{16,19}$/);
  const old = { enabled: false, clientId: "", sites: ["example.com"], siteOptions: { "example.com": { artwork: false } } };
  const configured = settingsFor(old);
  assert.equal(configured.clientId, release.applicationId);
  assert.equal(old.clientId, "", "Reading legacy settings must not mutate stored preferences");
  assert.deepEqual(configured.sites, old.sites);
  assert.deepEqual(configured.siteOptions, old.siteOptions);
  assert.equal(activityFor({ url: "https://example.com", title: "Example" }, configured), null);
  assert.equal(validateSettings({ ...configured, enabled: true }).clientId, release.applicationId);
  assert.equal(settingsFor({ clientId: "123456789012345678" }).clientId, "123456789012345678");
  assert.throws(() => validateSettings(settingsFor({ ...old, clientId: "not-an-id" })), /Application ID/);
});

test("onboarding distinguishes companion readiness from actual Discord publication", () => {
  const base = { helperReady: false, connectionState: "unavailable", settings: { sites: [] } };
  assert.equal(onboardingFor(base).visible, true);
  assert.equal(onboardingFor(base).showDownload, true);
  assert.match(onboardingFor(base).description, /setup once/);
  assert.equal(onboardingFor({ ...base, connectionState: "connecting" }).showDownload, false);
  assert.equal(onboardingFor({ ...base, connectionState: "connecting" }).checkDisabled, true);
  assert.equal(onboardingFor({ ...base, connectionState: "incompatible" }).title, "Update the companion");
  assert.equal(onboardingFor({ ...base, helperReady: true, connectionState: "ready" }).title, "Choose your first website");
  const discordMissing = onboardingFor({ ...base, helperReady: true, connectionState: "discord-unavailable", settings: { sites: ["example.com"] } });
  assert.equal(discordMissing.visible, true);
  assert.equal(discordMissing.showDownload, false);
  assert.equal(discordMissing.showCheck, true);
  assert.match(discordMissing.description, /already installed/);
  assert.equal(onboardingFor({ ...base, helperReady: true, connectionState: "shared", settings: { sites: ["example.com"] } }).visible, false);
});

test("companion download comes only from configured HTTPS release location", () => {
  assert.equal(companionDownload(), null, "Development source must not invent a public release link");
  for (const value of ["", "javascript:alert(1)", "file:///setup.exe", "http://downloads.example.com/setup.exe", "https://user:secret@downloads.example.com/setup.exe", "https://downloads.example.com:8443/setup.exe"]) {
    assert.equal(companionDownload(value), null, value);
  }
  assert.equal(companionDownload("https://downloads.example.com/TabSignal-Companion-Setup.exe"), "https://downloads.example.com/TabSignal-Companion-Setup.exe");
});
