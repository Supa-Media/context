import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Teach Vite the one thing wrangler.jsonc's `rules` entry teaches the Worker
 * build: a `.png` import is the file's BYTES, as an ArrayBuffer.
 *
 * Without this, Vite's own asset handling would resolve `import ogCard from
 * "./og-card.png"` to a URL string, and worker.test.ts would happily assert
 * that a Response containing the literal text "/src/og-card.png" is the
 * OpenGraph card. Matching the production semantics here is what makes that
 * test worth having.
 */
function pngAsArrayBuffer(): Plugin {
  return {
    name: "png-as-arraybuffer",
    // Ahead of Vite's built-in asset plugin, which would otherwise win.
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0]!;
      if (!file.endsWith(".png")) return null;
      const base64 = readFileSync(file).toString("base64");
      return [
        `const binary = atob(${JSON.stringify(base64)});`,
        "const bytes = new Uint8Array(binary.length);",
        "for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);",
        "export default bytes.buffer;",
      ].join("\n");
    },
  };
}

export default defineConfig({
  plugins: [pngAsArrayBuffer()],
});
