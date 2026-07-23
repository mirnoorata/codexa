$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Codexa Windows bootstrap requires Node.js on PATH."
}

$gitTop = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitTop)) {
  throw "Codexa Windows bootstrap must run inside a Git worktree."
}
$repoRoot = (Resolve-Path -LiteralPath $gitTop.Trim()).Path

& node (Join-Path $repoRoot "scripts/worktree-bootstrap.mjs") native-windows-mcp $repoRoot
if ($LASTEXITCODE -ne 0) {
  throw "Codexa Windows bootstrap failed (exit ${LASTEXITCODE})."
}
