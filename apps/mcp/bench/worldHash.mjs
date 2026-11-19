#!/usr/bin/env node
/**
 * THE WORLD A RUN WAS SHOWN, AS ONE HASH (`.github/workflows/tex-world-record.yml`).
 *
 * Two runs of one commit should see the same simulated world: every call answered from the committed fixtures
 * (`simFixtures.mjs`), none invented. This reads a run's kept Front door results (`sets run --keep <dir>`), takes each
 * `world <kind> ... -> <answer>` line the browser log holds (a replayed answer and one first asked read the same), and
 * prints how many distinct answers each conversation was shown and one sha256 over them all, with the run's misses.
 * Counts and hashes only: never a call or an answer, so the line can go in a public log.
 *
 *   node apps/mcp/bench/worldHash.mjs --kept <dir> [--rows <rows.json>]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { worldMisses } from "./setsRun.mjs";

/** A kept test folder's conversation: `c<k>-<id>-sets-<n>` (a repeat may add `-r<n>`). */
export const conversationOf = (name) => name.replace(/^c\d+-/, "").replace(/-sets-\d+.*$/, "");

/**
 * The world lines of one result's text: the `Browser:` line holds every event joined by " | " (`report.mjs`), and a
 * world answer is one that starts `world `. `(replayed)` is dropped, so where an answer came from does not change it.
 */
export function worldLines(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("Browser: ")) continue;
    for (const event of line.slice("Browser: ".length).split(" | ")) {
      if (event.startsWith("world ")) out.push(event.replace(/^world ([a-z ]+?) \(replayed\) /, "world $1 "));
    }
  }
  return out;
}

/** `{ byConversation: { id: count }, answers, hash }` over a kept folder. */
export function worldHash(kept) {
  const seen = new Map();
  for (const name of existsSync(kept) ? readdirSync(kept).sort() : []) {
    const file = join(kept, name, "result.md");
    if (!existsSync(file)) continue;
    const id = conversationOf(name);
    const lines = seen.get(id) ?? new Set();
    for (const line of worldLines(readFileSync(file, "utf8"))) lines.add(line);
    seen.set(id, lines);
  }
  const hash = createHash("sha256");
  const byConversation = {};
  let answers = 0;
  for (const id of [...seen.keys()].sort()) {
    const lines = [...seen.get(id)].sort();
    byConversation[id] = lines.length;
    answers += lines.length;
    hash.update(`${id}\n${lines.join("\n")}\n`);
  }
  return { byConversation, answers, hash: hash.digest("hex").slice(0, 16) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : null;
  };
  const kept = arg("--kept");
  if (!kept) {
    console.error("usage: worldHash.mjs --kept <dir> [--rows <rows.json>]");
    process.exit(2);
  }
  const { byConversation, answers, hash } = worldHash(kept);
  const rows = arg("--rows");
  const misses = rows && existsSync(rows) ? worldMisses(JSON.parse(readFileSync(rows, "utf8"))).length : null;
  console.log(`world answers shown: ${answers} (${Object.entries(byConversation).map(([id, n]) => `${id} ${n}`).join(", ")}), hash ${hash}${misses === null ? "" : `, misses ${misses}`}`);
}
