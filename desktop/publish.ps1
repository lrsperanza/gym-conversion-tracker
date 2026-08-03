[CmdletBinding()]
param(
    [string]$ExePath = "",
    [ValidateSet("", "keep", "patch", "minor", "major")]
    [string]$Bump = "",
    [string]$SetVersion = "",
    [switch]$Build,
    [switch]$NoBuild,
    [switch]$SkipChecks,
    [switch]$NoPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Build -and $NoBuild) {
    throw "-Build e -NoBuild são mutuamente exclusivos."
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-SemVerParts {
    param([string]$Version)

    if ($Version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
        throw "Versão inválida '$Version'. Use o formato X.Y.Z (ex: 1.0.2)."
    }

    return [pscustomobject]@{
        Major = [int]$Matches.major
        Minor = [int]$Matches.minor
        Patch = [int]$Matches.patch
        Text  = $Version
    }
}

function Get-NextVersion {
    param(
        [string]$Current,
        [ValidateSet("keep", "patch", "minor", "major")]
        [string]$Kind
    )

    $parts = Get-SemVerParts -Version $Current
    switch ($Kind) {
        "keep" { return $parts.Text }
        "patch" { return "{0}.{1}.{2}" -f $parts.Major, $parts.Minor, ($parts.Patch + 1) }
        "minor" { return "{0}.{1}.0" -f $parts.Major, ($parts.Minor + 1) }
        "major" { return "{0}.0.0" -f ($parts.Major + 1) }
    }
}

function Read-DesktopVersion {
    param(
        [string]$ConfigPath,
        [string]$CargoPath
    )

    $configVersion = [string]((Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).version)
    $cargoRaw = Get-Content -LiteralPath $CargoPath -Raw
    if ($cargoRaw -notmatch '(?m)^version\s*=\s*"(?<version>\d+\.\d+\.\d+)"\s*$') {
        throw "Não achei version = `"X.Y.Z`" em $CargoPath"
    }
    $cargoVersion = $Matches.version

    if ($configVersion -ne $cargoVersion) {
        throw "Versões dessincronizadas: tauri.conf.json=$configVersion, Cargo.toml=$cargoVersion"
    }

    return (Get-SemVerParts -Version $configVersion).Text
}

function Set-DesktopVersion {
    param(
        [string]$ConfigPath,
        [string]$CargoPath,
        [string]$Version
    )

    $null = Get-SemVerParts -Version $Version

    $configRaw = Get-Content -LiteralPath $ConfigPath -Raw
    $updatedConfig = [regex]::Replace(
        $configRaw,
        '(?m)^(\s*"version"\s*:\s*")\d+\.\d+\.\d+("\s*,?\s*)$',
        "`${1}$Version`${2}",
        1
    )
    if ($updatedConfig -eq $configRaw) {
        throw "Falha ao atualizar a versão em $ConfigPath"
    }
    [System.IO.File]::WriteAllText($ConfigPath, $updatedConfig)

    $cargoRaw = Get-Content -LiteralPath $CargoPath -Raw
    $updatedCargo = [regex]::Replace(
        $cargoRaw,
        '(?m)^version\s*=\s*"\d+\.\d+\.\d+"\s*$',
        "version = `"$Version`"",
        1
    )
    if ($updatedCargo -eq $cargoRaw) {
        throw "Falha ao atualizar a versão em $CargoPath"
    }
    [System.IO.File]::WriteAllText($CargoPath, $updatedCargo)
}

function Import-DotEnv {
    param([string]$Path)

    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -notmatch '^(?:export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$') { continue }

        $value = $Matches.value.Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$Matches.key] = $value
    }

    return $values
}

