/**
 * Tex's test conversations on disk. The contract is `packages/shared/src/texSets.cjs` and the plan is
 * `tex-sets/plan.md`. Training and Dev conversations live at `apps/mcp/bench/sets/<training|dev>/<id>.json`.
 * The Test Set never lives in the repo: a `test/` folder or a conversation in set "test" is reported as a problem,
 * never loaded into a set or written anywhere.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const texSets = require("../../../packages/shared/src/texSets.cjs");
const textDecide = require("../../../packages/shared/src/textDecide.cjs");

const { SETS, TARGET, DRIFT, check, ratio } = texSets;

/** Invisible and direction characters as escapes: a literal one fails the identifiers guard and can't be seen in review. */
const escapeInvisible = (text) => text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));

/** 2-space JSON with invisible characters escaped (`check-identifiers`). */
export const jsonFile = (value) => escapeInvisible(JSON.stringify(value, null, 2)) + "\n";

/**
 * A conversation file's text: one line per field and one line per message, so a long conversation (Dev2,
 * 2026-11-16: "100, 500 different turns") stays a few hundred lines for the size check and reads as a chat in review.
 */
export function conversationFile(c) {
  const { msgs = [], ...rest } = c;
  const head = Object.entries(rest).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = msgs.map((m) => `    ${JSON.stringify(m)}`).join(",\n");
  return escapeInvisible(`{\n${[...head, `  "msgs": [\n${body}\n  ]`].join(",\n")}\n}\n`);
}

export const SETS_DIR = fileURLToPath(new URL("./sets", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../../packages/shared/src/texConfig.json", import.meta.url));

/** Folders read from disk. `test` is read only so that a stray Test conversation is reported, never skipped. */
const FOLDERS = ["training", "dev", "test"];

/** Where each conversation was read from, by object identity: `{ folder, file }`. */
const SOURCE = new WeakMap();

/** The folder a conversation was read from; its set when it was not read from disk. */
export function folderOf(conv) {
  return SOURCE.get(conv)?.folder ?? conv?.set;
}

/** The file a conversation was read from; `<id>.json` when it was not read from disk. */
export function fileOf(conv) {
  return SOURCE.get(conv)?.file ?? `${conv?.id}.json`;
}

/** Tex's config and the judge's reasons, as the validator needs them. */
export function loadContract() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const why = Object.keys(textDecide.WHY);
  return { config, why };
}

const setRank = (set) => {
  const i = SETS.indexOf(set);
  return i === -1 ? SETS.length : i;
};

/**
 * Every conversation under `dir`, read from its folders, sorted by set then id. A file that is not JSON throws
 * with its name only: its contents are never printed.
 */
export async function loadSets(dir = SETS_DIR) {
  const out = [];
  for (const folder of FOLDERS) {
    let names;
    try {
      names = await readdir(join(dir, folder));
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const file of names.filter((n) => n.endsWith(".json")).sort()) {
      let conv;
      try {
        conv = JSON.parse(await readFile(join(dir, folder, file), "utf8"));
      } catch {
        throw new Error(`${folder}/${file} is not readable JSON`);
      }
      SOURCE.set(conv, { folder, file });
      out.push(conv);
    }
  }
  return out.sort((a, b) => setRank(a.set) - setRank(b.set) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every problem with the conversations, as "file: problem" strings; empty when the repo is sound. Each conversation
 * goes through the contract's `check()`, then the repo's own rules: its file is `<id>.json`, its folder is its set,
 * no set "test", no `test/` folder, and ids are unique across the folders.
 */
export function problemsOf(convs, { config, why, folderOf: folderFn = folderOf, fileOf: fileFn = fileOf } = {}) {
  const out = [];
  const ids = new Set();
  for (const c of convs) {
    if (!c || typeof c !== "object") {
      out.push("unreadable conversation: not an object");
      continue;
    }
    const label = `${folderFn(c)}/${fileFn(c)}`;
    const add = (p) => out.push(`${label}: ${p}`);
    for (const p of check(c, config, { why })) add(p);
    if (fileFn(c) !== `${c.id}.json`) add(`file name must be ${c.id}.json`);
    if (folderFn(c) === "test") add("test/ folder: Test conversations never live in the repo");
    else if (folderFn(c) !== c.set) add(`folder ${folderFn(c)} must match set ${c.set}`);
    if (c.set === "test") add("set test: Test conversations never live in the repo");
    if (ids.has(c.id)) add(`id ${c.id} is used by another conversation`);
    ids.add(c.id);
  }
  return out;
}

/**
 * The split over unit tests (starred labels). With `testStars` a number, all three sets are counted and the
 * contract's `ratio` decides. With null, only Training against Dev is checked: Dev's share of their stars must be
 * within DRIFT points of its target share.
 */
export function ratioCheck(convs, testStars = null) {
  const { counts } = ratio(convs);
  const { training, dev } = counts;
  if (typeof testStars === "number") {
    const r = ratio({ training, dev, test: testStars });
    const p = r.pct;
    const verdict = r.holds ? "holds" : "does not hold";
    return {
      holds: r.holds,
      line: `Training ${training} · Dev ${dev} · Test ${r.counts.test} stars (${p.training}/${p.dev}/${p.test}, ${verdict} ${TARGET.training}/${TARGET.dev}/${TARGET.test})`,
    };
  }
  const total = training + dev;
  const devShare = total ? (dev * 100) / total : 0;
  const wantShare = (TARGET.dev * 100) / (TARGET.training + TARGET.dev);
  const holds = total > 0 && Math.abs(devShare - wantShare) <= DRIFT;
  const trainingPct = total ? Math.round((training * 100) / total) : 0;
  const verdict = holds ? "holds" : "does not hold";
  return {
    holds,
    line: `Training ${training} · Dev ${dev} stars (${trainingPct}/${100 - trainingPct}, ${verdict} ${TARGET.training / TARGET.dev}:1); Test counted by the eval service`,
  };
}
