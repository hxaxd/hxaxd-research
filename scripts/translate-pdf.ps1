[CmdletBinding(DefaultParameterSetName='Single')]
param(
    [Parameter(ParameterSetName='Single', Mandatory)]
    [string]$InputPdf,

    [Parameter(ParameterSetName='Single', Mandatory)]
    [string]$OutputDir,

    [Parameter(ParameterSetName='Batch', Mandatory)]
    [string[]]$InputPdfList,

    [Parameter(ParameterSetName='Single')]
    [string]$Pages,

    [Parameter(ParameterSetName='Single')]
    [string]$Glossary,

    [ValidateRange(1, 1000)]
    [int]$Qps = 4,

    [ValidateRange(1, 1000)]
    [int]$Workers = 4,

    [Parameter(ParameterSetName='Batch')]
    [ValidateRange(1, 30)]
    [int]$Parallel = 4
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

# ------------------------------------------------------------------------
# Pre-flight: tool must exist and API key must be resolvable
# ------------------------------------------------------------------------
$executable = Get-Pdf2zhExecutable
if (-not $executable) {
    throw "pdf2zh_next is not installed. Run scripts/install-pdf2zh.ps1 first."
}
Test-Pdf2zhVersion -Executable $executable

$apiKey = Resolve-PersistentEnvironmentValue -Name "PDF2ZH_DEEPSEEK_API_KEY"
if (-not $apiKey) {
    throw "No DeepSeek API key was found in PDF2ZH_DEEPSEEK_API_KEY."
}

# ------------------------------------------------------------------------
# Translate one paper (local function, NOT used inside child processes)
# ------------------------------------------------------------------------
function Translate-One {
    param(
        [Parameter(Mandatory)][string]$InputPath,
        [Parameter(Mandatory)][string]$OutDir,
        [string]$PageRange,
        [string]$GlossaryPath,
        [int]$Rate = 4,
        [int]$Pool = 4
    )

    $ErrorActionPreference = "Stop"

    $inputFile = Get-Item -LiteralPath $InputPath -ErrorAction Stop
    if ($inputFile.PSIsContainer -or $inputFile.Extension -ne ".pdf") {
        throw "InputPdf must point to a PDF file: $InputPath"
    }
    if (-not (Test-PdfFile -File $inputFile)) {
        throw "InputPdf does not have a valid PDF file header: $($inputFile.FullName)"
    }

    $outputDirectory = [IO.Path]::GetFullPath($OutDir)
    [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

    $monoTarget = Join-Path $outputDirectory "中文译文.pdf"
    $dualTarget = Join-Path $outputDirectory "双语对照.pdf"
    if ($inputFile.FullName -in @($monoTarget, $dualTarget)) {
        throw "InputPdf cannot be one of the managed output files."
    }

    $glossaryFile = $null
    if ($GlossaryPath) {
        $glossaryFile = Get-Item -LiteralPath $GlossaryPath -ErrorAction Stop
        if ($glossaryFile.PSIsContainer -or $glossaryFile.Extension -ne ".csv") {
            throw "Glossary must point to a CSV file: $GlossaryPath"
        }
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
            "--qps", "$Rate",
            "--pool-max-workers", "$Pool"
        )
        if ($PageRange) {
            $arguments += @("--pages", $PageRange)
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
        Write-Output "mono=$($mono.FullName)`tbytes=$($mono.Length)"
        Write-Output "dual=$($dual.FullName)`tbytes=$($dual.Length)"
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
}

# ------------------------------------------------------------------------
# Single-paper mode
# ------------------------------------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'Single') {
    Translate-One `
        -InputPath $InputPdf `
        -OutDir $OutputDir `
        -PageRange $Pages `
        -GlossaryPath $Glossary `
        -Rate $Qps `
        -Pool $Workers
    exit 0
}

# ------------------------------------------------------------------------
# Batch mode
# ------------------------------------------------------------------------
$tasks = foreach ($pdf in $InputPdfList) {
    $inputItem = Get-Item -LiteralPath $pdf -ErrorAction Stop
    if ($inputItem.PSIsContainer -or $inputItem.Extension -ne ".pdf") {
        throw "Each path in InputPdfList must point to a PDF file: $pdf"
    }
    $outDir = $inputItem.Directory.FullName
    [PSCustomObject]@{ InputPath = $inputItem.FullName; OutputDir = $outDir; Name = $inputItem.Directory.Name }
}

if ($tasks.Count -eq 0) {
    throw "InputPdfList must contain at least one path."
}

Write-Output "# Batch translation"
Write-Output "  Papers: $($tasks.Count)"
Write-Output "  Parallel: $Parallel"
Write-Output "  QPS per paper: $Qps"
Write-Output "  Workers per paper: $Workers"
foreach ($t in $tasks) { Write-Output "  -> $($t.Name)" }
Write-Output ""

$scriptPath = $PSCommandPath
$started = [DateTime]::UtcNow
$total   = $tasks.Count

$results = $tasks | ForEach-Object -Parallel {
    $task   = $_
    $script = $using:scriptPath
    $qps    = $using:Qps
    $workers = $using:Workers

    $inner = "& `"$script`" -InputPdf `"$($task.InputPath)`" -OutputDir `"$($task.OutputDir)`" -Qps $qps -Workers $workers; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

    $proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru
    $proc.WaitForExit()

    if ($proc.ExitCode -eq 0) {
        $mono = Get-Item -LiteralPath (Join-Path $task.OutputDir '中文译文.pdf') -ErrorAction SilentlyContinue
        $dual = Get-Item -LiteralPath (Join-Path $task.OutputDir '双语对照.pdf') -ErrorAction SilentlyContinue
        $monoSize = if ($mono) { "$([Math]::Round($mono.Length/1MB,2)) MB" } else { '?' }
        $dualSize = if ($dual) { "$([Math]::Round($dual.Length/1MB,2)) MB" } else { '?' }
        Write-Output "OK  | $($task.Name) | mono=$monoSize dual=$dualSize"
        [PSCustomObject]@{ Name = $task.Name; Ok = $true }
    }
    else {
        Write-Output "FAIL | $($task.Name) (exit $($proc.ExitCode))"
        [PSCustomObject]@{ Name = $task.Name; Ok = $false }
    }
} -ThrottleLimit $Parallel

$resultObjects = @($results | Where-Object { $_ -is [pscustomobject] -and $_.PSObject.Properties.Name -contains 'Ok' })
$failed  = @($resultObjects | Where-Object { -not $_.Ok })
$success = @($resultObjects | Where-Object { $_.Ok })

$elapsed = [DateTime]::UtcNow - $started
Write-Output ""
Write-Output "## Result"
Write-Output "  Success: $($success.Count) / $total"
Write-Output "  Failed:  $($failed.Count) / $total"
Write-Output "  Elapsed: $($elapsed.ToString('hh\:mm\:ss'))"
if ($failed.Count -gt 0) {
    Write-Output "  Failed papers: $($failed -join ', ')"
}

if ($failed.Count -gt 0) {
    exit 1
}
exit 0
