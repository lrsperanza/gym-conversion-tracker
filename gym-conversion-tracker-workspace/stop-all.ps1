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

# Um socket pode sobreviver ao processo dono quando outro processo herdou o
# handle (o Chrome do EVO, aberto destacado pelo bridge, é o caso conhecido).
# Melhor avisar aqui do que deixar o próximo run-all.ps1 falhar sem contexto.
Start-Sleep -Milliseconds 500
foreach ($port in @(3000, 4000, 5173)) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        if (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue) { continue }
        $evoChrome = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match '--user-data-dir=.*[\\/]perfis[\\/]' -and $_.CommandLine -notmatch '--type=' } |
            Select-Object -First 1
        if ($evoChrome) {
            Write-Warning "Porta $port segue ocupada: o Chrome do EVO (pid $($evoChrome.ProcessId)) herdou o socket do bridge e mantém a porta presa. Feche a janela do Chrome do EVO para liberar."
        }
        else {
            Write-Warning "Porta $port segue ocupada por um socket órfão (dono pid $($listener.OwningProcess) não existe mais). Se não sumir sozinho, só reiniciando o PC."
        }
    }
}

Write-Host 'All parts stopped.'
