#!/usr/bin/env bash
set -euo pipefail

# Local D1 helper
# Usage:
#   ./scripts/d1.sh create
#   ./scripts/d1.sh migrate

cmd=${1:-}

case "$cmd" in
  create)
    npx wrangler d1 create bunrun
    ;;
  migrate)
    npx wrangler d1 migrations apply bunrun --local
    ;;
  *)
    echo "Usage: $0 {create|migrate}" >&2
    exit 1
    ;;
esac
