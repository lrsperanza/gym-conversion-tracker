<#
.SYNOPSIS
Coloca a conferencia de pagamentos no ar de ponta a ponta e grava tudo em logs\.

.DESCRIPTION
Etapas (cada uma pode ser pulada):
  1. Migration do banco (back: bun run db:migrate)       -SkipMigrate
  2. Deploy do back (back\deploy.ps1)                     -SkipBack
  3. Deploy do front (front\deploy.ps1)                   -SkipFront
  4. Teste local do job sem gravar (--dry-run, headless)  -SkipLocal
  5. Deploy do Cloud Run Job + Scheduler e execucao       -SkipJob
     (depois baixa os logs da execucao para o arquivo de log)

O log fica em evo-payment-checker\logs\ship-<data>.log (UTF-8).

.EXAMPLE
.\ship.ps1
.\ship.ps1 -SkipMigrate -SkipBack -SkipFront     # so testa e publica o job
.\ship.ps1 -OnlyLocal                            # so o dry-run local
#>
param(
    [switch]$SkipMigrate,
    [switch]$SkipBack,
    [switch]$SkipFront,
    [switch]$SkipLocal,
    [switch]$SkipJob,
    [switch]$OnlyLocal,
    [switch]$JobDryRun,
    [switch]$SkipBuild,
    [string]$LocalArgs = "--dry-run"
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

if ($OnlyLocal) { $SkipMigrate = $true; $SkipBack = $true; $SkipFront = $true; $SkipJob = $true }

$CHECKER = $PSScriptRoot
$ROOT = Resolve-Path (Join-Path $CHECKER "..")
$LOGS = Join-Path $CHECKER "logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
$LOG = Join-Path $LOGS ("ship-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Log([string]$text) {
    Write-Host $text
    [System.IO.File]::AppendAllText($LOG, $text + "`r`n", $utf8)
}

# Roda um bloco, mostrando e gravando toda a saida (stdout + stderr). Retorna o exit code.
function Step([string]$title, [string]$dir, [scriptblock]$block) {
    Log ""
    Log "=================================================================="
    Log "== $title  ($(Get-Date -Format 'HH:mm:ss'))"
    Log "=================================================================="
    Push-Location $dir
    $global:LASTEXITCODE = 0
    try {
        & $block *>&1 | ForEach-Object { Log ([string]$_) }
        $code = $global:LASTEXITCODE
    } catch {
        Log "EXCECAO: $($_ | Out-String)"
        $code = 1
    } finally {
        Pop-Location
    }
    Log "== fim: $title -> exit $code"
    return $code
}

# Mesmo Postgres e EVO_CRED_KEY do back para o teste local.
function Load-BackEnv {
    $envFile = Join-Path $ROOT "back\.env"
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            Set-Item -Path "Env:$($Matches[1])" -Value $value
        }
    }
}

Log "ship.ps1 iniciado em $(Get-Date -Format 's') - log: $LOG"
$failed = @()

if (-not $SkipMigrate) {
    if ((Step "1. Migration do banco" (Join-Path $ROOT "back") { bun install; bun run db:migrate }) -ne 0) { $failed += "migration" }
}
if ($failed.Count -eq 0 -and -not $SkipBack) {
    if ((Step "2. Deploy do back" (Join-Path $ROOT "back") { .\deploy.ps1 }) -ne 0) { $failed += "back" }
}
if ($failed.Count -eq 0 -and -not $SkipFront) {
    if ((Step "3. Deploy do front" (Join-Path $ROOT "front") { .\deploy.ps1 }) -ne 0) { $failed += "front" }
}
if ($failed.Count -eq 0 -and -not $SkipLocal) {
    $code = Step "4. Teste local do job ($LocalArgs)" $CHECKER {
        bun install
        bun run typecheck
        bun test
        Load-BackEnv
        $env:EVO_SCREENSHOTS_DIR = Join-Path $CHECKER "logs\screenshots"
        Invoke-Expression "bun src/check.ts $LocalArgs"
    }
    if ($code -ne 0) { $failed += "teste-local" }
}
if ($failed.Count -eq 0 -and -not $SkipJob) {
    $jobStart = Get-Date
    $deployParams = @{}
    if ($JobDryRun) { $deployParams.DryRunNow = $true } else { $deployParams.RunNow = $true }
    if ($SkipBuild) { $deployParams.SkipBuild = $true }
    $title = if ($JobDryRun) { "5. Deploy e execucao do Cloud Run Job (DRY-RUN)" } else { "5. Deploy e execucao do Cloud Run Job" }
    if ((Step $title $CHECKER { .\deploy.ps1 @deployParams }) -ne 0) { $failed += "job" }
    Step "5b. Logs da execucao do job" $CHECKER {
        Start-Sleep -Seconds 20  # o Cloud Logging leva alguns segundos para indexar
        # Janela de tempo desde o inicio da etapa 5 (evita misturar execucoes anteriores
        # sem precisar de aspas no filtro, que o PowerShell 5 estraga ao chamar gcloud.cmd).
        $minutes = [int][Math]::Ceiling(((Get-Date) - $jobStart).TotalMinutes) + 1
        gcloud.cmd logging read "resource.type=cloud_run_job AND resource.labels.job_name=evo-payment-checker" `
            --project=gym-conversion-tracker --limit=3000 --freshness="$($minutes)m" --order=asc --format="value(textPayload)"
    } | Out-Null
}

Log ""
if ($failed.Count -gt 0) {
    Log "RESULTADO: falhou em: $($failed -join ', ')"
    exit 1
}
Log "RESULTADO: tudo certo."
