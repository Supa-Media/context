import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in Node: the Workers runtime's own module is a stand-in (`src/cloudflareWorkers.testing.ts`).
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./src/cloudflareWorkers.testing.ts", import.meta.url)) } },
});
