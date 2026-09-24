/**
 * The Obsidian plugin compatibility check.
 *
 * Three layers, matching the three modules: the scan is a pure function over
 * text and is tested as one; the inventory is tested against a bucket stub that
 * can be made to behave like the awkward backends (no delimiter support,
 * pagination, an unreadable object); the report is tested for the four phrasing
 * rules it exists to keep.
 *
 * The checks that matter most are the ones asserting what the scan *refuses* to
 * conclude. A text scan proves presence, never absence, so every path where a
 * missing finding could be mistaken for a clean bill has a check here — an
 * over-long bundle, an unreadable one, and above all an obfuscated one. A
 * plugin that can build `require("child_" + "process")` after it starts must
 * never come back "runs here", and curation must never be able to make it.
 *
 * This file used to hold every one of these checks directly, in one
 * 1,281-line function. It is now a thin facade over `test/plugins/*.test.mjs`,
 * split by topic, so `import { runPluginChecks } from "./plugins.test.mjs"`
 * keeps working unchanged and every check still runs in its original order.
 */

import { runPluginManifestChecks } from "./plugins/manifest.test.mjs";
import { runPluginScanAndCurationChecks } from "./plugins/scanAndCuration.test.mjs";
import { runPluginInventoryChecks } from "./plugins/inventory.test.mjs";

export async function runPluginChecks(check) {
  await runPluginManifestChecks(check);
  await runPluginScanAndCurationChecks(check);
  await runPluginInventoryChecks(check);
}
