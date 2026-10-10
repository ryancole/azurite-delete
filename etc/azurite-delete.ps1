<#
.SYNOPSIS
Deletes blobs from a local Azurite data folder by editing its metadata directly.

.DESCRIPTION
Dry run by default: prints what would be deleted. Pass -Apply (with Azurite stopped)
to delete. See README.md.

.EXAMPLE
.\etc\azurite-delete.ps1 -Location C:\src\WhatInBox\.azurite -Target images/2024/, thumbnails

.EXAMPLE
.\etc\azurite-delete.ps1 -Location C:\src\WhatInBox\.azurite -Target images/2024/ -Apply
#>
[CmdletBinding()]
param(
    # Azurite data folder (the one holding __azurite_db_blob__.json).
    [Parameter(Mandatory)] [string] $Location,
    # One or more "container" or "container/prefix" values.
    [Parameter(Mandatory)] [string[]] $Target,
    [switch] $Apply,
    [string] $Account,
    [int] $BlobPort = 10000,
    [int] $Samples = 5,
    [switch] $NoBackup
)

$ErrorActionPreference = 'Stop'

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Visual Studio ships its own Node.js; Azurite inside VS doesn't need one on PATH.
    $vsRoots = @("$env:ProgramFiles\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio")
    foreach ($root in $vsRoots) {
        if (-not (Test-Path $root)) { continue }
        $found = Get-ChildItem $root -Directory | Sort-Object Name -Descending | ForEach-Object {
            Get-ChildItem $_.FullName -Directory | ForEach-Object {
                Join-Path $_.FullName 'MSBuild\Microsoft\VisualStudio\NodeJs\node.exe'
            }
        } | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($found) { return $found }
    }
    throw 'Node.js not found. Install it or add node.exe to PATH.'
}

$node = Find-Node
$here = Split-Path $PSScriptRoot -Parent  # repo root; this script lives in etc\

if (-not (Test-Path (Join-Path $here 'node_modules\lokijs'))) {
    Write-Host 'Installing dependencies (lokijs)...'
    $npm = Join-Path (Split-Path $node) 'npm.cmd'
    if (-not (Test-Path $npm)) { $npm = 'npm' }
    Push-Location $here
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

$nodeArgs = @('--max-old-space-size=4096', (Join-Path $here 'src\azurite-delete.js'), '--location', $Location)
foreach ($t in $Target) { $nodeArgs += @('--target', $t) }
if ($Apply) { $nodeArgs += '--apply' }
if ($Account) { $nodeArgs += @('--account', $Account) }
if ($NoBackup) { $nodeArgs += '--no-backup' }
$nodeArgs += @('--blob-port', $BlobPort, '--samples', $Samples)

& $node @nodeArgs
exit $LASTEXITCODE
