$Output = "project-export.txt"

$ExcludeDirs = @(
    "node_modules",
    ".next",
    ".git",
    ".vercel",
    "dist",
    "build",
    "coverage",
    ".turbo"
)

$AllowedExtensions = @(
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".scss",
    ".sass",
    ".html",
    ".md",
    ".mdx",
    ".sql",
    ".prisma",
    ".yml",
    ".yaml",
    ".xml",
    ".txt"
)

$Root = (Get-Location).Path

# Resolve the output file to its full path so it can be excluded reliably
$OutputFullPath = Join-Path $Root $Output

# Remove previous export before scanning
Remove-Item $OutputFullPath -ErrorAction SilentlyContinue

"============================================================" | Out-File $OutputFullPath -Encoding utf8
"NEXT.JS PROJECT EXPORT" | Out-File $OutputFullPath -Append -Encoding utf8
"Generated: $(Get-Date)" | Out-File $OutputFullPath -Append -Encoding utf8
"============================================================" | Out-File $OutputFullPath -Append -Encoding utf8

$Files = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $file = $_

        # ----------------------------------------------------
        # Exclude the export file itself
        # ----------------------------------------------------
        if ($file.FullName -eq $OutputFullPath) {
            return $false
        }

        # ----------------------------------------------------
        # Exclude directories
        # ----------------------------------------------------
        $excluded = $false

        foreach ($dir in $ExcludeDirs) {
            if ($file.FullName -match "[\\/]" + [regex]::Escape($dir) + "[\\/]") {
                $excluded = $true
                break
            }
        }

        # ----------------------------------------------------
        # Exclude environment/secrets
        # ----------------------------------------------------
        if ($file.Name -match '^\.env') {
            $excluded = $true
        }

        # ----------------------------------------------------
        # Only include useful source/config files
        # ----------------------------------------------------
        $extensionAllowed = $AllowedExtensions -contains $file.Extension.ToLower()

        -not $excluded -and $extensionAllowed
    } |
    Sort-Object FullName

Write-Host "Found $($Files.Count) files..." -ForegroundColor Cyan

foreach ($File in $Files) {

    $Relative = $File.FullName.Substring($Root.Length + 1)

    Write-Host "Adding: $Relative" -ForegroundColor DarkGray

    "`n`n============================================================" |
        Out-File $OutputFullPath -Append -Encoding utf8

    "FILE: $Relative" |
        Out-File $OutputFullPath -Append -Encoding utf8

    "============================================================" |
        Out-File $OutputFullPath -Append -Encoding utf8

    try {
        Get-Content $File.FullName -Raw |
            Out-File $OutputFullPath -Append -Encoding utf8
    }
    catch {
        "[Unable to read file]" |
            Out-File $OutputFullPath -Append -Encoding utf8
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "EXPORT COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Files exported: $($Files.Count)" -ForegroundColor Yellow
Write-Host "Output: $OutputFullPath" -ForegroundColor Cyan