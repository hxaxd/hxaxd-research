[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InputPdf,

    [Parameter(Mandatory)]
    [string]$OutputDir,

    [string]$Pages,

    [string]$Glossary,

    [ValidateRange(1, 1000)]
    [int]$Qps = 4,

    [ValidateRange(1, 1000)]
    [int]$Workers = 4
)

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

function Test-Pdf2zhVersion {
    param([Parameter(Mandatory)][string]$Executable)

    $output = (& $Executable --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to query pdf2zh_next version."
    }
    $versionMatch = [regex]::Match(
        $output,
        "(?m)^pdf2zh-next version:\s*(\d+\.\d+\.\d+)\s*$"
    )
    $installedVersion = if ($versionMatch.Success) {
        $versionMatch.Groups[1].Value
    }
    else {
        $null
    }
    if ($installedVersion -ne $ExpectedVersion) {
        $reportedVersion = if ($installedVersion) { $installedVersion } else { $output }
        throw "pdf2zh-next $ExpectedVersion is required. Version output was: $reportedVersion"
    }
}

function Resolve-PersistentEnvironmentValue {
    param([Parameter(Mandatory)][string]$Name)

    foreach ($scope in @("Process", "User", "Machine")) {
        $value = [Environment]::GetEnvironmentVariable($Name, $scope)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return $null
}

function Test-PdfFile {
    param([Parameter(Mandatory)][System.IO.FileInfo]$File)

    if (-not $File.Exists -or $File.Length -le 4) {
        return $false
    }

    $stream = $File.OpenRead()
    try {
        $header = New-Object byte[] 4
        if ($stream.Read($header, 0, 4) -ne 4) {
            return $false
        }
        return [Text.Encoding]::ASCII.GetString($header) -eq "%PDF"
    }
    finally {
        $stream.Dispose()
    }
}

function Commit-PdfOutputs {
    param(
        [Parameter(Mandatory)][System.IO.FileInfo]$MonoSource,
        [Parameter(Mandatory)][System.IO.FileInfo]$DualSource,
        [Parameter(Mandatory)][string]$MonoTarget,
        [Parameter(Mandatory)][string]$DualTarget,
        [Parameter(Mandatory)][string]$BackupDirectory
    )

    $monoBackup = Join-Path $BackupDirectory "previous-mono.pdf"
    $dualBackup = Join-Path $BackupDirectory "previous-dual.pdf"
    $monoCommitted = $false
    $dualCommitted = $false

    try {
        if (Test-Path -LiteralPath $MonoTarget) {
            Move-Item -LiteralPath $MonoTarget -Destination $monoBackup
        }
        if (Test-Path -LiteralPath $DualTarget) {
            Move-Item -LiteralPath $DualTarget -Destination $dualBackup
        }

        Move-Item -LiteralPath $MonoSource.FullName -Destination $MonoTarget
        $monoCommitted = $true
        Move-Item -LiteralPath $DualSource.FullName -Destination $DualTarget
        $dualCommitted = $true
    }
    catch {
        if ($monoCommitted -and (Test-Path -LiteralPath $MonoTarget)) {
            Remove-Item -LiteralPath $MonoTarget -Force
        }
        if ($dualCommitted -and (Test-Path -LiteralPath $DualTarget)) {
            Remove-Item -LiteralPath $DualTarget -Force
        }
        if (Test-Path -LiteralPath $monoBackup) {
            Move-Item -LiteralPath $monoBackup -Destination $MonoTarget
        }
        if (Test-Path -LiteralPath $dualBackup) {
            Move-Item -LiteralPath $dualBackup -Destination $DualTarget
        }
        throw
    }
}

$inputFile = Get-Item -LiteralPath $InputPdf -ErrorAction Stop
if ($inputFile.PSIsContainer -or $inputFile.Extension -ne ".pdf") {
    throw "InputPdf must point to a PDF file: $InputPdf"
}
if (-not (Test-PdfFile -File $inputFile)) {
    throw "InputPdf does not have a valid PDF file header: $($inputFile.FullName)"
}

$outputDirectory = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$monoTarget = Join-Path $outputDirectory "中文译文.pdf"
$dualTarget = Join-Path $outputDirectory "双语对照.pdf"
if ($inputFile.FullName -in @($monoTarget, $dualTarget)) {
    throw "InputPdf cannot be one of the managed output files."
}

$glossaryFile = $null
if ($Glossary) {
    $glossaryFile = Get-Item -LiteralPath $Glossary -ErrorAction Stop
    if ($glossaryFile.PSIsContainer -or $glossaryFile.Extension -ne ".csv") {
        throw "Glossary must point to a CSV file: $Glossary"
    }
}

$executable = Get-Pdf2zhExecutable
if (-not $executable) {
    throw "pdf2zh_next is not installed. Run scripts/install-pdf2zh.ps1 first."
}
Test-Pdf2zhVersion -Executable $executable

$apiKey = Resolve-PersistentEnvironmentValue -Name "PDF2ZH_DEEPSEEK_API_KEY"
if (-not $apiKey) {
    throw "No DeepSeek API key was found in PDF2ZH_DEEPSEEK_API_KEY."
}

$temporaryDirectory = Join-Path $outputDirectory ".pdf2zh-$([guid]::NewGuid().ToString('N'))"
$temporaryDirectory = [IO.Path]::GetFullPath($temporaryDirectory)
$temporaryParent = [IO.Directory]::GetParent($temporaryDirectory).FullName
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    $temporaryParent.TrimEnd([IO.Path]::DirectorySeparatorChar),
    $outputDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar)
)) {
    throw "Refusing to create a temporary directory outside OutputDir."
}
[IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
$previousProcessApiKey = [Environment]::GetEnvironmentVariable(
    "PDF2ZH_DEEPSEEK_API_KEY",
    "Process"
)

try {
    $env:PDF2ZH_DEEPSEEK_API_KEY = $apiKey

    $arguments = @(
        $inputFile.FullName,
        "--output", $temporaryDirectory,
        "--deepseek",
        "--deepseek-model", "deepseek-v4-flash",
        "--deepseek-thinking-mode", "disabled",
        "--lang-in", "en",
        "--lang-out", "zh-CN",
        "--watermark-output-mode", "no_watermark",
        "--qps", "$Qps",
        "--pool-max-workers", "$Workers"
    )
    if ($Pages) {
        $arguments += @("--pages", $Pages)
    }
    if ($glossaryFile) {
        $arguments += @("--glossaries", $glossaryFile.FullName)
    }

    $logPath = Join-Path $temporaryDirectory "pdf2zh.log"
    & $executable @arguments *> $logPath
    $pdf2zhExitCode = $LASTEXITCODE
    if ($pdf2zhExitCode -ne 0) {
        $logTail = (Get-Content -LiteralPath $logPath -Tail 40 | Out-String).Trim()
        throw "pdf2zh_next failed with exit code $pdf2zhExitCode. Last log lines:`n$logTail"
    }

    $monoFiles = @(Get-ChildItem -LiteralPath $temporaryDirectory -File -Filter "*.mono.pdf" -Recurse)
    $dualFiles = @(Get-ChildItem -LiteralPath $temporaryDirectory -File -Filter "*.dual.pdf" -Recurse)
    if ($monoFiles.Count -ne 1 -or $dualFiles.Count -ne 1) {
        throw "Expected one monolingual and one bilingual PDF, found mono=$($monoFiles.Count), dual=$($dualFiles.Count)."
    }
    if (-not (Test-PdfFile -File $monoFiles[0])) {
        throw "The generated monolingual output is not a valid PDF."
    }
    if (-not (Test-PdfFile -File $dualFiles[0])) {
        throw "The generated bilingual output is not a valid PDF."
    }

    Commit-PdfOutputs `
        -MonoSource $monoFiles[0] `
        -DualSource $dualFiles[0] `
        -MonoTarget $monoTarget `
        -DualTarget $dualTarget `
        -BackupDirectory $temporaryDirectory

    $mono = Get-Item -LiteralPath $monoTarget
    $dual = Get-Item -LiteralPath $dualTarget
    $monoHash = (Get-FileHash -LiteralPath $monoTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    $dualHash = (Get-FileHash -LiteralPath $dualTarget -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Output "pdf2zh-next=$ExpectedVersion"
    Write-Output "mono=$($mono.FullName)`tbytes=$($mono.Length)`tsha256=$monoHash"
    Write-Output "dual=$($dual.FullName)`tbytes=$($dual.Length)`tsha256=$dualHash"
}
finally {
    [Environment]::SetEnvironmentVariable(
        "PDF2ZH_DEEPSEEK_API_KEY",
        $previousProcessApiKey,
        "Process"
    )
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
