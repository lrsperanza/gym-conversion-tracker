<#
.SYNOPSIS
Deploy script for gym-conversion-tracker-back
Builds, pushes to Artifact Registry, and deploys to Cloud Run
#>

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

# Configuration
$PROJECT_ID = "gym-conversion-tracker"
$REGION = "southamerica-east1"
$REPOSITORY = "gym-conversion-tracker-registry"
$REGISTRY = "$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY"
$SERVICE_NAME = "gym-conversion-tracker"
$IMAGE_NAME = "gym-conversion-tracker-image"
$CORS_ORIGIN = "*"
$APP_URL = "https://nice-pebble-04842d70f.7.azurestaticapps.net"
$GCLOUD = "gcloud.cmd"

# Generate a timestamp tag for versioning
$TIMESTAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$IMAGE_TAG = "$REGISTRY/$IMAGE_NAME"

Write-Host "=============================================="
Write-Host "Deploying $SERVICE_NAME"
Write-Host "=============================================="
Write-Host "Project:  $PROJECT_ID"
Write-Host "Region:   $REGION"
Write-Host "Image:    $IMAGE_TAG"
Write-Host "=============================================="

function Fail($Message) {
    Write-Error $Message -ErrorAction Continue
    exit 1
}

# Setup temporary Docker config to avoid credHelper issues
$DOCKER_CONFIG_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "docker-config-$((New-Guid).ToString().Substring(0,8))"
New-Item -ItemType Directory -Path $DOCKER_CONFIG_DIR | Out-Null
$ORIGINAL_DOCKER_CONFIG = $env:DOCKER_CONFIG
$env:DOCKER_CONFIG = $DOCKER_CONFIG_DIR

try {
    # Step 1: Authenticate with GCP and Docker
    Write-Host "`nConfiguring Docker authentication..."
    & $GCLOUD auth configure-docker "$REGION-docker.pkg.dev" --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: gcloud auth configure-docker failed. Trying access token approach..."
        $token = & $GCLOUD auth print-access-token 2>&1
        if ($LASTEXITCODE -ne 0) {
            Fail "Failed to get access token. Run 'gcloud auth login' first."
        }
        $token | & docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev"
        if ($LASTEXITCODE -ne 0) {
            Fail "Docker login failed. Check your GCP credentials."
        }
    }

    # Step 2: Ensure Artifact Registry repository exists
    Write-Host "`nChecking Artifact Registry repository..."
    & $GCLOUD artifacts repositories describe $REPOSITORY --location=$REGION --project=$PROJECT_ID 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Repository $REPOSITORY not found. Creating it..."
        & $GCLOUD artifacts repositories create $REPOSITORY `
            --repository-format=docker `
            --location=$REGION `
            --project=$PROJECT_ID `
            --description="Docker images for $SERVICE_NAME"
        if ($LASTEXITCODE -ne 0) {
            Fail "Failed to create Artifact Registry repository $REPOSITORY."
        }
    }

    # Step 3: Build the Docker image
    Write-Host "`nBuilding Docker image..."
    & docker build --platform linux/amd64 -t "$($IMAGE_TAG):$TIMESTAMP" -t "$($IMAGE_TAG):latest" .
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker build failed."
    }

    # Step 4: Push to Artifact Registry
    Write-Host "`nPushing to Artifact Registry..."
    & docker push "$($IMAGE_TAG):$TIMESTAMP"
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker push failed for tag $TIMESTAMP."
    }
    & docker push "$($IMAGE_TAG):latest"
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker push failed for tag latest."
    }

    # Step 5: Deploy to Cloud Run
    Write-Host "`nDeploying to Cloud Run..."

    $deployArgs = @(
        "run", "deploy", $SERVICE_NAME,
        "--image=$($IMAGE_TAG):$TIMESTAMP",
        "--region=$REGION",
        "--platform=managed",
        "--allow-unauthenticated",
        "--memory=512Mi",
        "--cpu=1",
        "--timeout=1800",
        "--concurrency=80",
        "--port=8080",
        "--update-env-vars=CORS_ORIGIN=$CORS_ORIGIN,APP_URL=$APP_URL",
        "--project=$PROJECT_ID"
    )

    Write-Host "Running: gcloud $($deployArgs -join ' ')`n"
    & $GCLOUD @deployArgs
    if ($LASTEXITCODE -ne 0) {
        Fail "Cloud Run deployment failed."
    }

    # Get the service URL and verify health
    Write-Host "`n=============================================="
    Write-Host "Deployment complete!"
    Write-Host "=============================================="
    $SERVICE_URL = & $GCLOUD run services describe $SERVICE_NAME --region=$REGION --project=$PROJECT_ID --format="value(status.url)"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($SERVICE_URL)) {
        Fail "Failed to read Cloud Run service URL."
    }
    $SERVICE_URL = $SERVICE_URL.Trim()

    $HEALTH_URL = "$SERVICE_URL/health"
    Write-Host "Checking health: $HEALTH_URL"
    try {
        $healthResponse = Invoke-WebRequest -Uri $HEALTH_URL -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
        if ($healthResponse.StatusCode -lt 200 -or $healthResponse.StatusCode -ge 300) {
            Fail "Health check failed with status $($healthResponse.StatusCode)."
        }
        Write-Host "Health: $($healthResponse.Content)"
    } catch {
        Fail "Health check failed: $($_.Exception.Message)"
    }

    Write-Host "Service URL: $SERVICE_URL"
    Write-Host "Image tag:   $TIMESTAMP"
    Write-Host "=============================================="
} finally {
    $env:DOCKER_CONFIG = $ORIGINAL_DOCKER_CONFIG

    # Cleanup temporary Docker config
    if (Test-Path $DOCKER_CONFIG_DIR) {
        Remove-Item -Recurse -Force $DOCKER_CONFIG_DIR
    }
}
