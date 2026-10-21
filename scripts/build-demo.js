// Builds the database-free demo: a copy of public/ whose API runs in the browser (js/demo.js)
// with the sample family from demo/data.json. Output: dist-demo/ (deployed by wrangler.demo.toml).
import { cpSync, copyFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist-demo", { recursive: true, force: true });
cpSync("public", "dist-demo", { recursive: true });
writeFileSync("dist-demo/js/config.js", "// demo build\nexport const DEMO = true;\n");
copyFileSync("demo/data.json", "dist-demo/demo-data.json");
console.log("demo built in dist-demo/");
