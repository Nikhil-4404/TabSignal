$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $PSScriptRoot 'installed/app.tabsignal.bridge.json'
$registryPaths = @(
    'Software\Google\Chrome\NativeMessagingHosts\app.tabsignal.bridge',
    'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\app.tabsignal.bridge'
)
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $rootKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
        foreach ($path in $registryPaths) {
            $key = $rootKey.OpenSubKey($path)
            if ($null -eq $key) { continue }
            try { $owned = $key.GetValue('') -eq $manifestPath }
            finally { $key.Dispose() }
            if ($owned) { $rootKey.DeleteSubKey($path, $false) }
        }
    } finally { $rootKey.Dispose() }
}
Write-Output 'TabSignal registration removed where it belonged to this folder. Disable or remove the extension too.'
