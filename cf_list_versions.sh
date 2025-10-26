#!/usr/bin/env bash
set -euo pipefail

curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions" \
  | tee versions_list.json

echo "saved versions_list.json"
