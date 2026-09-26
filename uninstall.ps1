# OpalaTex Community uninstaller for direct Windows installations.
# Application files are removed by default. User data is removed only when
# -Purge is explicitly supplied.
param(
    [switch]$Purge,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "OpalaTex"
$pointerFile = Join-Path $HOME ".opalatexhome"
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpalaTex"
$purgeDataDir = $null

# Resolve and confirm the destructive target before changing the installation,
# so a rejected or unsafe purge cannot leave a half-uninstalled application.
if ($Purge) {
    $dataDir = $env:OPALATEX_HOME
    if (-not $dataDir -and (Test-Path $pointerFile)) {
        $dataDir = (Get-Content -Raw $pointerFile).Trim()
    }
    if (-not $dataDir) {
        $dataDir = Join-Path $HOME ".opalatex"
    }

    if (-not [IO.Path]::IsPathRooted($dataDir)) {
        throw "Refusing to purge a relative data directory: $dataDir"
    }

    $purgeDataDir = [IO.Path]::GetFullPath($dataDir).TrimEnd('\')
    $unsafePaths = @(
        [IO.Path]::GetPathRoot($purgeDataDir).TrimEnd('\'),
        [IO.Path]::GetFullPath($HOME).TrimEnd('\')
    )
    if ($unsafePaths | Where-Object { $_ -ieq $purgeDataDir }) {
        throw "Refusing to purge unsafe data directory: $purgeDataDir"
    }

    if (-not $Yes) {
        $confirmation = Read-Host "Remove all OpalaTex global data at '$purgeDataDir'? Type 'remove' to continue"
        if ($confirmation -cne "remove") {
            Write-Host "Global data will be preserved."
            $Purge = $false
            $purgeDataDir = $null
        }
    }
}

if (Get-Process -Name "OpalaTex" -ErrorAction SilentlyContinue) {
    throw "OpalaTex is still running. Close it and run the uninstaller again."
}

# A Start-menu shortcut starts PowerShell in the application directory. Windows
# cannot remove a process's current directory, so leave it before deleting files.
Set-Location $env:TEMP

Write-Host "Uninstalling the direct OpalaTex installation..." -ForegroundColor Cyan

# Remove only exact PATH entries owned by the current installer. A substring
# replacement could corrupt an unrelated directory with a similar name.
$pathWasAdded = $false
if (Test-Path $registryPath) {
    $pathWasAdded = [bool](Get-ItemPropertyValue -Path $registryPath -Name "PathAdded" -ErrorAction SilentlyContinue)
}
$userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($pathWasAdded -and $null -ne $userPath) {
    $knownEntries = @($installDir, (Join-Path $installDir "OpalaTex")) |
        ForEach-Object { $_.TrimEnd('\') }
    $keptEntries = @($userPath -split ';') | Where-Object {
        $entry = $_.Trim().TrimEnd('\')
        $entry -and -not ($knownEntries | Where-Object { $_ -ieq $entry })
    }
    [Environment]::SetEnvironmentVariable(
        "Path",
        ($keptEntries -join ';'),
        [EnvironmentVariableTarget]::User
    )
}

$wshShell = New-Object -ComObject WScript.Shell
$shortcutPaths = @(
    (Join-Path $wshShell.SpecialFolders("Desktop") "OpalaTex.lnk"),
    (Join-Path $wshShell.SpecialFolders("Programs") "OpalaTex.lnk"),
    (Join-Path $wshShell.SpecialFolders("Programs") "Uninstall OpalaTex.lnk")
)
foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path $shortcutPath) {
        $shortcut = $wshShell.CreateShortcut($shortcutPath)
        $target = $shortcut.TargetPath
        $arguments = $shortcut.Arguments
        $knownTargets = @(
            (Join-Path $installDir "OpalaTex.exe"),
            (Join-Path $installDir "OpalaTex\OpalaTex.exe")
        )
        # PyInstaller 6+ bundles this script under `_internal`; older releases
        # kept it beside the executable.
        $knownUninstallers = @(
            (Join-Path $installDir "uninstall.ps1"),
            (Join-Path $installDir "OpalaTex\uninstall.ps1"),
            (Join-Path $installDir "_internal\uninstall.ps1"),
            (Join-Path $installDir "OpalaTex\_internal\uninstall.ps1")
        )
        $isAppShortcut = [bool]($knownTargets | Where-Object { $_ -ieq $target })
        $isUninstallShortcut = [bool]($knownUninstallers | Where-Object {
            $arguments -and $arguments.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        if ($isAppShortcut -or $isUninstallShortcut) {
            Remove-Item -Force $shortcutPath
        }
    }
}

if (Test-Path $registryPath) {
    Remove-Item -Recurse -Force $registryPath
}

if ($Purge) {
    if (Test-Path $purgeDataDir) {
        Remove-Item -Recurse -Force $purgeDataDir
    }
    Remove-Item -Force $pointerFile -ErrorAction SilentlyContinue
    Write-Host "Removed global data at $purgeDataDir. Project directories were preserved."
}

if (Test-Path $installDir) {
    Remove-Item -Recurse -Force $installDir
}

Write-Host "OpalaTex application files were removed." -ForegroundColor Green
if (-not $Purge) {
    Write-Host "Global settings, chats, caches, credentials, and project directories were preserved."
}
