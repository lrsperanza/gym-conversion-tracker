<#
.SYNOPSIS
Deploy do evo-payment-checker como Cloud Run Job + Cloud Scheduler diario.

.DESCRIPTION
1. Builda a imagem a partir da raiz do monorepo (precisa do evo-puppeteer).
2. Publica no Artifact Registry do projeto.
3. Cria/atualiza o Cloud Run Job, copiando do servico do back as variaveis de
   banco e a EVO_CRED_KEY (valores simples ou referencias ao Secret Manager).
4. Cria/atualiza o Cloud Scheduler para rodar todo dia a 01:00 (Brasilia).

.PARAMETER RunNow
Executa o job uma vez logo depois do deploy (para acompanhar o primeiro run).

.PARAMETER DryRunNow
Publica o job com CHECK_DRY_RUN=true e executa uma vez: loga as decisoes sem gravar no banco.
ATENCAO: o job fica em dry-run ate o proximo deploy sem esta flag (-RunNow ou sem flags).

.PARAMETER SkipBuild
Reaproveita a imagem :latest ja publicada.
#>
param(
    [switch]$RunNow,
    [switch]$DryRunNow,
    [switch]$SkipBuild,
    [string]$Schedule = "0 1 * * *"
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$PROJECT_ID = "gym-conversion-tracker"
$REGION = "southamerica-east1"
$REPOSITORY = "gym-conversion-tracker-registry"
$REGISTRY = "$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY"
$BACK_SERVICE = "gym-conversion-tracker"
$JOB_NAME = "evo-payment-checker"
$SCHEDULER_NAME = "evo-payment-checker-daily"
$TIME_ZONE = "America/Sao_Paulo"
$IMAGE = "$REGISTRY/evo-payment-checker"
$GCLOUD = "gcloud.cmd"
# Variaveis que o job precisa e que ja existem no servico do back.
$SHARED_ENV = @("PostgreHost", "PostgrePort", "PostgreDatabase", "PostgreUser", "PostgrePassword", "PostgreSSL", "EVO_CRED_KEY")

$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
$TIMESTAMP = Get-Date -Format "yyyyMMdd-HHmmss"

function Fail($Message) {
    Write-Error $Message -ErrorAction Continue
    exit 1
}

Write-Host "=============================================="
Write-Host "Deploy $JOB_NAME (Cloud Run Job + Scheduler)"
Write-Host "Projeto: $PROJECT_ID  Regiao: $REGION"
Write-Host "Agenda:  '$Schedule' ($TIME_ZONE)"
Write-Host "=============================================="

& $GCLOUD services enable run.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com --project=$PROJECT_ID --quiet
if ($LASTEXITCODE -ne 0) { Fail "Nao foi possivel habilitar as APIs necessarias." }

if (-not $SkipBuild) {
    $DOCKER_CONFIG_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "docker-config-$((New-Guid).ToString().Substring(0,8))"
    New-Item -ItemType Directory -Path $DOCKER_CONFIG_DIR | Out-Null
    $ORIGINAL_DOCKER_CONFIG = $env:DOCKER_CONFIG
    $env:DOCKER_CONFIG = $DOCKER_CONFIG_DIR
    try {
        & $GCLOUD auth configure-docker "$REGION-docker.pkg.dev" --quiet
        if ($LASTEXITCODE -ne 0) {
            $token = & $GCLOUD auth print-access-token 2>&1
            if ($LASTEXITCODE -ne 0) { Fail "Falha ao obter token. Rode 'gcloud auth login'." }
            $token | & docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev"
            if ($LASTEXITCODE -ne 0) { Fail "Docker login falhou." }
        }

        Write-Host "`nBuildando imagem (contexto: $ROOT)..."
        $env:DOCKER_BUILDKIT = "1"
        & docker build --platform linux/amd64 -f (Join-Path $PSScriptRoot "Dockerfile") -t "$($IMAGE):$TIMESTAMP" -t "$($IMAGE):latest" $ROOT
        if ($LASTEXITCODE -ne 0) { Fail "Docker build falhou." }

        & docker push "$($IMAGE):$TIMESTAMP"
        if ($LASTEXITCODE -ne 0) { Fail "Docker push falhou." }
        & docker push "$($IMAGE):latest"
        if ($LASTEXITCODE -ne 0) { Fail "Docker push (latest) falhou." }
        $IMAGE_REF = "$($IMAGE):$TIMESTAMP"
    } finally {
        $env:DOCKER_CONFIG = $ORIGINAL_DOCKER_CONFIG
        if (Test-Path $DOCKER_CONFIG_DIR) { Remove-Item -Recurse -Force $DOCKER_CONFIG_DIR }
    }
} else {
    $IMAGE_REF = "$($IMAGE):latest"
}

# --- Variaveis do back -------------------------------------------------------
Write-Host "`nLendo variaveis do servico $BACK_SERVICE..."
$serviceJson = & $GCLOUD run services describe $BACK_SERVICE --region=$REGION --project=$PROJECT_ID --format=json
if ($LASTEXITCODE -ne 0) { Fail "Nao foi possivel ler o servico $BACK_SERVICE." }
$service = $serviceJson | Out-String | ConvertFrom-Json
$container = $service.spec.template.spec.containers[0]
Write-Host "Variaveis no servico: $(($container.env | ForEach-Object { $_.name }) -join ', ')"
$serviceAccount = $service.spec.template.spec.serviceAccountName
if ([string]::IsNullOrWhiteSpace($serviceAccount)) {
    $projectNumber = (& $GCLOUD projects describe $PROJECT_ID --format="value(projectNumber)").Trim()
    $serviceAccount = "$projectNumber-compute@developer.gserviceaccount.com"
}

$envFile = Join-Path ([System.IO.Path]::GetTempPath()) "evo-checker-env-$((New-Guid).ToString().Substring(0,8)).yaml"
# CHECK_DRY_RUN fica gravado no job: -DryRunNow publica com 'true' (inclusive para a
# execucao das 01:00, se ninguem republicar); qualquer outro deploy volta para 'false'.
$dryRunValue = if ($DryRunNow) { "true" } else { "false" }
$envLines = @("EVO_CHECKER_USER_EMAIL: 'lrsperanza@gmail.com'", "GYM_TIMEZONE: '$TIME_ZONE'", "CHECK_DRY_RUN: '$dryRunValue'")
$secrets = @()
foreach ($name in $SHARED_ENV) {
    $item = $container.env | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $item) {
        # Opcionais: ausentes no servico, o back usa os defaults (5432, banco/usuario "postgres", sem SSL);
        # o job usa os mesmos defaults em src/env.ts.
        if (@("PostgrePort", "PostgreSSL", "PostgreDatabase", "PostgreUser") -contains $name) { continue }
        Fail "Variavel $name nao encontrada no servico $BACK_SERVICE."
    }
    if ($item.valueFrom -and $item.valueFrom.secretKeyRef) {
        $ref = $item.valueFrom.secretKeyRef
        $secrets += "$name=$($ref.name):$($ref.key)"
    } else {
        $escaped = ([string]$item.value).Replace("'", "''")
        $envLines += "$($name): '$escaped'"
    }
}
# Sem BOM: o parser YAML do gcloud nao aceita BOM do Set-Content -Encoding UTF8 (PS 5).
[System.IO.File]::WriteAllLines($envFile, [string[]]$envLines)

