[CmdletBinding()]
param(
    [string]$BackUrl = "https://gym-conversion-tracker-437354431924.southamerica-east1.run.app",
    [string]$FrontUrl = "https://nice-pebble-04842d70f.7.azurestaticapps.net",
    [switch]$SkipChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)

    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Invoke-InDirectory {
    param(
        [string]$Path,
        [scriptblock]$Script
    )

    Push-Location $Path
    try {
        & $Script
    } finally {
        Pop-Location
    }
}

function Copy-DirectoryContents {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Directory not found: $Source"
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

try {
    $BackUri = [System.Uri]$BackUrl
    if (-not $BackUri.IsAbsoluteUri) {
        throw "BackUrl must be absolute."
    }
} catch {
    throw "Invalid BackUrl '$BackUrl'. Provide an absolute URL."
}

$BackUrl = $BackUrl.TrimEnd("/")
try {
    $FrontUri = [System.Uri]$FrontUrl
    if (-not $FrontUri.IsAbsoluteUri) {
        throw "FrontUrl must be absolute."
    }
} catch {
    throw "Invalid FrontUrl '$FrontUrl'. Provide an absolute URL."
}

$FrontUrl = $FrontUrl.TrimEnd("/")
$DesktopDir = Split-Path -Parent $PSCommandPath
$RootDir = (Resolve-Path -LiteralPath (Join-Path $DesktopDir "..")).Path
$FrontDir = Join-Path $RootDir "front"
$EvoPuppeteerDir = Join-Path $RootDir "evo-puppeteer"
$EvoBridgeDir = Join-Path $RootDir "evo-bridge"
$TauriDir = Join-Path $DesktopDir "src-tauri"
$PayloadDir = Join-Path $TauriDir "payload"
$DistDir = Join-Path $DesktopDir "dist"
$ConfigPath = Join-Path $TauriDir "tauri.conf.json"
$Version = [string]((Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).version)

Write-Step "Checking required tools"
Assert-Command "bun"
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
Assert-Command "cargo"
Invoke-Native "bun" @("--version")
Invoke-Native "cargo" @("--version")
try {
    Invoke-Native "cargo" @("tauri", "--version")
} catch {
    throw "Tauri CLI is required. Install it with: cargo install tauri-cli --version '^2' --locked"
}

Write-Step "Installing EVO dependencies"
Invoke-InDirectory $EvoPuppeteerDir { Invoke-Native "bun" @("install") }
Invoke-InDirectory $EvoBridgeDir { Invoke-Native "bun" @("install") }

if (-not $SkipChecks) {
    Write-Step "Typechecking EVO packages"
    Invoke-InDirectory $EvoPuppeteerDir { Invoke-Native "bun" @("run", "typecheck") }
    Invoke-InDirectory $EvoBridgeDir { Invoke-Native "bun" @("run", "typecheck") }
}

Write-Step "Preparing Tauri payload"
if (Test-Path -LiteralPath $PayloadDir) {
    Remove-Item -LiteralPath $PayloadDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PayloadDir | Out-Null

Write-Step "Compiling bridge executable"
$BridgeOut = Join-Path $PayloadDir "bridge.exe"
Invoke-InDirectory $EvoBridgeDir {
    Invoke-Native "bun" @(
        "build",
        "--compile",
        "--target=bun-windows-x64",
        "src/server.ts",
        "--outfile",
        $BridgeOut
    )
}

Write-Step "Generating Tauri icons"
$IconSource = Join-Path $TauriDir "icon-source.svg"
$Favicon = Join-Path (Join-Path (Join-Path $FrontDir "src") "lib") "assets\favicon.svg"
$IconDir = Join-Path $TauriDir "icons"
New-Item -ItemType Directory -Force -Path $IconDir | Out-Null
if (-not (Test-Path -LiteralPath $IconSource -PathType Leaf)) {
    $IconSource = $Favicon
}
if (Test-Path -LiteralPath $IconSource -PathType Leaf) {
    try {
        Invoke-InDirectory $TauriDir { Invoke-Native "cargo" @("tauri", "icon", $IconSource, "-o", "icons") }
    } catch {
        Write-Warning "Could not generate Tauri icons from $IconSource. Continuing with existing icons if present."
    }
} else {
    Write-Warning "Icon source not found at $IconSource. Continuing with existing icons if present."
}


Write-Step "Building Tauri executable"
$HadSkyfitBackUrl = Test-Path Env:SKYFIT_BACK_URL
$PreviousSkyfitBackUrl = $env:SKYFIT_BACK_URL
$HadSkyfitFrontUrl = Test-Path Env:SKYFIT_FRONT_URL
$PreviousSkyfitFrontUrl = $env:SKYFIT_FRONT_URL
try {
    $env:SKYFIT_BACK_URL = $BackUrl
    $env:SKYFIT_FRONT_URL = $FrontUrl
    Invoke-InDirectory $TauriDir { Invoke-Native "cargo" @("tauri", "build") }
} finally {
    if ($HadSkyfitBackUrl) {
        $env:SKYFIT_BACK_URL = $PreviousSkyfitBackUrl
    } else {
        Remove-Item Env:SKYFIT_BACK_URL -ErrorAction SilentlyContinue
    }
    if ($HadSkyfitFrontUrl) {
        $env:SKYFIT_FRONT_URL = $PreviousSkyfitFrontUrl
    } else {
        Remove-Item Env:SKYFIT_FRONT_URL -ErrorAction SilentlyContinue
    }
}

Write-Step "Packaging desktop artifacts"
$CargoTargetDir = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    Join-Path $TauriDir "target"
} elseif ([System.IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR
} else {
    Join-Path $TauriDir $env:CARGO_TARGET_DIR
}
$ReleaseExe = Join-Path (Join-Path $CargoTargetDir "release") "skyfit-evo-desktop.exe"
if (-not (Test-Path -LiteralPath $ReleaseExe -PathType Leaf)) {
    throw "Expected Tauri executable not found: $ReleaseExe"
}

$ExeName = "Skyfit-EVO-$Version.exe"
$ZipName = "Skyfit-EVO-$Version.zip"
$PackageName = "Skyfit-EVO-$Version"
$ExeOut = Join-Path $DistDir $ExeName
$ZipOut = Join-Path $DistDir $ZipName
$PackageDir = Join-Path $DistDir $PackageName

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Copy-Item -LiteralPath $ReleaseExe -Destination $ExeOut -Force

if (Test-Path -LiteralPath $PackageDir) {
    Remove-Item -LiteralPath $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null
Copy-Item -LiteralPath $ExeOut -Destination (Join-Path $PackageDir $ExeName) -Force

$ReadmeText = @"
Skyfit EVO Desktop $Version

Como usar:
1. Instale o Google Chrome antes de abrir o aplicativo.
2. Execute $ExeName.
3. O aplicativo tenta usar http://localhost:4000 primeiro. Se nao houver bridge local disponivel, ele inicia o bridge embutido em localhost:4000, que carrega o front remoto em $FrontUrl. Se o bridge falhar, abre $FrontUrl diretamente.
4. Ao fechar o app, o Chrome aberto para revisar/salvar cadastros do EVO permanece aberto.

Artefatos:
- $ExeName
- $ZipName
"@
Set-Content -LiteralPath (Join-Path $PackageDir "LEIA-ME.txt") -Value $ReadmeText -Encoding UTF8

if (Test-Path -LiteralPath $ZipOut) {
    Remove-Item -LiteralPath $ZipOut -Force
}
Compress-Archive -LiteralPath $PackageDir -DestinationPath $ZipOut -Force

Write-Host ""
Write-Host "Desktop build complete:" -ForegroundColor Green
Write-Host "  EXE: $ExeOut"
Write-Host "  ZIP: $ZipOut"
