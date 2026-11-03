import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

test("release validation checks store and GitHub public identities and preserves preview isolation", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("release-config.windows.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, PSModulePath: join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "Modules") }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.checks, 45);
  assert.equal(evidence.networkRequests, 0);
  assert.equal(evidence.artifactsBuilt, 0);
});

test("companion install, upgrade, rollback and removal stay inside an isolated test scope", { skip: process.platform !== "win32" }, () => {
  const script = fileURLToPath(new URL("packaging.windows.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script,
    "-RuntimePath", process.execPath, "-RuntimeVersion", process.versions.node], {
    encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { ...process.env, PSModulePath: join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "Modules") }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.checks, 31);
  assert.equal(evidence.isolatedRegistryRemoved, true);
  assert.equal(evidence.productionRegistrationChanged, false);
});
