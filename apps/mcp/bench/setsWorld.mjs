/**
 * A TEST CONVERSATION'S OWN WORLD (Training run of 2026-11-18: a podcast crew's chat ran in the fashion brand's
 * workspace, so the gear note, the outreach email and the budget it talks about did not exist, and Tex was graded on
 * not finding them).
 *
 * A Training or Dev conversation is a chat from a life: it refers to notes, emails, calendar days and web pages. The
 * bench's people have worlds of their own (`ai/workspaces/people.md`), and those worlds are about other things. So a
 * conversation may declare what it refers to, in a folder beside the sets named by its id:
 *
 *   apps/mcp/bench/sets/worlds/<conversation id>/
 *     workspaces/<name>/...   notes, emails and calendar days, in the forms every bench workspace uses (`load.mjs`)
 *     sites/<host>.md         scripted sites (`sites.mjs`)
 *     world.md                optional: `starts: YYYY-MM-DD`, the day of the chat's first line when it names no date
 *
 * `<name>` is a member's own workspace (laid over it: the person keeps their bench world and gains these records), or
 * a new name, which makes a shared workspace of the conversation's people, the first its owner (`@driftline`, the
 * podcast's notes). A group chat runs in its world's shared workspace. Every Front door test of the conversation runs
 * in a copy of the bench folder with its world laid in (`setsFd.mjs` `runFd`), and no other conversation sees it. What
 * a world leaves out is still played by the simulated world from the chat's setting (`simWorld.mjs`).
 *
 * A world is the state of things as the chat's people would find them. Notes are as they were when the chat began.
 * Mail is dated, and an email dated after a test's own day has not arrived for that test (`world.mjs` `mail_until`).
 * It is written from what the conversation's own lines say exists, never from a test's must and never lines: a record
 * that states the wanted answer in the label's words is the answer key, not a world.
 */
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parsePeople } from "./load.mjs";

/** Where the worlds live in a tree, and one conversation's folder there. */
export const WORLDS = "apps/mcp/bench/sets/worlds";
export const worldDirOf = (tree, id) => join(tree, WORLDS, String(id));

const isDir = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const dirsIn = async (path) => ((await isDir(path)) ? (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);

/**
 * What a conversation's world folder holds: `{ workspaces: [names], sites: [hosts] }`, both empty when it has none.
 */
export async function readWorld(worldDir) {
  const workspaces = await dirsIn(join(worldDir, "workspaces"));
  const siteFiles = (await isDir(join(worldDir, "sites"))) ? (await readdir(join(worldDir, "sites"))).filter((n) => n.endsWith(".md")).sort() : [];
  const sites = [];
  for (const name of siteFiles) {
    const host = /^site:\s*(\S+)\s*$/m.exec(await readFile(join(worldDir, "sites", name), "utf8"))?.[1];
    if (host) sites.push(host);
  }
  // `world.md`'s `starts:` is the day of the conversation's first line, for a chat that names no date itself.
  const starts = /^starts:\s*"?(\d{4}-\d{2}-\d{2})"?\s*$/m.exec(await readFile(join(worldDir, "world.md"), "utf8").catch(() => ""))?.[1] ?? null;
  return { workspaces, siteFiles, sites, starts };
}

/**
 * Why a world can't be laid in, as sentences; empty when it can. A workspace it names is the personal workspace of
 * one of the conversation's people, or a new shared one of theirs: a world never writes into anybody else's, and a
 * group chat has one shared workspace to run in.
 */
export function worldProblems(c, cast, world, people) {
  const out = [];
  const own = new Set(cast.map((name) => people.find((row) => row.person === name && row.personal)?.workspace).filter(Boolean));
  for (const name of world.workspaces) {
    if (!own.has(name) && people.some((row) => row.workspace === name)) out.push(`worlds/${c.id}/workspaces/${name} is a workspace the bench already has, and not one of ${c.id}'s people's own`);
  }
  const shared = sharedIn(world, own);
  if (c.kind === "group" && shared.length > 1) out.push(`worlds/${c.id} has ${shared.length} shared workspaces (${shared.join(", ")}): a group chat runs in one`);
  return out;
}

/** The shared workspaces a world makes: every one it names that is not a member's own. */
const sharedIn = (world, own) => world.workspaces.filter((name) => !own.has(name));

/**
 * Lay a conversation's world into `dir`, a copy of the bench folder: its workspaces over the copy's, its sites beside
 * the copy's, and each shared workspace added to `people.md` with the conversation's people. Answers
 * `{ group, sites, laid, starts }`: the shared workspace a group chat runs in (or null), the hosts it added, and whether
 * there was a world at all; throws what `worldProblems` says.
 */
export async function seedWorld(dir, worldDir, c, cast) {
  const world = await readWorld(worldDir);
  if (world.workspaces.length === 0 && world.siteFiles.length === 0) return { group: null, sites: [], laid: false, starts: world.starts };
  const peoplePath = join(dir, "workspaces", "people.md");
  const peopleRaw = await readFile(peoplePath, "utf8");
  const people = parsePeople(peopleRaw);
  const problems = worldProblems(c, cast, world, people);
  if (problems.length > 0) throw new Error(problems.join("; "));
  for (const name of world.workspaces) await cp(join(worldDir, "workspaces", name), join(dir, "workspaces", name), { recursive: true });
  for (const name of world.siteFiles) await cp(join(worldDir, "sites", name), join(dir, "sites", name));
  const own = new Set(cast.map((name) => people.find((row) => row.person === name && row.personal)?.workspace).filter(Boolean));
  const shared = sharedIn(world, own);
  const rows = shared.flatMap((workspace) => cast.map((name, k) => `| ${name} | ${workspace} | ${k === 0 ? "owner" : "editor"} |`));
  if (rows.length > 0) await writeFile(peoplePath, withRows(peopleRaw, rows));
  return { group: c.kind === "group" ? (shared[0] ?? null) : null, sites: world.sites, laid: true, starts: world.starts };
}

/** Whether a conversation's world gives a group chat its shared workspace (so `people.md` need not have one). */
export async function worldHasShared(worldDir, cast, people) {
  const world = await readWorld(worldDir);
  const own = new Set(cast.map((name) => people.find((row) => row.person === name && row.personal)?.workspace).filter(Boolean));
  return sharedIn(world, own).length > 0;
}

/** `people.md` with more rows at the end of its table. */
export function withRows(raw, rows) {
  const lines = raw.split("\n");
  const last = lines.findLastIndex((line) => /^\|.*\|\s*$/.test(line));
  if (last < 0) throw new Error("people.md has no table");
  return [...lines.slice(0, last + 1), ...rows, ...lines.slice(last + 1)].join("\n");
}
