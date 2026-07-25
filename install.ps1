# =========================================================
# OpalaTex Community Windows installer for PowerShell
# Usage: irm https://raw.githubusercontent.com/opalacoderdev/OpalaTex/master/install.ps1 | iex
# =========================================================

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     OpalaTex Installer (Community)       " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$installDir = "$env:LOCALAPPDATA\OpalaTex"
$tempZip    = "$env:TEMP\opalatex_release.zip"
$repoOwner  = "opalacoderdev"
$repoName   = "OpalaTex"

$headers = @{
    "Accept"               = "application/vnd.github+json"
    "User-Agent"           = "OpalaTex-Installer"
    "X-GitHub-Api-Version" = "2022-11-28"
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-OpalaTexDownloadUrl {
    if ($env:OPALATEX_DOWNLOAD_URL) {
        if ($env:OPALATEX_DOWNLOAD_URL -match "/actions/runs/.*/artifacts/") {
            throw "OPALATEX_DOWNLOAD_URL points to a GitHub Actions artifact. Please use a GitHub Release asset URL instead."
        }
        return $env:OPALATEX_DOWNLOAD_URL
    }

    Write-Host "Checking the latest GitHub release ($repoOwner/$repoName)..." -ForegroundColor Yellow
    $releaseApi = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/releases/latest" -Headers $headers
    $asset = $releaseApi.assets |
        Where-Object { $_.name -eq "OpalaTex-windows-x64.zip" -and $_.state -eq "uploaded" } |
        Select-Object -First 1

    if (-not $asset) {
        throw "The latest GitHub release does not contain OpalaTex-windows-x64.zip. Create a tagged release with the Windows asset before running this installer."
    }

    if ($asset.browser_download_url -match "/actions/runs/.*/artifacts/") {
        throw "The latest Windows download points to a GitHub Actions artifact instead of a GitHub Release asset."
    }

    return $asset.browser_download_url
}

function Invoke-DownloadWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            if (Test-Path $OutFile) {
                Remove-Item -Path $OutFile -Force
            }

            Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $headers -UseBasicParsing -MaximumRedirection 10

            if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) {
                return
            }

            throw "Download completed but the output file is empty."
        } catch {
            if ($attempt -eq $maxAttempts) {
                throw "Failed to download OpalaTex after $maxAttempts attempts. Last error: $($_.Exception.Message)"
            }

            Write-Host "Download failed. Retrying ($attempt/$maxAttempts)..." -ForegroundColor Yellow
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

$downloadUrl = Get-OpalaTexDownloadUrl
Write-Host "Downloading OpalaTex from: $downloadUrl" -ForegroundColor Yellow

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

Invoke-DownloadWithRetry -Uri $downloadUrl -OutFile $tempZip

Write-Host "Extracting files to $installDir..." -ForegroundColor Yellow
Expand-Archive -Path $tempZip -DestinationPath $installDir -Force

$exeDir = "$installDir\OpalaTex"
if (-not (Test-Path "$exeDir\OpalaTex.exe")) {
    $exeDir = $installDir
}

# Add the OpalaTex executable directory to the user PATH.
$userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($userPath -notlike "*$exeDir*") {
    Write-Host "Adding OpalaTex to PATH..." -ForegroundColor Yellow
    $newPath = "$userPath;$exeDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$exeDir"
}

# Create Desktop and Start menu shortcuts.
Write-Host "Creating Desktop and Start menu shortcuts..." -ForegroundColor Yellow
$exePath  = "$exeDir\OpalaTex.exe"
$wshShell = New-Object -ComObject WScript.Shell

$desktopPath     = $wshShell.SpecialFolders("Desktop")
$desktopShortcut = $wshShell.CreateShortcut("$desktopPath\OpalaTex.lnk")
$desktopShortcut.TargetPath       = $exePath
$desktopShortcut.WorkingDirectory = $exeDir
$desktopShortcut.Description      = "OpalaTex Open-Source AI LaTeX IDE"
$desktopShortcut.IconLocation     = "$exePath,0"
$desktopShortcut.Save()

$startMenuDir = $wshShell.SpecialFolders("Programs")
if (-not (Test-Path $startMenuDir)) {
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
}
$startMenuShortcut = $wshShell.CreateShortcut("$startMenuDir\OpalaTex.lnk")
$startMenuShortcut.TargetPath       = $exePath
$startMenuShortcut.WorkingDirectory = $exeDir
$startMenuShortcut.Description      = "OpalaTex Open-Source AI LaTeX IDE"
$startMenuShortcut.IconLocation     = "$exePath,0"
$startMenuShortcut.Save()

Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  OpalaTex installed successfully!       " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "Terminal command: opalatex" -ForegroundColor Cyan
Write-Host "Shortcuts were created on the Desktop and Start menu." -ForegroundColor Cyan
