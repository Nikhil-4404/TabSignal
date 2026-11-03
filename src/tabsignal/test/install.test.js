import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, delimiter } from "node:path";

test("developer installer accepts patched LTS and rejects older runtime before registration", { skip: process.platform !== "win32" }, () => {
  const installer = fileURLToPath(new URL("../native/install.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", installer,
    "-ExtensionId", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "-DryRun"], {
      encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH }
    });
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported = major === 22 && (minor > 23 || minor === 23 && patch >= 4) || major === 24 && (minor > 22 || minor === 22 && patch >= 1);
  if (supported) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: would write/);
    assert.match(result.stdout, /chrome-extension:\/\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\//);
  } else {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /patched Node\.js/);
  }
});
