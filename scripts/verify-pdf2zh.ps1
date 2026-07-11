[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ExpectedVersion = "2.9.0"

function Get-Pdf2zhExecutable {
    $command = Get-Command "pdf2zh_next" -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $uv = Get-Command "uv" -ErrorAction SilentlyContinue
    if (-not $uv) { return $null }

    $binDirectory = (& $uv.Source tool dir --bin).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $binDirectory) { return $null }

    foreach ($name in @("pdf2zh_next.exe", "pdf2zh_next.cmd", "pdf2zh_next")) {
        $candidate = Join-Path $binDirectory $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

$executable = Get-Pdf2zhExecutable
if (-not $executable) {
    Write-Output "NOT FOUND: pdf2zh_next is not installed."
    Write-Output "Run .\scripts\install-pdf2zh.ps1 or see 指导/学习/PDF 翻译脚本配置.md"
    exit 1
}

$output = (& $executable --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    Write-Output "ERROR: pdf2zh_next found at $executable but --version failed."
    exit 1
}

$versionMatch = [regex]::Match($output, "(?m)^pdf2zh-next version:\s*(\d+\.\d+\.\d+)\s*$")
if ($versionMatch.Success) {
    $version = $versionMatch.Groups[1].Value
    if ($version -eq $ExpectedVersion) {
        Write-Output "OK: pdf2zh_next $ExpectedVersion at $executable"
        exit 0
    }
    else {
        Write-Output "WRONG VERSION: pdf2zh_next $version (expected $ExpectedVersion) at $executable"
        Write-Output "Run .\scripts\install-pdf2zh.ps1 to install the correct version."
        exit 1
    }
}

Write-Output "UNKNOWN: could not parse version from: $output"
exit 1
