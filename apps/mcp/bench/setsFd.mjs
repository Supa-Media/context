/**
 * THE FRONT DOOR ALONE ON ITS UNIT TESTS (Dev2, 2026-11-16: the Dev set's twenty Front door tests all came back
 * "can't run alone"; "YES" to making them run). A Front door test is one person's text in a test conversation with
 * its must and never lines. It runs as a whole turn, because the Front door's answer is the turn's: the bench's
 * invented world for that person (`world.mjs`: their notes, a scripted web, no real mail or texts), the chat before
 * the text posted to its ledger first (`- earlier person:` / `- earlier tex:`, as a Lab replay does), then the one
 * text, answered by the tree's own code and config, and the judge grades the answer on its must and never lines
 * (`coreArea.mjs` `runTests`: `pnpm ai run`, then `pnpm ai judge`).
 *
 * The setup. A Lab run writes the draft's graph into the tree's `texConfig.json`, and Tex's models, efforts and
 * prompt words come only from that config (`production.js`, since PRs #3268 and #3272), so the run answers as the
 * draft. The live setup note in Context adds the search, web and step settings and the task skills; a tree the replay
 * gate pulled it into uses it, and any other gets `LIVE_SETTINGS` below, the same settings without the task skills,
 * whose words live only in Context. A test that needs a task skill says so in its own words, never silently.
 *
 * What runs: a text or a reply from one of the bench's people (Dev2, 2026-11-17: "why dont we use existing people that
 * we do have worlds for then, and then why dont we restrict the people that can be put in these test sets"; the
 * contract refuses anyone else in a Dev chat, `texSets.cjs` BENCH_PEOPLE), as them: their own test's front matter when
 * one runs as them, else the core set's. A group chat runs in the shared workspace `people.md` puts all its members in
 * (the one named like the conversation first), each earlier line sent as the member who said it. Each test runs on its
 * own day: the conversation's `at` lines walked from the first one that names a date ("Tue Oct 13 10:14"). A check-in
 * row runs as a check-in that finds its email in the person's Gmail, and a routine row as a run of a routine with its
 * words (`- check-in mail:`, `- routine runs:`; Dev set, 2026-11-17: seven Front door rows were check-ins and routines);
 * a group's, a picture or an edit says why it can't yet, on its row.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parsePeople } from "./load.mjs";

/** The live setup note's settings, without its task skills (Context `@context-lc ai/production/texting-assistant.md`). */
export const LIVE_SETTINGS = ["job: texting-assistant", "max_steps: 24", "open_web: yes", "search:", "  everywhere: true"].join("\n");

/** The most chat lines posted before a test's text: Tex's history reads at most about this much anyway. */
export const MAX_EARLIER = 200;

const FRONT = /^---\n([\s\S]*?)\n---/;

/** A member's bench handle, as `people.md` names them in a group (`groupChat.mjs`). */
export const handleOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9-]/g, "");

/**
 * A test conversation's lines before message `i`, as the chat's ledger takes them: texts and replies, the person's and
 * Tex's. In a group each person's line names who said it (`who`, their handle). A check-in or routine row is not a
 * text anyone sent, so it is left out; Tex's answer to it stays.
 */
