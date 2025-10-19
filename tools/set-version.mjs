// Purpose: point root index.js at a specific version file
import { writeFileSync } from "node:fs";
const ver = process.argv[2]; if(!ver){ console.error("usage: node tools/set-version.mjs 4.2.2"); process.exit(1); }
writeFileSync("index.js", `import worker from "./versions/index.v${ver}.js";\nexport default worker;\n`);
