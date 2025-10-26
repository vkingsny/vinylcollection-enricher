#!/usr/bin/env bash
# cf_deploy_and_pull.sh
# Deploy every Worker version -> fetch raw JS -> save sequentially -> restore latest

set -euo pipefail

# --- Environment ---
: "${CF_ACCOUNT_ID:?}"; : "${CF_API_TOKEN:?}"; : "${WORKER_NAME:?}"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}"
AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}")
mkdir -p versions/raw

echo "Fetching version list..."
VERS_JSON="$(curl -fsS "${AUTH[@]}" "${API}/versions?page=1&per_page=100")"

mapfile -t IDS  < <(jq -r '.result.items | sort_by(.number)[] | .id'      <<<"$VERS_JSON")
mapfile -t NUMS < <(jq -r '.result.items | sort_by(.number)[] | .number'  <<<"$VERS_JSON")
LATEST_ID="$(jq -r '.result.items | max_by(.number).id'                   <<<"$VERS_JSON")"

echo "Found ${#IDS[@]} versions. Latest ID: ${LATEST_ID}"

# --- Iterate versions ---
for i in "${!IDS[@]}"; do
  id="${IDS[$i]}"
  num="${NUMS[$i]}"
  out="versions/raw/index.v${num}.${id}.js"

  echo "Deploying v${num} (${id})..."
  curl -fsS -X POST "${AUTH[@]}" "${API}/versions/${id}/deployments" >/dev/null

  sleep 2

  echo "Fetching raw JS -> ${out}"
  if ! curl -fsS "${AUTH[@]}" -H "Accept: application/javascript" "${API}/content" -o "${out}"; then
    echo "Fetch failed for ${id}" >&2
  fi
done

# --- Restore latest ---
echo "Restoring latest version ${LATEST_ID}..."
curl -fsS -X POST "${AUTH[@]}" "${API}/versions/${LATEST_ID}/deployments" >/dev/null
echo "Done. Saved JS files in versions/raw/"
