$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-CodexaBootstrapStep {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "Codexa Windows bootstrap failed during ${Label} (exit ${LASTEXITCODE})."
  }
}

foreach ($commandName in @("git", "node", "npm")) {
  if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Codexa Windows bootstrap requires ${commandName} on PATH."
  }
}

$gitTop = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitTop)) {
  throw "Codexa Windows bootstrap must run inside a Git worktree."
}
$repoRoot = (Resolve-Path -LiteralPath $gitTop.Trim()).Path

Push-Location -LiteralPath $repoRoot
try {
  if (-not (Test-Path -LiteralPath "package.json" -PathType Leaf) -or
      -not (Test-Path -LiteralPath "package-lock.json" -PathType Leaf)) {
    throw "Codexa Windows bootstrap requires package.json and package-lock.json at ${repoRoot}."
  }

  Invoke-CodexaBootstrapStep "Node.js version check" {
    node -e "const major=Number(process.versions.node.split('.')[0]); if (!Number.isInteger(major) || major < 22) { console.error('Codexa requires Node.js 22 or newer; found ' + process.version + '.'); process.exit(2); }"
  }
  Invoke-CodexaBootstrapStep "npm ci" {
    npm ci --no-audit --no-fund
  }
  Invoke-CodexaBootstrapStep "build" {
    npm run build
  }
  Invoke-CodexaBootstrapStep "Codexa MCP-only init" {
    node dist/cli.js init $repoRoot --tools core --no-hooks
  }
  Invoke-CodexaBootstrapStep "Codexa strict startup check" {
    node dist/cli.js session-start $repoRoot --json --strict
  }

  Write-Output "Codexa Windows bootstrap: dependencies=ready; build=ready; wiring=core; hooks=disabled; strict=passed; bootstrap-receipt=not-issued."
  Write-Warning "Native Windows setup is MCP-only. The POSIX hook and identity-bound bootstrap-receipt lane requires Linux, macOS, or WSL."
}
finally {
  Pop-Location
}
