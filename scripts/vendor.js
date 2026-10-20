// Copies the dagre layout library into public/vendor so the frontend has no CDN dependency.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public/vendor", { recursive: true });
copyFileSync("node_modules/@dagrejs/dagre/dist/dagre.esm.js", "public/vendor/dagre.esm.js");
copyFileSync("node_modules/@dagrejs/dagre/dist/dagre.esm.js.LEGAL.txt", "public/vendor/dagre.LEGAL.txt");
console.log("vendored dagre");
