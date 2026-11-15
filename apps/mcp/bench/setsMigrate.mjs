#!/usr/bin/env node
/**
 * Today's Tex bench cases as conversations (the test-set format in `packages/shared/src/texSets.cjs`; plan:
 * `tex-sets/plan.md`). Respond, review, job-check and core questions become conversations; the judge's examples are
 * written by another branch and are not migrated here.
 *
 *   node apps/mcp/bench/setsMigrate.mjs --write   writes apps/mcp/bench/sets/<set>/<id>.json
 *   node apps/mcp/bench/setsMigrate.mjs --check   exits 1 when a file it would write differs from what is on disk
 *
 * Sets: non-stars are split so dev holds about a quarter of the unit tests (stars), so Training:Dev is near 3:1.
 */
import { jsonFile } from "./sets.mjs";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTest } from "./load.mjs";

const require = createRequire(import.meta.url);
const texSets = require("../../../packages/shared/src/texSets.cjs");
const textDecide = require("../../../packages/shared/src/textDecide.cjs");

const { check, unitTests } = texSets;
const { WHY } = textDecide;

const TEX = "Tex";
const DEV_SHARE_CAP = 0.25;

/** Lowercase letters, digits and dashes; any other run becomes one dash. */
export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `prefix-slug`, cut to the 80 characters an id may hold. */
function makeId(prefix, rest) {
  return `${prefix}-${slug(rest)}`.slice(0, 80).replace(/-+$/g, "");
}

