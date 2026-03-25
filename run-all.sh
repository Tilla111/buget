#!/usr/bin/env bash
set -euo pipefail

if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell 7 (pwsh) is required to run run-all.ps1 on Linux/macOS." >&2
  exit 1
fi

exec pwsh ./run-all.ps1 "$@"
