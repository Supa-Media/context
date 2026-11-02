import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { withoutFontCdnFallback } from "./excalidraw-font-fallback.mjs";

/** Where `build-drawing-editor.mjs` reads the package from. */
const PROD = join(import.meta.dirname, "..", "apps", "mobile", "node_modules", "@excalidraw", "excalidraw", "dist", "prod");

/** The installed Excalidraw's production chunk that builds the font URLs. */
function installedChunk() {
  const prod = PROD;
  const files = readdirSync(prod).filter((name) => name.endsWith(".js"));
  const hits = files.filter((name) => readFileSync(join(prod, name), "utf8").includes("ASSETS_FALLBACK_URL"));
  assert.equal(hits.length, 1, `one chunk defines the fallback, found ${hits.join(", ")}`);
  return readFileSync(join(prod, hits[0]), "utf8");
}

test("the installed Excalidraw loses the esm.sh push, and keeps our own asset path", () => {
  const source = installedChunk();
  const out = withoutFontCdnFallback(source);
  assert.ok(!/\.push\(new URL\([\w$]+,[\w$]+\.ASSETS_FALLBACK_URL\)\)/.test(out), "no fallback URL is pushed");
  assert.ok(out.includes("window.EXCALIDRAW_ASSET_PATH"), "our asset path is still read");
  assert.equal(source.length - out.length, source.match(/\b[\w$]+\.push\(new URL\([\w$]+,[\w$]+\.ASSETS_FALLBACK_URL\)\),/)[0].length);
});

test("the font URL list is ours alone, and a missing face asks nobody", () => {
  const sample =
    'static createUrls(t){let n=t.replace(/^\\/+/,""),r=[];if(typeof window.EXCALIDRAW_ASSET_PATH=="string"){r.push(new URL(n,window.EXCALIDRAW_ASSET_PATH))}return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r}';
  const createUrls = new Function("jn", "window", `return class { ${withoutFontCdnFallback(sample)} }`)(
    { ASSETS_FALLBACK_URL: "https://esm.sh/@excalidraw/excalidraw/dist/prod/" },
    { EXCALIDRAW_ASSET_PATH: "https://context.lc/drawing-assets/editor/" },
  ).createUrls;
  assert.deepEqual(createUrls("fonts/Xiaolai/a.woff2").map(String), ["https://context.lc/drawing-assets/editor/fonts/Xiaolai/a.woff2"]);
});

test("an upgrade that changes the code fails the build rather than shipping the fallback", () => {
  assert.throws(() => withoutFontCdnFallback("urls.push(new URL(assetUrl, ExcalidrawFontFace.ASSETS_FALLBACK_URL));"), /exactly once, found it 0/);
  const twice = "a.push(new URL(b,c.ASSETS_FALLBACK_URL)),a.push(new URL(b,c.ASSETS_FALLBACK_URL)),";
  assert.throws(() => withoutFontCdnFallback(twice), /found it 2/);
});
