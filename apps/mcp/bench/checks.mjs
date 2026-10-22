/**
 * CHECKS A RUN CAN PROVE WITHOUT A JUDGE.
 *
 * A golden task (`tests/tasks.md`) is judged on what was done, not only on
 * what was said: Tex either opened ChatGPT's plugins page and typed Context's
 * address into it, or it did not, and a model asked whether it did can be
 * talked round by an answer that says so. These lines are read from the
 * answer's own record (the tools it called, what the scripted browser did,
 * `sites.mjs`, the notes it wrote) and graded here; the judge never sees them.
 *
 *   - must call: read_skill          a tool call that did not fail
 *   - must not call: vault_add_link
 *   - must reach: chatgpt.com/plugins  a page opened or read (a prefix)
 *   - must hand off: chatgpt.com     a handoff while on that site
 *   - must type: https://mcp.context.lc/mcp   typed into any box
 *   - must choose: Read-only tools: Always allow   an option picked in a list
 *   - must set: connected chatgpt    a flag a scripted button set
 *   - must publish: website          a site publish that went through (`siteStub.mjs`)
 *   - must connect: mayaruns.com     a domain connected to the workspace's site
 *   - must download: Invoice-2026-09.pdf   a file a browse download step took (`sites.mjs`)
 *   - must attach: Invoice-2026-09.pdf     an email saved as a draft or sent that
 *                                    carries that file as an attachment
 *   - must forward: 19a2f0c4         an email saved as a draft or sent that
 *                                    forwards the message with that Gmail id
 *                                    (`mailbox.mjs`), its attachments with it
 *   - must write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am
 *                                    a note written at that path (a folder when
 *                                    it ends in `/`), with that front matter
 *   - must file: tomas/1-projects/kitchen/overview.md under tomas/4-archive/
 *                                    where the note that was at that path is
 *                                    after the run (housekeeping moves notes,
 *                                    and a moved note's old name follows it):
 *                                    under a folder ending in `/`, or that path;
 *                                    optionally `with status: finished` (front
 *                                    matter; `review: *` means any value) and
 *                                    `containing <words>` (in its text)
 *
 * Each also takes `must not`. A verdict is a "must" or "must not" line like
 * the judge's, so a failed check fails its question, and on a task, the gate.
 */

import { cadenceFromFolder, parseTime, parseWeekdays } from "../../../packages/shared/src/routines.cjs";

const CHECK = /^- (must|must not) (call|reach|hand off|type|choose|set|publish|connect|write|file|forward|download|attach):\s*(.+)$/;

/** A check line, or null when the line is not one. */
export function readCheck(line) {
  const m = line.trim().match(CHECK);
  if (!m) return null;
  // A malformed write line fails when the test is read, not as a failed check.
  if (m[2] === "write") writeTarget(m[3].trim());
  if (m[2] === "file") fileTarget(m[3].trim());
  return { kind: m[1], what: m[2], value: m[3].trim(), line: `${m[2]} ${m[3].trim()}` };
}

const called = (tools, name) => tools.some((label) => label === name || label === `${name} (held for OK)`);

/** Whether the answer did what the check names. */
function happened(check, answer) {
  const events = answer.browser ?? [];
  const value = check.value.toLowerCase();
  switch (check.what) {
    case "call":
      return called(answer.tools ?? [], check.value);
    case "reach":
      return events.some((event) => /^(open|read) /.test(event) && event.slice(5).toLowerCase().startsWith(value));
    case "hand off":
      return events.some((event) => event.toLowerCase() === `handoff ${value}`);
    case "type":
      return events.some((event) => event.startsWith("type ") && event.toLowerCase().includes(`"${value}`));
    case "choose":
      return events.some((event) => event.startsWith("select ") && event.toLowerCase().endsWith(`"${value}"`));
    case "set":
      return events.some((event) => event.toLowerCase() === `set ${value}`);
    case "publish":
      return events.includes("publish");
    case "connect":
      return events.some((event) => event.toLowerCase() === `connect ${value}`);
    case "forward":
      return (answer.emails ?? []).some((email) => email.forward === check.value);
    case "download":
      return events.some((event) => event.startsWith("download ") && event.endsWith(` "${check.value}"`));
    case "attach":
      return (answer.emails ?? []).some((email) => (email.files ?? []).some((file) => file.filename === check.value));
    case "write":
      return wrote(check.value, answer.changes ?? []);
    case "file":
      return filed(check.value, answer.where ?? {});
    default:
      return false;
  }
}

/**
 * A `write` check's target: `<workspace>/<path>`, then optionally `with` and
 * the front matter lines the note must carry, comma-separated:
 * `maya/routines/daily/ with at: 7:30 am, on: weekdays`. A comma inside a
 * value (`on: mon, wed`) is kept: only one followed by `key:` starts a line.
 */
export function writeTarget(value) {
  const at = value.search(/\s+with\s+/);
  const place = at < 0 ? value : value.slice(0, at);
  const fields = at < 0 ? "" : value.slice(at).replace(/^\s+with\s+/, "");
  const front = {};
  for (const part of fields.split(/,\s*(?=[A-Za-z][\w-]*:\s)/).filter((p) => p.trim())) {
    const m = part.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!m) throw new Error(`write check: "${part.trim()}" is not a front matter line (key: value)`);
    front[m[1].toLowerCase()] = m[2];
  }
  return { place: place.trim(), front };
}

/**
 * The notes an answer wrote, as `{ path, detail }` with the path prefixed by
 * its workspace. A live run's record has the world's change objects; a result
 * note read back has its "Changes recorded" lines (`report.mjs`), e.g.
 * `- written maya/home/repairs.md: --- at: 9:00 am --- Text me...`.
 */
