#!/usr/bin/env bash
set -euo pipefail

repo=/workspace/project
artifacts=/logs/artifacts
codexa=/opt/codexa-runtime/bin/codexa
mkdir -p "$artifacts"

started_ns="$(date +%s%N)"
version="$($codexa --version)"
if "$codexa" index "$repo" >"$artifacts/codexa-index.log" 2>&1; then
  index_exit=0
else
  index_exit=$?
fi
finished_ns="$(date +%s%N)"
elapsed_ms="$(( (finished_ns - started_ns) / 1000000 ))"

python3 - "$artifacts/codexa-setup.json" "$version" "$elapsed_ms" "$index_exit" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = {
    "schemaVersion": 1,
    "codexaVersion": sys.argv[2],
    "indexElapsedMs": int(sys.argv[3]),
    "indexExitCode": int(sys.argv[4]),
}
path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
PY

if [[ "$index_exit" -ne 0 ]]; then
  printf 'Codexa index failed; inspect %s\n' "$artifacts/codexa-index.log" >&2
  exit "$index_exit"
fi

export CODEXA_MCP_OUTPUT_SCHEMA=full
export CODEXA_MCP_TELEMETRY_PATH=/logs/artifacts/codexa-mcp-telemetry.jsonl
exec "$codexa" serve "$repo" --tools full
