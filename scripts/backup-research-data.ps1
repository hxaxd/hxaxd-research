[CmdletBinding()]
param(
    [string]$Output
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BackendRoot = Join-Path $RepositoryRoot "backend"
$CommandArguments = @("run", "python", "-m", "scripts.backup_data")

if ($Output) {
    $OutputPath = [System.IO.Path]::GetFullPath($Output)
    $CommandArguments += @("--output", $OutputPath)
}

Push-Location $BackendRoot
try {
    & uv @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "研究数据备份失败，退出码: $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
