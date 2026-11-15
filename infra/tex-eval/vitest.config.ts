import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `cloudflare:workers` is the runtime's; under Node the tests stand in a small shim (test/workersShim.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/workersShim.ts", import.meta.url)) } },
});
