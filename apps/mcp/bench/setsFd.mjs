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
    // A tapback, an edit or an unsend is not a line of the chat's text; Tex's own tapbacks are only a step in
    // production's ledger, which no history draws (`stepEvents.ts` `tapback`).
    if (m.kind && m.kind !== "reply") continue;
    // A check-in, a routine or a job's report fired a turn nobody texted: kept as production keeps it (`byCode.mjs`).
    if (m.via) {
      const trigger = triggerOf(c, c.msgs.indexOf(m));
      if (trigger !== null) lines.push(trigger);
      continue;
    }
    const pictures = m.tex ? [] : picturesOf(m);
    if ((typeof m.text !== "string" || m.text.trim() === "") && pictures.length === 0) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (m.tex) lines.push({ from: "tex", text });
    else lines.push({ from: "person", ...(c.kind === "group" ? { who: handleOf(m.who) } : {}), text, ...(pictures.length > 0 ? { pictures } : {}) });
  }
  return lines.slice(-MAX_EARLIER);
}

/** Where a Dev message's picture is kept in this repository: `pics` urls under `apps/mcp/bench/ai/pictures/`. */
const REPO_PICTURE = /\/apps\/mcp\/bench\/ai\/pictures\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g))$/i;

/** The bench picture names of a message's `pics`, each one kept in this repository; one kept elsewhere is left out. */
export const picturesOf = (m) => (Array.isArray(m.pics) ? m.pics : []).map((p) => REPO_PICTURE.exec(String(p?.url ?? ""))?.[1]).filter(Boolean);

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

/** The time of day message `i` of `c` was sent, "HH:MM" from the latest `at` at or before it ("Fri Oct 23 8:02"), or null. */
export function timeOf(c, i) {
  let time = null;
  for (const m of c.msgs.slice(0, i + 1)) {
    const hm = /\b(\d{1,2}):(\d{2})\s*$/.exec(typeof m.at === "string" ? m.at.trim() : "");
    if (hm && Number(hm[1]) < 24) time = `${hm[1].padStart(2, "0")}:${hm[2]}`;
  }
  return time;
}

/**
 * The zone a person's chat times are read in, fixed for the conversation: their own workspace's `timezone:` (their
 * calendar's, as Google sends it), else the gateway's default. Production's Worker sends the person's zone the same way.
 */
export async function zoneOf(dir, workspace) {
  const root = join(dir, "workspaces", workspace);
  const files = await readdir(root, { recursive: true }).catch(() => []);
  for (const name of files.filter((n) => n.endsWith(".md")).sort()) {
    const zone = /^timezone:\s*"?([A-Za-z_]+\/[A-Za-z_\/]+)"?\s*$/m.exec(await readFile(join(root, name), "utf8").catch(() => ""))?.[1];
    if (zone) return zone;
  }
  return DEFAULT_ZONE;
}
const DEFAULT_ZONE = "America/New_York";

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

/**
 * A trigger row of `c` (message `i`) as a case's earlier line (`load.mjs`): a check-in with the email it found, a
 * routine with its words, a job's report with its words; null for one the bench keeps nothing of (a notify).
 */
export function triggerOf(c, i) {
  const m = c.msgs[i];
  if (m.via === "checkin") return { from: "trigger", via: "checkin", mail: checkinMail(m.text) };
  if (m.via === "routine") return { from: "trigger", via: "routine", text: String(m.text ?? "") };
  if (m.via === "job") return { from: "trigger", via: "job", report: jobReportRow(c, i) };
  return null;
}

/**
 * A job row's report (`texSets.cjs` via "job"): its words, its state (done unless the row says), and the asker's text it
 * answers, the last person text before it. The title is invented, the same way for every job row: production's is the
 * one the Front door gave when it started the job, which a Dev chat doesn't keep, so it is the first sentence of the
 * asker's text, at most 120 characters, never the row's own words.
 */
