#!/usr/bin/env node
/**
 * BRING THE COMMITTED CONFIG TO THE CURRENT SCHEMA (Dev2, 2026-11-17: "make sure that when we make updates or changes
 * to the schema everything is updated").
 *
 * A schema change is one pull request: bump `SCHEMA_VERSION` in `packages/shared/src/texConfigSchema.cjs`, add the
 * migration that takes the old shape to the new one, run this, and commit the config it writes. The same migrations
 * upgrade Lab drafts when they are opened and promoted; CI (`tex-config-readers.mjs`) fails while the committed config
 * is behind its schema.
 *
 *   node scripts/tex-config-migrate.mjs           write the migrated config
 *   node scripts/tex-config-migrate.mjs --check   exit 1 when it would change
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_PATH, texConfigText } from "./lib/texConfigFile.mjs";
import { configText } from "./tex-lab-promote.mjs";

const { SCHEMA_VERSION, configProblems, migrateGraph } = createRequire(import.meta.url)("../packages/shared/src/texConfigSchema.cjs");
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const before = texConfigText(ROOT);
const migrated = { ...migrateGraph(JSON.parse(before)), texConfig: SCHEMA_VERSION };
const problems = configProblems(migrated);
if (problems.length > 0) {
  console.error(`tex-config-migrate: the migrated config still does not match its schema: ${problems.join("; ")}`);
  process.exit(1);
}
const after = configText(migrated);
if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(`tex-config-migrate: ${CONFIG_PATH} is not at schema version ${SCHEMA_VERSION}: run node scripts/tex-config-migrate.mjs`);
    process.exit(1);
  }
  console.log(`tex-config-migrate: ${CONFIG_PATH} is at schema version ${SCHEMA_VERSION}`);
} else {
  writeFileSync(join(ROOT, CONFIG_PATH), after);
  console.log(`tex-config-migrate: ${after === before ? "already" : "now"} at schema version ${SCHEMA_VERSION}${after === before ? "" : ": run node scripts/tex-architecture.mjs next"}`);
}
