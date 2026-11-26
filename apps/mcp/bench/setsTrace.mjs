/**
 * EVERY GOLD FACT HAS A SOURCE IN THE BENCH (Training of 2026-11-18, running-the-shop m83: the gold answer named "the
 * Mailbox plan renewal and a $19 domain charge" that Tex had left open, and nothing the bench lays in held either, so
 * Tex was failed for not offering to close loops it could never know about).
 *
 * A labelled Front door row is graded against the texts Tex sent after it in the real chat (its gold). Those texts may
 * rest on Tex's state: its memory, the open asks on its jobs list, routines, saved logins, mail it read. The bench can
 * only make state that is written down somewhere it lays in, so every hard fact in a gold text has to be found in one of:
 *
 *   - the chat up to and including the row (every line and its `at`), and the conversation's `setting`;
 *   - the conversation's world (`worlds/<id>/`: its workspaces, sites and world.md, `setsWorld.mjs`);
 *   - the bench workspaces the row's people can reach (`ai/workspaces/people.md`);
 *   - the bench's own scripted sites (`ai/sites/`), which `open_page` reads in every run.
 *
 * A hard fact is a money amount, a number with a unit, a clock time, a calendar date, a capitalised name in the middle
 * of a sentence, or a quoted title. A fact Tex works out itself (a sum, a difference, a count of what it listed) is on
 * the conversation's `COMPUTED` list below, each with its reason; nothing else is let through. A finding is fixed by
 * adding to the world what the chat's own story says existed, never by changing the gold to fit the world.
 *
 * Static: it reads files and makes no model call.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { parsePeople } from "./load.mjs";
import { castOf } from "./setsFd.mjs";
import { WORLDS, worldDirOf } from "./setsWorld.mjs";

/**
 * Facts Tex works out itself, by conversation id, then the id of the gold text that says them: `[{ fact, why }]`, `fact` as the gold writes it ("$210",
 * "8:45") or as `factsOf` keeps it. Each says what it is worked out from: a sum or difference of facts the bench holds,
 * a count, the time of Tex's own send, or Tex's own wording. An entry no longer needed (the fact is found, or no
 * longer in the gold) is reported as stale by `traceTraining`, so the list never outlives its reason.
 */
export const COMPUTED = {
  "harbour-bounce": {
    r2: [
      { fact: "Advanced", why: "the buttons on Google's own unverified-app and permissions screens, which the picture after this text shows: Context's sign-up, not anything of Nia's" },
    ],
  },
  "build-crew": {
    m22: [
      { fact: "$210", why: "three Q2Us at the gear note's $70 each" },
      { fact: "$1,200", why: "three SM7Bs at the gear note's $400 each" },
    ],
  },
  "loose-ends": { m72: [{ fact: "$25.20", why: "18% of the $140 in Maya's text" }] },
  "running-the-shop": {
    m5: [{ fact: "$22", why: "Rovertown's $18 weekly-plan walk plus its $4 area fee for John's zip" }],
    m6: [{ fact: "$22", why: "Rovertown's $18 weekly-plan walk plus its $4 area fee for John's zip" }],
    m54: [{ fact: "6 people", why: "the waitlist names in John's picture, m52 (\"6 names\")" }],
    m88: [{ fact: "LoRA", why: "a fine-tuning method, general knowledge: not anything of John's or Tex's state" }],
  },
  "trial-hire": {
    m14: [
      { fact: "8:45", why: "45 minutes before the 9:30 call in the chat" },
      { fact: "9:25", why: "5 minutes before the 9:30 call in the chat" },
    ],
    m22: [{ fact: "10:45", why: "the end of the 45-minute event Tex makes for the Monday 10:00 start" }],
    m34: [{ fact: "What earns week two", why: "the heading Tex writes into the week-one doc in this turn" }],
    m54: [{ fact: "11:41", why: "the time of Tex's own send, from the bench's clock" }],
    m74: [{ fact: "zero effort", why: "Tex's summing-up of John's m71 (\"no thought went into it\")" }],
    m85: [{ fact: "14 days", why: "the two weeks of the trial, in the chat" }],
    m90: [
      { fact: "Less than you expected", why: "Tex's summing-up of John's m82 (\"not even close\")" },
      { fact: "Didn't do the work", why: "Tex's summing-up of John's m71 and m82, the claim it weighs" },
    ],
    m111: [{ fact: "31 items", why: "the count of the checklist Tex writes in this turn" }],
    m124: [{ fact: "8:03pm", why: "the time of Tex's own send, from the bench's clock" }],
  },
  "truck-crew": {
    m32: [{ fact: "$420", why: "the new $120 a month (Kofi, m29) times 12, less the budget's $240 a year" }],
    m44: [{ fact: "$5", why: "La Estrella's $220 less Molino Rojo's $215" }],
  },
};

