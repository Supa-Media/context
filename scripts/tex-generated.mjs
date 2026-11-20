#!/usr/bin/env node
/**
 * THE TEX LAB'S BUILT FILES ARE BUILT, NOT COMMITTED (Dev2, 2026-11-17: "how are we avoiding merge conflicts"; chose
 * "A + B + schema, no split").
 *
 * Four files are made from the repository's own sources and were committed as a few enormous lines each, so any two
 * pull requests that touched the config, the Lab or the bench cases conflicted in them, every time:
 *
 *   packages/lab/app/labData.generated.ts   the bench's cases, prompt texts and fixtures (tex-lab-data.mjs)
 *   apps/mcp/src/texDev/lab.generated.js               the Lab's engine for tex_dev (tex-dev-lab.mjs)
 *   apps/mcp/src/texDev/canvas.generated.js            the Lab's drawing for tex_dev snapshot (tex-dev-canvas.mjs)
 *   apps/mcp/src/texDev/replay.generated.js            the Lab's Replay for tex_dev (tex-dev-replay.mjs)
 *
 * They are git-ignored now and built on every install: `postinstall` in apps/mobile builds the first, in apps/mcp all
 * four (the bundles read the first), so a deploy, a CI job, a self-hoster and a fresh clone all build them from the
 * commit they install. The small, line-shaped outputs (the config's drawing and map, the prompt words, the prompt
 * catalogue the Lab reads at old commits) stay committed.
 *
 *   node scripts/tex-generated.mjs [mobile|mcp|all]     (default all)
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOR = {
  mobile: ["tex-lab-data.mjs"],
  mcp: ["tex-lab-data.mjs", "tex-dev-lab.mjs", "tex-dev-canvas.mjs", "tex-dev-replay.mjs"],
};
FOR.all = FOR.mcp;

const which = process.argv[2] ?? "all";
if (!FOR[which]) {
  console.error("usage: node scripts/tex-generated.mjs [mobile|mcp|all]");
  process.exit(2);
}
for (const script of FOR[which]) execFileSync(process.execPath, [`scripts/${script}`], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
console.log(`tex-generated: built ${FOR[which].join(", ")}`);
