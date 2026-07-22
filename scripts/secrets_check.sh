#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "secrets-check skipped: not a git repository"
  exit 0
fi

failed=0

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "ERROR: .env is tracked by git"
  failed=1
fi

if ! git check-ignore -q .env; then
  echo "ERROR: .env must be ignored by git"
  failed=1
fi

if git grep -n -E 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AWS_SECRET_ACCESS_KEY=[^[:space:]]+|POSTGRES_PASSWORD=[^[:space:]]+|SESSION_SECRET=[^[:space:]]+|BOOTSTRAP_ADMIN_PASSWORD=[^[:space:]]+' -- . ':!*.md' ':!scripts/secrets_check.sh' ':!.env.example'; then
  echo "ERROR: potential secret found in tracked files"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "secrets-check OK"
