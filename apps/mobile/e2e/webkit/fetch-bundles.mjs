#!/usr/bin/env node
/**
 * Fetch the real community-plugin releases `pluginBundles.spec.ts` runs.
 *
 * Not committed, and not a preference: one of these is four megabytes of
 * somebody else's minified code, and this repository is public, MIT licensed
 * and not where that belongs. The spec skips when a release is absent, so the
 * suite still runs offline — this is what CI and a developer run first.
 *
 * Pinned by version, deliberately. The point of the check is that the shim runs
 * *a real bundle*, and a floating "latest" would make a green run mean "the
 * release published this morning happens to load", which is a different and
 * much weaker claim — and an unreproducible one when it goes red.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "bundles");

const RELEASES = [
  {
    id: "obsidian-bible-reference",
    repository: "tim-hub/obsidian-bible-reference",
    version: "26.08.07",
  },
];

await mkdir(OUT, { recursive: true });
for (const release of RELEASES) {
  const url =
    `https://github.com/${release.repository}/releases/download/` +
    `${encodeURIComponent(release.version)}/main.js`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${release.id}: ${response.status} from ${url}`);
    process.exitCode = 1;
    continue;
  }
  const text = await response.text();
  await writeFile(join(OUT, `${release.id}.js`), text);
  console.log(`${release.id} ${release.version} — ${text.length} bytes`);
}
