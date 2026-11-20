import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Worker's code and tests live in packages/tex/worker; this app is its deploy unit.
const WORKER = fileURLToPath(new URL("../../packages/tex/worker", import.meta.url));

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": `${WORKER}/cloudflareWorkers.testing.ts` } },
  test: { dir: WORKER },
});