export function jobReportRow(c, i) {
  const m = c.msgs[i];
  const asked = [...c.msgs.slice(0, i)].reverse().find((x) => !x.tex && !x.via && !x.kind && typeof x.text === "string" && x.text.trim() !== "");
  const words = String(asked?.text ?? "").replace(/\s+/g, " ").trim();
  const title = (words.split(/(?<=[.!?])\s/)[0] || "the job you started").slice(0, 120);
  return { title, state: m.state ?? "done", text: String(m.text ?? ""), asked: words, askedBy: asked?.who ?? null };
}

/** Why message `i` of `c` can't run as a Front door test yet, or null when it can. */
export function cantRun(c, i) {
  const m = c.msgs[i];
  if (m.via === "checkin" && checkinMail(m.text) === null) return "a check-in row runs only when it found an email (\"Gmail: ...\")";
  if (m.via && m.via !== "checkin" && m.via !== "routine" && m.via !== "job") return `a ${m.via} row can't run as a Front door test`;
  if (m.kind && m.kind !== "reply") return `a ${m.kind} can't run as a Front door test: only a text or a reply`;
  if (Array.isArray(m.pics) && picturesOf(m).length < m.pics.length) return "a picture of this text isn't kept in the repository (apps/mcp/bench/ai/pictures/)";
  if ((typeof m.text !== "string" || m.text.trim() === "") && picturesOf(m).length === 0) return "the text is empty";
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

/** Whether a conversation's setting says Tex has the calendar ("Tex has Gmail, Calendar, ...", "the shared calendar"). */
export const hasCalendar = (c) => /\bcalendar\b/i.test(String(c?.setting ?? ""));

/**
 * Who message `i` of `c` runs as: the one person of a one-to-one chat; in a group its speaker, and for a trigger the
 * person the Worker queues it as: a job's asker, a routine's or check-in's writer (`groupRoutines.ts` `run.phone`), the
 * shared workspace's owner in `people.md` (the bench's choice: a Dev chat doesn't say who wrote its routines).
 */
export function senderOf(c, i, people = [], group = null) {
  if (c.kind !== "group") return c.members[0];
  const m = c.msgs[i];
  if (m.via === "job") return jobReportRow(c, i).askedBy ?? c.members[0];
  if (m.via) return people.find((row) => row.workspace === group && row.role === "owner")?.person ?? c.members[0];
  return m.who;
}

/** One bench test of `units` (all one person's): the front matter given, then one case a unit, its chat before it. */
export function fdTest(units, front) {
  const out = [`---\n${front}\n---\n\n# Sets\n\nThe Front door's unit tests from the test conversations (\`setsFd.mjs\`).\n`];
  units.forEach((u, k) => {
    const m = u.convo.msgs[u.at];
    const l = u.label;
    const { earlier, unanswered } = sinceTexAnswered(earlierLines(u.convo, u.at), picturesOf(m), u.convo.kind === "group");
    const lines = [
      `## ${k + 1}. ${String(m.text).replace(/\s+/g, " ").slice(0, 120)}`,
      "",
      "- kind: task",
      m.via === "checkin" ? `- check-in mail: ${JSON.stringify(checkinMail(m.text))}` : m.via === "routine" ? `- routine runs: ${JSON.stringify(m.text)}` : m.via === "job" ? `- job reports: ${JSON.stringify(jobReportRow(u.convo, u.at))}` : `- person texts: ${JSON.stringify(m.text ?? "")}`,
      ...unanswered.map((name) => `- person sends picture: ${name}`),
      ...earlier.flatMap((line) => {
        if (line.from === "trigger") return [triggerLine(line)];
        const who = line.who ? `@${line.who}` : line.from;
        return [`- earlier ${who}: ${JSON.stringify(line.text)}`, ...(line.pictures ?? []).map((name) => `- earlier ${who} sends picture: ${name}`)];
      }),
      ...(l.must || []).map((x) => `- must: ${x}`),
      ...(l.never || []).map((x) => `- must not: ${x}`),
    ];
    out.push(lines.join("\n") + "\n");
  });
  return out.join("\n");
}

/**
 * The pictures a turn reads, as production's: its own and those sent since Tex last answered, oldest first. A group
 * turn reads the newest four of the chat's, any member's (`groupInbox.ts` `filesFor`); a one-to-one turn merges the
 * burst and reads the first eight (`inboxTurn.ts` `merged`). Tex answered when it texted, or when a routine ran, which
 * clears the chat's lines even when it stays quiet (`groupModelTurn.ts`); a tapback is not a line here. The earlier
 * lines keep their words without the picture, so none is sent twice.
 */
export function sinceTexAnswered(lines, own = [], group = false) {
  const from = lines.findLastIndex((line) => line.from === "tex" || (line.from === "trigger" && line.via === "routine")) + 1;
  const all = [...lines.slice(from).flatMap((line) => line.pictures ?? []), ...own];
  const unanswered = group ? all.slice(-4) : all.slice(0, 8);
  const earlier = lines.map((line, k) => (k >= from && line.pictures ? (({ pictures, ...rest }) => rest)(line) : line));
  return { earlier, unanswered };
}

/** An earlier trigger as its case line (`load.mjs`). */
function triggerLine(line) {
  if (line.via === "checkin") return line.mail ? `- earlier check-in mail: ${JSON.stringify(line.mail)}` : "- earlier check-in";
  if (line.via === "routine") return `- earlier routine: ${JSON.stringify(line.text)}`;
  return `- earlier job reports: ${JSON.stringify(line.report)}`;
}

/**
 * The front matter a person's tests run with: the bench test that runs as them (`run_as:`), the core set first, with its
 * day, judge and voice lines; failing that, the core set's own with `run_as:` them. One run each, on the scripted web,
 * on `today` and in the `group` when given. Null when nobody in `people.md` is called that.
 */
export async function frontFor(dir, person, { today = null, group = null, calendar = false, setting = null, clock = null } = {}) {
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
  // Production offers every text background jobs (the texting Worker always sends what the chat has running), so a
  // Dev test does too: without it a test that wants a job started could never pass (Dev set, 2026-11-17).
  if (!/^background: on$/m.test(f)) f = f.replace(/^background: .*\n?/m, "") + "\nbackground: on";
  if (calendar && !/^calendar: /m.test(f)) f += "\ncalendar: connected";
  // The outside world the chat takes for granted, played by a model where the fixtures have nothing (`simWorld.mjs`,
  // Dev2 2026-11-17): it sees the chat's setting, never its labels.
  if (setting !== null) f = f.replace(/^world(?:_setting)?: .*\n?/gm, "") + `\nworld: simulated\nworld_setting: ${JSON.stringify(String(setting).replace(/\s+/g, " ").trim())}`;
  if (today) f = f.replace(/^today: .*$/m, `today: ${today}`);
  // The row's own time of day in the person's zone (`clock.mjs`), and that zone on every text as the Worker sends it.
  const zone = await zoneOf(dir, people.find((row) => row.person === person && row.personal).workspace);
  f = f.replace(/^(?:clock|time_zone): .*\n?/gm, "") + `\ntime_zone: ${zone}`;
  if (clock) f += `\nclock: ${clock}`;
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
      const group = u.convo.kind === "group" ? groupFor(people, u.convo) : null;
      const person = senderOf(u.convo, u.at, people, group);
      if (u.convo.kind === "group" && group === null) {
        rows.push({ ...u.row, right: false, ran: false, usd: 0, why: `no shared workspace in apps/mcp/bench/ai/workspaces/people.md has all of ${u.convo.members.join(", ")}` });
        continue;
      }
      const today = dayOf(u.convo, u.at, year);
      // A conversation whose setting gives Tex the calendar runs with one connected (`calendar.mjs` benchCalendar).
      const calendar = hasCalendar(u.convo);
      const setting = String(u.convo.setting ?? "");
      const clock = timeOf(u.convo, u.at);
      const key = JSON.stringify([person, today, group, calendar, setting, clock]);
      if (!batches.has(key)) batches.set(key, { person, today, group, calendar, setting, clock, units: [] });
      batches.get(key).units.push(u);
    }
    const tests = [];
    for (const { person, today, group, calendar, setting, clock, units } of batches.values()) {
      const front = await frontFor(dir, person, { today, group, calendar, setting, clock });
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
