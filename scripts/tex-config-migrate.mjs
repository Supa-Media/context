#!/usr/bin/env node
/**
 * BRING THE COMMITTED CONFIG TO THE CURRENT SCHEMA (Dev2, 2026-11-17: "make sure that when we make updates or changes
 * to the schema everything is updated").
 *
 * A schema change is one pull request: bump `SCHEMA_VERSION` in `packages/tex/src/texConfigSchema.cjs`, add the
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

import { CONFIG_PATH, NIGHTLY_PATH, joinedTexConfig, nightlyConfigText, texConfigText } from "./lib/texConfigFile.mjs";
import { configText } from "./tex-lab-promote.mjs";

const require = createRequire(import.meta.url);
const { SCHEMA_VERSION, configProblems, migrateGraph } = require("../packages/tex/src/texConfigSchema.cjs");
// Both of Tex's files, texting and nightly, share the schema: migrated joined, written back split (`texConfigFiles.cjs`).
const { splitConfig, nightlyText } = require("../packages/tex/src/texConfigFiles.cjs");
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const before = texConfigText(ROOT) + nightlyConfigText(ROOT);
const migrated = { ...migrateGraph(joinedTexConfig(ROOT)), texConfig: SCHEMA_VERSION };
const problems = configProblems(migrated);
if (problems.length > 0) {
  console.error(`tex-config-migrate: the migrated config still does not match its schema: ${problems.join("; ")}`);
  process.exit(1);
}
const parts = splitConfig(migrated);
const after = configText(parts.tex) + nightlyText(parts.nightly);
if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(`tex-config-migrate: ${CONFIG_PATH} and ${NIGHTLY_PATH} are not at schema version ${SCHEMA_VERSION}: run node scripts/tex-config-migrate.mjs`);
    process.exit(1);
  }
  console.log(`tex-config-migrate: ${CONFIG_PATH} is at schema version ${SCHEMA_VERSION}`);
} else {
  writeFileSync(join(ROOT, CONFIG_PATH), configText(parts.tex));
  writeFileSync(join(ROOT, NIGHTLY_PATH), nightlyText(parts.nightly));
  console.log(`tex-config-migrate: ${after === before ? "already" : "now"} at schema version ${SCHEMA_VERSION}${after === before ? "" : ": run node scripts/tex-architecture.mjs next"}`);
}
