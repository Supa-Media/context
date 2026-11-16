#!/usr/bin/env node
/**
 * Today's Tex bench cases as conversations (the test-set format in `packages/shared/src/texSets.cjs`; plan:
 * `tex-sets/plan.md`). Respond, review, job-check and core questions become conversations; the judge's examples are
 * written by another branch and are not migrated here.
 *
 *   node apps/mcp/bench/setsMigrate.mjs --check   exits 1 when a migrated case is not inside the repo's conversations
 *
 * The repo keeps about ten long conversations rather than one short one per case (Dev2, 2026-11-16: "only like
 * around 10 conversations, but the conversations are much longer"): each case's messages sit as one unbroken run
 * inside one of them, named in its `from`, with invented history around it. `--check` holds every case to that.
 */
import { loadSets } from "./sets.mjs";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTest } from "./load.mjs";

const require = createRequire(import.meta.url);
const texSets = require("../../../packages/shared/src/texSets.cjs");
const textDecide = require("../../../packages/shared/src/textDecide.cjs");

const { check, unitTests } = texSets;
const { WHY } = textDecide;

const TEX = "Tex";

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
 * Every migrated case goes to Dev. These are the cases today's replays score, and Training is shown to the steps as
 * examples (texTraining.cjs), so a migrated case in Training would hand the steps the answers they are scored on
 * (Dev2's call, 2026-11-15). Training fills from rewritten real chats (tex_dev set_import) and the judge's examples.
 */
export function assignSets(convs) {
  return convs.map((c) => ({ ...c, set: "dev" }));
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

const bare = (labels) => Object.fromEntries(Object.entries(labels || {}).map(([node, { star: _s, ...rest }]) => [node, rest]));
/** What must survive a case's move into a long conversation: who is Tex, special kinds, and every label. */
/** JSON with object keys sorted, so a file the Lab rewrites (keys in its own order) keeps the same shape. */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const shapeOf = (m) => JSON.stringify(canon([Boolean(m.tex), m.kind ?? "", bare(m.labels), m.rec ?? null]));

/**
 * Every migrated case that is not one unbroken run of messages, with the same labels, inside the one repo
 * conversation whose `from` names it, as sentences. Speakers may be renamed; the shape of each message may not.
 */
export function placesOf(cases, repoConvs) {
  const out = [];
  for (const kase of cases) {
    const homes = repoConvs.filter((c) => [].concat(c.from ?? []).includes(kase.id));
    if (homes.length !== 1) {
      out.push(`${kase.id}: named by ${homes.length} conversations, not 1`);
      continue;
    }
    const want = kase.msgs.map(shapeOf);
    const have = homes[0].msgs.map(shapeOf);
    const found = have.some((_, i) => want.every((w, j) => have[i + j] === w));
    if (!found) out.push(`${kase.id}: its messages are not one unbroken run in ${homes[0].id}`);
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
  if (!argv.includes("--check")) {
    process.stderr.write("usage: setsMigrate.mjs --check\n");
    return 2;
  }
  const config = JSON.parse(await readFile(join(repoRoot, "packages/shared/src/texConfig.json"), "utf8"));
  const convs = await migrateAll(repoRoot);
  const bad = [...problems(convs, config), ...placesOf(convs, await loadSets())];
  if (bad.length) {
    process.stderr.write(`${bad.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`${convs.length} cases are inside the repo's conversations\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
