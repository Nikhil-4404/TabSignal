param([Parameter(Mandatory = $true)][string]$RuntimePath, [Parameter(Mandatory = $true)][string]$RuntimeVersion)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\packaging\setup.ps1') -Mode Library
$testId = [Guid]::NewGuid().ToString('N')
$scope = 'Software\TabSignalInstallerTests\' + $testId
$work = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\..\..\work\installer-tests\' + $testId)))
$fixture = Join-Path $work 'package'
$target = Join-Path $work 'installed'
$checks = 0
function Check([bool]$Condition, [string]$Reason) { if (-not $Condition) { throw $Reason }; $script:checks++ }
function Throws([scriptblock]$Action, [string]$Reason) { $failed = $false; try { & $Action | Out-Null } catch { $failed = $true }; Check $failed $Reason }
function Registration-Snapshot {
    $result = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            foreach ($path in @(Get-RegistrationPaths 'Software')) {
                $key = $registry.OpenSubKey($path)
                if ($key) { try { $result += [string]$key.GetValue('') } finally { $key.Dispose() } } else { $result += '' }
            }
        } finally { $registry.Dispose() }
    }
    return $result -join '|'
}
& {
    $profileTarget = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TabSignal'
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $capability = [Security.Principal.SecurityIdentifier]::new('S-1-15-3-1')
    $unknownAccount = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1234')
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $package = [Security.Principal.SecurityIdentifier]::new('S-1-15-2-1')
    $service = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $capabilityAllow = [Security.AccessControl.FileSystemAccessRule]::new($capability, 'FullControl', 'Allow')
    $unknownAllow = [Security.AccessControl.FileSystemAccessRule]::new($unknownAccount, 'FullControl', 'Allow')
    $usersAllow = [Security.AccessControl.FileSystemAccessRule]::new($users, 'DeleteSubdirectoriesAndFiles', 'Allow')
    $packageAllow = [Security.AccessControl.FileSystemAccessRule]::new($package, 'FullControl', 'Allow')
    $serviceAllow = [Security.AccessControl.FileSystemAccessRule]::new($service, 'FullControl', 'Allow')
    $inheritOnly = [Security.AccessControl.FileSystemAccessRule]::new($unknownAccount, 'FullControl', 'ContainerInherit,ObjectInherit', 'InheritOnly', 'Allow')
    $ownerAllow = [Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow')
    $usersRead = [Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'Allow')
    function Get-Acl { param([string]$LiteralPath) return [pscustomobject]@{ Access = $rules } }
    $rules = @($capabilityAllow)
    Check ((Assert-InstallLocation $profileTarget) -ceq $profileTarget) 'A capability ACE was classified as another Windows account.'
    $rules = @($unknownAllow)
    Throws { Assert-InstallLocation $profileTarget } 'An applicable dangerous unknown-account ACE was accepted.'
    $rules = @($capabilityAllow, $usersAllow)
    Throws { Assert-InstallLocation $profileTarget } 'A capability ACE hid a dangerous Users ACE.'
    $rules = @($packageAllow)
    Throws { Assert-InstallLocation $profileTarget } 'A package SID was mistaken for a capability SID.'
    $rules = @($serviceAllow)
    Throws { Assert-InstallLocation $profileTarget } 'An NT-authority service SID was exempted from the account guard.'
    $rules = @($inheritOnly)
    Check ((Assert-InstallLocation $profileTarget) -ceq $profileTarget) 'An inherit-only ACE was applied to the profile parent itself.'
    $rules = @($ownerAllow, $usersRead)
    Check ((Assert-InstallLocation $profileTarget) -ceq $profileTarget) 'An account-isolated parent ACL was rejected.'
}
$before = Registration-Snapshot
try {
    foreach ($folder in @('native', 'extension', 'runtime')) { New-Item -ItemType Directory -Path (Join-Path $fixture $folder) -Force | Out-Null }
    Copy-Item -LiteralPath $RuntimePath -Destination (Join-Path $fixture 'runtime/node.exe')
    foreach ($name in @('native/bridge.js', 'extension/activity.js', 'extension/release.js', 'runtime/LICENSE', 'package.json')) {
        [System.IO.File]::WriteAllText((Join-Path $fixture $name), 'Synthetic installer fixture: never connected to Discord.')
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\packaging\setup.ps1') -Destination (Join-Path $fixture 'setup.ps1')
    $hashes = @{}
    foreach ($name in $script:PayloadFiles) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $fixture $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
    $product = @{ productId = $script:ProductId; version = '0.4.0'; architecture = 'x64'; nodeVersion = $RuntimeVersion; extensionIds = @('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); files = $hashes }
    $productPath = Join-Path $fixture 'product.json'
    $product | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $productPath
    $null = Read-TabSignalPackage $fixture
    Check $true 'Fixture verification failed.'
    $bridge = Join-Path $fixture 'native/bridge.js'
    Add-Content -LiteralPath $bridge -Value 'tampered'
    Throws { Install-TabSignal $fixture $target $scope } 'Tampered payload was installed.'
    Check (-not (Test-Path -LiteralPath $target)) 'Tamper rejection changed the target.'
    [System.IO.File]::WriteAllText($bridge, 'Synthetic installer fixture: never connected to Discord.')
    $null = Install-TabSignal $fixture $target $scope
    $installation = Read-Installation $target
    $manifest = Get-Content -LiteralPath $installation.manifestPath -Raw | ConvertFrom-Json
    Check ($manifest.allowed_origins.Count -eq 1 -and $manifest.allowed_origins[0] -eq 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/') 'Native manifest identity is not exact.'
    $acl = Get-Acl -LiteralPath $target
    $allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    $unexpected = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids })
    Check ($acl.AreAccessRulesProtected -and $unexpected.Count -eq 0) 'Installed ACL permits an unexpected account.'
    $null = Install-TabSignal $fixture $target $scope
    Check ((Read-Installation $target).manifestPath -eq $installation.manifestPath) 'Reinstall did not preserve its exact package.'
    # A failed copy must leave an owned, retryable installation without a partial version.
    $product.version = '0.4.1'
    $product | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $productPath
    function Copy-Item { throw 'Synthetic copy failure.' }
    try { Throws { Install-TabSignal $fixture $target $scope } 'Copy failure was not surfaced.' } finally { Remove-Item Function:\Copy-Item }
    Check ((Read-Installation $target).manifestPath -eq $installation.manifestPath -and -not @(Get-ChildItem -LiteralPath (Join-Path $target 'versions') -Filter '.pending-*' -Force).Count) 'Failed upgrade changed the active package or left a partial version.'
    $null = Install-TabSignal $fixture $target $scope
    Check ((Read-Installation $target).version -eq '0.4.1') 'Upgrade failed after the simulated interrupted copy.'
    $oldInstallation = Read-Installation $target
    $product.version = '0.4.2'
    $product | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $productPath
    $originalSetter = ${function:Set-RegisteredValue}
    function Set-RegisteredValue { if ($args[4] -eq 'DisplayVersion') { throw 'Synthetic registry failure.' }; & $originalSetter @args }
    try { Throws { Install-TabSignal $fixture $target $scope } 'Registry failure was not surfaced.' } finally { Set-Item Function:\Set-RegisteredValue $originalSetter }
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $registry.OpenSubKey((Get-RegistrationPaths $scope)[0])
        try { Check ($key.GetValue('') -eq $oldInstallation.manifestPath -and (Read-Installation $target).version -eq '0.4.1') 'Failed registry update did not restore the previous active version.' } finally { $key.Dispose() }
    } finally { $registry.Dispose() }
    $unowned = Join-Path $work 'unowned'
    New-Item -ItemType Directory -Path $unowned | Out-Null
    Throws { Install-TabSignal $fixture $unowned $scope } 'Installer took over an unowned directory.'
    Throws { Get-RegistrationPaths 'Software\UnrelatedApplication' } 'A non-test custom registry scope was accepted.'
    $firstAttempt = Join-Path $work 'interrupted-first-install'
    function Copy-Item { throw 'Synthetic first-install copy failure.' }
    try { Throws { Install-TabSignal $fixture $firstAttempt $scope } 'First-install copy failure was not surfaced.' } finally { Remove-Item Function:\Copy-Item }
    Check ((Read-Installation $firstAttempt).productId -eq $script:ProductId) 'An interrupted first install is not owned and retryable.'
    $null = Install-TabSignal $fixture $firstAttempt $scope
    Check ((Read-Installation $firstAttempt).version -eq '0.4.2') 'First install could not recover after an interrupted copy.'
    $pending = Join-Path $firstAttempt ('versions\.pending-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $pending 'native') -Force | Out-Null
    Copy-Item -LiteralPath $productPath -Destination (Join-Path $pending 'product.json')
    Copy-Item -LiteralPath $bridge -Destination (Join-Path $pending 'native/bridge.js')
    $null = Uninstall-TabSignal $firstAttempt $scope
    Check (-not (Test-Path -LiteralPath $firstAttempt)) 'Uninstall did not clean an identifiable interrupted package.'
    # Restore this fixture's original registration after the independent recovery check.
    $null = Install-TabSignal $fixture $target $scope
    $junction = Join-Path $work 'junction'
    New-Item -ItemType Junction -Path $junction -Target $unowned | Out-Null
    Throws { Install-TabSignal $fixture $junction $scope } 'Installer followed a junction.'
    [System.IO.Directory]::Delete($junction)
    # Removal preserves a registration that another installation took over.
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $foreign = 'Z:\Unrelated\manifest.json'
    try { $key = $registry.CreateSubKey((Get-RegistrationPaths $scope)[0]); try { $key.SetValue('', $foreign) } finally { $key.Dispose() } } finally { $registry.Dispose() }
    $null = Uninstall-TabSignal $target $scope
    Check (-not (Test-Path -LiteralPath $target)) 'Uninstaller left its owned files behind.'
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    try { $key = $registry.OpenSubKey((Get-RegistrationPaths $scope)[0]); try { Check ($key.GetValue('') -eq $foreign) 'Uninstaller removed a foreign registration.' } finally { $key.Dispose() } } finally { $registry.Dispose() }
    $dataTarget = Join-Path $work 'with-user-file'
    $null = Install-TabSignal $fixture $dataTarget $scope
    $personalFile = Join-Path $dataTarget 'keep.txt'
    [System.IO.File]::WriteAllText($personalFile, 'Unrelated user data')
    $brokenPending = Join-Path $dataTarget ('versions\.pending-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $brokenPending -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $brokenPending 'product.json'), '{"productId":')
    $null = Uninstall-TabSignal $dataTarget $scope
    Check ((Get-Content -LiteralPath $personalFile -Raw) -eq 'Unrelated user data') 'Uninstaller removed unrelated user data.'
    Check ((Read-Installation $dataTarget).manifestPath -eq $null -and (Test-Path -LiteralPath $brokenPending)) 'An uncommitted invalid package blocked uninstall or lost its retained ownership marker.'
    $null = Install-TabSignal $fixture $dataTarget $scope
    Check ((Read-Installation $dataTarget).version -eq '0.4.2') 'Retaining unrelated files prevented reinstall.'
    $null = Uninstall-TabSignal $dataTarget $scope
    Check ((Registration-Snapshot) -eq $before) 'A production native-host registration changed.'
} finally {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try { $registry.DeleteSubKeyTree($scope, $false) } finally { $registry.Dispose() }
    }
    # Fixtures live only below this unique D: work directory; keep them for inspection.
}
@{ checks = $checks; isolatedRegistryRemoved = $true; productionRegistrationChanged = $false; fixtureRoot = $work } | ConvertTo-Json -Compress