/**
 * Gold facts the bench has no form for yet, by conversation id, then gold text id: `[{ fact, why }]`. The row's label stays;
 * the gap is the bench's or the product's, named in `why`, and reported with every run of the lint. Never a fact the
 * bench could hold as a note, an email, a calendar day or a site: those are added to the conversation's world.
 */
export const GAPS = {
  "trial-hire": {
    m75: [{ fact: "fix and check it", why: "read off John's 9 screenshots (m70), which are a placeholder line, not pictures the bench keeps" }],
    m88: [{ fact: "Sept 21", why: "the repo's PR history, read on John's computer: the bench has no repository or GitHub stand-in to hold it" }],
  },
};

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const UNITS = "%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|miles?|mi|km|kg|lbs?|pounds?|ounces?|oz|feet|ft|inches|people|guests|seats|tickets|nights|walks?|episodes?|items?|emails?|texts?|calls?|pages?|slots?|spots?";

/** Words that start with a capital in the middle of a sentence and are not names of anything Tex has to know. */
const NOT_NAMES = new Set(
  "i i'm i'll i've i'd ok okay tex mon monday tue tues tuesday wed wednesday thu thur thurs thursday fri friday sat saturday sun sunday jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november dec december am pm"
    .split(" "),
);

/** Text as it is compared: lower case, plain quotes and dashes, one space. */
export const flat = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");

/** "$1,200.00" and "$1200" as one amount. */
const money = (raw) => {
  const n = raw.replace(/[$,\s]/g, "").toLowerCase();
  return n.endsWith(".00") ? n.slice(0, -3) : n;
};

/** A clock time as minutes past midnight, or null. */
function clockOf(raw) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h === 12) h = 0;
    if (m[3].toLowerCase() === "p") h += 12;
  }
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** Every clock time a text holds, as minutes past midnight, with the 12-hour reading of a bare "7:30" too. */
function clocksIn(text) {
  const out = new Set();
  for (const m of flat(text).matchAll(/\b(\d{1,2}(?::\d{2})?)\s*([ap])\.?m\b\.?|\b(\d{1,2}:\d{2})\b/g)) {
    const t = clockOf(m[3] ?? `${m[1]}${m[2]}m`);
    if (t === null) continue;
    out.add(t);
    if (m[3] && t < 12 * 60) out.add(t + 12 * 60);
  }
  return out;
}

