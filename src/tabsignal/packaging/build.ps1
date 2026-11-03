param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'release.preview.json'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\releases'),
    [string]$CacheDirectory = (Join-Path $PSScriptRoot '..\..\..\work\release-cache')
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility')
Add-Type -AssemblyName System.IO.Compression.FileSystem
. (Join-Path $PSScriptRoot 'release-config.ps1')
function Write-ReleaseZip([string]$Root, [string]$Target, [string[]]$Names) {
    $zip = [System.IO.Compression.ZipFile]::Open($Target, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        # .NET Framework otherwise emits Windows backslashes in ZIP entry names.
        foreach ($name in $Names) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $Root $name), $name.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    } finally { $zip.Dispose() }
}
$applicationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$CacheDirectory = [System.IO.Path]::GetFullPath($CacheDirectory)
$config = Get-ReleaseConfiguration (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
$extensionIds = $config.extensionIds
$downloadUrl = [string]$config.companionDownloadUrl
$previewId = $config.previewExtensionId
$package = Get-Content -LiteralPath (Join-Path $applicationRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z') { throw 'Invalid application version.' }
$extensionFiles = $script:ReleaseExtensionFiles
foreach ($name in $extensionFiles) { if (-not (Test-Path -LiteralPath (Join-Path $applicationRoot ('extension/' + $name)) -PathType Leaf)) { throw "Required extension file is missing: $name" } }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $CacheDirectory -Force | Out-Null
$stage = Join-Path $CacheDirectory ('build-' + [Guid]::NewGuid().ToString('N'))
$extensionStage = Join-Path $stage 'extension'
$companionStage = Join-Path $stage 'companion'
$artifactDirectory = Join-Path $stage 'artifacts'
New-Item -ItemType Directory -Path $extensionStage, $companionStage, $artifactDirectory -Force | Out-Null
foreach ($name in $extensionFiles) {
    $target = Join-Path $extensionStage $name
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $applicationRoot ('extension/' + $name)) -Destination $target
}
$manifestPath = Join-Path $extensionStage 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.version = $package.version
if ($config.channel -eq 'preview') {
    $manifest | Add-Member -MemberType NoteProperty -Name key -Value $config.previewExtensionKey -Force
    $manifest.name = 'TabSignal Preview'
} elseif ($config.publicExtensionKey) {
    $manifest | Add-Member -MemberType NoteProperty -Name key -Value $config.publicExtensionKey -Force
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
$release = @{ version = $package.version; channel = $config.channel; protocolVersion = 1; applicationId = $config.applicationId; companionDownloadUrl = $downloadUrl }
$releaseSource = 'export const release = Object.freeze(' + ($release | ConvertTo-Json -Compress) + ');' + "`n"
[System.IO.File]::WriteAllText((Join-Path $extensionStage 'release.js'), $releaseSource, [System.Text.UTF8Encoding]::new($false))

$archiveName = 'node-v' + $config.nodeVersion + '-win-x64.zip'
$runtimeArchive = Join-Path $CacheDirectory $archiveName
$runtimeUrl = 'https://nodejs.org/dist/v' + $config.nodeVersion + '/' + $archiveName
if (-not (Test-Path -LiteralPath $runtimeArchive)) { Invoke-WebRequest -Uri $runtimeUrl -OutFile $runtimeArchive -UseBasicParsing }
if ((Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash -ine $config.nodeArchiveSha256) { throw 'The Node archive does not match its pinned official checksum. Remove the cached archive and investigate before rebuilding.' }
$runtimeStage = Join-Path $stage 'node'
[System.IO.Compression.ZipFile]::ExtractToDirectory($runtimeArchive, $runtimeStage)
$runtimeFiles = Join-Path $runtimeStage ('node-v' + $config.nodeVersion + '-win-x64')
foreach ($folder in @('native', 'extension', 'runtime')) { New-Item -ItemType Directory -Path (Join-Path $companionStage $folder) | Out-Null }
Copy-Item -LiteralPath (Join-Path $runtimeFiles 'node.exe') -Destination (Join-Path $companionStage 'runtime/node.exe')
Copy-Item -LiteralPath (Join-Path $runtimeFiles 'LICENSE') -Destination (Join-Path $companionStage 'runtime/LICENSE')
Copy-Item -LiteralPath (Join-Path $applicationRoot 'native/bridge.js') -Destination (Join-Path $companionStage 'native/bridge.js')
Copy-Item -LiteralPath (Join-Path $extensionStage 'activity.js'), (Join-Path $extensionStage 'release.js') -Destination (Join-Path $companionStage 'extension')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'setup.ps1') -Destination (Join-Path $companionStage 'setup.ps1')
$companionPackage = @{ name = 'tabsignal-companion'; version = $package.version; type = 'module' } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $companionStage 'package.json'), $companionPackage, [System.Text.UTF8Encoding]::new($false))
$hashes = @{}
$payloadFiles = @('package.json', 'native/bridge.js', 'extension/activity.js', 'extension/release.js', 'runtime/node.exe', 'runtime/LICENSE', 'setup.ps1')
foreach ($name in $payloadFiles) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $companionStage $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
$product = @{ productId = 'f3414e5a-747a-42e0-920f-1a8095dc72fa'; version = $package.version; protocolVersion = 1; channel = $config.channel; architecture = 'x64'; nodeVersion = $config.nodeVersion; extensionIds = $extensionIds; files = $hashes }
[System.IO.File]::WriteAllText((Join-Path $companionStage 'product.json'), ($product | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
$null = & (Join-Path $companionStage 'setup.ps1') -Mode Verify -PackageRoot $companionStage
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'The companion payload failed verification.' }
$payloadZip = Join-Path $stage 'payload.zip'
Write-ReleaseZip $companionStage $payloadZip (@($payloadFiles) + @('product.json'))
$suffix = $package.version + '-' + $config.channel + '-win-x64'
$installerPath = Join-Path $artifactDirectory ('TabSignal-Companion-' + $suffix + '.exe')
$extensionZip = Join-Path $artifactDirectory ('TabSignal-Extension-' + $package.version + '-' + $config.channel + '.zip')
Write-ReleaseZip $extensionStage $extensionZip $extensionFiles
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required to build the companion installer.' }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payloadZip,payload.zip" "/out:$installerPath" (Join-Path $PSScriptRoot 'Bootstrap.cs')
if ($LASTEXITCODE -ne 0) { throw 'The companion installer could not be compiled.' }
$evidence = @{ version = $package.version; channel = $config.channel; architecture = 'x64'; extensionIds = $extensionIds; previewExtensionId = $previewId; runtimeUrl = $runtimeUrl; runtimeArchiveSha256 = $config.nodeArchiveSha256; runtimeExeSha256 = $hashes['runtime/node.exe']; nodeVersion = $config.nodeVersion; applicationOwnershipVerified = $config.applicationOwnershipVerified; companionDownloadUrlConfigured = [bool]$downloadUrl; installerSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant(); extensionZipSha256 = (Get-FileHash -LiteralPath $extensionZip -Algorithm SHA256).Hash.ToLowerInvariant(); embeddedVerificationPassed = $true; builtAtUtc = [DateTime]::UtcNow.ToString('o'); packageStage = $companionStage; cleanMachineInstallationVerified = $false }
$evidencePath = Join-Path $artifactDirectory ('TabSignal-' + $suffix + '-build.json')
[System.IO.File]::WriteAllText($evidencePath, ($evidence | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
if ($config.channel -eq 'preview') {
    $instructions = @"
TabSignal $($package.version) - Windows x64 preview

This preview is for the owner's local testing only. Do not distribute it.

1. Extract TabSignal-Extension-$($package.version)-preview.zip to a folder you will keep.
2. Open chrome://extensions or brave://extensions, enable Developer mode and choose Load unpacked. Select the extracted folder.
3. Open TabSignal-Companion-$suffix.exe and accept Install for this account. If upgrading, close Chrome and Brave first. No separate Node installation or PowerShell command is needed.
4. Open your browser and Discord Desktop. Open TabSignal, choose Check connection, allow the websites you want and enable sharing.
5. For video details, approve the exact media permissions requested by TabSignal. Sharing starts off.

The companion installs under %LOCALAPPDATA%\TabSignal. You can remove it using Windows Installed apps, then remove the extension separately. Close Chrome and Brave before upgrading or removing the companion. Previous companion versions remain until uninstall so an interrupted upgrade does not remove the earlier version.

Privacy: titles and selected media details are shared with Discord only for enabled, allowed websites. Site icon requests disclose the website hostname to icons.bitwarden.net. Open the extension's Privacy page for the full data flow. Node's runtime license is included in the companion installation.

Preview extension ID: $previewId
The installer also supports the existing development extension ID configured for this preview. Final public extension IDs, download hosting, a separate Discord application approved for public use and clean-machine acceptance remain release prerequisites.
"@
} else {
    $extensionInstructions = '1. Add the TabSignal extension using its official distribution instructions.'
    $updateInstructions = ''
    if ($config.publicExtensionKey) {
        $extensionInstructions = @"
1. Extract TabSignal-Extension-$($package.version)-public.zip to a folder you will keep. Open chrome://extensions or brave://extensions, enable Developer mode, choose Load unpacked and select the extracted folder. Keep that folder in place while using TabSignal.
"@
        $updateInstructions = 'Updates are manual: close Chrome and Brave, install the new companion, replace the contents of the same extension folder with the new release, then reopen the browser and reload TabSignal on its extensions page. Do not edit the public key in manifest.json; no manual extension ID or Application ID entry is needed.'
    }
    $instructions = @"
TabSignal $($package.version) - Windows x64

$extensionInstructions
2. Open TabSignal-Companion-$suffix.exe and accept Install for this Windows account. If upgrading, close Chrome and Brave first. No separate Node installation, PowerShell command or manual Application ID is needed.
3. Keep Discord Desktop open. Open TabSignal, choose Check connection, add the websites you want and enable sharing.
4. For video details, approve the exact media permissions requested by TabSignal. Sharing starts off.

Companion download: $downloadUrl
Compatible extension IDs: $($extensionIds -join ', ')

The companion installs under %LOCALAPPDATA%\TabSignal. Remove it using Windows Installed apps, then remove the extension separately. Close Chrome and Brave before upgrading or removing the companion. Previous companion versions remain until uninstall so an interrupted upgrade does not remove the earlier version.

$updateInstructions

Privacy: titles and selected media details are shared with Discord only for enabled, allowed websites. Site icon requests disclose the website hostname to icons.bitwarden.net. Open the extension's Privacy page for the full data flow. Node's runtime license is included in the companion installation.
"@
}
$readmePath = Join-Path $artifactDirectory ('README-' + $package.version + '-' + $config.channel + '.txt')
[System.IO.File]::WriteAllText($readmePath, $instructions, [System.Text.UTF8Encoding]::new($false))
$checksumName = 'SHA256SUMS-' + $package.version + '-' + $config.channel + '.txt'
$checksums = @($installerPath, $extensionZip, $readmePath) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [System.IO.Path]::GetFileName($_) }
[System.IO.File]::WriteAllText((Join-Path $artifactDirectory $checksumName), (($checksums -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'verify.ps1') -ConfigPath $ConfigPath -BuildEvidencePath $evidencePath | Out-Null
# Publish the local artifact set only after verification; stale evidence must not survive a partial replacement.
foreach ($name in @([System.IO.Path]::GetFileName($evidencePath), $checksumName)) {
    $old = Join-Path $OutputDirectory $name
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old }
}
foreach ($path in @($installerPath, $extensionZip, $readmePath, (Join-Path $artifactDirectory $checksumName), (Join-Path $artifactDirectory ('verification-' + $package.version + '-' + $config.channel + '.json')), $evidencePath)) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $OutputDirectory ([System.IO.Path]::GetFileName($path))))
    if ([System.IO.Path]::GetDirectoryName($target) -ine $OutputDirectory) { throw 'Invalid release output path.' }
    Move-Item -LiteralPath $path -Destination $target -Force
}
Write-Output "Installer: $(Join-Path $OutputDirectory ([System.IO.Path]::GetFileName($installerPath)))"
Write-Output "Extension: $(Join-Path $OutputDirectory ([System.IO.Path]::GetFileName($extensionZip)))"
Write-Output "Build evidence: $(Join-Path $OutputDirectory ([System.IO.Path]::GetFileName($evidencePath)))"
if ($config.channel -eq 'preview') { Write-Output 'PREVIEW ONLY: public identities, download hosting, application ownership and clean-machine acceptance are not verified.' }
