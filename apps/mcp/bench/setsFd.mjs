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
 * contract refuses anyone else in a Dev or Training chat, `texSets.cjs` BENCH_PEOPLE), as them: their own test's front matter when
 * one runs as them, else the core set's. A group chat runs in the shared workspace `people.md` puts all its members in
 * (the one named like the conversation first), each earlier line sent as the member who said it. Each test runs on its
 * own day: the conversation's `at` lines walked from the first one that names a date ("Tue Oct 13 10:14"). A check-in
 * row runs as a check-in that finds its email in the person's Gmail, and a routine row as a run of a routine with its
 * words (`- check-in mail:`, `- routine runs:`; Dev set, 2026-11-17: seven Front door rows were check-ins and routines);
 * a group's, a picture or an edit says why it can't yet, on its row.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REAL_CLEF_ENV } from "./worldAi.mjs";

import { createRequire } from "node:module";

import { tapbackSaidLine } from "../../../packages/tex/gateway/agent/tapbackEnding.js";
import { saveRunFixtures, worldFront } from "./simFixtures.mjs";
import { armDone, compareOf, compareWorld } from "./worldCompare.mjs";
import { collectConvo } from "./setsFdRows.mjs";

// Moved to `setsFdRows.mjs` (2026-11-19) to keep this file under the size bar; still imported from here.
export { benchFailed, missedLine } from "./setsFdRows.mjs";
import { parsePeople } from "./load.mjs";
import { seedWorld, worldDirOf } from "./setsWorld.mjs";
import { runPool, scheduleOrder, untilOutOfCredit } from "./setsPool.mjs";

const { OTHER_ASSISTANTS } = createRequire(import.meta.url)("../../../packages/tex/src/texSets.cjs");

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
export function earlierLines(c, i, year = null, from = null) {
  const lines = [];
  const dated = (line, j) => {
    const ago = year === null ? null : minutesBefore(c, j, i, year, from);
    return ago === null ? line : { ...line, minutesBefore: ago };
  };
  for (const [j, m] of c.msgs.slice(0, i).entries()) {
    // A tapback, an edit or an unsend is not a line of the chat's text, with one exception: Tex's tapback that was its
    // whole answer (no text of Tex's after it before the next message of theirs), kept as production keeps it so the
    // next turn knows it acted (dropped, a later "put it back" read as nothing having moved; Dev set, 2026-11-17). In a
    // one-to-one chat the Worker posts it as Tex's `reaction` event ("(a tapback) ⏰", `inbox.ts`); in a group the
    // Front door's tapback is kept as said, "(You texted them nothing and reacted 🗓️ to their text.)"
    // (`sendTheReply.js` tapbackSaidLine), while Decide's own react on a text it stayed quiet on is only a step
    // (`groupInbox.ts`) and stays out. A tapback beside Tex's words was only an acknowledgement and stays out too.
    if (m.kind === "react" && m.tex && endsTexTurn(c, j)) {
      if (c.kind !== "group") lines.push(dated({ from: "tex", text: String(m.text ?? ""), tapback: true }, j));
      else if (!decideStayedQuiet(c, m.to)) lines.push(dated({ from: "tex", text: tapbackSaidLine(m.text) }, j));
      continue;
    }
    // A person's tapback is a line of the chat: production logs every tapback as its line (`reactionLine`, Dev2
    // 2026-11-01), and since #3712 it names the message it was on, so a vote by tapback reads as a vote. The bench
    // dropped them, and Training build-crew 81 "Tex who won" could not count them.
    if (m.kind === "react" && !m.tex) {
      if (String(m.text ?? "").trim() !== "") lines.push(dated({ from: "person", ...(c.kind === "group" ? { who: handleOf(m.who) } : {}), text: personTapbackLine(c, m) }, j));
      continue;
    }
    if (m.kind && m.kind !== "reply") continue;
    // A check-in, a routine or a job's report fired a turn nobody texted: kept as production keeps it (`byCode.mjs`).
    if (m.via) {
      const trigger = triggerOf(c, j);
      if (trigger !== null) lines.push(dated(trigger, j));
      continue;
    }
    const pictures = m.tex ? [] : picturesOf(m);
    if ((typeof m.text !== "string" || m.text.trim() === "") && pictures.length === 0) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (m.tex) lines.push(dated({ from: "tex", text }, j));
    else lines.push(dated({ from: "person", ...(c.kind === "group" ? { who: handleOf(m.who) } : {}), text, ...(pictures.length > 0 ? { pictures } : {}) }, j));
  }
  // A line before the chat's first date is as old as the dated line after it, so the order holds.
  const kept = lines.slice(-MAX_EARLIER);
  let later;
  for (let k = kept.length - 1; k >= 0; k -= 1) {
    if (kept[k].minutesBefore === undefined && later !== undefined) kept[k] = { ...kept[k], minutesBefore: later };
    later = kept[k].minutesBefore ?? later;
  }
  return kept;
}

