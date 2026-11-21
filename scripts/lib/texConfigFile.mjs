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
const { NIGHTLY_PATH, joinConfigs } = require("../../packages/tex/src/texConfigFiles.cjs");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The config's path from the repository root. */
export const CONFIG_PATH = "packages/tex/src/texConfig.json";

/** The nightly cleanup's file (Dev2, 2026-11-21: Tex's config is two files, `texConfigFiles.cjs`). */
export { NIGHTLY_PATH };

/** The texting config file's text, as committed. */
export const texConfigText = (root = ROOT) => readFileSync(join(root, CONFIG_PATH), "utf8");

/** The nightly config file's text, as committed. */
export const nightlyConfigText = (root = ROOT) => readFileSync(join(root, NIGHTLY_PATH), "utf8");

/** The two files joined as one config, unchecked: what Promote and the merge compare a draft with. */
export const joinedTexConfig = (root = ROOT) => joinConfigs(JSON.parse(texConfigText(root)), JSON.parse(nightlyConfigText(root)));

/** The config (both files joined), parsed and checked against its schema (throws naming every problem). */
export const readTexConfig = (root = ROOT) => texConfigOf(joinedTexConfig(root));

/**
 * The config with the steps retired off it to the shelf (`texNodeShelf.json`, `retired: true`; 2026-11-20) put back,
 * off, for a reader of old records that still name them (a bench case migrated from before they were retired).
 */
export const withRetiredSteps = (config, root = ROOT) => {
  const shelf = JSON.parse(readFileSync(join(root, "packages/tex/src/texNodeShelf.json"), "utf8"));
  const have = new Set(config.nodes.map((n) => n.id));
  const retired = Object.values(shelf.nodes ?? {}).filter((e) => e?.retired === true && e.node?.id && !have.has(e.node.id)).map((e) => ({ ...e.node, on: false }));
  return { ...config, nodes: [...config.nodes, ...retired] };
};