function Find-LatestDesktopExe {
    param([string]$DistDir)

    if (-not (Test-Path -LiteralPath $DistDir -PathType Container)) {
        return $null
    }

    $bestFile = $null
    $bestParts = $null
    foreach ($file in Get-ChildItem -LiteralPath $DistDir -File -Filter "Skyfit-EVO-*.exe") {
        if ($file.Name -notmatch '^Skyfit-EVO-(?<version>\d+\.\d+\.\d+)\.exe$') { continue }
        $parts = Get-SemVerParts -Version $Matches.version
        $isNewer = $null -eq $bestParts -or
            $parts.Major -gt $bestParts.Major -or
            ($parts.Major -eq $bestParts.Major -and $parts.Minor -gt $bestParts.Minor) -or
            ($parts.Major -eq $bestParts.Major -and $parts.Minor -eq $bestParts.Minor -and $parts.Patch -gt $bestParts.Patch)
        if ($isNewer) {
            $bestFile = $file
            $bestParts = $parts
        }
    }

    return $bestFile
}

function Resolve-VersionChoice {
    param(
        [string]$Current,
        [string]$Bump,
        [string]$SetVersion,
        [switch]$NoPrompt
    )

    if (-not [string]::IsNullOrWhiteSpace($SetVersion)) {
        return (Get-SemVerParts -Version $SetVersion.Trim()).Text
    }

    if (-not [string]::IsNullOrWhiteSpace($Bump)) {
        return Get-NextVersion -Current $Current -Kind $Bump
    }

    if ($NoPrompt) {
        return $Current
    }

    $patch = Get-NextVersion -Current $Current -Kind patch
    $minor = Get-NextVersion -Current $Current -Kind minor
    $major = Get-NextVersion -Current $Current -Kind major

    Write-Host ""
    Write-Host "Versão atual: $Current" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  [1] patch  -> $patch   (padrão, Enter)"
    Write-Host "  [2] minor  -> $minor"
    Write-Host "  [3] major  -> $major"
    Write-Host "  [4] keep   -> $Current  (republicar a mesma versão)"
    Write-Host "  ou digite uma versão (ex: 1.2.0)"
    Write-Host ""

    $answer = Read-Host "Escolha"
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq "1") {
        return $patch
    }
    if ($answer -eq "2") { return $minor }
    if ($answer -eq "3") { return $major }
    if ($answer -eq "4" -or $answer -eq "keep") { return $Current }
    if ($answer -match '^(patch|minor|major|keep)$') {
        return Get-NextVersion -Current $Current -Kind $answer
    }

    return (Get-SemVerParts -Version $answer.Trim()).Text
}

$DesktopDir = Split-Path -Parent $PSCommandPath
$RootDir = (Resolve-Path -LiteralPath (Join-Path $DesktopDir "..")).Path
$BackDir = Join-Path $RootDir "back"
$DistDir = Join-Path $DesktopDir "dist"
$TauriDir = Join-Path $DesktopDir "src-tauri"
$ConfigPath = Join-Path $TauriDir "tauri.conf.json"
$CargoPath = Join-Path $TauriDir "Cargo.toml"

$CurrentVersion = Read-DesktopVersion -ConfigPath $ConfigPath -CargoPath $CargoPath
$Version = Resolve-VersionChoice -Current $CurrentVersion -Bump $Bump -SetVersion $SetVersion -NoPrompt:$NoPrompt

if ($Version -ne $CurrentVersion) {
    Write-Step "Atualizando versão $CurrentVersion -> $Version"
    Set-DesktopVersion -ConfigPath $ConfigPath -CargoPath $CargoPath -Version $Version
    Write-Host "Atualizado tauri.conf.json e Cargo.toml." -ForegroundColor Green
} else {
    Write-Step "Mantendo versão $Version"
}

$ExePathProvided = -not [string]::IsNullOrWhiteSpace($ExePath)
if (-not $ExePathProvided) {
    $ExePath = Join-Path $DistDir "Skyfit-EVO-$Version.exe"
}