/** Messages' six tapbacks by their emoji, as the Lab sends them (`packages/lab/gateway/labSandbox/inbound.js` `TAPBACK_OF`, copied so this bench needs no gateway code). */
const TAPBACK_OF = Object.freeze({ "❤️": "Loved", "👍": "Liked", "👎": "Disliked", "😂": "Laughed at", "‼️": "Emphasized", "❓": "Questioned" });

/**
 * A person's tapback as the chat's line, what production logs for it (`packages/tex/worker/reactions.ts` `reactionLine`): the
 * emoji, its yes or no for like, love, emphasis and dislike, and the message it was on, Tex's or somebody else's, named
 * by its words (120 characters at most). Any other emoji is just itself.
 */
export function personTapbackLine(c, m) {
  const given = String(m.text ?? "").trim();
  // A tapback written without its variation selector ("❤" for "❤️") is still that tapback, shown as the Worker shows it.
  const named = Object.keys(TAPBACK_OF).find((e) => e.replace(/\uFE0F/g, "") === given.replace(/\uFE0F/g, ""));
  const emoji = named ?? given;
  const how = named === undefined ? undefined : TAPBACK_OF[named];
  const answer = how === "Disliked" ? " (no)" : how === "Liked" || how === "Loved" || how === "Emphasized" ? " (yes)" : "";
  const target = c.msgs.find((x) => x.id === m.to);
  const onTex = target?.tex === true;
  const own = String(target?.text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...own];
  const words = chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : own;
  const quote = words === "" ? "" : ` "${words}"`;
  if (onTex) return `${emoji}${answer} on Tex's message${quote}`;
  return words === "" ? `${emoji}${answer} on a message` : `${emoji}${answer} on the message${quote}`;
}

/** Whether the group text `id` is one Decide stayed quiet on (its react then is Decide's, never the Front door's). */
const decideStayedQuiet = (c, id) => c.msgs.find((m) => m.id === id)?.labels?.decide?.act === "quiet";

/**
 * The tapbacks that start a job, bare (no variation selector). Production has no emoji-to-job table: a job's start with
 * no `say` gets the Worker's own pick from the ask's words (`sendTheReply.js` `react: ""`, `packages/tex/worker/ackEmoji.ts`),
 * and its find and search rule picks 🔎 or 🕵️. The Front door's own tapback can't be 🔎 (not one of the 64,
 * `textDecide.cjs` REACT_EMOJI), so a 🔎 that was Tex's whole answer came from that start.
 */
const JOB_TAPBACKS = new Set(["🔎", "🕵"]);
const bareEmoji = (text) => String(text ?? "").replace(/️/g, "").trim();

/** A job's title from the words it was started with: their first sentence, at most 120 characters (`jobReportRow`). */
export const titleOf = (words) => (words.split(/(?<=[.!?])\s/)[0] || "the job you started").slice(0, 120);

/**
 * The job a Tex tapback of 🔎 started that is still running at message `i` of `c`, or null. Scanning back from `i`: a
 * job report in the chat means it finished (its report is an earlier line), and Tex's words after the tapback mean it
 * was answered in words, so neither leaves a job running. A tapback that was Tex's whole answer and nothing else of
 * Tex's came after it, with no report, is still going when the row comes. Its title is its ask's first sentence, the
 * way a job's title is (`jobReportRow`); `minutesBefore` says when it started, when the chat's dates place it.
 */
export function runningJobOf(c, i, year = null, from = null) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const m = c.msgs[k];
    if (m.via === "job") return null;
    if (m.tex && m.kind !== "react" && typeof m.text === "string" && m.text.trim() !== "") return null;
    if (!(m.tex && m.kind === "react" && JOB_TAPBACKS.has(bareEmoji(m.text)))) continue;
    if (c.kind === "group" && decideStayedQuiet(c, m.to)) continue;
    const words = String(c.msgs.find((x) => x.id === m.to)?.text ?? "").replace(/\s+/g, " ").trim();
    if (words === "") return null;
    const minutes = year === null ? null : minutesBefore(c, k, i, year, from);
    return { title: titleOf(words), ...(minutes === null ? {} : { minutesBefore: minutes }) };
  }
  return null;
}

