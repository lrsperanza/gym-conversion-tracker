#Requires -Version 5.1
<#
.SYNOPSIS
  Sobe back (:3000), front dev (:5173) e evo-bridge (:4000, fazendo proxy para o front local).

.DESCRIPTION
  O bridge recebe FRONT_URL=http://localhost:5173 e BACK_URL=http://localhost:3000,
  então http://localhost:4000 serve o front local (não o SWA remoto) com a API local.
  Os logs das partes aparecem multiplexados neste terminal. Ctrl+C (ou fechar o
  terminal) encerra todas as partes, inclusive o Chrome aberto pelo bridge.

.EXAMPLE
  .\run-all.ps1
  .\run-all.ps1 -NoInstall
#>
[CmdletBinding()]
param(
    [switch]$NoInstall   # Pula a verificação/instalação de dependências
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$requiredDirs = 'back', 'front', 'evo-bridge', 'evo-puppeteer'
$root = $null
foreach ($candidate in @((Split-Path -Parent $scriptDir), $scriptDir)) {
    $missing = @($requiredDirs | Where-Object { -not (Test-Path (Join-Path $candidate $_)) })
    if ($missing.Count -eq 0) { $root = $candidate; break }
}
if (-not $root) {
    throw "Não encontrei back/front/evo-bridge/evo-puppeteer ao lado de $scriptDir."
}

$backDir      = Join-Path $root 'back'
$frontDir     = Join-Path $root 'front'
$bridgeDir    = Join-Path $root 'evo-bridge'
$puppeteerDir = Join-Path $root 'evo-puppeteer'

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) { throw 'bun não está no PATH. Instale em https://bun.sh e tente novamente.' }
$script:BunPath = $bunCmd.Source

# Job object com KILL_ON_JOB_CLOSE: cada processo filho passa a morrer junto com
# este script, mesmo se o terminal for fechado sem passar pelo finally.
$jobType = @'
using System;
using System.Runtime.InteropServices;

public static class KillOnCloseJob
{
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static IntPtr job = IntPtr.Zero;

    public static void Init()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(ptr); }
    }

    public static int Add(IntPtr processHandle)
    {
        if (job == IntPtr.Zero) return -1;
        if (AssignProcessToJobObject(job, processHandle)) return 0;
        return Marshal.GetLastWin32Error();
    }
}
'@

$script:JobReady = $false
$script:JobWarned = $false
try {
    Add-Type -TypeDefinition $jobType -Language CSharp -ErrorAction Stop
    [KillOnCloseJob]::Init()
    $script:JobReady = $true
}
catch {
    Write-Warning "Job object indisponível ($($_.Exception.Message)); o encerramento dependerá só do taskkill."
}

$script:Running = New-Object System.Collections.Generic.List[object]
# PID file permite que stop-all.ps1 limpe tudo mesmo se este script morrer de forma abrupta
$script:PidFile = Join-Path $scriptDir '.run-all.pids'

function Save-PidFile {
    $script:Running | ForEach-Object { $_.Proc.Id } | Set-Content -Path $script:PidFile -Encoding ascii
}

function Assert-PortFree {
    param([int]$Port, [string]$Name)
    $client = New-Object System.Net.Sockets.TcpClient
    $inUse = $false
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $inUse = $async.AsyncWaitHandle.WaitOne(300) -and $client.Connected
    }
    catch [System.Net.Sockets.SocketException] { }
    finally { $client.Close() }
    if (-not $inUse) { return }

    $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    $alive = @()
    foreach ($ownerPid in $owners) {
        $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if ($proc) { $alive += "$($proc.ProcessName) (pid $ownerPid)" }
    }
    if ($alive.Count -gt 0) {
        throw "Porta $Port ($Name) já está em uso por $($alive -join ', '). Encerre o processo (ou rode .\stop-all.ps1) e tente de novo."
    }

    # Socket órfão: o dono morreu, mas outro processo herdou o handle do socket.
    # O caso conhecido aqui é o Chrome do EVO, aberto destacado pelo bridge —
    # fechar a janela dele é o que libera a porta.
    $evoChrome = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '--user-data-dir=.*[\\/]perfis[\\/]' -and $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1
    if ($evoChrome) {
        throw "Porta $Port ($Name) está presa por um socket órfão: o Chrome do EVO (pid $($evoChrome.ProcessId)), aberto pelo bridge anterior, herdou o socket e mantém a porta ocupada. Feche a janela do Chrome do EVO (salve o cadastro no EVO antes, se houver) e tente de novo."
    }
    throw "Porta $Port ($Name) está presa por um socket órfão: o processo dono (pid $($owners -join ', ')) já morreu, mas outro processo herdou o socket. Reinicie o PC para liberar a porta."
}

function Ensure-Deps {
    param([string]$Name, [string]$Dir, [string]$ExtraCheck)
    if ($NoInstall) { return }
    $needsInstall = -not (Test-Path (Join-Path $Dir 'node_modules'))
    if (-not $needsInstall -and $ExtraCheck) {
        $needsInstall = -not (Test-Path (Join-Path $Dir $ExtraCheck))
    }
    if ($needsInstall) {
        Write-Host "Installing dependencies for $Name..." -ForegroundColor Cyan
        Push-Location $Dir
        try {
            & $script:BunPath install
            if ($LASTEXITCODE -ne 0) { throw "bun install falhou em $Name" }
        }
        finally { Pop-Location }
    }
}

