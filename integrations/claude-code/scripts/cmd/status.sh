#!/usr/bin/env bash
set -u
CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$CMD_DIR/lib.sh"

repo="$(cmd_require_codexa_repo)" || exit 1
cmd_require_codexa_cli
exec "$NODE_BIN" "$CODEXA_CLI" status "$repo"
