#!/usr/bin/env bash
set -euo pipefail

git -C /workspace/project apply --unidiff-zero /solution/solution.patch