$shouldBuild = $false
if ($Build) {
    $shouldBuild = $true
} elseif ($NoBuild) {
    Write-Step "Pulando build (-NoBuild); publicando o exe existente"
} elseif ($NoPrompt) {
    Write-Step "Pulando build (-NoPrompt sem -Build); publicando o exe existente"
} else {
    $exeExists = Test-Path -LiteralPath $ExePath -PathType Leaf
    if ($exeExists) {
        Write-Host ""
        Write-Host "Exe encontrado: $ExePath" -ForegroundColor DarkGray
        $reply = Read-Host "Buildar agora? [y/N]"
        $shouldBuild = $reply -match '^(y|yes|s|sim)$'
    } else {
        Write-Host ""
        Write-Host "Exe não encontrado: $ExePath" -ForegroundColor Yellow
        $reply = Read-Host "Buildar agora? [Y/n]"
        $shouldBuild = [string]::IsNullOrWhiteSpace($reply) -or $reply -match '^(y|yes|s|sim)$'
    }
    if (-not $shouldBuild) {
        Write-Step "Pulando build; publicando o exe existente"
    }
}

if ($shouldBuild) {
    Write-Step "Building desktop package $Version"
    $buildScript = Join-Path $DesktopDir "build.ps1"
    if ($SkipChecks) {
        & $buildScript -SkipChecks
    } else {
        & $buildScript
    }
    if ($LASTEXITCODE -ne 0) {
        throw "build.ps1 failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    $latestExe = $null
    if (-not $ExePathProvided) {
        $latestExe = Find-LatestDesktopExe -DistDir $DistDir
    }

    if ($null -ne $latestExe -and -not $NoPrompt) {
        Write-Host ""
        Write-Host "Não achei exe da versão $Version." -ForegroundColor Yellow
        Write-Host "Latest em dist: $($latestExe.Name)" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "ATENÇÃO: renomear um exe antigo gera uma build quebrada." -ForegroundColor Red
        Write-Host "O binário continua reportando a versão antiga, então todo launcher vê" -ForegroundColor Red
        Write-Host "a build como desatualizada e fica baixando e reiniciando em loop." -ForegroundColor Red
        $reply = Read-Host "Reutilizar mesmo assim como Skyfit-EVO-$Version.exe e publicar? [y/N]"
        if ($reply -match '^(y|yes|s|sim)$') {
            Copy-Item -LiteralPath $latestExe.FullName -Destination $ExePath -Force
            Write-Host "Copiado $($latestExe.Name) -> $(Split-Path -Leaf $ExePath)" -ForegroundColor Green
        }
    }
}

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "Executable not found: $ExePath. Rode com -Build, passe -ExePath, ou reutilize o latest em dist."
}

Write-Step "Publishing $ExePath to Azure Blob Storage"

# Variáveis já presentes no ambiente têm prioridade sobre o .env no Bun, então
# aplicamos desktop/.env explicitamente para não publicar na conta errada.
$DesktopEnvPath = Join-Path $DesktopDir ".env"
$DesktopEnv = Import-DotEnv -Path $DesktopEnvPath
if ($DesktopEnv.Count -eq 0) {
    Write-Host "Aviso: $DesktopEnvPath não encontrado (ou vazio). Usando as variáveis do ambiente e de back/.env." -ForegroundColor Yellow
}

$PreviousEnv = @{}
foreach ($key in $DesktopEnv.Keys) {
    $PreviousEnv[$key] = [Environment]::GetEnvironmentVariable($key)
    if ($null -ne $PreviousEnv[$key] -and $PreviousEnv[$key] -ne $DesktopEnv[$key]) {
        Write-Host "Sobrescrevendo $key do ambiente com o valor de desktop/.env." -ForegroundColor DarkGray
    }
    [Environment]::SetEnvironmentVariable($key, $DesktopEnv[$key])
}

Push-Location $BackDir
try {
    foreach ($required in @("AZURE_STORAGE_ACCOUNT_NAME", "AZURE_STORAGE_ACCOUNT_KEY")) {
        $value = [Environment]::GetEnvironmentVariable($required)
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "$required não está definido. Adicione em $DesktopEnvPath."
        }
    }

    & bun "src/scripts/publish-desktop.ts" $ExePath
    if ($LASTEXITCODE -ne 0) {
        throw "publish-desktop.ts failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
    foreach ($key in $PreviousEnv.Keys) {
        [Environment]::SetEnvironmentVariable($key, $PreviousEnv[$key])
    }
}

Write-Host ""
Write-Host "Published Skyfit-EVO-$Version.exe." -ForegroundColor Green
