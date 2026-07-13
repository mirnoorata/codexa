#!/usr/bin/env bash
set -euo pipefail

umask 077
install -d -m 0700 /logs/verifier
chmod 0700 /logs /logs/verifier
python3 /tests/verify.py
