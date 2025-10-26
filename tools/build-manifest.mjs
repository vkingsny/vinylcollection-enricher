// tools/build-manifest.mjs
import { readFileSync, writeFileSync } from "node:fs";
const src = JSON.parse(readFileSync("versions_list.json", "utf8"));
const items = src?.result?.items ?? [];
const manifest = items.map(v => ({ id: v.id, number: v.number, created_on: v.metadata?.created_on }))
                     .sort((a,b)=>a.number-b.number);
writeFileSync("versions_manifest.json", JSON.stringify(manifest, null, 2));
console.log(`Wrote versions_manifest.json (${manifest.length} items)`);
