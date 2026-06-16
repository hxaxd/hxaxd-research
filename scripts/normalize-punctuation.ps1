[CmdletBinding()]
param(
    [string]$Path = ".",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$mdFiles = Get-ChildItem -Path $Path -Filter "*.md" -Recurse |
    Where-Object { $_.FullName -notmatch "\\\.git\\|\\node_modules\\|\\labs\\" }

$totalChanges = 0

foreach ($file in $mdFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Raw
    if (-not $content) { continue }

    $inCodeBlock = $false
    $lines = $content -split '\r?\n'
    $newLines = @()
    $fileChanged = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        # Track code block boundaries
        if ($line -match '^\s*```') {
            $inCodeBlock = -not $inCodeBlock
            $newLines += $line
            continue
        }

        if ($inCodeBlock) {
            $newLines += $line
            continue
        }

        $original = $line

        # Split line into segments: even indices = outside backticks, odd = inside backticks
        $segments = $line -split '(`[^`]*`)'
        for ($s = 0; $s -lt $segments.Count; $s++) {
            if ($s % 2 -eq 1) { continue }  # skip inline code segments

            $seg = $segments[$s]

            # Chinese comma → English comma + space
            $seg = $seg -replace '，', ', '

            # Chinese semicolon → English semicolon + space
            $seg = $seg -replace '；', '; '

            # Chinese 顿号 → English comma + space
            $seg = $seg -replace '、', ', '

            # Chinese colon → English colon + space
            $seg = $seg -replace '：', ': '

            # Chinese parentheses → English with space before
            $seg = $seg -replace '（', ' ('
            $seg = $seg -replace '）', ') '

            # Chinese double quotation marks → English double quotes
            $leftQuote = [char]0x201C
            $rightQuote = [char]0x201D
            $seg = $seg -replace $leftQuote, ' "'
            $seg = $seg -replace $rightQuote, '" '

            # Chinese period → remove
            $seg = $seg -replace '。', ''

            # Chinese question/exclamation → English
            $seg = $seg -replace '？', '?'
            $seg = $seg -replace '！', '! '

            # Clean up: space before comma, multiple spaces
            $seg = $seg -replace ' ,', ','
            $seg = $seg -replace ' {2,}', ' '

            $segments[$s] = $seg
        }

        $line = $segments -join ''

        if ($line -ne $original) {
            $fileChanged = $true
            $totalChanges++
        }

        $newLines += $line
    }

    if ($fileChanged) {
        if ($WhatIf) {
            Write-Output "Would change: $($file.FullName)"
        } else {
            $newContent = $newLines -join "`n"
            Set-Content -LiteralPath $file.FullName -Value $newContent -Encoding UTF8 -NoNewline
            Write-Output "Fixed: $($file.FullName)"
        }
    }
}

Write-Output "Total lines changed: $totalChanges across $($mdFiles.Count) files"
