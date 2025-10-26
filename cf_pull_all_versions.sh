#!/usr/bin/env bash
set -euo pipefail
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-1e6f1096e0ad4f59a95599e2d8033523}"
CF_API_TOKEN="${CF_API_TOKEN:RYqJLFpjGZHm6P-IA_WYJ1WE4s2i9XxDt9vXZ1Fe}"
WORKER_NAME="${WORKER_NAME:-vinylcollection-enricher}"
[[ -z "$CF_API_TOKEN" || "$CF_API_TOKEN" == "RYqJLFpjGZHm6P-IA_WYJ1WE4s2i9XxDt9vXZ1Fe" ]] && { echo "Set CF_API_TOKEN"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }
mkdir -p versions/cloudflare

# list all pages
pages=(); page=1
while :; do
  resp="$(curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions?page=${page}&per_page=50")"
  cnt="$(echo "$resp" | jq '.result.items | length')" || cnt=0
  [[ "$cnt" == "0" || "$cnt" == "null" ]] && break
  pages+=("$resp"); echo "Listed page ${page} (${cnt})"; page=$((page+1))
done
jq -s '{result:{items:(.[].result.items | add)}}' <<<"${pages[@]}" > versions_list.json
mapfile -t IDS < <(jq -r '.result.items[].id' versions_list.json)

# fetch raw JS per version
for id in "${IDS[@]}"; do
  out="versions/cloudflare/index.${id}.js"
  echo "Fetching ${id}"
  if ! curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Accept: application/javascript" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions/${id}/content" -o "${out}" \
      || grep -q '"result"' "${out}"; then
    curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Accept: application/javascript" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/content?version_id=${id}" -o "${out}"
  fi
done

# manifest
jq '[.result.items[] | {id, number, created_on: .metadata.created_on}] | sort_by(.number)' \
  versions_list.json > versions_manifest.json
echo "Done: versions/cloudflare/ and versions_manifest.json"
