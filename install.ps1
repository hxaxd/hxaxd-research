$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    & node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24+ is required'); process.exit(1); }"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24+ is required.' }

    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }

    Write-Host 'Installation complete. Run npm start to open the workbench at http://127.0.0.1:8642.'
} finally {
    Pop-Location
}
