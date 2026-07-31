#Requires -Version 5.1
<#
.SYNOPSIS
  Encerra todas as partes subidas pelo run-all.ps1.

.DESCRIPTION
  Rede de segurança para quando o run-all.ps1 morre de forma abrupta (terminal
  fechado em ambiente que não permite o job kill-on-close): usa o arquivo
  .run-all.pids e, como fallback, os processos escutando nas portas do app
  (3000, 4000, 5173).
#>
[CmdletBinding()]
param()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir '.run-all.pids'

$targetPids = @()
if (Test-Path $pidFile) {
    $targetPids += Get-Content $pidFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
}
foreach ($port in @(3000, 4000, 5173)) {
    try {
        $targetPids += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess
    }
    catch { }
}
$targetPids = @($targetPids | Sort-Object -Unique)

if ($targetPids.Count -eq 0) {
    Write-Host 'Nenhuma parte do run-all em execução.'
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}

foreach ($targetPid in $targetPids) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "Stopping $($proc.ProcessName) (pid $targetPid) and its tree..."
        $null = & taskkill.exe /PID $targetPid /T /F 2>&1
    }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'All parts stopped.'
