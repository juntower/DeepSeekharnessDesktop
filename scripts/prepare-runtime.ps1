[CmdletBinding()]
param(
  [string]$NodeBinary = '',
  [string]$NpmCli = ''
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'build\runtime'))
$workspacePrefix = [IO.Path]::GetFullPath($workspaceRoot + [IO.Path]::DirectorySeparatorChar)
if (-not $destinationRoot.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write runtime outside the workspace: $destinationRoot"
}

if ($NodeBinary -eq '') {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $NodeBinary = $nodeCommand.Source
}
$NodeBinary = [IO.Path]::GetFullPath($NodeBinary)
if (-not (Test-Path -LiteralPath $NodeBinary -PathType Leaf)) {
  throw "Node executable not found: $NodeBinary"
}

$versionText = ((& $NodeBinary --version) | Select-Object -First 1).Trim()
if ($versionText -notmatch '^v(\d+)\.(\d+)\.') {
  throw "Unable to parse Node version: $versionText"
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
if (-not (($major -eq 22 -and $minor -ge 19) -or $major -ge 24)) {
  throw "Node $versionText is unsupported; expected ^22.19.0 or >=24.0.0"
}

if ($NpmCli -eq '') {
  $nodeDirectory = Split-Path -Parent $NodeBinary
  $candidate = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $NpmCli = $candidate
  } else {
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    $npmDirectory = Split-Path -Parent $npmCommand.Source
    $NpmCli = Join-Path $npmDirectory 'node_modules\npm\bin\npm-cli.js'
  }
}
$NpmCli = [IO.Path]::GetFullPath($NpmCli)
if (-not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) {
  throw "npm CLI not found: $NpmCli"
}
$npmRoot = Split-Path -Parent (Split-Path -Parent $NpmCli)
if (-not (Test-Path -LiteralPath (Join-Path $npmRoot 'package.json') -PathType Leaf)) {
  throw "npm package root is invalid: $npmRoot"
}

if (Test-Path -LiteralPath $destinationRoot) {
  Remove-Item -LiteralPath $destinationRoot -Recurse -Force
}
$nodeDestination = Join-Path $destinationRoot 'node'
$npmDestination = Join-Path $destinationRoot 'npm'
New-Item -ItemType Directory -Force -Path $nodeDestination | Out-Null

Copy-Item -LiteralPath $NodeBinary -Destination (Join-Path $nodeDestination 'node.exe') -Force
# Copy the npm package *contents* into runtime/npm so runtime/npm/bin/npm-cli.js resolves.
# Copying the directory itself into an existing destination would nest it as runtime/npm/npm.
New-Item -ItemType Directory -Force -Path $npmDestination | Out-Null
Copy-Item -Path (Join-Path $npmRoot '*') -Destination $npmDestination -Recurse -Force
if (-not (Test-Path -LiteralPath (Join-Path $npmDestination 'bin\npm-cli.js') -PathType Leaf)) {
  throw "npm CLI was not staged correctly at $npmDestination\bin\npm-cli.js"
}

$manifest = [ordered]@{
  preparedAt = [DateTime]::UtcNow.ToString('o')
  nodeVersion = $versionText
  nodeBinary = 'node/node.exe'
  npmCli = 'npm/bin/npm-cli.js'
}
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $destinationRoot 'runtime.json')
Write-Host "Prepared bundled Node $versionText and npm at $destinationRoot"
