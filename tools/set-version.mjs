// tools/set-version.mjs
// Purpose: point root index.js at a specific version file
import { writeFileSync, existsSync } from "node:fs";
const ver = process.argv[2];
if (!ver) { console.error("usage: node tools/set-version.mjs 4.2.2"); process.exit(1); }
const path = `versions/index.v${ver}.js`;
if (!existsSync(path)) { console.error(`missing ${path}`); process.exit(1); }
writeFileSync("index.js", `import worker from "./${path}";\nexport default worker;\n`);
console.log(`index.js -> ${path}`);
