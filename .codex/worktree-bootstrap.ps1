$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Codexa Windows bootstrap requires Node.js on PATH."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

& node (Join-Path $repoRoot "scripts/worktree-bootstrap.mjs") native-windows-mcp $repoRoot
if ($LASTEXITCODE -ne 0) {
  throw "Codexa Windows bootstrap failed (exit ${LASTEXITCODE})."
}
