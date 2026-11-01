# Baixa os logs recentes do Cloud Run Job para logs\job-<data>.log (UTF-8).
param([int]$Minutes = 90, [switch]$CancelRunning)
if ($CancelRunning) {
    # Cancela a execucao mais recente (se ja terminou, o gcloud so reclama e seguimos).
    $latest = & gcloud.cmd run jobs executions list --job=evo-payment-checker --region=southamerica-east1 `
        --project=gym-conversion-tracker --limit=1 --format="value(name)" 2>$null | Select-Object -First 1
    if ($latest) { & gcloud.cmd run jobs executions cancel $latest --region=southamerica-east1 --project=gym-conversion-tracker --quiet 2>&1 | Out-Null }
}
$LOGS = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
$out = Join-Path $LOGS ("job-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$lines = & gcloud.cmd logging read "resource.type=cloud_run_job AND resource.labels.job_name=evo-payment-checker" `
    --project=gym-conversion-tracker --limit=5000 --freshness="$($Minutes)m" --order=asc `
    --format="value(timestamp,labels.'run.googleapis.com/execution_name',textPayload)" 2>&1
$execs = & gcloud.cmd run jobs executions list --job=evo-payment-checker --region=southamerica-east1 --project=gym-conversion-tracker --limit=5 2>&1
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($out, [string[]](@("== execucoes") + ($execs | ForEach-Object { [string]$_ }) + @("== logs") + ($lines | ForEach-Object { [string]$_ })), $utf8)