function Start-Part {
    param([string]$Name, [string]$WorkDir, [string[]]$Arguments, [ConsoleColor]$Color)
    $outLog = Join-Path $env:TEMP "run-all-$PID-$Name.out.log"
    $errLog = Join-Path $env:TEMP "run-all-$PID-$Name.err.log"
    $proc = Start-Process -FilePath $script:BunPath -ArgumentList $Arguments -WorkingDirectory $WorkDir `
        -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($script:JobReady) {
        try {
            $assignErr = [KillOnCloseJob]::Add($proc.Handle)
            if ($assignErr -ne 0 -and -not $script:JobWarned) {
                $script:JobWarned = $true
                Write-Warning "Processos filhos não puderam ser vinculados ao job kill-on-close (erro $assignErr). Ctrl+C ainda encerra tudo; fechar a janela do terminal pode deixar órfãos."
            }
        }
        catch { }
    }
    $part = [pscustomobject]@{
        Name = $Name; Proc = $proc; Color = $Color
        OutLog = $outLog; ErrLog = $errLog; OutPos = 0L; ErrPos = 0L
    }
    $script:Running.Add($part) | Out-Null
    Write-Host "started $Name (pid $($proc.Id))" -ForegroundColor DarkGray
    return $part
}

function Update-Logs {
    foreach ($part in $script:Running) {
        foreach ($stream in @('Out', 'Err')) {
            $path = $part."${stream}Log"
            if (-not (Test-Path $path)) { continue }
            $fs = $null; $reader = $null
            try {
                $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $posProp = "${stream}Pos"
                $fs.Position = $part.$posProp
                $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
                $text = $reader.ReadToEnd()
                $part.$posProp = $fs.Position
                if ($text) {
                    foreach ($line in ($text -split "`r?`n")) {
                        if ($line) { Write-Host "[$($part.Name)] $line" -ForegroundColor $part.Color }
                    }
                }
            }
            catch { }
            finally {
                if ($reader) { $reader.Close() } elseif ($fs) { $fs.Close() }
            }
        }
    }
}

function Wait-Part {
    param([object]$Part, [string]$Url, [int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($Part.Proc.HasExited) {
            Update-Logs
            throw "$($Part.Name) encerrou durante a inicialização (código $($Part.Proc.ExitCode)). Veja o log acima."
        }
        try {
            $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            Write-Host "$($Part.Name) is up at $Url" -ForegroundColor Green
            return
        }
        catch { }
        Update-Logs
        Start-Sleep -Milliseconds 600
    }
    Update-Logs
    Write-Warning "$($Part.Name) não respondeu em $Url após ${TimeoutSec}s; continuando mesmo assim."
}

try {
    Write-Host "Repo root: $root" -ForegroundColor DarkGray

    Assert-PortFree -Port 3000 -Name 'back'
    Assert-PortFree -Port 4000 -Name 'evo-bridge'
    Assert-PortFree -Port 5173 -Name 'front-dev'

    Ensure-Deps -Name 'back' -Dir $backDir
    Ensure-Deps -Name 'front' -Dir $frontDir
    Ensure-Deps -Name 'evo-puppeteer' -Dir $puppeteerDir
    # O link file:../evo-puppeteer pode ter ficado obsoleto após a mudança de pasta
    Ensure-Deps -Name 'evo-bridge' -Dir $bridgeDir -ExtraCheck 'node_modules\evo-puppeteer\src\index.ts'

    if (-not (Test-Path (Join-Path $backDir '.env'))) {
        Write-Warning 'back\.env não encontrado. Copie back\.env.example e configure; a API pode falhar ao subir.'
    }

    $backPart = Start-Part -Name 'back' -WorkDir $backDir -Arguments @('run', 'dev') -Color Cyan
    $frontPart = Start-Part -Name 'front-dev' -WorkDir $frontDir -Arguments @('run', 'dev') -Color Magenta
    # O bridge faz proxy pela rede: sem FRONT_URL/BACK_URL ele cairia nos defaults de nuvem
    $env:FRONT_URL = 'http://localhost:5173'
    $env:BACK_URL = 'http://localhost:3000'
    # 'start' em vez de 'dev': --watch reiniciaria o server no meio de jobs Puppeteer
    $bridgePart = Start-Part -Name 'evo-bridge' -WorkDir $bridgeDir -Arguments @('run', 'start') -Color Green
    Save-PidFile

    Wait-Part -Part $backPart -Url 'http://localhost:3000/health'
    Wait-Part -Part $frontPart -Url 'http://localhost:5173'
    Wait-Part -Part $bridgePart -Url 'http://localhost:4000/evo/health'

    Write-Host ''
    Write-Host 'All parts are running:' -ForegroundColor Green
    Write-Host '  App (front local + API local via bridge): http://localhost:4000'
    Write-Host '  API (back):                               http://localhost:3000'
    Write-Host '  Front dev server (HMR):                   http://localhost:5173'
    Write-Host '  evo-puppeteer: embutido no evo-bridge; o Chrome abre sob demanda ao registrar uma venda.'
    Write-Host ''
    Write-Host 'Press Ctrl+C to stop everything.' -ForegroundColor Yellow

    while ($true) {
        Update-Logs
        $dead = @($script:Running | Where-Object { $_.Proc.HasExited })
        if ($dead.Count -gt 0) {
            Write-Host ''
            Write-Warning "$($dead[0].Name) encerrou inesperadamente (código $($dead[0].Proc.ExitCode)). Derrubando as demais partes."
            break
        }
        Start-Sleep -Milliseconds 500
    }
}
finally {
    Write-Host ''
    Write-Host 'Stopping all parts...' -ForegroundColor Yellow
    foreach ($part in $script:Running) {
        try {
            if (-not $part.Proc.HasExited) {
                $null = & taskkill.exe /PID $part.Proc.Id /T /F 2>&1
            }
        }
        catch { }
    }
    Start-Sleep -Milliseconds 800
    Update-Logs
    foreach ($part in $script:Running) {
        Remove-Item $part.OutLog, $part.ErrLog -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $script:PidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'All parts stopped.' -ForegroundColor Yellow
}
