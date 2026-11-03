$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\packaging\release-config.ps1')
$preview = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\packaging\release.preview.json') -Raw
$checks = 0
function Reject([scriptblock]$Change, [string]$Base = $preview) {
    $candidate = $Base | ConvertFrom-Json
    & $Change $candidate
    $failed = $false
    try { $null = Get-ReleaseConfiguration $candidate } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid release configuration was accepted.' }
    $script:checks++
}
$valid = Get-ReleaseConfiguration ($preview | ConvertFrom-Json)
if ($valid.previewExtensionId -cne 'kgnnlknoflclpbdialcokaklhpncpehn') { throw 'Stable preview identity changed.' }; $checks++
Reject { param($c) $c.channel = 'PUBLIC' }
Reject { param($c) $c.extensionIds = @('A' * 32) }
Reject { param($c) $c.extensionIds = @('*') }
Reject { param($c) $c.extensionIds = @() }
Reject { param($c) $c.extensionIds = 'kgnnlknoflclpbdialcokaklhpncpehn' }
Reject { param($c) $c.extensionIds = @(@{ id = 'kgnnlknoflclpbdialcokaklhpncpehn' }) }
Reject { param($c) $c.nodeVersion = '22.21.1' }
Reject { param($c) $c.nodeVersion = '23.0.0' }
Reject { param($c) $c.nodeVersion = 22 }
Reject { param($c) $c.nodeArchiveSha256 = 'not-a-checksum' }
Reject { param($c) $c.nodeArchiveSha256 = 123 }
Reject { param($c) $c.applicationId = '123' }
Reject { param($c) $c.applicationId = [long]1563140076089639053 }
Reject { param($c) $c.applicationId += "`n" }
Reject { param($c) $c.extensionIds[0] += "`n" }
Reject { param($c) $c.nodeVersion += "`n" }
Reject { param($c) $c.nodeArchiveSha256 += "`n" }
Reject { param($c) $c.applicationOwnershipVerified = 'true' }
Reject { param($c) $c.previewExtensionKey = 'invalid base64' }
Reject { param($c) $c.previewExtensionKey += "`n" }
Reject { param($c) $c.extensionIds = @('b' * 32) }
foreach ($url in @('http://example.com/download.exe', 'https://example.com:8443/download.exe', 'https://name:password@example.com/download.exe', 'https://example.com/download.exe#fragment', ' https://example.com/download.exe', 'https://example.com\download.exe', 'https://127.0.0.1/download.exe', 'https://localhost/download.exe', 'https://download.invalid/download.exe')) {
    $candidate = $preview | ConvertFrom-Json
    $candidate.companionDownloadUrl = $url
    $failed = $false
    try { $null = Get-ReleaseConfiguration $candidate } catch { $failed = $true }
    if (-not $failed) { throw 'An unsafe or unsupported companion URL was accepted.' }
    $checks++
}
Reject { param($c) $c.channel = 'public' }
Reject { param($c) $c.channel = 'public'; $c.companionDownloadUrl = 'https://example.com/download.exe'; $c.applicationOwnershipVerified = $true; $c.previewExtensionKey = '' }
# Synthetic parser fixture only: no download, build or publication uses this URL/ID.
$public = $preview | ConvertFrom-Json
$public.channel = 'public'; $public.companionDownloadUrl = 'https://example.com/download.exe'; $public.applicationOwnershipVerified = $true; $public.previewExtensionKey = ''; $public.extensionIds = @('b' * 32)
$public.applicationId = '1563140076089639053'
$null = Get-ReleaseConfiguration $public
$checks++
$public | Add-Member -MemberType NoteProperty -Name publicExtensionKey -Value 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwXj+k9vWVpesxSlObEzrB91FWAZU9s4IckXqhWaJFdg/Zvud9QxCSbxprbjgpWe4mFltaRc4dEFB/+XtmyhH+MCEFKwHkvFsMXGtHgHR9tDLJDOXkUPGzgeiNYhAG7xJ34z5+ttvZKmCCHPtq5GoINkofQdysadkr6WJvn5LyJGM0dUCh5PTrK9e6mZktdXfqtiRc3QZm3vcFbTT63JS+I5oXazqgDtapmNC+8RPa7ci9TNhR9Ga6U3gNrhAW2z1HEjO65h7/DKxDVwc8PLWFGu82pgqqJY1GLepDTldRU9JmvXy0atOSsgdy7P5SwBQPDirsIH6a5dd6YBCNSGIyQIDAQAB'
$public.extensionIds = @((Get-ExtensionId $public.publicExtensionKey))
$null = Get-ReleaseConfiguration $public
$checks++
$github = $public | ConvertTo-Json -Depth 10
Reject { param($c) $c.publicExtensionKey = 'invalid base64' } $github
Reject { param($c) $c.publicExtensionKey += "`n" } $github
Reject { param($c) $c.publicExtensionKey = 123 } $github
Reject { param($c) $c.publicExtensionKey = $false } $github
Reject { param($c) $c.extensionIds = @('b' * 32) } $github
Reject { param($c) $c.extensionIds += @('b' * 32) } $github
Reject { param($c) $c.publicExtensionKey = $valid.previewExtensionKey; $c.extensionIds = @($valid.previewExtensionId) } $github
Reject { param($c) $c.previewExtensionKey = $valid.previewExtensionKey } $github
Reject { param($c) $c.applicationOwnershipVerified = $false } $github
$public.applicationId = '123456789012345679'
$rejection = $null
try { $null = Get-ReleaseConfiguration $public } catch { $rejection = $_.Exception.Message }
if ($rejection -cne "Use TabSignal's approved public Discord application.") { throw 'An otherwise valid public configuration must reject an unapproved application.' }
$checks++
@{ checks = $checks; networkRequests = 0; artifactsBuilt = 0 } | ConvertTo-Json -Compress
