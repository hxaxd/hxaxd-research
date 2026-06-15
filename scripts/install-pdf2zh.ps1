[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ExpectedVersion = "2.9.0"

function Get-Pdf2zhExecutable {
    $command = Get-Command "pdf2zh_next" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $uv = Get-Command "uv" -ErrorAction SilentlyContinue
    if (-not $uv) {
        return $null
    }

    $binDirectory = (& $uv.Source tool dir --bin).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $binDirectory) {
        return $null
    }

    foreach ($name in @("pdf2zh_next.exe", "pdf2zh_next.cmd", "pdf2zh_next")) {
        $candidate = Join-Path $binDirectory $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Get-Pdf2zhVersion {
    param([Parameter(Mandatory)][string]$Executable)

    $output = (& $Executable --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    $versionMatch = [regex]::Match(
        $output,
        "(?m)^pdf2zh-next version:\s*(\d+\.\d+\.\d+)\s*$"
    )
    if ($versionMatch.Success) {
        return $versionMatch.Groups[1].Value
    }
    return $output
}

$uv = Get-Command "uv" -ErrorAction SilentlyContinue
if (-not $uv) {
    throw "uv is required. Install it from https://docs.astral.sh/uv/ first."
}

$executable = Get-Pdf2zhExecutable
if ($executable) {
    $installedVersion = Get-Pdf2zhVersion -Executable $executable
    if ($installedVersion -eq $ExpectedVersion) {
        Write-Output "pdf2zh-next $ExpectedVersion is already installed: $executable"
        exit 0
    }
}

Write-Output "Installing pdf2zh-next $ExpectedVersion in an isolated uv tool environment..."
& $uv.Source tool install --python 3.12 --force "pdf2zh-next==$ExpectedVersion"
if ($LASTEXITCODE -ne 0) {
    throw "uv tool install failed with exit code $LASTEXITCODE."
}

$executable = Get-Pdf2zhExecutable
if (-not $executable) {
    throw "pdf2zh_next was installed but its executable could not be located."
}

$installedVersion = Get-Pdf2zhVersion -Executable $executable
if ($installedVersion -ne $ExpectedVersion) {
    throw "Expected pdf2zh-next $ExpectedVersion, but version output was: $installedVersion"
}

Write-Output "Installed pdf2zh-next ${ExpectedVersion}: $executable"
