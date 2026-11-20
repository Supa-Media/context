/**
 * TEX'S CONFIG, AS NODE SCRIPTS READ THE FILE (Dev2, 2026-11-17: one loader, one schema).
 *
 * Scripts that write the config, compare its text, or read it at another commit name its path here and nowhere else;
 * a script that only reads it gets it checked against `texConfigSchema.cjs`. Runtime code reads
 * `packages/tex/src/texConfig.cjs` instead. `scripts/tex-config-readers.mjs` fails CI for any other reader.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { texConfigOf } = require("../../packages/tex/src/texConfigSchema.cjs");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The config's path from the repository root. */
export const CONFIG_PATH = "packages/tex/src/texConfig.json";

/** The config file's text, as committed. */
export const texConfigText = (root = ROOT) => readFileSync(join(root, CONFIG_PATH), "utf8");

/** The config, parsed and checked against its schema (throws naming every problem). */
export const readTexConfig = (root = ROOT) => texConfigOf(JSON.parse(texConfigText(root)));
