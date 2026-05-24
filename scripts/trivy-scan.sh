#!/usr/bin/env sh
set -eu

if ! command -v trivy >/dev/null 2>&1; then
  echo "Trivy is not installed. Run ./scripts/install-trivy.sh first." >&2
  exit 127
fi

trivy fs \
  --scanners vuln,secret,misconfig \
  --severity HIGH,CRITICAL \
  --exit-code 1 \
  --ignore-unfixed \
  --skip-version-check \
  --skip-dirs .git \
  --skip-dirs .tools \
  --skip-dirs node_modules \
  --skip-dirs .vscode-test \
  --skip-dirs .devcontainer \
  --skip-dirs coverage \
  --skip-dirs out \
  --skip-dirs dist \
  --skip-files '*.vsix' \
  "$@"
