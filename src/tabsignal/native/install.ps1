param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string[]]$ExtensionId,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The helper supports Windows only.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodePath --version
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the Node.js version.' }
$runtime = [version]($nodeVersion -replace '^v', '')
if (-not (($runtime.Major -eq 22 -and $runtime -ge [version]'22.23.4') -or ($runtime.Major -eq 24 -and $runtime -ge [version]'24.22.1'))) { throw 'Use the companion installer, or install patched Node.js 22.23.4 / 24.22.1 LTS or newer in the same LTS line.' }
$bridgePath = Join-Path $PSScriptRoot 'bridge.js'
$installPath = Join-Path $PSScriptRoot 'installed'
$launcherPath = Join-Path $installPath 'tabsignal.cmd'
$manifestPath = Join-Path $installPath 'app.tabsignal.bridge.json'
foreach ($path in @($nodePath, $bridgePath, $launcherPath)) {
    if ($path -match '[%"\r\n]') { throw 'Move the project to a path without percent signs, quotes or newlines.' }
}
$manifest = @{
    name = 'app.tabsignal.bridge'
    description = 'TabSignal Discord desktop bridge'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @($ExtensionId | Select-Object -Unique | ForEach-Object { "chrome-extension://$_/" })
} | ConvertTo-Json
$registryPaths = @(
    'Software\Google\Chrome\NativeMessagingHosts\app.tabsignal.bridge',
    'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\app.tabsignal.bridge'
)
if ($DryRun) {
    Write-Output "Dry run: would write $launcherPath and $manifestPath."
    Write-Output "Would register this helper in HKCU for Chrome and Brave (32-bit and 64-bit views)."
    Write-Output $manifest
    return
}
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
# Disable delayed expansion so exclamation marks in paths stay literal.
$launcher = "@echo off`r`nchcp 65001 >nul`r`nsetlocal DisableDelayedExpansion`r`n`"$nodePath`" `"$bridgePath`" %*`r`n"
[System.IO.File]::WriteAllText($launcherPath, $launcher, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $rootKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
        foreach ($path in $registryPaths) {
            $key = $rootKey.CreateSubKey($path)
            try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
            finally { $key.Dispose() }
        }
    } finally { $rootKey.Dispose() }
}
Write-Output 'TabSignal helper registered for Chrome and Brave. Click Retry connection in the extension.'
Write-Output 'Developer installation: keep this folder in place. Public users should use the bundled companion installer.'
