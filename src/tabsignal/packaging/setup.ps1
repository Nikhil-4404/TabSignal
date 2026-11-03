param(
    [ValidateSet('Install', 'Uninstall', 'Verify', 'Library')][string]$Mode = 'Install',
    [string]$PackageRoot = $PSScriptRoot,
    [switch]$ShowResult
)
$ErrorActionPreference = 'Stop'
$script:ProductId = 'f3414e5a-747a-42e0-920f-1a8095dc72fa'
$script:PayloadFiles = @('package.json', 'native/bridge.js', 'extension/activity.js', 'extension/release.js', 'runtime/node.exe', 'runtime/LICENSE', 'setup.ps1')

function Assert-NoReparsePoint([string]$Path) {
    $current = [System.IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Setup cannot use a symbolic link or junction. Choose a normal Windows user profile.' }
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Read-TabSignalPackage([string]$Root, [switch]$SkipHashes) {
    Assert-NoReparsePoint $Root
    $product = Get-Content -LiteralPath (Join-Path $Root 'product.json') -Raw | ConvertFrom-Json
    if ($product.productId -ne $script:ProductId -or $product.version -notmatch '^\d+\.\d+\.\d+$' -or $product.nodeVersion -notmatch '^(22|24)\.\d+\.\d+$') { throw 'This is not a valid TabSignal package.' }
    if ($product.architecture -ne 'x64' -or -not [Environment]::Is64BitOperatingSystem) { throw 'This companion requires 64-bit Windows.' }
    if (@($product.extensionIds).Count -lt 1 -or @($product.extensionIds).Count -gt 4) { throw 'The package has no valid extension identity.' }
    foreach ($extensionId in $product.extensionIds) { if ($extensionId -notmatch '^[a-p]{32}$') { throw 'Invalid extension identity.' } }
    $names = @($product.files.PSObject.Properties.Name)
    if (@(Compare-Object $script:PayloadFiles $names).Count) { throw 'The package contains an unexpected file list.' }
    foreach ($name in $script:PayloadFiles) {
        $path = Join-Path $Root $name
        Assert-NoReparsePoint $path
        $expected = $product.files.$name
        if ($expected -notmatch '^[a-f0-9]{64}$' -or (-not $SkipHashes -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $expected)) { throw "Package verification failed: $name" }
    }
    return $product
}

function Assert-InstallLocation([string]$Root, [switch]$Testing) {
    $full = [System.IO.Path]::GetFullPath($Root)
    if ($full -match '[%"\r\n]') { throw 'The Windows profile path contains characters unsupported by native messaging.' }
    Assert-NoReparsePoint $full
    if (-not $Testing) {
        $expected = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TabSignal'
        if ($full -ine $expected) { throw 'Invalid companion installation folder.' }
        # A protected child ACL cannot prevent replacement through a writable parent.
        $trusted = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
        $acl = Get-Acl -LiteralPath ([System.IO.Path]::GetDirectoryName($full))
        $dangerous = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
        foreach ($rule in $acl.Access) {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            # Capability ACEs also require the app's normal-user access; this guard isolates Windows accounts.
            if ($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -and
                $sid -notin $trusted -and -not $sid.StartsWith('S-1-15-3-', [StringComparison]::Ordinal) -and ($rule.FileSystemRights -band $dangerous)) { throw 'The Windows profile grants application-replacement rights to an unsupported account or group. Setup cannot use this location.' }
        }
    }
    return $full
}

function Protect-InstallDirectory([string]$Path) {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [System.IO.Directory]::GetAccessControl($Path, [System.Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }
    foreach ($identity in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $principal = New-Object System.Security.Principal.SecurityIdentifier($identity)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($Path, $acl)
}

function Get-RegistrationPaths([string]$Prefix) {
    if ($Prefix -ne 'Software' -and $Prefix -notmatch '^Software\\TabSignalInstallerTests\\[a-f0-9]{32}$') { throw 'Invalid registry scope.' }
    return @("$Prefix\Google\Chrome\NativeMessagingHosts\app.tabsignal.bridge", "$Prefix\BraveSoftware\Brave-Browser\NativeMessagingHosts\app.tabsignal.bridge")
}

function Read-Installation([string]$Root) {
    $marker = Join-Path $Root 'installation.json'
    if (-not (Test-Path -LiteralPath $marker)) { throw 'Setup will not change a folder that belongs to another application.' }
    $installation = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($installation.productId -ne $script:ProductId) { throw 'Invalid TabSignal installation marker.' }
    return $installation
}

function Write-Installation([string]$Root, $Value) {
    $marker = Join-Path $Root 'installation.json'
    $temporary = Join-Path $Root ('.installation-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $marker) { [System.IO.File]::Replace($temporary, $marker, [System.Management.Automation.Language.NullString]::Value) }
        else { [System.IO.File]::Move($temporary, $marker) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Assert-CompanionStopped([string]$Root) {
    foreach ($process in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        try { $path = $process.Path } catch { continue }
        if ($path -and $path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Close Chrome and Brave, then run setup again. The companion is still in use.' }
    }
}

function New-TabSignalManifest($Product, [string]$LauncherPath) {
    return @{ name = 'app.tabsignal.bridge'; description = 'TabSignal Discord desktop bridge'; type = 'stdio'; path = $LauncherPath; allowed_origins = @($Product.extensionIds | Select-Object -Unique | ForEach-Object { "chrome-extension://$_/" }) }
}

function Remove-PackageFiles([string]$Directory) {
    Assert-NoReparsePoint $Directory
    foreach ($name in @($script:PayloadFiles) + @('product.json', 'app.tabsignal.bridge.json', 'tabsignal.cmd')) {
        $path = Join-Path $Directory $name
        Assert-NoReparsePoint $path
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    foreach ($relative in @('native', 'extension', 'runtime', '')) {
        $path = $Directory
        if ($relative) { $path = Join-Path $Directory $relative }
        if ((Test-Path -LiteralPath $path) -and -not @(Get-ChildItem -LiteralPath $path -Force).Count) { Remove-Item -LiteralPath $path }
    }
}

function Set-RegisteredValue($Registry, $Changes, $View, [string]$Path, [string]$Name, $Value, $Kind = [Microsoft.Win32.RegistryValueKind]::String) {
    $key = $Registry.CreateSubKey($Path)
    try {
        $existed = $Name -in @($key.GetValueNames())
        $previous = $null
        $previousKind = [Microsoft.Win32.RegistryValueKind]::String
        if ($existed) { $previous = $key.GetValue($Name); $previousKind = $key.GetValueKind($Name) }
        $Changes.Add(@{ View = $View; Path = $Path; Name = $Name; Existed = $existed; Previous = $previous; Kind = $previousKind }) | Out-Null
        $key.SetValue($Name, $Value, $Kind)
    } finally { $key.Dispose() }
}

function Install-TabSignal([string]$Source, [string]$Root = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TabSignal'), [string]$RegistryPrefix = 'Software') {
    $testing = $RegistryPrefix -ne 'Software'
    $registryPaths = Get-RegistrationPaths $RegistryPrefix
    $product = Read-TabSignalPackage $Source
    $Root = Assert-InstallLocation $Root -Testing:$testing
    Assert-CompanionStopped $Root
    $newRoot = -not (Test-Path -LiteralPath $Root)
    if (-not $newRoot) { $null = Read-Installation $Root }
    else { New-Item -ItemType Directory -Path $Root | Out-Null }
    Protect-InstallDirectory $Root
    if ($newRoot) {
        Write-Installation $Root @{ productId = $script:ProductId; version = $null; manifestPath = $null }
    }
    $suffix = (Get-FileHash -LiteralPath (Join-Path $Source 'product.json') -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
    $versionRoot = Join-Path $Root ('versions\' + $product.version + '-' + $suffix)
    if (Test-Path -LiteralPath $versionRoot) { $null = Read-TabSignalPackage $versionRoot }
    else {
        $pending = Join-Path $Root ('versions\.pending-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $pending -Force | Out-Null
        try {
            Copy-Item -LiteralPath (Join-Path $Source 'product.json') -Destination (Join-Path $pending 'product.json')
            foreach ($name in $script:PayloadFiles) {
                $target = Join-Path $pending $name
                New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $target
            }
            $null = Read-TabSignalPackage $pending
            Move-Item -LiteralPath $pending -Destination $versionRoot
        } catch {
            Remove-PackageFiles $pending
            throw
        }
    }
    $node = Join-Path $versionRoot 'runtime\node.exe'
    $actualVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $actualVersion -ne ('v' + $product.nodeVersion)) { throw 'The bundled runtime cannot start or has an unexpected version.' }
    $launcherPath = Join-Path $versionRoot 'tabsignal.cmd'
    $manifestPath = Join-Path $versionRoot 'app.tabsignal.bridge.json'
    $bridge = Join-Path $versionRoot 'native\bridge.js'
    $launcher = "@echo off`r`nchcp 65001 >nul`r`nsetlocal DisableDelayedExpansion`r`n`"$node`" `"$bridge`" %*`r`n"
    [System.IO.File]::WriteAllText($launcherPath, $launcher, [System.Text.UTF8Encoding]::new($false))
    $manifest = New-TabSignalManifest $product $launcherPath
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    $changes = New-Object System.Collections.ArrayList
    try {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
            $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
            try {
                foreach ($path in $registryPaths) {
                    Set-RegisteredValue $registry $changes $view $path '' $manifestPath
                }
                $uninstallPath = "$RegistryPrefix\Microsoft\Windows\CurrentVersion\Uninstall\TabSignalCompanion"
                $powershell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
                $command = '"' + $powershell + '" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $versionRoot 'setup.ps1') + '" -Mode Uninstall -ShowResult'
                Set-RegisteredValue $registry $changes $view $uninstallPath 'DisplayName' 'TabSignal Companion'
                Set-RegisteredValue $registry $changes $view $uninstallPath 'DisplayVersion' $product.version
                Set-RegisteredValue $registry $changes $view $uninstallPath 'InstallLocation' $Root
                Set-RegisteredValue $registry $changes $view $uninstallPath 'UninstallString' $command
                Set-RegisteredValue $registry $changes $view $uninstallPath 'NoModify' 1 ([Microsoft.Win32.RegistryValueKind]::DWord)
                Set-RegisteredValue $registry $changes $view $uninstallPath 'NoRepair' 1 ([Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $registry.Dispose() }
        }
        $installation = @{ productId = $script:ProductId; version = $product.version; manifestPath = $manifestPath }
        Write-Installation $Root $installation
    } catch {
        for ($index = $changes.Count - 1; $index -ge 0; $index--) {
            $change = $changes[$index]
            $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $change.View)
            try {
                $key = $registry.CreateSubKey($change.Path)
                try {
                    if ($change.Existed) { $key.SetValue($change.Name, $change.Previous, $change.Kind) }
                    else { $key.DeleteValue($change.Name, $false) }
                } finally { $key.Dispose() }
            } finally { $registry.Dispose() }
        }
        throw
    }
    Write-Output 'TabSignal Companion installed for Chrome and Brave.'
}

function Uninstall-TabSignal([string]$Root = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TabSignal'), [string]$RegistryPrefix = 'Software') {
    $registryPaths = Get-RegistrationPaths $RegistryPrefix
    $Root = Assert-InstallLocation $Root -Testing:($RegistryPrefix -ne 'Software')
    $null = Read-Installation $Root
    Assert-CompanionStopped $Root
    $versions = Join-Path $Root 'versions'
    Assert-NoReparsePoint $versions
    $ownedManifests = @()
    $directories = @()
    if (Test-Path -LiteralPath $versions) { $directories = @(Get-ChildItem -LiteralPath $versions -Directory) }
    foreach ($directory in $directories) {
        if ($directory.Name -notmatch '^(\d+\.\d+\.\d+-[a-f0-9]{12}|\.pending-[a-f0-9]{32})$') { continue }
        Assert-NoReparsePoint $directory.FullName
        if (-not (Test-Path -LiteralPath (Join-Path $directory.FullName 'product.json'))) { continue }
        try { $product = Read-TabSignalPackage $directory.FullName -SkipHashes }
        catch {
            if ($directory.Name -match '^\.pending-') { continue }
            throw
        }
        $ownedManifests += Join-Path $directory.FullName 'app.tabsignal.bridge.json'
    }
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            foreach ($path in $registryPaths) {
                $key = $registry.OpenSubKey($path)
                if (-not $key) { continue }
                try { $owned = $key.GetValue('') -in $ownedManifests } finally { $key.Dispose() }
                if ($owned) { $registry.DeleteSubKey($path, $false) }
            }
            $uninstallPath = "$RegistryPrefix\Microsoft\Windows\CurrentVersion\Uninstall\TabSignalCompanion"
            $key = $registry.OpenSubKey($uninstallPath)
            $owned = $false
            if ($key) { try { $owned = $key.GetValue('InstallLocation') -ieq $Root } finally { $key.Dispose() } }
            if ($owned) { $registry.DeleteSubKey($uninstallPath, $false) }
        } finally { $registry.Dispose() }
    }
    foreach ($manifest in $ownedManifests) {
        $directory = [System.IO.Path]::GetDirectoryName($manifest)
        Remove-PackageFiles $directory
    }
    if ((Test-Path -LiteralPath $versions) -and -not @(Get-ChildItem -LiteralPath $versions -Force).Count) { Remove-Item -LiteralPath $versions }
    if (@(Get-ChildItem -LiteralPath $Root -Force | Where-Object Name -ne 'installation.json').Count) {
        Write-Installation $Root @{ productId = $script:ProductId; version = $null; manifestPath = $null }
    } else {
        Remove-Item -LiteralPath (Join-Path $Root 'installation.json') -Force
        Remove-Item -LiteralPath $Root
    }
    Write-Output 'TabSignal Companion removed. You can remove the browser extension separately.'
}

if ($Mode -eq 'Library') { return }
try {
    if ($env:OS -ne 'Windows_NT') { throw 'TabSignal Companion supports Windows only.' }
    switch ($Mode) {
        'Verify' { $null = Read-TabSignalPackage $PackageRoot; Write-Output 'Embedded package verified. No files installed or registry changed.' }
        'Install' { Install-TabSignal -Source $PackageRoot }
        'Uninstall' { Uninstall-TabSignal }
    }
    if ($ShowResult) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('TabSignal Companion removed.', 'TabSignal Companion') | Out-Null }
} catch {
    if ($ShowResult) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'TabSignal Companion') | Out-Null }
    Write-Error $_
    exit 1
}