/** The start of every sentence or list item in `text`, as offsets: a capital there is not a name. */
function sentenceStarts(text) {
  const out = new Set([0]);
  for (const m of text.matchAll(/(?:^|[.!?:;]\s+|\n\s*(?:[-*•]|\d+[.)])?\s*|["(]\s*)/g)) out.add(m.index + m[0].length);
  return out;
}

/**
 * The hard facts in one gold text: `{ kind, fact, raw }`, `fact` the form looked for (lower case). Kinds: money, unit,
 * time, date, name, title.
 */
export function factsOf(text) {
  const t = String(text ?? "");
  const out = [];
  const seen = new Set();
  const add = (kind, fact, raw) => {
    const key = `${kind}:${fact}`;
    if (!seen.has(key)) out.push({ kind, fact, raw }), seen.add(key);
  };
  for (const m of t.matchAll(/\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?k?/gi)) add("money", money(m[0]), m[0]);
  for (const m of t.matchAll(new RegExp(`(?<![\\d:.,$-]|(?:${MONTHS})\\.?\\s)\\b(\\d+(?:\\.\\d+)?)\\s?(${UNITS})(?![a-z])`, "gi"))) add("unit", `${m[1]} ${m[2].toLowerCase()}`, m[0]);
  for (const m of t.matchAll(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b\.?|\b\d{1,2}:\d{2}\b/gi)) add("time", String(clockOf(m[0].replace(/\./g, "")) ?? m[0]), m[0]);
  for (const m of t.matchAll(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) add("date", `${m[1].slice(0, 3).toLowerCase()} ${Number(m[2])}`, m[0]);
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b`, "gi"))) add("date", `${m[2].slice(0, 3).toLowerCase()} ${Number(m[1])}`, m[0]);
  for (const m of t.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) add("date", m[0], m[0]);
  for (const m of t.matchAll(/["“]([^"“”\n]{3,80})["”]/g)) if (/[a-z]/i.test(m[1])) add("title", flat(m[1]).trim().replace(/[.,!?;:]+$/, ""), m[0]);
  const starts = sentenceStarts(t);
  // A run of capitalised words ("Claude Code", "Mailbox plan" is "Mailbox"): one name, unless a word starts a sentence.
  for (const m of t.matchAll(/\b[A-Z][\p{L}\d'&.-]*[\p{L}\d](?:\s+[A-Z][\p{L}\d'&.-]*[\p{L}\d])*/gu)) {
    let words = m[0].split(/\s+/);
    let at = m.index;
    if (starts.has(at)) {
      at += words[0].length + 1;
      words = words.slice(1);
    }
    // "Wed-Thu" is two day names, "Maya's" is Maya, "PRs" is PR.
    words = words.map((w) => w.split("-").filter((part) => !NOT_NAMES.has(part.toLowerCase().replace(/'s$/, ""))).join("-")).filter(Boolean);
    if (words.length === 0) continue;
    const name = words.join(" ").replace(/'s$/, "").replace(/(?<=[A-Z\d])s$/, "");
    if (/^[A-Z]{1,3}$/.test(name)) continue; // an initial or a short shout (OK, TV): not a name to trace
    add("name", flat(name), name);
  }
  return out;
}

/** Whether `fact` is found in `hay` (already `flat`), with `clocks` the clock times `hay` holds. */
export function foundIn(f, hay, clocks) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (f.kind) {
    case "money": {
      const n = f.fact.replace(/^\$?/, "");
      const digits = esc(n.replace(/k$/, ""));
      const thousands = n.endsWith("k") ? `|\\$\\s?${esc(String(Number(n.slice(0, -1)) * 1000).replace(/\B(?=(\d{3})+(?!\d))/g, ","))}(?![\\d])|\\$\\s?${esc(String(Number(n.slice(0, -1)) * 1000))}(?![\\d])` : "";
      const commas = esc(n.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
      return new RegExp(`(?:\\$\\s?(?:${digits}|${commas})(?:\\.00)?${n.endsWith("k") ? "k" : ""}(?![\\d,]*\\d)${thousands}|\\b(?:${digits}|${commas}) (?:dollars|bucks|usd))`).test(hay);
    }
    case "unit": {
      const [num, unit] = f.fact.split(" ");
      const stem = unit.replace(/s$/, "").slice(0, 3);
      return new RegExp(`(?<![\\d.])${esc(num)}(?![\\d])\\s?-?${esc(stem)}`).test(hay);
    }
    case "time":
      return clocks.has(Number(f.fact)) || hay.includes(f.fact);
    case "date": {
      if (/^\d{4}-/.test(f.fact)) {
        const [, mo, d] = f.fact.split("-").map(Number);
        const name = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][mo - 1];
        return hay.includes(f.fact) || new RegExp(`\\b${name}[a-z]*\\.? ${d}(?!\\d)`).test(hay);
      }
      const [mon, day] = f.fact.split(" ");
      const mo = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(mon) + 1;
      const iso = `-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return new RegExp(`\\b${mon}[a-z]*\\.? ${day}(?!\\d)|\\b${day}(?:st|nd|rd|th)? (?:of )?${mon}`).test(hay) || hay.includes(iso);
    }
    default: {
      // "home-screen" and "home screen" alike; a quote Tex turns to them ("less than you expected") as they said it.
      const loose = hay.replace(/-/g, " ");
      const forms = [f.fact, ...(f.kind === "title" ? [firstPerson(f.fact)] : [])].map((x) => x.replace(/-/g, " "));
      if (forms.some((x) => loose.includes(x))) return true;
      return f.kind === "name" && f.fact.replace(/-/g, " ").split(" ").every((w) => new RegExp(`(?<![\\p{L}\\d])${esc(w)}`, "u").test(loose));
    }
  }
}

/** A quote put back in the speaker's own words: Tex says "you", they said "I". */
const firstPerson = (text) =>
  text.replace(/\b(you're|you've|you'll|you'd|yours|your|you)\b/g, (w) => ({ "you're": "i'm", "you've": "i've", "you'll": "i'll", "you'd": "i'd", yours: "mine", your: "my", you: "i" })[w]);

const isDir = (path) => stat(path).then((s) => s.isDirectory(), () => false);

/** Every file's text under `dir`, `{ path, text }`, path relative to `root`. */
async function filesUnder(dir, root) {
  if (!(await isDir(dir))) return [];
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(path, root)));
    else if (/\.(md|txt|json|ics|eml)$/i.test(e.name)) out.push({ path: relative(root, path), text: await readFile(path, "utf8") });
  }
  return out;
}

/** The index of the last gold text of the row at `i`: Tex's texts after it, up to the next line of theirs. */
export function goldOf(c, i) {
  const out = [];
  for (const m of c.msgs.slice(i + 1)) {
    if (!m.tex) break;
    if (!m.kind && typeof m.text === "string" && m.text.trim() !== "") out.push(m);
  }
  return out;
}

/**
 * The places a row's facts are looked for, `[{ where, text }]`, built once per conversation except the chat, which
 * grows a line at a time.
 */
