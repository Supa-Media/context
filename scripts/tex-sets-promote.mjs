#!/usr/bin/env node
/**
 * THE LAB'S TEST CONVERSATIONS INTO THE REPO (Dev2, 2026-11-15; `apps/convex/functions/texSets.ts`).
 *
 * Reads the drafts the Lab promote workflow asked for (`texSets:asked`, as JSON) and writes each into
 * `apps/mcp/bench/sets/<set>/<id>.json`: a changed or new conversation as its file (moved to its new set's folder
 * when its set changed), a deleted one removed. Each is checked with `texSets.cjs` first; one that is not sound is
 * left out and named, never written half right. Then the data the gateway and the Lab read from the folder are
 * rebuilt (`tex-sets-data.mjs`, `tex-lab-data.mjs`). Prints one JSON line: { written, removed, refused }.
 *
 *   node scripts/tex-sets-promote.mjs <asks.json>
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { check } = require("../packages/shared/src/texSets.cjs");
const { WHY } = require("../packages/shared/src/textDecide.cjs");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "packages/shared/src/texConfig.json"), "utf8"));
export const SETS_DIR = join(ROOT, "apps/mcp/bench/sets");
const { jsonFile } = await import(new URL("../apps/mcp/bench/sets.mjs", import.meta.url).href);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OPEN = ["training", "dev"];

/** Where a conversation's file is now, in either folder, or null. */
const fileOf = (dir, id) => OPEN.map((s) => join(dir, s, `${id}.json`)).find((p) => existsSync(p)) ?? null;

/** Apply the asks to the folder `dir`. Pure of git; answers what it did. */
export function promote(asks, dir = SETS_DIR) {
  const written = [];
  const removed = [];
  const refused = [];
  for (const ask of asks) {
    const id = String(ask.id ?? "");
    if (!ID.test(id)) {
      refused.push({ id, why: "not a conversation id" });
      continue;
    }
    const old = fileOf(dir, id);
    if (ask.removed) {
      if (old) rmSync(old);
      removed.push(id);
      continue;
    }
    let convo;
    try {
      convo = JSON.parse(ask.conv);
    } catch {
      refused.push({ id, why: "its conversation is not JSON" });
      continue;
    }
    if (convo.id !== id || !OPEN.includes(convo.set)) {
      refused.push({ id, why: convo.set === "test" ? "the Test Set never goes into the repo" : "its id or set is wrong" });
      continue;
    }
    const problems = check(convo, CONFIG, { why: Object.keys(WHY) });
    if (problems.length) {
      refused.push({ id, why: problems.slice(0, 3).join("; ").slice(0, 280) });
      continue;
    }
    const to = join(dir, convo.set, `${id}.json`);
    if (old && old !== to) rmSync(old);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, jsonFile(convo));
    written.push(id);
  }
  return { written, removed, refused };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/tex-sets-promote.mjs <asks.json>");
    process.exit(2);
  }
  const result = promote(JSON.parse(readFileSync(file, "utf8")));
  if (result.written.length || result.removed.length) {
    execFileSync(process.execPath, [join(ROOT, "scripts/tex-sets-data.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync(process.execPath, [join(ROOT, "scripts/tex-lab-data.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
