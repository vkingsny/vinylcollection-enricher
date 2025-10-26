#!/usr/bin/env bash
set -euo pipefail
: "${CF_ACCOUNT_ID:?}"; : "${CF_API_TOKEN:?}"; : "${WORKER_NAME:?}"

mkdir -p versions/cloudflare
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions?page=1&per_page=100" \
  | tee versions_list.json >/dev/null

jq '[.result.items[] | {id, number, created_on: .metadata.created_on}] | sort_by(.number)' \
  versions_list.json > versions_manifest.json

mapfile -t IDS < <(jq -r '.result.items[].id' versions_list.json)
for id in "${IDS[@]}"; do
  out="versions/cloudflare/index.${id}.js"
  echo "Fetching ${id} -> ${out}"
  curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Accept: application/javascript" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/versions/${id}/content" -o "${out}" \
  || curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Accept: application/javascript" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/content?version_id=${id}" -o "${out}"
done

find versions/cloudflare -type f -name 'index.*.js' -print0 \
 | xargs -0 sed -i 's/vinylkingsny@gmail.com/records@vinylcollection.vip/g'

git add versions_list.json versions_manifest.json versions/cloudflare
git commit -m "fix: raw JS backfill + email swap"
git push