export function earlierLines(c, i) {
  const lines = [];
  for (const m of c.msgs.slice(0, i)) {
    if (m.kind && m.kind !== "reply") continue; // a tapback, an edit or an unsend is not a line of the chat's text
    if (m.via) continue; // a check-in or a routine fired a turn; nobody texted it
    if (typeof m.text !== "string" || m.text.trim() === "") continue;
    if (m.tex) lines.push({ from: "tex", text: m.text });
    else lines.push(c.kind === "group" ? { from: "person", who: handleOf(m.who), text: m.text } : { from: "person", text: m.text });
  }
  return lines.slice(-MAX_EARLIER);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * The day message `i` of `c` was sent, YYYY-MM-DD, or null. `at` lines are times ("Tue 15:05"); the first that names a
 * date ("Tue Oct 13 10:14") anchors them, in `year`, and each later weekday is the next one on or after the day before.
 */
export function dayOf(c, i, year) {
  let day = null;
  for (const m of c.msgs.slice(0, i + 1)) {
    const at = typeof m.at === "string" ? m.at.trim() : "";
    const dated = /^(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) (\d{1,2})\b/.exec(at);
    if (dated && MONTHS.includes(dated[1])) {
      day = new Date(Date.UTC(year, MONTHS.indexOf(dated[1]), Number(dated[2])));
      continue;
    }
    const weekday = /^([A-Z][a-z]{2})\b/.exec(at)?.[1];
    if (day && weekday && DAYS.includes(weekday)) {
      const ahead = (DAYS.indexOf(weekday) - day.getUTCDay() + 7) % 7;
      day = new Date(day.getTime() + ahead * 86_400_000);
    }
  }
  return day ? iso(day) : null;
}

/**
 * The shared workspace a group conversation runs in: one `people.md` puts every member in with nobody's personal
 * workspace, the one named like the conversation first. Null when there is none.
 */
export function groupFor(people, c) {
  const want = c.members.map(handleOf);
  const byWs = new Map();
  for (const row of people) {
    if (row.personal) continue;
    if (!byWs.has(row.workspace)) byWs.set(row.workspace, new Set());
    byWs.get(row.workspace).add(handleOf(row.person));
  }
  const fits = [...byWs].filter(([, who]) => want.every((h) => who.has(h))).map(([ws]) => ws);
  return fits.includes(c.id) ? c.id : (fits.sort()[0] ?? null);
}

/** Why message `i` of `c` can't run as a Front door test yet, or null when it can. */
export function cantRun(c, i) {
  const m = c.msgs[i];
  if (m.via && c.kind === "group") return `a group's ${m.who} row can't run as a Front door test yet: the bench runs a person's own check-ins and routines`;
  if (m.via === "checkin" && checkinMail(m.text) === null) return "a check-in row runs only when it found an email (\"Gmail: ...\")";
  if (m.via && m.via !== "checkin" && m.via !== "routine") return `a ${m.via} row can't run as a Front door test`;
  if (m.kind && m.kind !== "reply") return `a ${m.kind} can't run as a Front door test: only a text or a reply`;
  if (Array.isArray(m.pics) && m.pics.length > 0) return "a text with pictures can't run as a Front door test yet";
  if (typeof m.text !== "string" || m.text.trim() === "") return "the text is empty";
  if (!Array.isArray(c.members) || typeof c.members[0] !== "string") return "the conversation names no person";
  return null;
}

/**
 * A failed Front door test as its run row says it, short (the Lab keeps 200 characters): the first line that failed
 * and what Tex said. The judge's whole reasons and Tex's whole texts stay in the row's `misses` and `said`.
 */
export function missedLine(r) {
  const miss = (r.misses ?? [])[0];
  const said = (r.said ?? []).join(" / ").replace(/\s+/g, " ");
  const line = miss ? `${miss.kind === "must not" ? "never" : "must"}: ${miss.line}` : "a must or never line failed";
  return `${line.slice(0, 90)} | Tex: ${said.slice(0, 100) || "(said nothing)"}`;
}

/**
 * The email a check-in row found, as the bench's Gmail holds it: "Gmail: <from>: <what it says>" (the sender is the
 * words before the first colon when they are short enough to be one). Null when the row is not mail.
 */
export function checkinMail(text) {
  const m = /^\s*Gmail:\s*([\s\S]+)$/.exec(String(text ?? ""));
  if (!m) return null;
  const rest = m[1].trim();
  const colon = rest.indexOf(":");
  const from = colon > 0 && colon <= 60 ? rest.slice(0, colon).trim() : "(sender)";
  const said = colon > 0 && colon <= 60 ? rest.slice(colon + 1).trim() : rest;
  const subject = said.split(/(?<=[.!?])\s/)[0].slice(0, 120);
  return { from, subject, body: said };
}

/** Who sends message `i`: its speaker, the one person of a one-to-one chat. */
const senderOf = (c, i) => (c.kind === "group" ? c.msgs[i].who : c.members[0]);

/** One bench test of `units` (all one person's): the front matter given, then one case a unit, its chat before it. */
export function fdTest(units, front) {
  const out = [`---\n${front}\n---\n\n# Sets\n\nThe Front door's unit tests from the test conversations (\`setsFd.mjs\`).\n`];
  units.forEach((u, k) => {
    const m = u.convo.msgs[u.at];
    const l = u.label;
    const lines = [
      `## ${k + 1}. ${String(m.text).replace(/\s+/g, " ").slice(0, 120)}`,
      "",
      "- kind: task",
      m.via === "checkin" ? `- check-in mail: ${JSON.stringify(checkinMail(m.text))}` : m.via === "routine" ? `- routine runs: ${JSON.stringify(m.text)}` : `- person texts: ${JSON.stringify(m.text)}`,
      ...earlierLines(u.convo, u.at).map((line) => `- earlier ${line.who ? `@${line.who}` : line.from}: ${JSON.stringify(line.text)}`),
      ...(l.must || []).map((x) => `- must: ${x}`),
      ...(l.never || []).map((x) => `- must not: ${x}`),
    ];
    out.push(lines.join("\n") + "\n");
  });
  return out.join("\n");
}

/**
 * The front matter a person's tests run with: the bench test that runs as them (`run_as:`), the core set first, with its
 * day, judge and voice lines; failing that, the core set's own with `run_as:` them. One run each, on the scripted web,
 * on `today` and in the `group` when given. Null when nobody in `people.md` is called that.
 */
export async function frontFor(dir, person, { today = null, group = null } = {}) {
  const people = parsePeople(await readFile(join(dir, "workspaces", "people.md"), "utf8"));
  if (!people.some((row) => row.person === person && row.personal)) return null;
  const names = (await readdir(join(dir, "tests"))).filter((n) => n.endsWith(".md")).sort((a, b) => (a === "core.md" ? -1 : b === "core.md" ? 1 : a.localeCompare(b)));
  const runsAs = new RegExp(`^run_as: ${person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  let found = null;
  for (const name of names) {
    const front = FRONT.exec(await readFile(join(dir, "tests", name), "utf8"))?.[1];
    if (front && runsAs.test(front) && /^today: /m.test(front)) {
      found = front;
      break;
    }
  }
  if (found === null) {
    const core = FRONT.exec(await readFile(join(dir, "tests", "core.md"), "utf8"))?.[1];
    if (!core) return null;
    found = core.replace(/^run_as: .*$/m, `run_as: ${person}`);
  }
  let f = found.replace(/^runs: .*$/m, "runs: 1").replace(/^web: .*$/m, "web: scripted").replace(/^group: .*\n?/m, "");
  if (!/^runs: /m.test(f)) f += "\nruns: 1";
  if (!/^web: /m.test(f)) f += "\nweb: scripted";
  if (today) f = f.replace(/^today: .*$/m, `today: ${today}`);
  if (group) f = f.replace(/^(run_as: .*)$/m, `$1\ngroup: ${group}`);
  return f;
}

/**
 * The Front door's batch: every unit through the tree's own bench, grouped by person, each group one test. `runTests`
 * is `coreArea.mjs`'s from the tree, swapped by a test. Answers one row a unit.
 */
export async function runFd(units, { tree, fake = false, runTests = null }) {
  const rows = [];
  const can = [];
  for (const u of units) {
    const why = cantRun(u.convo, u.at);
    if (why) rows.push({ ...u.row, right: false, ran: false, usd: 0, why });
    else can.push(u);
  }
  if (can.length === 0) return rows;
  const run = runTests ?? (await import(pathToFileURL(join(tree, "apps/mcp/bench/coreArea.mjs")).href)).runTests;
  const scratch = await mkdtemp(join(tmpdir(), "tex-sets-fd-"));
  try {
    const dir = join(scratch, "ai");
    await cp(join(tree, "apps/mcp/bench/ai"), dir, { recursive: true });
    const setup = join(dir, "setups", "texting-assistant");
    const pulled = await readFile(join(setup, "production.md"), "utf8").then(() => true, () => false);
    if (!pulled) {
      await rm(setup, { recursive: true, force: true });
      await mkdir(setup, { recursive: true });
      await writeFile(join(setup, "production.md"), `---\n${LIVE_SETTINGS}\n---\n\nTex's rules are its prompt modules, read from Tex's config.\n`);
    }
    const people = parsePeople(await readFile(join(dir, "workspaces", "people.md"), "utf8"));
    const year = Number(/^today: (\d{4})/m.exec(FRONT.exec(await readFile(join(dir, "tests", "core.md"), "utf8"))?.[1] ?? "")?.[1] ?? new Date().getUTCFullYear());
    const batches = new Map();
    for (const u of can) {
      const person = senderOf(u.convo, u.at);
      const group = u.convo.kind === "group" ? groupFor(people, u.convo) : null;
      if (u.convo.kind === "group" && group === null) {
        rows.push({ ...u.row, right: false, ran: false, usd: 0, why: `no shared workspace in apps/mcp/bench/ai/workspaces/people.md has all of ${u.convo.members.join(", ")}` });
        continue;
      }
      const today = dayOf(u.convo, u.at, year);
      const key = JSON.stringify([person, today, group]);
      if (!batches.has(key)) batches.set(key, { person, today, group, units: [] });
      batches.get(key).units.push(u);
    }
    const tests = [];
    for (const { person, today, group, units } of batches.values()) {
      const front = await frontFor(dir, person, { today, group });
      if (front === null) {
        rows.push(...units.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `${person} has no bench world: a Dev chat's people are the bench's (apps/mcp/bench/ai/workspaces/people.md)` })));
        continue;
      }
      const name = `sets-${tests.length + 1}`;
      await writeFile(join(dir, "tests", `${name}.md`), fdTest(units, front));
      tests.push({ name, group: units });
    }
    if (tests.length === 0) return rows;
    const got = await run(tree, tests.map((t) => t.name), { dir, scratch, tag: "sets", fake });
    const each = got.usd / tests.reduce((n, t) => n + t.group.length, 0);
    for (const t of tests) {
      t.group.forEach((u, k) => {
        const r = got.rows.find((x) => x.id === `${t.name}/q${k + 1}`);
        const usd = Math.round(each * 10_000) / 10_000;
        if (!r) rows.push({ ...u.row, right: false, ran: false, usd, why: "the bench gave no judged answer" });
        else rows.push({ ...u.row, right: Boolean(r.right), ran: true, usd, got: r.right ? "every line held" : missedLine(r), want: "every must and never line", ...(r.right ? {} : { misses: r.misses ?? [], said: r.said ?? [] }) });
      });
    }
    return rows;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
