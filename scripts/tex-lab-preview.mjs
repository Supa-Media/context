/**
 * Builds the Tex Architecture Lab (tex.lc/admin/lab) as one static page with Convex stood in, so its look can be
 * screenshot beside the artifact it was ported from (Dev2, 2026-11-13: "EXACTLY like the artifact"):
 *
 *   node scripts/tex-lab-preview.mjs [out.html]     (default: /tmp/tex-lab-preview.html)
 *
 * Staff, an empty shared list, saves that go nowhere (`tex-lab-preview/convexMock.js`). Nothing is sent anywhere.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = process.argv[2] ?? "/tmp/tex-lab-preview.html";
const result = await build({
  entryPoints: [here("./tex-lab-preview/entry.jsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  resolveExtensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".jsx", ".js", ".json"],
  alias: { "convex/react": here("./tex-lab-preview/convexMock.js") },
  nodePaths: [here("../apps/mobile/node_modules"), here("../node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const js = result.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tex Architecture Lab preview</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"></head><body style="margin:0"><div id="root"></div><script>${js}</script></body></html>`);
console.log(`wrote ${out}`);