/** "g-tag-mid" -> "Tag mid": a readable title from the case id, nothing invented. */
function humanize(id) {
  const words = String(id).replace(/^g-/, "").replace(/-/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const cap = (name) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * One chat line: "@name: words" is a person's, "You: words" is Tex's row. A one-to-one chat's person has no prefix
 * in the cases, so their bare words are "Jo" there (the name the judge's one-to-one examples use).
 */
function chatMessage(line, oneToOne = false) {
  const you = /^You:\s?(.*)$/s.exec(line);
  if (you) return { who: TEX, tex: true, text: you[1] };
  const person = /^@([^:\s]+):\s?(.*)$/s.exec(line);
  if (person) return { who: cap(person[1]), text: person[2] };
  if (oneToOne) return { who: "Jo", text: line };
  throw new Error(`unreadable chat line: ${JSON.stringify(line)}`);
}

/** Members are the people who speak, in order of first speaking. Tex is never one. */
function membersOf(msgs) {
  const out = [];
  for (const m of msgs) if (!m.tex && !out.includes(m.who)) out.push(m.who);
  return out;
}

/** The fields in the order a set file reads: id, title, set, kind, members, setting, world, msgs, from. */
function conversation({ id, title, kind, members, setting, world, msgs, from }) {
  return {
    id,
    title,
    set: "training",
    kind,
    members,
    ...(setting ? { setting } : {}),
    ...(world ? { world } : {}),
    msgs: msgs.map((m, i) => ({ id: `m${i + 1}`, ...m })),
    from,
  };
}

function fromChat(kase) {
  const oneToOne = kase.chat !== "group";
  const parsed = [...(kase.lines ?? []).map((l) => chatMessage(l, oneToOne)), chatMessage(kase.text, oneToOne)];
  const last = parsed.at(-1);
  if (last.tex) throw new Error(`${kase.id}: the last message must be a person's`);
  if (kase.want !== "reply" && kase.want !== "hush") throw new Error(`${kase.id}: want must be reply or hush, got ${kase.want}`);
  const decide = { act: kase.want === "reply" ? "respond" : "quiet", star: true };
  if (kase.want === "hush") decide.also_react = "any";
  last.labels = { decide };
  return conversation({
    id: makeId("respond", kase.id),
    title: humanize(kase.id),
    kind: kase.chat === "group" ? "group" : "one",
    members: membersOf(parsed),
    setting: kase.setting,
    msgs: parsed,
    from: `respond/${kase.id}`,
  });
}

function fromReview(kase) {
  const msgs = [];
  for (const [role, text] of kase.earlier ?? []) {
    if (role === "person") msgs.push({ who: "Jo", text });
    else if (role === "tex" || role === "assistant") msgs.push({ who: TEX, tex: true, text });
    else throw new Error(`${kase.id}: unknown earlier role ${role}`);
  }
  msgs.push({
    who: "Jo",
    text: kase.q,
    labels: { reviewer: { sentBack: kase.fault ? "1" : "0", star: true } },
    rec: { fd: { draft: kase.reply, did: kase.did } },
  });
  if (!kase.fault) msgs.push({ who: TEX, tex: true, text: kase.reply });
  return conversation({
    id: makeId(`review-${slug(kase.gate)}`, kase.id),
    title: humanize(kase.id),
    kind: "one",
    members: ["Jo"],
    msgs,
    from: `review/${kase.gate}/${kase.id}`,
  });
}

function fromJobCheck(kase) {
  if (!kase.job?.asked?.length) throw new Error(`${kase.id}: no asked lines`);
  const msgs = kase.job.asked.map((text) => ({ who: "Maya", text }));
  msgs.at(-1).labels = { jobcheck: { verdict: kase.want, star: true } };
  msgs.at(-1).rec = {
    job: { title: kase.job.title, brief: kase.job.brief, doneWhen: kase.job.doneWhen, did: kase.did },
  };
  return conversation({
    id: makeId("jobcheck", kase.id),
    title: kase.job.title,
    kind: "one",
    members: ["Maya"],
    msgs,
    from: `advisor/job-check/${kase.id}`,
  });
}

/** A core.md or simple-asks.md question: `test`, `runAs` and the parsed question, from `parseTest`. */
function fromCore(kase) {
  const simple = kase.test !== "core";
  const text = kase.personStarts ?? kase.text;
  const fd = {};
  if (kase.must?.length) fd.must = [...kase.must];
  if (kase.mustNot?.length) fd.never = [...kase.mustNot];
  fd.star = true;
  return conversation({
    id: makeId(simple ? `simple-${String(kase.n).padStart(2, "0")}` : `core-${String(kase.n).padStart(2, "0")}`, kase.text),
    title: kase.text,
    kind: "one",
    members: [kase.runAs],
    world: "maya",
    msgs: [{ who: kase.runAs, text, labels: { fd } }],
    from: simple ? `core/simple-${kase.n}` : `core/${kase.n}`,
  });
}

/**
 * One conversation from one source case. `area` is respond | review | jobcheck | core. Pure: no file IO. `kase` for
 * review carries its file's `gate`; for core it carries `test`, `runAs` and the parsed question. Fields the
 * conversation does not use (such as `cause`) are ignored. `set` is "training" until migrateAll assigns it.
 */
export function caseToConversation(area, kase) {
  switch (area) {
    case "respond": return fromChat(kase);
    case "review": return fromReview(kase);
    case "jobcheck": return fromJobCheck(kase);
    case "core": return fromCore(kase);
    default: throw new Error(`unknown area ${area}`);
  }
}

/**
 * Assigns each conversation to dev or training, walking them in id order: a conversation goes to dev while dev holds
 * less than a quarter of the unit tests so far, else to training. Deterministic, so the split is the same every run.
 */
export function assignSets(convs) {
  let dev = 0;
  let total = 0;
  return convs.map((c) => {
    const stars = unitTests(c).length;
    const set = dev < DEV_SHARE_CAP * total ? "dev" : "training";
    if (set === "dev") dev += stars;
    total += stars;
    return { ...c, set };
  });
}

/** Every source case as a conversation, each with its set, sorted by id. */
export async function migrateAll(repoRoot) {
  const bench = join(repoRoot, "apps/mcp/bench");
  const convs = [];

  const respond = JSON.parse(await readFile(join(bench, "respond/cases.json"), "utf8"));
  for (const kase of respond.cases) convs.push(caseToConversation("respond", kase));

  const reviewDir = join(bench, "review");
  for (const file of (await readdir(reviewDir)).filter((f) => f.endsWith(".json")).sort()) {
    const data = JSON.parse(await readFile(join(reviewDir, file), "utf8"));
    for (const kase of data.cases) convs.push(caseToConversation("review", { ...kase, gate: data.gate }));
  }

  const jobs = JSON.parse(await readFile(join(bench, "advisor/job-check.json"), "utf8"));
  for (const kase of jobs.cases) convs.push(caseToConversation("jobcheck", kase));

  for (const test of ["core", "simple-asks"]) {
    const parsed = parseTest(await readFile(join(bench, "ai/tests", `${test}.md`), "utf8"));
    const runAs = parsed.front.run_as;
    if (!runAs) throw new Error(`${test}.md has no run_as`);
    for (const q of parsed.questions) convs.push(caseToConversation("core", { ...q, test, runAs }));
  }

  const sorted = [...convs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set();
  for (const c of sorted) {
    if (ids.has(c.id)) throw new Error(`duplicate id ${c.id}`);
    ids.add(c.id);
  }
  return assignSets(sorted);
}

/** The file each conversation is stored in, with the exact text it is written as. */
export function setFiles(repoRoot, convs) {
  const out = new Map();
  for (const c of convs) {
    out.set(join(repoRoot, "apps/mcp/bench/sets", c.set, `${c.id}.json`), jsonFile(c));
  }
  return out;
}

/** Every problem across the conversations, as sentences; empty when all pass the contract. */
export function problems(convs, config) {
  const out = [];
  for (const c of convs) for (const p of check(c, config, { why: Object.keys(WHY) })) out.push(`${c.id}: ${p}`);
  return out;
}

async function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const write = argv.includes("--write");
  const verify = argv.includes("--check");
  if (write === verify) {
    process.stderr.write("usage: setsMigrate.mjs --write | --check\n");
    return 2;
  }
  const config = JSON.parse(await readFile(join(repoRoot, "packages/shared/src/texConfig.json"), "utf8"));
  const convs = await migrateAll(repoRoot);
  const bad = problems(convs, config);
  if (bad.length) {
    process.stderr.write(`${bad.join("\n")}\n`);
    return 1;
  }
  const files = setFiles(repoRoot, convs);
  if (write) {
    for (const [path, text] of files) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    process.stdout.write(`wrote ${files.size} conversations\n`);
    return 0;
  }
  const differ = [];
  for (const [path, text] of files) {
    const onDisk = await readFile(path, "utf8").catch(() => null);
    if (onDisk !== text) differ.push(path);
  }
  if (differ.length) {
    process.stderr.write(`out of date:\n${differ.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`${files.size} conversations up to date\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