/** Whether Tex's tapback at `j` was its whole answer: no text of Tex's follows it before the next message of theirs. */
export function endsTexTurn(c, j) {
  for (const m of c.msgs.slice(j + 1)) {
    if (m.tex && !m.kind && typeof m.text === "string" && m.text.trim() !== "") return false;
    if (!m.tex) return true;
  }
  return true;
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
 * date ("Tue Oct 13 10:14") anchors them, in `year`: each later weekday is the next one on or after the day before, and
 * each earlier weekday the last one on or before the day after. A conversation that names no date at all starts on the
 * first day on or after `from` (the bench's own day) that is its first line's weekday, so every row still runs on its
 * own weekday. Left on the bench's day, a Thursday, a Monday routine ran on a Thursday and rightly stayed quiet, and
 * every "tomorrow" in the chat was the wrong day (Training, 2026-11-18: no Training chat names a date).
 */
export function dayOf(c, i, year, from = null) {
  const marks = [];
  for (const [k, m] of c.msgs.entries()) {
    const at = typeof m.at === "string" ? m.at.trim() : "";
    const dated = /^(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) (\d{1,2})\b/.exec(at);
    if (dated && MONTHS.includes(dated[1])) marks.push({ k, day: new Date(Date.UTC(year, MONTHS.indexOf(dated[1]), Number(dated[2]))) });
    else {
      const weekday = /^([A-Z][a-z]{2})\b/.exec(at)?.[1];
      if (weekday && DAYS.includes(weekday)) marks.push({ k, weekday: DAYS.indexOf(weekday) });
    }
  }
  let anchor = marks.findIndex((mark) => mark.day);
  if (anchor < 0) {
    if (marks.length === 0 || typeof from !== "string" || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return null;
    const start = new Date(`${from}T00:00:00Z`);
    marks[0].day = new Date(start.getTime() + ((marks[0].weekday - start.getUTCDay() + 7) % 7) * DAY_MS);
    anchor = 0;
  }
  for (let n = anchor + 1; n < marks.length; n += 1) {
    if (!marks[n].day) marks[n].day = new Date(marks[n - 1].day.getTime() + ((marks[n].weekday - marks[n - 1].day.getUTCDay() + 7) % 7) * DAY_MS);
  }
  for (let n = anchor - 1; n >= 0; n -= 1) {
    marks[n].day = new Date(marks[n + 1].day.getTime() - ((marks[n + 1].day.getUTCDay() - marks[n].weekday + 7) % 7) * DAY_MS);
  }
  // A row takes the day of the last timed line at or before it; one before the first timed line, that line's day.
  const mark = marks.findLast((x) => x.k <= i) ?? marks[0];
  return mark ? iso(mark.day) : null;
}
const DAY_MS = 86_400_000;

/**
 * How many minutes before message `i` of `c` message `j` was sent, from their own days and times (weekdays walked in
 * `year`, the test's), or null when either
 * is undated. Production's ledger keeps each text's own time, so ten days of chat read as ten days, not as one burst
 * a minute ago (Dev set, 2026-11-17: Tex read a payment set up days before as "set up at 12:04" today).
 */
export function minutesBefore(c, j, i, year, from = null) {
  const when = (k) => {
    const day = dayOf(c, k, year, from);
    const time = timeOf(c, k);
    return day === null || time === null ? null : Date.parse(`${day}T${time}:00Z`);
  };
  const [then, now] = [when(j), when(i)];
  if (then === null || now === null || then > now) return null;
  // The real age, however old: a line past the Front door's word-for-word window is summed up as a day (`benchDays.mjs`).
  return Math.round((now - then) / 60_000);
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

/** A conversation's people: its members, less another AI assistant in the chat (`texSets.cjs` OTHER_ASSISTANTS). */
export const castOf = (c) => (Array.isArray(c?.members) ? c.members : []).filter((name) => !OTHER_ASSISTANTS.includes(name));

/**
 * Why a conversation's Front door tests could not run in the bench, as sentences; empty when they can: each of its
 * people has a bench world (a personal workspace in `people.md`) and a group has a shared workspace with them all.
 * The set tests hold every Training and Dev conversation to it, and a Lab run refuses one that fails it rather than
 * scoring its tests wrong (Lab run 2026-11-17: Training's Front door read 0/63, none of its people in the bench).
 */
export function castProblems(c, people, { ownWorkspace = false } = {}) {
  const cast = castOf(c);
  if (cast.length === 0) return ["the conversation names no person"];
  const out = cast.filter((name) => !people.some((row) => row.person === name && row.personal)).map((name) => `${name} has no bench world`);
  // `ownWorkspace`: the conversation's own world brings the shared workspace it runs in (`setsWorld.mjs` worldHasShared).
  if (out.length === 0 && c.kind === "group" && !ownWorkspace && groupFor(people, c) === null) out.push(`no shared workspace has all of ${cast.join(", ")}`);
  return out;
}

/**
 * The shared workspace a group conversation runs in: one `people.md` puts every member in with nobody's personal
 * workspace, the one named like the conversation first. Null when there is none.
 */
export function groupFor(people, c) {
  const want = castOf(c).map(handleOf);
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
  // The ask is what the job's start reacted to (🔎) or replied under (Tex's "on it" line, Dev2 2026-11-26). An earlier job
  // row or Tex's other words end the search (an older answered job is never this one); else the last person text.
  let tapback = null;
  for (let k = i - 1; k >= 0; k -= 1) {
    const x = c.msgs[k];
    if (x.via === "job") break;
    if (x.tex && x.kind === "reply" && typeof x.to === "string" && typeof x.text === "string" && x.text.trim() !== "") { tapback = x; break; }
    if (x.tex && x.kind !== "react" && typeof x.text === "string" && x.text.trim() !== "") break;
    if (x.tex && x.kind === "react" && JOB_TAPBACKS.has(bareEmoji(x.text))) { tapback = x; break; }
  }
  const tapped = tapback ? c.msgs.find((x) => x.id === tapback.to) : null;
  const asked = tapped && !tapped.tex && typeof tapped.text === "string" && tapped.text.trim() !== "" ? tapped : [...c.msgs.slice(0, i)].reverse().find((x) => !x.tex && !x.via && !x.kind && typeof x.text === "string" && x.text.trim() !== "");
  const words = String(asked?.text ?? "").replace(/\s+/g, " ").trim();
  const title = titleOf(words);
  return { title, state: m.state ?? "done", text: String(m.text ?? ""), asked: words, askedBy: asked?.who ?? null };
}

/** Why message `i` of `c` can't run as a Front door test yet, or null when it can. */
export function cantRun(c, i) {
  const m = c.msgs[i];
  if (m.via === "checkin" && checkinMail(m.text) === null && checkinCalendar(m.text) === null) return "a check-in row runs only when it names an email (\"Gmail: ...\") or a calendar event (\"Calendar: ...\")";
  if (m.via && m.via !== "checkin" && m.via !== "routine" && m.via !== "job") return `a ${m.via} row can't run as a Front door test`;
  if (m.kind && m.kind !== "reply") return `a ${m.kind} can't run as a Front door test: only a text or a reply`;
  if (Array.isArray(m.pics) && picturesOf(m).length < m.pics.length) return "a picture of this text isn't kept in the repository (apps/mcp/bench/ai/pictures/)";
  if ((typeof m.text !== "string" || m.text.trim() === "") && picturesOf(m).length === 0) return "the text is empty";
  if (!Array.isArray(c.members) || typeof c.members[0] !== "string") return "the conversation names no person";
  return null;
}

/** A check-in row's labelled parts: "Gmail: ..." (or "Gmail to the group inbox: ...") and "Calendar: ..." (or "shared calendar: ..."), each to the next label. */
const CHECKIN_LABEL = /(?:^\s*|[;.]\s+)((?:shared\s+)?calendar|gmail(?:\s+to\s+[^:;.]{1,40})?):\s*/gi;

/** The text of each labelled part of a check-in row (`gmail`, `calendar`), the first of each; a part left empty is absent. */
function checkinParts(text) {
  const s = String(text ?? "");
  const found = [...s.matchAll(CHECKIN_LABEL)];
  const parts = {};
  found.forEach((m, i) => {
    const key = /^gmail/i.test(m[1]) ? "gmail" : "calendar";
    const start = m.index + m[0].length;
    const part = s.slice(start, i + 1 < found.length ? found[i + 1].index : undefined).trim();
    if (parts[key] === undefined && part !== "") parts[key] = part;
  });
  return parts;
}

/**
 * The email a check-in row found, as the bench's Gmail holds it: "Gmail: <from>: <what it says>" (the sender is the
 * words before the first colon when they are short enough to be one). The row may say what else the check-in saw
 * first ("shared calendar: ...; Gmail to the group inbox: Kenji asks to move to 3pm"), and what its calendar holds
 * ("Gmail: TAP: flight delayed. Calendar: Dinner at 7"): the email is only its own part (`checkinCalendar`). Null when
 * the row names no mail.
 */
export function checkinMail(text) {
  const rest = checkinParts(text).gmail;
  if (rest === undefined) return null;
  const colon = rest.indexOf(":");
  const named = colon > 0 && colon <= 60 && !/[;.]/.test(rest.slice(0, colon));
  const from = named ? rest.slice(0, colon).trim() : "(sender)";
  const said = named ? rest.slice(colon + 1).trim() : rest;
  const subject = said.split(/(?<=[.!?;])\s/)[0].slice(0, 120);
  return { from, subject, body: said };
}

/** The calendar event a check-in row names ("calendar: Mon standup at 9", "Calendar: Dinner at 7"), or null when it names none. */
export function checkinCalendar(text) {
  return checkinParts(text).calendar ?? null;
}

/** A check-in row's case lines: its email (`- check-in mail:`) and its calendar event (`- check-in calendar:`), each only when it names one. */
function checkinLines(text) {
  const mail = checkinMail(text);
  const calendar = checkinCalendar(text);
  return [...(mail ? [`- check-in mail: ${JSON.stringify(mail)}`] : []), ...(calendar ? [`- check-in calendar: ${JSON.stringify(calendar)}`] : [])];
}

/** Whether a conversation's setting says Tex has the calendar ("Tex has Gmail, Calendar, ...", "the shared calendar"). */
export const hasCalendar = (c) => /\bcalendar\b/i.test(String(c?.setting ?? ""));

/** Whether a conversation's setting says Tex has Google Chat ("Tex has John's Gmail, Calendar, Google Chat, ..."). */
export const hasChat = (c) => /\bgoogle chat\b/i.test(String(c?.setting ?? ""));

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

/**
 * Whether a routine row is a one-off reminder: its words open by saying so ("one-off reminder Maya asked for: move the
 * car"). It then runs from `tex/routines/once/`, with a one-off's own framing (`routine.js` routineQuestion); placed as
 * a daily routine, a reminder was asked "is there anything to say today" and could answer no.
 */
export const isOneOff = (text) => /^\s*(?:a\s+)?one[- ]off\b/i.test(String(text ?? ""));

/** One bench test of `units` (all one person's): the front matter given, then one case a unit, its chat before it. */
export function fdTest(units, front, from = null) {
  const out = [`---\n${front}\n---\n\n# Sets\n\nThe Front door's unit tests from the test conversations (\`setsFd.mjs\`).\n`];
  const year = /^today: (\d{4})-/m.test(front) ? Number(/^today: (\d{4})-/m.exec(front)[1]) : null;
  units.forEach((u, k) => {
    const m = u.convo.msgs[u.at];
    const l = u.label;
    const burst = burstBefore(u.convo, u.at);
    const before = earlierLines(u.convo, u.at, year, from);
    const { earlier, unanswered } = sinceTexAnswered(before.slice(0, before.length - burst.length), picturesOf(m), u.convo.kind === "group");
    // A job a Tex 🔎 started and no report or words have settled: running now, as production's running list says (`background.js` runningNow).
    const running = m.via === undefined ? runningJobOf(u.convo, u.at, year, from) : null;
    const lines = [
      `## ${k + 1}. ${String(m.text).replace(/\s+/g, " ").slice(0, 120)}`,
      "",
      "- kind: task",
      ...(m.via === "checkin" ? checkinLines(m.text) : [m.via === "routine" ? `- ${isOneOff(m.text) ? "one-off routine" : "routine"} runs: ${JSON.stringify(m.text)}` : m.via === "job" ? `- job reports: ${JSON.stringify(jobReportRow(u.convo, u.at))}` : `- person texts: ${JSON.stringify([...burst, m.text ?? ""].filter(Boolean).join("\n"))}`]),
      ...unanswered.map((name) => `- person sends picture: ${name}`),
      ...earlier.flatMap((line) => {
        const ago = line.minutesBefore === undefined ? [] : [`- earlier minutes before: ${line.minutesBefore}`];
        if (line.from === "trigger") return [triggerLine(line), ...ago];
        const who = line.who ? `@${line.who}` : line.from;
        if (line.tapback) return [`- earlier tex tapback: ${JSON.stringify(line.text)}`, ...ago];
        return [`- earlier ${who}: ${JSON.stringify(line.text)}`, ...(line.pictures ?? []).map((name) => `- earlier ${who} sends picture: ${name}`), ...ago];
      }),
      ...(running ? [`- running job: ${JSON.stringify(running)}`] : []),
      ...(l.must || []).map((x) => `- must: ${x}`),
      ...(l.never || []).map((x) => `- must not: ${x}`),
    ];
    out.push(lines.join("\n") + "\n");
  });
  return out.join("\n");
}

/** A bare acknowledgement, as production's (`packages/tex/worker/inboxTurn.ts` PURE_ACK; a test keeps the two the same). */
export const PURE_ACK = /^\s*(?:ok|okay|k|kk|thanks|thank you|thx|ty|cool|got it|great|nice|perfect|👍|🙏|❤️)[\s.!]*$/iu;

/**
 * The person's texts a one-to-one turn at message `i` answers with it, oldest first. Production starts a turn on a
 * words-only text at once (`inbox.ts` TEXT_WAIT_MS 0); a text that lands while it runs restarts it, and the restarted
 * turn answers both as one, words in order (`inboxTurn.ts` merged). So the texts right before `i` with no answer of
 * Tex's between (a text or a tapback) join it, and the burst stops at: a message with its own `at` (sent apart), a
 * bare acknowledgement (production drops an uncovered one: `gatherTheTurn`), a message labelled for the Front door
 * (the set says it was a turn of its own), a picture or a trigger. Without a time on each text the bench cannot tell a
 * restart from a finished quiet turn, so an undated text right before is taken as a restart. Dev set, 2026-11-17:
 * "what's the weather at home tomorrow" then "no tuesday actually" never reached the turn as one ask. A tapback of
 * theirs is not words and is passed over.
 */
export function burstBefore(c, i) {
  if (c.kind === "group" || c.msgs[i]?.via) return [];
  const texts = [];
  for (let j = i - 1; j >= 0; j -= 1) {
    if (typeof c.msgs[j + 1].at === "string" && c.msgs[j + 1].at.trim() !== "") break;
    const m = c.msgs[j];
    if (m.tex || m.via) break;
    if (m.kind && m.kind !== "reply") continue;
    if (m.labels?.fd || picturesOf(m).length > 0 || typeof m.text !== "string" || m.text.trim() === "" || PURE_ACK.test(m.text)) break;
    texts.unshift(m.text);
  }
  return texts;
}

/**
 * The pictures a turn reads, as production's: its own and those sent since Tex last answered, oldest first. A group
 * turn reads the newest four of the chat's, any member's (`groupInbox.ts` `filesFor`); a one-to-one turn merges the
 * burst and reads the first eight (`inboxTurn.ts` `merged`). Tex answered when it texted, or when a routine ran, which
 * clears the chat's lines even when it stays quiet (`groupModelTurn.ts`); a tapback that was Tex's whole answer is its
 * line too (`earlierLines`), and so answers what came before it. The earlier
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
export async function frontFor(dir, person, { today = null, group = null, calendar = false, chat = false, setting = null, clock = null, sites = [], dated = false } = {}) {
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
  // A setting that names Google Chat connects it (`chat.mjs`), as one that names the calendar connects that.
  if (chat && !/^chat: /m.test(f)) f += "\nchat: connected";
  // A set conversation's Gmail may send (`connectMailbox`): the same for every one, as the set is written to be sent.
  if (!/^gmail: /m.test(f)) f += "\ngmail: sends";
  // The outside world the chat takes for granted, played by a model where the fixtures have nothing (`simWorld.mjs`,
  // Dev2 2026-11-17): it sees the chat's setting, never its labels.
  if (setting !== null) f = f.replace(/^world(?:_setting)?: .*\n?/gm, "") + `\nworld: simulated\nworld_setting: ${JSON.stringify(String(setting).replace(/\s+/g, " ").trim())}`;
  // The conversation's own sites (`setsWorld.mjs`) are part of its chat, made-up hosts included (`simWorld.mjs` sitesIn).
  f = f.replace(/^world_sites: .*\n?/gm, "");
  if (sites.length > 0) f += `\nworld_sites: ${sites.join(", ")}`;
  if (today) f = f.replace(/^today: .*$/m, `today: ${today}`);
  // A conversation's world dates its mail: what is dated after this test's day has not arrived for it (`world.mjs`).
  f = f.replace(/^mail_until: .*\n?/gm, "");
  if (today && dated) f += `\nmail_until: ${today}`;
  // The row's own time of day in the person's zone (`clock.mjs`), and that zone on every text as the Worker sends it.
  const zone = await zoneOf(dir, people.find((row) => row.person === person && row.personal).workspace);
  f = f.replace(/^(?:clock|time_zone): .*\n?/gm, "") + `\ntime_zone: ${zone}`;
  if (clock) f += `\nclock: ${clock}`;
  if (group) f = f.replace(/^(run_as: .*)$/m, `$1\ngroup: ${group}`);
  return f;
}

/**
 * The variables that hold one Training conversation out of the Front door's examples (`texTraining.cjs` `heldOutOf`),
 * or end it at a test's moment (`trainingOf`).
 */
const { HOLD_OUT_ENV, UNTIL_ENV } = createRequire(import.meta.url)("../../../packages/tex/src/texTraining.cjs");

/**
 * The Front door's batch: every unit through the tree's own bench. Each conversation runs in a copy of the bench folder
 * of its own with its world laid in (`setsWorld.mjs`), its units grouped by person and day, each group one test.
 * `runTests` is `coreArea.mjs`'s from the tree, swapped by a test; `parallel` tests go at once. Unless `fake`, each
 * asks Clef for real (`REAL_CLEF_ENV`, `worldAi.mjs`): on the stand-in every specialist pick read "none". One shared
 * pool: every conversation is prepared first (its folder, its world, its `sets-N.md` tests; a few at a time), then
 * every test of every conversation is one job in a single pool of `parallel` lanes (`setsPool.mjs`), so no lane sits
 * idle waiting for its own conversation. Each job is one test of one conversation, run alone in that conversation's
 * folder, cut at its own moment where the conversation is a Training one (`envOf`). A test that throws marks only its
 * own units. Rows come back in the units' order. With `holdOut`, a Training conversation's tests run in processes that
 * leave it out of the Front door's examples (`heldOutOf`): the held-out score. Without, the in-context score, as
 * production reads it but each test cut at its moment. One row a unit. `keep`: each judged test kept for `regrade.mjs`.
 */
export async function runFd(units, { tree, fake = false, runTests = null, parallel = 1, holdOut = false, env = process.env, keep = null, world = "replay" }) {
  if (!fake) env = { ...env, [REAL_CLEF_ENV]: "1" };
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
    const byConvo = new Map();
    for (const u of can) byConvo.set(u.convo.id, [...(byConvo.get(u.convo.id) ?? []), u]);
    const convos = [...byConvo.values()];
    // Every conversation's folder and tests first, a few at a time.
    const prepared = new Array(convos.length);
    const compare = compareOf(env, { tree, convs: convos.map((m) => m[0].convo), world }); // one world for both arms (`worldCompare.mjs`)
    await runPool(convos, PREPARE_LANES, async (mine, k) => {
      const c = mine[0].convo;
      const convoEnv = holdOut && c.set === "training" ? { ...env, [HOLD_OUT_ENV]: c.id } : env;
      try {
        prepared[k] = { ...(await prepareConvo(mine, { tree, scratch: join(scratch, `c${k + 1}-${handleOf(c.id)}`), env: convoEnv, mode: world, compare })) };
      } catch (error) {
        prepared[k] = { rows: mine.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `could not run: ${String(error?.message ?? error).slice(0, 300)}` })), tests: [] };
      }
    });
    // The one pool: every test of every conversation, longest conversations first and round-robin across them.
    for (const p of prepared) for (const t of p.tests) t.p = p;
    const jobs = scheduleOrder(prepared.map((p) => p.tests));
    await runPool(jobs, parallel, untilOutOfCredit(async (t) => {
      const p = t.p;
      try {
        t.got = await run(tree, [t.name], { dir: p.dir, scratch: p.scratch, tag: "sets", fake, parallel: 1, env: p.env, envOf: p.envOf, keep, keepPrefix: `${basename(p.scratch)}-`, keepUnits: t.group.map((u) => ({ chat: u.row.chat, msg: u.row.msg, node: u.row.node, rep: u.row.rep })) });
      } catch (error) {
        t.error = error;
      }
    }));
    for (const p of prepared) rows.push(...collectConvo(p));
    // record/refresh write this run's answers; a replay adds what it had to ask; a compare's arm waits for `finish`.
    if (compare) armDone(compare.dir, compare.arm);
    else saveRunFixtures(prepared, tree, world);
    // Rows in the order their units came, whichever conversation finished first.
    const place = new Map(units.map((u, k) => [`${u.row.chat}\n${u.row.msg}\n${u.row.node}`, k]));
    return rows.sort((a, b) => (place.get(`${a.chat}\n${a.msg}\n${a.node}`) ?? 0) - (place.get(`${b.chat}\n${b.msg}\n${b.node}`) ?? 0));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** How many conversations are prepared at once (their folders are copies of the bench folder). */
const PREPARE_LANES = 4;

/**
 * One conversation's units, prepared to run: its own copy of the bench folder with its world laid in, and one `sets-N`
 * test a person-day. Returns the rows that cannot run already (`rows`), and `tests` (name, group, cut) for the pool.
 */
async function prepareConvo(units, { tree, scratch, env, mode = "replay", compare = null }) {
  const rows = [];
  const c = units[0].convo;
  const dir = join(scratch, "ai");
  // The world's answers, shared by the conversation's test processes and, in a compare, both arms (`compareWorld`).
  const { runDir = join(scratch, "world"), ...worldFixtures } = compareWorld(compare, c.id);
  await mkdir(scratch, { recursive: true });
  await cp(join(tree, "apps/mcp/bench/ai"), dir, { recursive: true });
  const setup = join(dir, "setups", "texting-assistant");
  const pulled = await readFile(join(setup, "production.md"), "utf8").then(() => true, () => false);
  if (!pulled) {
    await rm(setup, { recursive: true, force: true });
    await mkdir(setup, { recursive: true });
    await writeFile(join(setup, "production.md"), `---\n${LIVE_SETTINGS}\n---\n\nTex's rules are its prompt modules, read from Tex's config.\n`);
  }
  // The conversation's own records, pages, mail and calendar (`setsWorld.mjs`), over the copy; a group's own workspace
  // is the one it runs in.
  const world = await seedWorld(dir, worldDirOf(tree, c.id), c, castOf(c));
  const people = parsePeople(await readFile(join(dir, "workspaces", "people.md"), "utf8"));
  const base = /^today: (\d{4}-\d{2}-\d{2})/m.exec(FRONT.exec(await readFile(join(dir, "tests", "core.md"), "utf8"))?.[1] ?? "")?.[1] ?? new Date().toISOString().slice(0, 10);
  // The day the chat's first line was sent: its world's, else the first such weekday from the bench's day on (`dayOf`).
  const from = world.starts ?? base;
  const year = Number(from.slice(0, 4));
  const group = c.kind === "group" ? (world.group ?? groupFor(people, c)) : null;
  if (c.kind === "group" && group === null) {
    return { dir, scratch, env, envOf: null, tests: [], runDir, id: c.id, set: c.set, rows: units.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `no shared workspace in apps/mcp/bench/ai/workspaces/people.md has all of ${castOf(c).join(", ")}` })) };
  }
  const batches = new Map();
  for (const u of units) {
    const person = senderOf(c, u.at, people, group);
    const today = dayOf(c, u.at, year, from);
    const clock = timeOf(c, u.at);
    const key = JSON.stringify([person, today, clock]);
    if (!batches.has(key)) batches.set(key, { person, today, clock, units: [] });
    batches.get(key).units.push(u);
  }
  const tests = [];
  for (const { person, today, clock, units: mine } of batches.values()) {
    // A conversation whose setting gives Tex the calendar runs with one connected (`calendar.mjs` benchCalendar).
    const front = await frontFor(dir, person, { today, group, calendar: hasCalendar(c), chat: hasChat(c), setting: String(c.setting ?? ""), clock, sites: world.sites, dated: world.laid });
    if (front === null) {
      rows.push(...mine.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `${person} has no bench world: a set chat's people are the bench's (apps/mcp/bench/ai/workspaces/people.md)` })));
      continue;
    }
    const name = `sets-${tests.length + 1}`;
    // The world this test runs in (`simFixtures.mjs`): the conversation's run folder, the mode, its fixtures, its name.
    await writeFile(join(dir, "tests", `${name}.md`), fdTest(mine, `${front}\n${worldFront({ tree, id: c.id, runDir, mode, test: name, ...worldFixtures })}`, from));
    tests.push({ name, group: mine, cut: Math.min(...mine.map((u) => u.at)) });
  }
  // A Training conversation scored in context reads itself as an example only up to the scored moment
  // (`texTraining.cjs` UNTIL_ENV): its later texts are its future (truck-crew 96, 2026-11-18, quoted message 98). A test
  // is one person's day and clock, often several moments; it is cut at its earliest, so none of them reads ahead, and
  // the later ones still have their own past in the live chat. A held-out chat is gone whole and needs no cut.
  const cuts = c.set === "training" && env[HOLD_OUT_ENV] !== c.id;
  const envOf = cuts ? (name) => ({ ...env, [UNTIL_ENV]: `${c.id}:${tests.find((t) => t.name === name)?.cut ?? 0}` }) : null;
  return { dir, scratch, env, envOf, tests, rows, runDir, id: c.id, set: c.set };
}
