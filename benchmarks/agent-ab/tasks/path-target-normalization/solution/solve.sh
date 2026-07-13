#!/usr/bin/env bash
set -euo pipefail

git -C /workspace/project apply /solution/solution.patch
