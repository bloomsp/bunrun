#!/usr/bin/env bash
set -euo pipefail

# Local D1 helper
# Usage:
#   ./scripts/d1.sh create
#   ./scripts/d1.sh migrate
#   ./scripts/d1.sh migrate-preview

cmd=${1:-}

case "$cmd" in
  create)
    npx wrangler d1 create bunrun
    ;;
  migrate)
    npx wrangler d1 migrations apply bunrun --local
    ;;
  migrate-preview)
    node scripts/prepare-worker-preview.mjs
    npx wrangler d1 migrations apply bunrun --config dist/server/wrangler.json
    ;;
  *)
    echo "Usage: $0 {create|migrate|migrate-preview}" >&2
    exit 1
    ;;
esac
