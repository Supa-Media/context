// Emulators stand in on a pull request's preview and nowhere else: no staging
// or production deploy may build the gateway with them or point Convex at them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOWS = `${REPO}.github/workflows/`;
const ONLY_PREVIEW = new Set(["deploy-preview.yml"]);

test("only the preview deploy builds or configures anything with emulators", () => {
  const offenders = [];
  for (const name of readdirSync(WORKFLOWS)) {
    if (ONLY_PREVIEW.has(name)) continue;
    const text = readFileSync(WORKFLOWS + name, "utf8");
    if (/__CONTEXT_EMULATORS__|EMULATORS_ORIGIN|context-emulators/.test(text)) offenders.push(name);
  }
  for (const config of ["apps/mcp/wrangler.toml", "apps/agent/wrangler.jsonc", "infra/router/wrangler.jsonc"]) {
    let text = "";
    try {
      text = readFileSync(REPO + config, "utf8");
    } catch {
      continue;
    }
    if (/__CONTEXT_EMULATORS__|EMULATORS_ORIGIN/.test(text)) offenders.push(config);
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(WORKFLOWS + "deploy-preview.yml", "utf8"), /--name "context-emulators-pr\$PR"/, "the preview deploys its own emulators");
});
