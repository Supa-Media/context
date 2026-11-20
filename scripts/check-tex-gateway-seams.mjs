#!/usr/bin/env node

/**
 * THE GATEWAY'S TEX CODE MAY ONLY LEAN ON THE GATEWAY WHERE IT ALREADY DID.
 *
 * Tex's gateway code (its chat, job and store objects, and next the turn
 * itself) moved from `apps/mcp/src` into `packages/tex/gateway` as folders,
 * unchanged (Dev2, 2026-11-20: "Move as a folder now, cut seams later"). It
 * still imports gateway files (tools, vault, privacy, storage, http) by
 * relative path. Each such file is a seam: a place the package is not yet its
 * own. `packages/tex/gateway/seams.json` lists them, and this fails when:
 *
 *   - Tex's gateway code imports a gateway file the list does not name (a new
 *     seam: take what you need through code Tex owns, or say why in the list);
 *   - the list names a file nothing imports any more (a seam was cut: take it
 *     off, so the list only ever shrinks and always says what is left).
 *
 * Plain Node over files in this repository, so it needs no install.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEX_GATEWAY = "packages/tex/gateway";
export const GATEWAY = "apps/mcp/src";
export const LIST = `${TEX_GATEWAY}/seams.json`;

const SOURCE = /\.(?:m?js|ts)$/;
const SPECIFIER = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Every gateway file that `files` ({ path, text }) import by relative path, sorted and unique. */
export function seamsOf(files) {
  const found = new Set();
  for (const { path, text } of files) {
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      const target = relative(ROOT, resolve(ROOT, dirname(path), spec)).replaceAll("\\", "/");
      if (target.startsWith(`${GATEWAY}/`)) found.add(target);
    }
  }
  return [...found].sort();
}

/** What is wrong with `listed` given the seams `found`: new seams, and listed ones nothing uses. */
export function seamProblems(found, listed) {
  const have = new Set(listed);
  const used = new Set(found);
  const problems = [];
  for (const seam of found) if (!have.has(seam)) problems.push(`${TEX_GATEWAY} now imports ${seam}, a gateway file ${LIST} does not list: reach it through code Tex owns, or add it to the list with the reason`);
  for (const seam of listed) if (!used.has(seam)) problems.push(`${LIST} lists ${seam}, which nothing in ${TEX_GATEWAY} imports any more: take it off the list`);
  return problems;
}

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(path));
    else if (SOURCE.test(entry.name)) out.push({ path, text: readFileSync(join(ROOT, path), "utf8") });
  }
  return out;
}

function selfTest() {
  const files = [
    { path: `${TEX_GATEWAY}/texStore/wire.js`, text: 'import { r2 } from "../../../../apps/mcp/src/store/r2.js";\nimport { x } from "./objects.js";' },
    { path: `${TEX_GATEWAY}/texChat.js`, text: 'const m = await import("../../../apps/mcp/src/objectPlace.js");\nimport y from "../../shared/src/routines.cjs";' },
  ];
  const found = seamsOf(files);
  const expect = (cond, what) => {
    if (!cond) throw new Error(`self-test: ${what}`);
  };
  expect(found.join() === `${GATEWAY}/objectPlace.js,${GATEWAY}/store/r2.js`, `the wrong seams were found: ${found.join()}`);
  expect(seamProblems(found, found).length === 0, "an exact list was refused");
  expect(seamProblems(found, [`${GATEWAY}/store/r2.js`]).length === 1, "a new seam passed");
  expect(seamProblems(found, [...found, `${GATEWAY}/vault/keys.js`]).length === 1, "a cut seam left on the list passed");
  console.log("check-tex-gateway-seams self-test: ok");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = seamsOf(sources(TEX_GATEWAY));
  if (args.includes("--write")) {
    const list = JSON.parse(readFileSync(join(ROOT, LIST), "utf8"));
    writeFileSync(join(ROOT, LIST), `${JSON.stringify({ ...list, seams: found }, null, 2)}\n`);
    console.log(`wrote ${LIST}: ${found.length} seams`);
  } else {
    const { seams } = JSON.parse(readFileSync(join(ROOT, LIST), "utf8"));
    const problems = seamProblems(found, seams);
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      process.exit(1);
    }
    console.log(`check-tex-gateway-seams: Tex's gateway code leans on ${found.length} gateway files, each listed in ${LIST}`);
  }
}
