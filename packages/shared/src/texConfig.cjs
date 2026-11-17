/**
 * TEX'S CONFIG, AS EVERY RUNTIME READS IT (Dev2, 2026-11-17: one loader, one schema).
 *
 * The gateway, the texting Worker, the Lab, Convex and the shared helpers read `texConfig.json` through this file
 * only, so every one of them gets a config that matches `texConfigSchema.cjs` or fails loudly at start instead of
 * misreading a field. Node scripts read the file through `scripts/lib/texConfigFile.mjs`;
 * `scripts/tex-config-readers.mjs` fails CI for any other file that names `texConfig.json` in code.
 */
"use strict";

const { texConfigOf } = require("./texConfigSchema.cjs");

const TEX_CONFIG = texConfigOf(require("./texConfig.json"));

module.exports = { TEX_CONFIG };
