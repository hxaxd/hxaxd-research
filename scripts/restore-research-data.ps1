[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Snapshot,

    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BackendRoot = Join-Path $RepositoryRoot "backend"
$SnapshotPath = (Resolve-Path -LiteralPath $Snapshot).Path
$CommandArguments = @(
    "run",
    "python",
    "-m",
    "scripts.restore_data",
    $SnapshotPath
)

if ($Replace) {
    $CommandArguments += "--replace"
}

Push-Location $BackendRoot
try {
    & uv @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "研究数据重建失败，退出码: $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