try {
    Write-Host "`nCriando/atualizando o Cloud Run Job $JOB_NAME..."
    $jobArgs = @(
        "run", "jobs", "deploy", $JOB_NAME,
        "--image=$IMAGE_REF",
        "--region=$REGION",
        "--project=$PROJECT_ID",
        "--tasks=1",
        "--max-retries=1",
        "--task-timeout=3600s",
        "--memory=2Gi",
        "--cpu=1",
        "--service-account=$serviceAccount",
        "--env-vars-file=$envFile"
    )
    if ($secrets.Count -gt 0) { $jobArgs += "--set-secrets=$($secrets -join ',')" }
    & $GCLOUD @jobArgs
    if ($LASTEXITCODE -ne 0) { Fail "Deploy do Cloud Run Job falhou." }
} finally {
    if (Test-Path $envFile) { Remove-Item -Force $envFile }
}

# --- Agenda ------------------------------------------------------------------
Write-Host "`nPermitindo que $serviceAccount dispare o job..."
& $GCLOUD run jobs add-iam-policy-binding $JOB_NAME --region=$REGION --project=$PROJECT_ID `
    --member="serviceAccount:$serviceAccount" --role="roles/run.invoker" --quiet | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Falha ao conceder roles/run.invoker." }

$runUri = "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$($JOB_NAME):run"
$schedulerArgs = @(
    "--location=$REGION",
    "--project=$PROJECT_ID",
    "--schedule=$Schedule",
    "--time-zone=$TIME_ZONE",
    "--uri=$runUri",
    "--http-method=POST",
    "--oauth-service-account-email=$serviceAccount"
)
& $GCLOUD scheduler jobs describe $SCHEDULER_NAME --location=$REGION --project=$PROJECT_ID 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Atualizando agenda $SCHEDULER_NAME..."
    & $GCLOUD scheduler jobs update http $SCHEDULER_NAME @schedulerArgs
} else {
    Write-Host "Criando agenda $SCHEDULER_NAME..."
    & $GCLOUD scheduler jobs create http $SCHEDULER_NAME @schedulerArgs
}
if ($LASTEXITCODE -ne 0) { Fail "Falha ao criar/atualizar o Cloud Scheduler." }

if ($RunNow -or $DryRunNow) {
    $executeArgs = @("run", "jobs", "execute", $JOB_NAME, "--region=$REGION", "--project=$PROJECT_ID", "--wait")
    if ($DryRunNow) {
        Write-Host "`nExecutando o job agora em DRY-RUN (nao grava no banco)..."
    } else {
        Write-Host "`nExecutando o job agora (aguardando terminar)..."
    }
    & $GCLOUD @executeArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "O job terminou com erro. Veja os logs abaixo." }
    Write-Host "Logs: gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=$JOB_NAME' --project=$PROJECT_ID --limit=200 --freshness=1h --format='value(textPayload)'"
}

Write-Host "`n=============================================="
Write-Host "Pronto. Job: $JOB_NAME  Agenda: $SCHEDULER_NAME ($Schedule, $TIME_ZONE)"
Write-Host "Imagem: $IMAGE_REF"
Write-Host "=============================================="
