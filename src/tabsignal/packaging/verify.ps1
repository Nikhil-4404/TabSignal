param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'release.preview.json'),
    [string]$BuildEvidencePath
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $windowsPowerShell
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ConfigPath "' + (Resolve-Path -LiteralPath $ConfigPath).Path + '"'
    if ($BuildEvidencePath) { $start.Arguments += ' -BuildEvidencePath "' + (Resolve-Path -LiteralPath $BuildEvidencePath).Path + '"' }
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables['PSModulePath'] = Join-Path ([System.IO.Path]::GetDirectoryName($windowsPowerShell)) 'Modules'
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $outputRead = $process.StandardOutput.ReadToEndAsync(); $errorRead = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Windows artifact verification timed out.' }
        if ($process.ExitCode -ne 0) { throw $errorRead.Result }
        Write-Output $outputRead.Result.Trim()
        return
    } finally { $process.Dispose() }
}
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility')
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot 'release-config.ps1')
$config = Get-ReleaseConfiguration (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
if (-not $BuildEvidencePath) {
    $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
    $BuildEvidencePath = Join-Path $PSScriptRoot ('..\..\releases\TabSignal-' + $package.version + '-' + $config.channel + '-win-x64-build.json')
}
$BuildEvidencePath = [System.IO.Path]::GetFullPath($BuildEvidencePath)
$directory = [System.IO.Path]::GetDirectoryName($BuildEvidencePath)
$receipt = Get-Content -LiteralPath $BuildEvidencePath -Raw | ConvertFrom-Json
if ($receipt.version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z' -or $receipt.channel -cne $config.channel -or $receipt.architecture -cne 'x64' -or $receipt.nodeVersion -cne $config.nodeVersion -or $receipt.runtimeArchiveSha256 -cne $config.nodeArchiveSha256) { throw 'Release receipt does not match its configured identity/runtime.' }
$suffix = $receipt.version + '-' + $receipt.channel
$installerName = 'TabSignal-Companion-' + $suffix + '-win-x64.exe'
$extensionName = 'TabSignal-Extension-' + $suffix + '.zip'
$readmeName = 'README-' + $suffix + '.txt'
$installer = Join-Path $directory $installerName
$extensionZip = Join-Path $directory $extensionName
foreach ($entry in @(@($installer, $receipt.installerSha256), @($extensionZip, $receipt.extensionZipSha256))) {
    if ($entry[1] -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $entry[0] -Algorithm SHA256).Hash -ine $entry[1]) { throw 'Release artifact checksum differs from its build receipt.' }
}
$expectedArtifacts = @($installerName, $extensionName, $readmeName)
$checksumLines = @(Get-Content -LiteralPath (Join-Path $directory ('SHA256SUMS-' + $suffix + '.txt')) | Where-Object { $_ })
if ($checksumLines.Count -ne 3) { throw 'SHA256SUMS must cover exactly the three user-facing files.' }
$seen = @()
foreach ($line in $checksumLines) {
    if ($line -cnotmatch '^([a-f0-9]{64})  ([^\\/]+)$') { throw 'Invalid checksum entry.' }
    $hash = $Matches[1]; $name = $Matches[2]
    if ($name -cnotin $expectedArtifacts -or $name -cin $seen -or (Get-FileHash -LiteralPath (Join-Path $directory $name) -Algorithm SHA256).Hash -ine $hash) { throw 'A user-facing file is missing, duplicated or has changed.' }
    $seen += $name
}
$readme = Get-Content -LiteralPath (Join-Path $directory $readmeName) -Raw
if (-not $readme.Contains($receipt.version) -or -not $readme.Contains($installerName) -or $readme -notmatch 'Check connection' -or $readme -match '(?i)[CD]:\\|packageStage|release-cache') { throw 'Release instructions are missing or expose development paths.' }

function Read-ZipText($Archive, [string]$Name) {
    $reader = New-Object System.IO.StreamReader($Archive.GetEntry($Name).Open(), [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Assert-ZipEntries($Archive, [string[]]$Expected, [long]$MaximumEntrySize) {
    $names = @()
    foreach ($entry in $Archive.Entries) {
        if ($entry.FullName -cnotin $Expected -or $entry.FullName -cin $names -or $entry.Length -gt $MaximumEntrySize) { throw 'Archive contains a missing, duplicate, oversized or unexpected file.' }
        $names += $entry.FullName
    }
    if ($names.Count -ne $Expected.Count) { throw 'Archive is missing a required file.' }
}
function Read-ReleaseModule([string]$Source) {
    if ($Source -cnotmatch '(?s)^export const release = Object\.freeze\((\{.*\})\);\s*$') { throw 'Invalid packaged release configuration.' }
    $release = $Matches[1] | ConvertFrom-Json
    if ($release.version -cne $receipt.version -or $release.channel -cne $config.channel -or $release.protocolVersion -ne 1 -or $release.applicationId -isnot [string] -or $release.applicationId -cne $config.applicationId -or $release.companionDownloadUrl -cne $config.companionDownloadUrl) { throw 'Packaged release configuration differs from its build inputs.' }
    return $release
}
function Assert-ExtensionIds($Ids) {
    if ($Ids -isnot [array] -or $Ids.Count -ne $config.extensionIds.Count -or @(Compare-Object -CaseSensitive ($Ids | Sort-Object) ($config.extensionIds | Sort-Object)).Count) { throw 'Exact extension identities differ from the release configuration.' }
}
Assert-ExtensionIds $receipt.extensionIds
$archive = [System.IO.Compression.ZipFile]::OpenRead($extensionZip)
try {
    Assert-ZipEntries $archive $script:ReleaseExtensionFiles 8388608
    $manifest = Read-ZipText $archive 'manifest.json' | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3 -or $manifest.version -cne $receipt.version -or $manifest.incognito -cne 'not_allowed') { throw 'Invalid packaged browser manifest.' }
    if ($config.channel -eq 'preview') {
        if ($manifest.key -cne $config.previewExtensionKey -or (Get-ExtensionId $manifest.key) -cne $config.previewExtensionId -or $receipt.previewExtensionId -cne $config.previewExtensionId -or -not $readme.Contains($config.previewExtensionId)) { throw 'Packaged preview extension identity is unstable.' }
    } else {
        if ($receipt.previewExtensionId -or $readme -notmatch [regex]::Escape($config.companionDownloadUrl)) { throw 'A public artifact still uses preview identity or instructions.' }
        if ($config.publicExtensionKey) {
            if ($manifest.key -cne $config.publicExtensionKey -or (Get-ExtensionId $manifest.key) -cne $config.extensionIds[0] -or -not $readme.Contains($extensionName) -or -not $readme.Contains('Developer mode') -or -not $readme.Contains('Load unpacked') -or -not $readme.Contains('Updates are manual')) { throw 'Packaged public extension identity or GitHub setup instructions differ from the release configuration.' }
        } elseif ($manifest.key) { throw 'A store extension artifact must not include a development key.' }
    }
    $releaseText = Read-ZipText $archive 'release.js'
    $null = Read-ReleaseModule $releaseText
} finally { $archive.Dispose() }

$verificationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\work\release-verification'))
$temporary = Join-Path $verificationRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
try {
    # Reading the embedded resource does not run the installer entry point.
    $assembly = [Reflection.Assembly]::ReflectionOnlyLoad([System.IO.File]::ReadAllBytes($installer))
    if (@($assembly.GetManifestResourceNames()).Count -ne 1 -or $assembly.GetManifestResourceNames()[0] -cne 'payload.zip') { throw 'Unexpected installer resources.' }
    $payloadPath = Join-Path $temporary 'payload.zip'
    $resource = $assembly.GetManifestResourceStream('payload.zip')
    $payload = [System.IO.File]::Create($payloadPath)
    try { $resource.CopyTo($payload) } finally { $resource.Dispose(); $payload.Dispose() }
    $payloadNames = @('product.json', 'package.json', 'setup.ps1', 'native/bridge.js', 'extension/activity.js', 'extension/release.js', 'runtime/node.exe', 'runtime/LICENSE')
    $payload = [System.IO.Compression.ZipFile]::OpenRead($payloadPath)
    $companion = Join-Path $temporary 'companion'
    New-Item -ItemType Directory -Path $companion | Out-Null
    try {
        Assert-ZipEntries $payload $payloadNames 167772160
        foreach ($entry in $payload.Entries) {
            $target = [System.IO.Path]::GetFullPath((Join-Path $companion $entry.FullName))
            if (-not $target.StartsWith($companion + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package extraction path.' }
            New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        }
    } finally { $payload.Dispose() }
    $payloadRelease = Get-Content -LiteralPath (Join-Path $companion 'extension\release.js') -Raw
    if ($payloadRelease -cne $releaseText) { throw 'Browser and companion release configuration differ.' }
    . (Join-Path $companion 'setup.ps1') -Mode Library
    $product = Read-TabSignalPackage $companion
    Assert-ExtensionIds $product.extensionIds
    if ($product.version -cne $receipt.version -or $product.protocolVersion -ne 1 -or $product.channel -cne $config.channel -or $product.nodeVersion -cne $config.nodeVersion -or $product.files.'runtime/node.exe' -cne $receipt.runtimeExeSha256) { throw 'Embedded companion metadata differs from the release receipt.' }
    $native = New-TabSignalManifest $product (Join-Path $companion 'tabsignal.cmd')
    $origins = @($config.extensionIds | ForEach-Object { "chrome-extension://$_/" })
    if ($native.name -cne 'app.tabsignal.bridge' -or $native.type -cne 'stdio' -or @(Compare-Object -CaseSensitive $origins $native.allowed_origins).Count) { throw 'The native manifest recipe does not authorize exactly the configured extensions.' }
    $license = Get-Content -LiteralPath (Join-Path $companion 'runtime\LICENSE') -Raw
    if ($license.Length -lt 1000 -or $license -notmatch 'Node\.js is licensed') { throw 'The bundled runtime license is missing.' }
    $node = Join-Path $companion 'runtime\node.exe'
    $actualVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $actualVersion -cne ('v' + $config.nodeVersion)) { throw 'The bundled runtime version differs from the release inputs.' }

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.Arguments = '"' + (Join-Path $companion 'native\bridge.js') + '" "chrome-extension://' + $config.extensionIds[0] + '/"'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $output = New-Object System.IO.MemoryStream
        $copy = $process.StandardOutput.BaseStream.CopyToAsync($output)
        $errorRead = $process.StandardError.ReadToEndAsync()
        foreach ($message in @(@{ type = 'hello'; protocolVersion = 1 }, @{ type = 'clear' })) {
            $body = [System.Text.Encoding]::UTF8.GetBytes(($message | ConvertTo-Json -Compress))
            $header = [BitConverter]::GetBytes([int]$body.Length)
            $process.StandardInput.BaseStream.Write($header, 0, 4)
            $process.StandardInput.BaseStream.Write($body, 0, $body.Length)
        }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Packaged helper did not exit after EOF.' }
        if (-not $copy.Wait(5000) -or $process.ExitCode -ne 0 -or $errorRead.Result) { throw 'Packaged helper failed its isolated hello/clear smoke check.' }
        $bytes = $output.ToArray(); $position = 0; $frames = 0
        while ($position -lt $bytes.Length) {
            if ($position + 4 -gt $bytes.Length) { throw 'Truncated packaged helper metadata.' }
            $length = [BitConverter]::ToInt32($bytes, $position); $position += 4
            if ($length -le 0 -or $length -gt 16384 -or $position + $length -gt $bytes.Length) { throw 'Invalid packaged helper frame.' }
            $frame = [System.Text.Encoding]::UTF8.GetString($bytes, $position, $length) | ConvertFrom-Json
            if ($frame.helperVersion -cne $receipt.version -or $frame.protocolVersion -ne 1 -or $frame.connectionState -cnotin @('ready', 'hidden')) { throw 'Packaged helper reported unexpected metadata.' }
            $position += $length; $frames++
        }
        if ($frames -lt 3) { throw 'Packaged helper did not complete hello/clear/EOF.' }
    } finally { $process.Dispose(); if ($output) { $output.Dispose() } }

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $installer; $start.Arguments = '/verify'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.EnvironmentVariables['TEMP'] = $temporary; $start.EnvironmentVariables['TMP'] = $temporary
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'Embedded installer verification timed out.' }
        if ($process.ExitCode -ne 0) { throw 'The installer failed its non-installing verification mode.' }
    } finally { $process.Dispose() }
    $result = @{ version = $receipt.version; channel = $config.channel; extensionFiles = $script:ReleaseExtensionFiles.Count; companionFiles = $payloadNames.Count; runtimeVersion = $config.nodeVersion; runtimeLicenseIncluded = $true; previewExtensionId = $config.previewExtensionId; metadataFrames = $frames; helperExitCode = 0; helperStderrBytes = 0; checksumFiles = 3; installerVerificationPassed = $true; registryWrites = 0; activityMessagesSent = 0; cleanMachineInstallationVerified = $false }
    $json = ($result | ConvertTo-Json -Depth 6)
    [System.IO.File]::WriteAllText((Join-Path $directory ('verification-' + $suffix + '.json')), $json, [System.Text.UTF8Encoding]::new($false))
    Write-Output $json
} finally {
    $resolved = [System.IO.Path]::GetFullPath($temporary)
    if ([System.IO.Path]::GetDirectoryName($resolved) -ine $verificationRoot -or [System.IO.Path]::GetFileName($resolved) -cnotmatch '^[a-f0-9]{32}$' -or (Get-Item -LiteralPath $resolved).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean an invalid verification directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
