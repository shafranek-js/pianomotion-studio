<#
.SYNOPSIS
    Packages PianoMotion Studio into a clean, standalone zip archive,
    strictly excluding node_modules, cache, and extraneous files.
#>

param(
    [string]$OutputPath = "..\..\pianomotion-studio.zip"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = (Resolve-Path "$scriptDir\..").Path
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $scriptDir $OutputPath))

Write-Host "Packaging web project from: $webRoot"
Write-Host "Target archive: $resolvedOutput"

# Ensure output archive is removed before creating new one
if (Test-Path $resolvedOutput) {
    Remove-Item $resolvedOutput -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($resolvedOutput, [System.IO.Compression.ZipArchiveMode]::Create)

$files = Get-ChildItem -Path $webRoot -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($webRoot.Length)
    -not (
        $rel -match '\\node_modules(\\|$)' -or
        $rel -match '\\test-results(\\|$)' -or
        $rel -match '\\playwright-report(\\|$)' -or
        $rel -match '\\__pycache__(\\|$)' -or
        $rel -match '\\\.pytest_cache(\\|$)' -or
        $rel -match '\.pyc$' -or
        $rel -match '\.vite-temp(\\|$)' -or
        $rel -match '\.zip$'
    )
}

$count = 0
foreach ($file in $files) {
    $entryName = $file.FullName.Substring($webRoot.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
    $count++
}

$zip.Dispose()

$zipItem = Get-Item $resolvedOutput
$sizeMB = [math]::Round($zipItem.Length / 1MB, 2)

Write-Host "Successfully packaged $count files into $resolvedOutput ($sizeMB MB)."
