#!/usr/bin/env node
/**
 * ONE RECORDED WORLD PER COMPARE (determinism research, Part 3 A.1).
 *
 * A compare runs two arms of Tex (base and draft) over the same conversations. Before this, each arm read whatever
 * fixtures were on disk when its test processes started, asked the world's model on its own for every call no fixture
 * was near, and healed the fixtures as it went, so the two arms saw different worlds: in the Opus run the draft had 33
 * invented answers and the base 18, and each run changed the fixtures the next one read.
 *
 * A compare folder (`TEX_WORLD_COMPARE=<dir>`, with `TEX_WORLD_ARM=base|draft`, read by `setsFd.mjs`) fixes that:
 *
 *   - **Snapshot.** The first arm to open the folder copies the conversations' saved fixtures into it once and records
 *     their content hash (`snapshot.json`). Every later arm reads only that copy, never a fixture written mid-compare.
 *   - **Shared miss memo.** A call nothing in the snapshot is near (the same 0.5 likeness rule, `simFixtures.mjs`) is
 *     answered once into `memo/<conversation>/`, one file per call claimed atomically (`openWorldStore` claim), and
 *     the other arm, in this process or another, replays that answer for the same or a near ask.
 *   - **Write-back once.** Nothing is written to `apps/mcp/bench/sets/sim/` while an arm runs. `finish` writes the memo
 *     back once, through the same `saveRunFixtures` a single run uses (so the heal workflow is unchanged), and a
 *     `written` marker made with an exclusive create makes a second `finish` a no-op.
 *   - **Misses per arm.** Each arm marks every memo answer it used (`touched-<arm>/`). `finish` reports
 *     "world misses: base N, draft M" and, when the arms differ by at least max(5, 25% of the larger), says the compare
 *     was "not the same recorded world" and gives no verdict on it.
 *
 * Two arms that run in separate processes or jobs share the folder: on one machine, by path; across jobs, by passing
 * the folder on as an artifact keyed by its snapshot hash. The Lab today runs each arm as its own workflow run and
 * compares with main's last finished run, so wiring the Lab to one folder per compare is a follow-up; this is the
 * mechanism it needs, and `sets run` uses it as soon as the two variables are set.
 *
 *   node apps/mcp/bench/worldCompare.mjs finish --dir <compare> [--tree <repo>]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixturePath, saveRunFixtures } from "./simFixtures.mjs";

export const COMPARE_ENV = "TEX_WORLD_COMPARE";
export const ARM_ENV = "TEX_WORLD_ARM";
export const ARMS = ["base", "draft"];

/** An arm's name as given, or null for anything that is not a plain short word. */
export const armOf = (value) => (/^[a-z][a-z0-9-]{0,30}$/.test(String(value ?? "")) ? String(value) : null);

/**
 * The saved fixtures of `convs` (`{ id, set }`) as they are now, and their hash: each conversation's file text, or ""
 * for none, hashed in id order, so the same files always give the same hash.
 */
export function snapshotFixtures(tree, convs) {
  const files = {};
  const sets = {};
  for (const c of [...convs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const path = fixturePath(tree, c.id);
    files[c.id] = existsSync(path) ? readFileSync(path, "utf8") : "";
    sets[c.id] = c.set ?? null;
  }
  const hash = createHash("sha256");
  for (const id of Object.keys(files)) hash.update(`${id}\0${files[id]}\0`);
  return { hash: hash.digest("hex"), files, sets };
}

/** Where the compare keeps a conversation's snapshot copy, its shared memo, and an arm's marks. */
export const snapshotPath = (dir, id) => join(dir, "snapshot", `${id}.json`);
export const memoDir = (dir, id) => join(dir, "memo", id);

/**
 * Opens a compare folder: the first call takes the snapshot and writes it in; every later call (the other arm, another
 * process) reads the one already there, whatever the fixtures on disk now hold. Returns `{ hash, ids, sets }`.
 */
export function openCompare(dir, { tree, convs }) {
  const record = join(dir, "snapshot.json");
  if (!existsSync(record)) {
    const snap = snapshotFixtures(tree, convs);
    mkdirSync(join(dir, "snapshot"), { recursive: true });
    for (const [id, text] of Object.entries(snap.files)) if (text !== "") writeFileSync(snapshotPath(dir, id), text);
    try {
      writeFileSync(record, `${JSON.stringify({ hash: snap.hash, ids: Object.keys(snap.files), sets: snap.sets }, null, 1)}\n`, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error; // another arm took it first: its snapshot stands
    }
  }
  return JSON.parse(readFileSync(record, "utf8"));
}

/** How many memo answers an arm used across the compare's conversations: its world misses. */
export function armMisses(dir, arm) {
  const root = join(dir, "memo");
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const id of readdirSync(root)) {
    const marks = join(root, id, `touched-${arm}`);
    if (existsSync(marks)) n += readdirSync(marks).length;
  }
  return n;
}

/** The smallest gap in world misses that makes a compare "not the same recorded world": max(5, 25% of the larger). */
export const missGap = (base, draft) => Math.max(5, Math.ceil(0.25 * Math.max(base, draft)));

/** The compare's world line, and whether its verdict stands. */
export function worldVerdict(base, draft) {
  const gap = Math.abs(draft - base);
  const sameWorld = gap < missGap(base, draft);
  const line = `world misses: base ${base}, draft ${draft}`;
  return { base, draft, sameWorld, line: sameWorld ? line : `${line}; not the same recorded world (|draft - base| = ${gap} >= ${missGap(base, draft)}), no verdict` };
}

/**
 * Ends a compare: reports each arm's misses and writes the memo back to the fixtures once (`saveRunFixtures`, replay
 * mode: only the repo's Training and Dev conversations, a committed answer stands). A second call writes nothing.
 * Returns the report, also kept as `report.json`.
 */
export function finishCompare(dir, { tree, mode = "replay", log = (line) => process.stderr.write(line) } = {}) {
  const snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  const verdict = worldVerdict(armMisses(dir, "base"), armMisses(dir, "draft"));
  let wrote = false;
  try {
    writeFileSync(join(dir, "written"), `${snap.hash}\n`, { flag: "wx" });
    wrote = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (wrote) saveRunFixtures(snap.ids.map((id) => ({ id, set: snap.sets?.[id] ?? null, runDir: memoDir(dir, id) })), tree, mode, log);
  const report = { snapshot: snap.hash, ...verdict, wroteBack: wrote };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args[0] !== "finish" || !flag("dir")) {
    process.stderr.write("usage: node apps/mcp/bench/worldCompare.mjs finish --dir <compare> [--tree <repo>]\n");
    process.exit(2);
  }
  const report = finishCompare(resolve(flag("dir")), { tree: resolve(flag("tree") ?? join(import.meta.dirname, "../../..")) });
  process.stdout.write(`world snapshot ${report.snapshot.slice(0, 12)}: ${report.line}\n`);
}
