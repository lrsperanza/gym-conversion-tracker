$deployTarget = @{
        Name = "gym-conversion-tracker"
        TenantId = "6ecf91ef-34d7-4e94-9926-7f8262d34dbc"
        SubscriptionId = "1475e090-076c-4faa-98b4-af8b83c62e03"
        DeploymentToken = "1ebc0a5a12ec65e5015f689471d9dae1fcda820623fa6215ca20f306401d530d07-57ff21e7-dca5-41e9-8eef-44b33fad8cf800f241704842d70f"
    }


$target = $deployTarget

if (-not $target) {
    Write-Error "Invalid selection. Please run the script again and choose 1 or 2."
    exit 1
}

Write-Host "Building with Vite..."
bun run build

if ($LASTEXITCODE -ne 0) {
    Write-Error "Vite build failed."
    exit $LASTEXITCODE
}

Write-Host "Deploying to $($target.Name)..."
$deployArgs = @(
    "deploy",
    "--no-use-keychain",
    "--tenant-id",
    $target.TenantId,
    "--subscription-id",
    $target.SubscriptionId,
    "--env",
    "production",
    "--config-name",
    $target.Name
)

if ($target.DeploymentToken) {
    $deployArgs += @("--deployment-token", $target.DeploymentToken)
}

swa @deployArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "SWA deploy failed."
    exit $LASTEXITCODE
}