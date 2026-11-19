#!/usr/bin/env node
/**
 * A RUN'S WORLD ANSWERS INTO THE COMMITTED FIXTURES (`.github/workflows/tex-lab-run.yml`, `tex-world-record.yml`).
 *
 * A replay asks the simulated world's model only for a call nothing recorded is near, and saves the answer
 * (`simFixtures.mjs` saveRunFixtures). The run's fixture files come back as an artifact; this merges them into the
 * tree the way `record` does (an answer already committed stands, a new one is added), so a run made on older code
 * never takes back an answer main has since gained. Only a conversation of the repo's own Training or Dev set is
 * written, never one the run was handed from elsewhere (owner, 2026-11-19: "self-healing").
 *
 *   node apps/mcp/bench/worldHeal.mjs --from <dir> [--tree <repo>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { FIXTURES_DIR, fixturePath, isRepoConversation, saveFixtures } from "./simFixtures.mjs";

/** `{ id: added }` for each fixture file in `from` whose conversation is one of the tree's Training or Dev set. */
export function healWorld(from, tree) {
  const added = {};
  for (const name of existsSync(from) ? readdirSync(from).sort() : []) {
    if (!name.endsWith(".json")) continue;
    const id = basename(name, ".json");
    if (!isRepoConversation(tree, id)) continue;
    const answers = JSON.parse(readFileSync(join(from, name), "utf8")).answers ?? [];
    const n = saveFixtures(fixturePath(tree, id), id, answers, "record");
    if (n > 0) added[id] = n;
  }
  return added;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const from = arg("--from");
  if (!from) {
    console.error("usage: worldHeal.mjs --from <dir> [--tree <repo>]");
    process.exit(2);
  }
  const added = healWorld(from, arg("--tree") ?? ".");
  const total = Object.values(added).reduce((a, b) => a + b, 0);
  console.log(`world heal: ${total} new answer(s) into ${FIXTURES_DIR}${total ? ` (${Object.entries(added).map(([id, n]) => `${id} ${n}`).join(", ")})` : ""}`);
}
