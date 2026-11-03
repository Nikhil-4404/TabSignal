function Get-ExtensionId([string]$Key) {
    if ($Key -cnotmatch '\A[A-Za-z0-9+/]+={0,2}\z') { throw 'The extension public key must use canonical base64 without whitespace.' }
    try { $bytes = [Convert]::FromBase64String($Key) } catch { throw 'The extension key must be a base64 public key.' }
    if ($bytes.Length -lt 32) { throw 'The extension key is too short.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    return -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

function Get-ReleaseConfiguration($Config) {
    if ($Config.channel -cnotin @('preview', 'public')) { throw 'Choose a preview or public build channel.' }
    if ($Config.architecture -cne 'x64') { throw 'This build supports Windows x64 only.' }
    if ($Config.nodeVersion -isnot [string] -or $Config.nodeVersion -cnotmatch '\A22\.[0-9]+\.[0-9]+\z' -or [version]$Config.nodeVersion -lt [version]'22.23.4' -or $Config.nodeArchiveSha256 -isnot [string] -or $Config.nodeArchiveSha256 -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Configure a patched Node 22 LTS release and its official SHA256 checksum.' }
    if ($Config.applicationId -isnot [string] -or $Config.applicationId -cnotmatch '\A[1-9][0-9]{16,19}\z') { throw 'Configure the project Discord Application ID.' }
    if ($Config.extensionIds -isnot [array] -or $Config.extensionIds.Count -lt 1 -or $Config.extensionIds.Count -gt 4) { throw 'Configure one to four exact extension IDs in an array.' }
    foreach ($id in $Config.extensionIds) { if ($id -isnot [string] -or $id -cnotmatch '\A[a-p]{32}\z') { throw 'Invalid extension ID.' } }
    if ($Config.companionDownloadUrl -isnot [string]) { throw 'Configure an HTTPS companion download URL, or an empty preview URL.' }
    $downloadUrl = $Config.companionDownloadUrl
    if ($downloadUrl) {
        $url = $null
        if ($downloadUrl -match '[\s\\]' -or -not [Uri]::TryCreate($downloadUrl, [UriKind]::Absolute, [ref]$url) -or $url.Scheme -ne 'https' -or -not $url.IsDefaultPort -or $url.UserInfo -or $url.Fragment -or $url.Host -notmatch '\.' -or $url.HostNameType -ne [UriHostNameType]::Dns -or $url.Host -match '(?i)(^localhost$|\.(local|localhost|internal|test|example|invalid)$)') { throw 'The companion download URL must be a public HTTPS URL without credentials, fragments or a custom port.' }
    }
    if ($Config.applicationOwnershipVerified -isnot [bool]) { throw 'Application ownership confirmation must be a boolean.' }
    $previewId = $null
    if ($Config.channel -eq 'public') {
        if ($Config.applicationId -cne '1563140076089639053') { throw "Use TabSignal's approved public Discord application." }
        if (-not $downloadUrl -or -not $Config.applicationOwnershipVerified -or $Config.previewExtensionKey) { throw 'Public release requires the final download URL, confirmed project application ownership, and production extension IDs without a preview key.' }
        if ($Config.extensionIds -contains 'kgnnlknoflclpbdialcokaklhpncpehn') { throw 'Replace development extension identities with the exact public extension IDs.' }
        if ($null -ne $Config.publicExtensionKey -and $Config.publicExtensionKey -isnot [string]) { throw 'The public extension key must be a string.' }
        if ($Config.publicExtensionKey -and ($Config.extensionIds.Count -ne 1 -or (Get-ExtensionId $Config.publicExtensionKey) -cne $Config.extensionIds[0])) { throw 'The public extension key must match exactly one configured extension ID.' }
    } else {
        if ($Config.previewExtensionKey -isnot [string] -or -not $Config.previewExtensionKey) { throw 'A preview build requires a stable public development key.' }
        $previewId = Get-ExtensionId $Config.previewExtensionKey
        if ($previewId -cnotin $Config.extensionIds) { throw 'The preview extension key does not match the configured extension ID.' }
    }
    $Config.extensionIds = @($Config.extensionIds | Select-Object -Unique)
    $Config | Add-Member -MemberType NoteProperty -Name previewExtensionId -Value $previewId -Force
    return $Config
}

$script:ReleaseExtensionFiles = @('manifest.json', 'activity.js', 'background.js', 'media.js', 'popup.css', 'popup.html', 'popup.js', 'release.js', 'onboarding.js', 'privacy.html', 'privacy.css', 'assets/disney.svg', 'assets/hianime-banner.png', 'assets/hianime.svg', 'assets/netflix.svg', 'assets/soundcloud.svg', 'assets/tabsignal-icon-128.png', 'assets/twitch.svg', 'assets/youtube.svg')