function writesOf(changes) {
  const out = [];
  for (const change of changes) {
    if (typeof change === "string") {
      const m = change.match(/^-\s+(\S+)\s+(.+?\.md):\s?(.*)$/) ?? change.match(/^-\s+(\S+)\s+([^:]+):\s?(.*)$/);
      if (m && m[1] === "written") out.push({ path: m[2], detail: m[3] });
    } else if (change?.kind === "written") out.push({ path: `${change.workspace}/${change.path}`, detail: change.detail ?? "" });
  }
  return out;
}

/**
 * The front matter of a written note's recorded detail. The world records a
 * note's text with its whitespace folded to single spaces (`world.mjs`), so
 * the lines are found by their `key:` rather than by line breaks.
 */
export function recordedFront(detail) {
  const m = /^---\s+(.*?)\s+---(?:\s|$)/.exec(String(detail).trim());
  if (!m) return {};
  const keys = [...m[1].matchAll(/(?:^|\s)([A-Za-z][\w-]*):(?=\s|$)/g)];
  const out = {};
  keys.forEach((key, i) => {
    const raw = m[1].slice(key.index + key[0].length, i + 1 < keys.length ? keys[i + 1].index : m[1].length).trim();
    out[key[1].toLowerCase()] = raw.replace(/^(["'])(.*)\1$/, "$2");
  });
  return out;
}

/** `9:00 am`, `2026-10-09 9:00 am` or `2026-10-09T09:00`: a date (or none) and a time. */
function when(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T|\s+)(.+)$/.exec(value);
  const time = parseTime(m ? m[2] : value);
  return time ? { date: m ? m[1] : null, ...time } : null;
}

/** Whether a written front matter value says what the check wants, read the way routines.cjs reads it. */
function sameValue(key, want, got) {
  const a = String(want).trim();
  const b = String(got ?? "").trim();
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const wa = when(a);
  const wb = when(b);
  if (wa && wb) return wa.date === wb.date && wa.hour === wb.hour && wa.minute === wb.minute;
  if (key === "on") {
    const da = parseWeekdays(a);
    const db = parseWeekdays(b);
    return Boolean(da && db && da.join() === db.join());
  }
  return false;
}

/**
 * Whether `path` is at `place`: the note itself, or anything under a folder
 * that ends in `/`. Two routine folders that mean one schedule
 * (`routines/daily/`, `routines/every-day/`) under the same root are one
 * place; the two roots (`tex/routines/`, `routines/`) are not, because the
 * check names where a new one belongs.
 */
function atPlace(place, path) {
  if (!place.endsWith("/")) return path === place;
  if (path.startsWith(place)) return true;
  const want = /^([^/]+)\/((?:tex\/)?routines)\/([^/]+)\/$/.exec(place);
  const got = /^([^/]+)\/((?:tex\/)?routines)\/([^/]+)\/[^/]+\.md$/.exec(path);
  if (!want || !got || want[1] !== got[1] || want[2] !== got[2]) return false;
  const a = cadenceFromFolder(want[3]);
  const b = cadenceFromFolder(got[3]);
  return Boolean(a && b && a.unit === b.unit && a.every === b.every);
}

function wrote(value, changes) {
  const { place, front } = writeTarget(value);
  return writesOf(changes).some((write) => {
    if (!atPlace(place, write.path)) return false;
    const fields = recordedFront(write.detail);
    return Object.entries(front).every(([key, want]) => sameValue(key, want, fields[key]));
  });
}

/**
 * A `file` check: `<workspace>/<note>.md under <workspace>/<place>`, then
 * optionally `with key: value, key: value` and `containing <words>`.
 */
export function fileTarget(value) {
  const m = /^(\S+\/\S+\.md)\s+under\s+(\S+)(?:\s+with\s+(.+?))?(?:\s+containing\s+(.+))?$/.exec(value.trim());
  if (!m) throw new Error(`file check: "${value}" is not "<workspace>/<note>.md under <workspace>/<folder>/ [with key: value] [containing words]"`);
  const front = {};
  for (const part of (m[3] ?? "").split(/,\s*(?=[A-Za-z][\w-]*:\s)/).filter((p) => p.trim())) {
    const f = part.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!f) throw new Error(`file check: "${part.trim()}" is not a front matter line (key: value)`);
    front[f[1].toLowerCase()] = f[2];
  }
  return { note: m[1], place: m[2], front, containing: m[4]?.trim() ?? null };
}

/** The notes a question's `file` checks name, for the run to look up afterwards. */
export function filedNotes(question) {
  return [...new Set((question.checks ?? []).filter((check) => check.what === "file").map((check) => fileTarget(check.value).note))];
}

/**
 * Whether the note named is at the place named, and carries what the check
 * asks, from the record's `where`: note → `{ at, front, text }` where it is
 * now, or null when it is gone.
 */
function filed(value, where) {
  const { note, place, front, containing } = fileTarget(value);
  const now = where[note];
  if (!now || typeof now.at !== "string") return false;
  const at = place.endsWith("/") ? now.at.startsWith(place) : now.at === place;
  if (!at) return false;
  for (const [key, want] of Object.entries(front)) {
    const got = String(now.front?.[key] ?? "").trim();
    if (want === "*" ? got === "" : got.toLowerCase() !== want.toLowerCase()) return false;
  }
  return containing === null || String(now.text ?? "").toLowerCase().includes(containing.toLowerCase());
}

/** The question's checks graded on one answer, as verdicts. */
export function checkVerdicts(question, answer) {
  return (question.checks ?? []).map((check) => {
    const did = happened(check, answer);
    return {
      kind: check.kind,
      line: check.line,
      pass: check.kind === "must" ? did : !did,
      reason: `checked from the run's record: ${did ? "it did" : "it did not"}`,
    };
  });
}