export async function placesOf(c, { tree }) {
  const bench = join(tree, "apps/mcp/bench/ai");
  const people = parsePeople(await readFile(join(bench, "workspaces/people.md"), "utf8"));
  const cast = castOf(c);
  const reach = [...new Set(people.filter((row) => cast.includes(row.person)).map((row) => row.workspace))];
  const places = [];
  const world = worldDirOf(tree, c.id);
  for (const f of await filesUnder(world, join(tree, WORLDS))) places.push({ where: `worlds/${f.path}`, text: f.text });
  for (const ws of reach) for (const f of await filesUnder(join(bench, "workspaces", ws), bench)) places.push({ where: `ai/${f.path}`, text: f.text });
  for (const f of await filesUnder(join(bench, "sites"), bench)) places.push({ where: `ai/${f.path}`, text: f.text });
  return { places, reach };
}

/**
 * Every gold fact of `c`'s labelled Front door rows that no place holds: `[{ row, fact, kind, raw, gold, looked }]`.
 * `places` is `placesOf`'s; `computed` the conversation's COMPUTED entries.
 */
export function traceConvo(c, { places, reach }, allowed = { ...(COMPUTED[c.id] ?? {}), ...mergeRows(GAPS[c.id]) }) {
  const fixed = flat(places.map((p) => p.text).join("\n"));
  const fixedClocks = clocksIn(places.map((p) => p.text).join("\n"));
  const out = [];
  c.msgs.forEach((m, i) => {
    if (!m.labels?.fd) return;
    const chat = [c.setting, ...c.msgs.slice(0, i + 1).flatMap((x) => [x.at, x.text])].filter((s) => typeof s === "string").join("\n");
    const hay = `${flat(chat)}\n${fixed}`;
    const clocks = new Set([...fixedClocks, ...clocksIn(chat)]);
    for (const g of goldOf(c, i)) {
      const ok = allowed[g.id] ?? [];
      for (const f of factsOf(g.text)) {
        if (ok.some((x) => sameFact(x.fact, f)) || foundIn(f, hay, clocks)) continue;
        out.push({ convo: c.id, row: m.id, gold: g.id, kind: f.kind, fact: f.fact, raw: f.raw, looked: lookedLine(c, reach) });
      }
    }
  });
  return out;
}

const lookedLine = (c, reach) => `the chat to the row, its setting, worlds/${c.id}/, bench workspaces ${reach.join(", ") || "(none)"}, ai/sites`;

/** One finding as a line: the row, the fact and where it looked. */
export const findingLine = (f) => `${f.convo} ${f.row} (gold ${f.gold}): ${f.kind} "${f.raw}" is in none of: ${f.looked}`;

/** Whether an allowlist entry's `fact` names the fact `f`: as the gold wrote it, or as `factsOf` keeps it. */
export const sameFact = (entry, f) => {
  const e = flat(entry).trim().replace(/[.,!?;:"]+$/, "").replace(/^"/, "");
  return e === f.fact || e === flat(f.raw).trim().replace(/[.,!?;:"]+$/, "").replace(/^"/, "");
};

/** Two allowlists' rows as one: `{ row: [entries] }`. */
const mergeRows = (...lists) => {
  const out = {};
  for (const list of lists) for (const [row, entries] of Object.entries(list ?? {})) out[row] = [...(out[row] ?? []), ...entries];
  return out;
};

/**
 * Every finding over the Training conversations among `convs`, `{ findings, stale, gaps }`: the facts no place holds
 * and no list lets through; the list entries that let nothing through; and the gaps still standing.
 */
export async function traceTraining(convs, { tree, computed = COMPUTED, gaps = GAPS } = {}) {
  const findings = [];
  const stale = [];
  const standing = [];
  for (const c of convs.filter((x) => x.set === "training")) {
    const places = await placesOf(c, { tree });
    findings.push(...traceConvo(c, places, mergeRows(computed[c.id], gaps[c.id])));
    // What each entry lets through: the findings with no lists at all.
    const bare = traceConvo(c, places, {});
    for (const [list, entries] of [["COMPUTED", computed[c.id]], ["GAPS", gaps[c.id]]]) {
      for (const [row, rowEntries] of Object.entries(entries ?? {})) {
        for (const x of rowEntries) {
          const hit = bare.some((f) => f.gold === row && sameFact(x.fact, f));
          if (!hit) stale.push(`${list} ${c.id} ${row} "${x.fact}" lets nothing through: the bench now holds it, or the gold no longer says it`);
          else if (list === "GAPS") standing.push(`${c.id} ${row} "${x.fact}": ${x.why}`);
        }
      }
    }
  }
  return { findings, stale, gaps: standing };
}
