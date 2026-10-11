// The meeting summary: what the model is asked, what it may answer, and the
// Markdown that answer becomes in the meeting note.
//
// Decided by the owner, 2026-10-09: every meeting, on every plan, gets a
// summary written into its note when it ends: a short summary, a table when
// amounts or dates came up, a chart when comparing numbers helps, and action
// items with a name and any date that was said. And, said with the approval:
// the note must still feel like a Markdown file. So the model never writes
// Markdown. It fills in a fixed shape (`SUMMARY_TOOL`), and this file renders
// that shape as ordinary paragraphs, `##` sections, pipe tables, `- [ ]`
// checkboxes and, for a chart, one `html-preview` block, which the editor draws
// and every other program shows as text.
//
// Rendering here rather than trusting model Markdown is what makes the write
// safe to splice into somebody's note: no line the model produces can become a
// `## My notes` heading, open a code fence that swallows the rest of the file,
// or put markup into the chart. Every string is collapsed to one line and
// escaped for where it lands.
//
// Model-agnostic like `enhance.js`: this builds requests and reads answers.
// Which model runs them, behind which gateway, is the caller's.

import { NOTES_HEADING, SUMMARY_HEADING, SUMMARY_PLACEHOLDER, TRANSCRIPT_CAVEAT, TRANSCRIPT_PLACEHOLDER, indexSections, parseMeetingNote } from "./note.js";
import { budgetTranscript } from "./enhance.js";

/* ------------------------------ note states ------------------------------ */

/** Written in place of a summary when the day's ceiling was reached. Recognized by its first words. */
export const SUMMARY_WAITING_PREFIX = "_This meeting will be summarized tomorrow.";

/** Written when a transcript is too short to say anything about. No model call is made. */
export const SUMMARY_TOO_SHORT = "_There wasn't enough said to summarize this meeting._";

/** Written when the model could not produce a summary. The next open tries again. */
export const SUMMARY_FAILED = "_Couldn't write a summary this time. Use Redo summary to try again._";

/** Fewer words than this and a transcript is a hallway "hello", not a meeting. */
export const MIN_TRANSCRIPT_WORDS = 40;

/** The free and Premium daily ceilings, as the waiting line states them. */
export const FREE_DAILY_SUMMARIES = 10;

/**
 * The line a note carries while it waits for tomorrow's allowance.
 *
 * @param {{paying: boolean}} options
 */
export function waitingSummary({ paying }) {
  const why = paying
    ? "Today's summaries for this workspace are used up."
    : `Free accounts get ${FREE_DAILY_SUMMARIES} summaries a day, and today's are used up.`;
  return `${SUMMARY_WAITING_PREFIX} ${why} Your notes and the transcript are saved below._`;
}

/**
 * What the `## Summary` section of a meeting note holds right now.
 *
 *   not_meeting  no `type: meeting` front matter, or no `## Summary` heading
 *   placeholder  never summarized
 *   waiting      held for tomorrow's allowance
 *   failed       the last try failed
 *   too_short    nothing worth summarizing was said
 *   written      anything else: a summary, by the model or by a person
 *
 * @param {string} markdown
 */
export function summaryState(markdown) {
  const parsed = parseMeetingNote(markdown);
  if (parsed.frontmatter.type !== "meeting" || summaryBounds(markdown) === null) return "not_meeting";
  const body = parsed.summary.trim();
  if (body === "" || body === SUMMARY_PLACEHOLDER) return "placeholder";
  if (body.startsWith(SUMMARY_WAITING_PREFIX)) return "waiting";
  if (body === SUMMARY_FAILED) return "failed";
  if (body === SUMMARY_TOO_SHORT) return "too_short";
  return "written";
}

/**
 * Should opening this note start a summary on its own? Only when nobody has
 * written one, and never over words a person typed there.
 *
 * @param {string} markdown
 */
export function needsAutomaticSummary(markdown) {
  const state = summaryState(markdown);
  return (
    (state === "placeholder" || state === "waiting" || state === "failed") &&
    !isStillRecording(markdown) &&
    transcriptWords(markdown) >= MIN_TRANSCRIPT_WORDS
  );
}

/** States in which the transcript is still growing, so a summary now would describe half a meeting. */
const LIVE_STATES = new Set(["idle", "recording", "paused", "finalizing"]);

/** Is this meeting still being recorded? A note with no `status:` is finished. */
export function isStillRecording(markdown) {
  return LIVE_STATES.has(parseMeetingNote(markdown).frontmatter.status);
}

/** The transcript as the model reads it: the section, minus our caveat and placeholder. */
export function transcriptText(markdown) {
  const raw = parseMeetingNote(markdown).transcript ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== TRANSCRIPT_CAVEAT && line.trim() !== TRANSCRIPT_PLACEHOLDER)
    .join("\n")
    .trim();
}

/** Words actually said: the transcript without its speaker labels and timestamps. */
export function transcriptWords(markdown) {
  const spoken = transcriptText(markdown)
    .replace(/\*\*[^*\n]{0,80}\*\*/g, " ")
    .replace(/\[?\b\d{1,2}:\d{2}(?::\d{2})?\]?/g, " ");
  const words = spoken.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/**
 * Where `## Summary` is and where its section ends (the next of `## My notes`
 * and `## Transcript`, else the end), as line indexes; `null` without one.
 * The summary writer replaces exactly these lines and nothing else.
 *
 * @param {string} markdown
 * @returns {{start: number, end: number}|null}
 */
export function summaryBounds(markdown) {
  const { summary, notes, transcript, lines } = indexSections(markdown);
  if (summary === -1) return null;
  const after = [notes, transcript].filter((index) => index > summary);
  return { start: summary, end: after.length ? Math.min(...after) : lines.length };
}

/**
 * The note with its summary section replaced, and nothing else touched: the
 * front matter, the title, `## My notes` and the transcript stay byte for byte.
 * `null` when the note has no `## Summary` heading to replace under.
 *
 * @param {string} markdown
 * @param {string} body
 */
export function replaceSummary(markdown, body) {
  const bounds = summaryBounds(markdown);
  if (bounds === null) return null;
  const lines = String(markdown).split("\n");
  const next = lines.slice(0, bounds.start + 1);
  next.push("", ...String(body).replace(/\s+$/, "").split("\n"), "");
  next.push(...lines.slice(bounds.end));
  return next.join("\n");
}

/* ------------------------------ the request ------------------------------ */

/**
 * How much transcript one request carries. About two and a half hours of
 * speech; the model reads far more, and a summary of the head and tail of a
 * longer one says so (`budgetTranscript`).
 */
export const SUMMARY_TRANSCRIPT_BUDGET = 120_000;

/** How long a Redo instruction may be. */
export const MAX_INSTRUCTION_CHARS = 500;

const LIMITS = Object.freeze({
  paragraphs: 4,
  paragraph: 1200,
  bullets: 12,
  bullet: 400,
  tables: 3,
  columns: 6,
  rows: 25,
  cell: 200,
  title: 80,
  chartItems: 12,
  label: 60,
  actions: 25,
  task: 300,
  owner: 60,
});

/**
 * The one tool the model is made to call. Its arguments are the whole answer.
 * Every field the renderer reads is here, and nothing else is read.
 */
export const SUMMARY_TOOL = Object.freeze({
  name: "write_meeting_summary",
  description: "Write the summary of this meeting. Call this exactly once with the whole summary.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "decisions", "tables", "chart", "action_items", "open_questions"],
    properties: {
      summary: {
        type: "array",
        description: "One to four short paragraphs, plain sentences, most important first. No headings, no bullets.",
        items: { type: "string" },
      },
      decisions: { type: "array", description: "Decisions actually made. Empty when none were.", items: { type: "string" } },
      tables: {
        type: "array",
        description: "Only when the meeting went through amounts, dates, options or people that read better as rows. Usually empty.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "columns", "rows"],
          properties: {
            title: { type: "string", description: "A short section title, e.g. 'Proposed 2027 budget'." },
            note: { type: "string", description: "One optional sentence under the title, e.g. that figures are working estimates." },
            columns: { type: "array", items: { type: "string" } },
            numeric: { type: "array", description: "For each column, true when it holds amounts or counts (right-aligned).", items: { type: "boolean" } },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          },
        },
      },
      chart: {
        description: "A bar chart, only when three or more numbers in the same unit are being compared and a picture helps. Otherwise null.",
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["title", "items"],
            properties: {
              title: { type: "string" },
              note: { type: "string" },
              unit: { type: "string", description: "Written before each value, e.g. '$'. Empty for plain counts." },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "value"],
                  properties: {
                    label: { type: "string" },
                    value: { type: "number", description: "The amount, or the low end of a range." },
                    high: { type: "number", description: "The high end, only when a range was given." },
                  },
                },
              },
            },
          },
        ],
      },
      action_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["owner", "task", "due"],
          properties: {
            owner: { type: ["string", "null"], description: "The person who took it, as they were named. null when nobody was named." },
            task: { type: "string" },
            due: { type: ["string", "null"], description: "YYYY-MM-DD when a date was said, else null." },
          },
        },
      },
      open_questions: { type: "array", description: "Questions left open. Empty when none.", items: { type: "string" } },
    },
  },
});

const SYSTEM = [
  "You write the summary section of a meeting note. It goes into somebody's own Markdown notes, and the people in the meeting will rely on it.",
  "",
  "Rules, in order of precedence:",
  "1. Use only what is in the transcript and the person's own notes. Never invent a name, amount, date or decision. Where something was unclear or only estimated, say so in the words (\"about\", \"roughly\", \"not decided\").",
  "2. The person's own typed notes show what they care about. Follow their emphasis, and never contradict them.",
  "3. Write for someone who missed the meeting: plain words, short sentences, the outcome first. Two to four short paragraphs at most. A ten-minute check-in gets one short paragraph.",
  "4. Action items: one per task, in the person's words. owner is the person who took it, exactly as named; null when nobody took it. due only when a date was actually said, as YYYY-MM-DD, using today's date to resolve words like \"Monday\".",
  "5. Tables only when the meeting walked through several amounts, dates, options or people that read better as rows. Most meetings have none.",
  "6. A chart only when three or more numbers in the same unit are being compared and seeing them side by side helps. Otherwise chart is null. Never chart something that is not in the meeting.",
  "7. Write in the language the meeting was held in.",
  "",
  `Answer by calling ${SUMMARY_TOOL.name} once.`,
].join("\n");

const CHECK_SYSTEM = [
  "You check a draft meeting summary against the transcript it was written from.",
  "",
  "Fix anything the transcript does not support: a wrong or invented name, amount, date, owner or decision. Remove an action item nobody agreed to. Set owner to null where nobody took a task. Mark estimates as estimates. Keep everything that is right, and keep the same shape and length.",
  "",
  `Answer by calling ${SUMMARY_TOOL.name} once with the corrected summary.`,
].join("\n");

function meetingFacts(markdown) {
  const parsed = parseMeetingNote(markdown);
  const front = parsed.frontmatter;
  const attendees = Array.isArray(front.attendees) ? front.attendees.filter(Boolean) : [];
  return {
    title: parsed.title,
    started: typeof front.started === "string" ? front.started : "",
    duration: typeof front.duration === "string" ? front.duration : "",
    attendees,
    notes: parsed.notes.trim(),
    transcript: budgetTranscript(transcriptText(markdown), SUMMARY_TRANSCRIPT_BUDGET),
  };
}

function cleanInstruction(instruction) {
  if (typeof instruction !== "string") return "";
  return instruction.replace(/\s+/g, " ").trim().slice(0, MAX_INSTRUCTION_CHARS);
}

function meetingMessage(markdown, today) {
  const facts = meetingFacts(markdown);
  return [
    `Today: ${today}`,
    `Title: ${facts.title}`,
    `Started: ${facts.started}`,
    `Length: ${facts.duration}`,
    `Attendees: ${facts.attendees.length ? facts.attendees.join(", ") : "not recorded"}`,
    "",
    "## Their own notes",
    "",
    facts.notes || "_They typed nothing._",
    "",
    "## Transcript",
    "",
    facts.transcript || "_No transcript._",
  ].join("\n");
}

/**
 * The first request: write the summary.
 *
 * @param {string} markdown the whole meeting note
 * @param {{instruction?: string, today: string}} options `today` as YYYY-MM-DD
 * @returns {{system: string, user: string}}
 */
export function buildSummaryRequest(markdown, { instruction, today }) {
  const asked = cleanInstruction(instruction);
  const user = [
    meetingMessage(markdown, today),
    ...(asked
      ? ["", "## What they asked for this time", "", "Follow this where the rules allow; it never overrides rule 1.", "", asked]
      : []),
  ].join("\n");
  return { system: SYSTEM, user };
}

/**
 * The second request: check the draft against the transcript.
 *
 * @param {string} markdown
 * @param {object} draft the first answer, as `readSummaryOutput` returned it
 * @param {{today: string}} options
 */
export function buildCheckRequest(markdown, draft, { today }) {
  const user = [meetingMessage(markdown, today), "", "## Draft summary to check", "", JSON.stringify(draft)].join("\n");
  return { system: CHECK_SYSTEM, user };
}

/* ------------------------------- the answer ------------------------------ */

function oneLine(value, max) {
  if (typeof value !== "string") return "";
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function strings(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => oneLine(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The model's tool arguments, reduced to exactly what the renderer reads, with
 * every string one bounded line. `null` when there is no summary to write.
 *
 * @param {unknown} args
 */
export function readSummaryOutput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const summary = strings(args.summary, LIMITS.paragraphs, LIMITS.paragraph);
  if (summary.length === 0) return null;

  const tables = (Array.isArray(args.tables) ? args.tables : [])
    .map((table) => {
      if (!table || typeof table !== "object") return null;
      const columns = strings(table.columns, LIMITS.columns, LIMITS.cell);
      if (columns.length < 2) return null;
      const rows = (Array.isArray(table.rows) ? table.rows : [])
        .filter(Array.isArray)
        .slice(0, LIMITS.rows)
        .map((row) => columns.map((_, i) => oneLine(row[i], LIMITS.cell)))
        .filter((row) => row.some(Boolean));
      if (rows.length === 0) return null;
      const numeric = columns.map((_, i) => Array.isArray(table.numeric) && table.numeric[i] === true);
      return { title: oneLine(table.title, LIMITS.title) || "Details", note: oneLine(table.note, LIMITS.paragraph), columns, numeric, rows };
    })
    .filter(Boolean)
    .slice(0, LIMITS.tables);

  let chart = null;
  if (args.chart && typeof args.chart === "object" && Array.isArray(args.chart.items)) {
    const items = args.chart.items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const label = oneLine(item.label, LIMITS.label);
        const value = finite(item.value);
        if (!label || value === null || value < 0) return null;
        const high = finite(item.high);
        return { label, value, high: high !== null && high > value ? high : null };
      })
      .filter(Boolean)
      .slice(0, LIMITS.chartItems);
    if (items.length >= 3 && items.some((item) => (item.high ?? item.value) > 0)) {
      chart = {
        title: oneLine(args.chart.title, LIMITS.title) || "Compared",
        note: oneLine(args.chart.note, LIMITS.paragraph),
        unit: oneLine(args.chart.unit, 4),
        items,
      };
    }
  }

  const actions = (Array.isArray(args.action_items) ? args.action_items : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const task = oneLine(item.task, LIMITS.task);
      if (!task) return null;
      const owner = oneLine(item.owner, LIMITS.owner) || null;
      const due = typeof item.due === "string" && DATE.test(item.due.trim()) ? item.due.trim() : null;
      return { owner, task, due };
    })
    .filter(Boolean)
    .slice(0, LIMITS.actions);

  return {
    summary,
    decisions: strings(args.decisions, LIMITS.bullets, LIMITS.bullet),
    tables,
    chart,
    action_items: actions,
    open_questions: strings(args.open_questions, LIMITS.bullets, LIMITS.bullet),
  };
}

/* ------------------------------ the Markdown ----------------------------- */

const RESERVED_TITLES = new Set([SUMMARY_HEADING, NOTES_HEADING, "## Transcript"].map((h) => h.slice(3).toLowerCase()));

/**
 * One line of model text made safe to stand at the start of a Markdown line:
 * it cannot open a heading, a fence, a quote, a list, a table or raw HTML.
 */
function prose(text) {
  return inline(text).replace(/^([#>|`~+*=-]|\d+[.)])/, "\\$1");
}

/** Text in the middle of a line: no raw HTML, whatever renders the file. */
function inline(text) {
  return text.replace(/</g, "\\<");
}

/** A table cell: one line, with its pipes escaped. */
function cell(text) {
  return prose(text).replace(/\|/g, "\\|");
}

function sectionTitle(title) {
  const plain = title.replace(/^#+\s*/, "").trim() || "Details";
  return RESERVED_TITLES.has(plain.toLowerCase()) ? `${plain} (from the call)` : plain;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatNumber(value) {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return rounded.toLocaleString("en-US");
}

const CHART = Object.freeze({ width: 640, row: 30, top: 54, label: 200, value: 120, gap: 12, bottom: 34 });

/**
 * A horizontal bar chart as one `html-preview` block: inline SVG, no script,
 * nothing fetched. The editor draws it in a sandboxed frame; anywhere else it is
 * a readable block of text. Every model string in it is HTML-escaped.
 *
 * @param {{title: string, note: string, unit: string, items: Array<{label: string, value: number, high: number|null}>}} chart
 */
export function renderChart(chart) {
  const { width, row, top, label, value, gap, bottom } = CHART;
  const max = Math.max(...chart.items.map((item) => item.high ?? item.value));
  const track = width - label - value - gap * 2;
  const height = top + chart.items.length * row + bottom;
  const amount = (n) => `${chart.unit}${formatNumber(n)}`;
  const bars = chart.items.map((item, i) => {
    const y = top + i * row;
    const solid = max > 0 ? (item.value / max) * track : 0;
    const range = item.high !== null && max > 0 ? ((item.high - item.value) / max) * track : 0;
    const shown = item.high !== null ? `${amount(item.value)}–${amount(item.high)}` : amount(item.value);
    return [
      `<text x="0" y="${y + 19}" class="l">${escapeHtml(item.label.length > 30 ? `${item.label.slice(0, 29).trimEnd()}…` : item.label)}</text>`,
      `<rect x="${label + gap}" y="${y + 8}" width="${solid.toFixed(1)}" height="14" rx="2" fill="#0E6C69"/>`,
      range > 0 ? `<rect x="${(label + gap + solid).toFixed(1)}" y="${y + 8}" width="${range.toFixed(1)}" height="14" fill="url(#range)"/>` : "",
      `<text x="${width}" y="${y + 19}" class="v">${escapeHtml(shown)}</text>`,
    ].filter(Boolean).join("");
  });
  const hasRange = chart.items.some((item) => item.high !== null);
  const legendY = height - 10;
  return [
    `\`\`\`html-preview height=${height + 24}`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(chart.title)}">`,
    "<style>text{font:13px system-ui,sans-serif;fill:#4A443C}.t{font-weight:600;font-size:14px;fill:#1A1714}.n,.k{font-size:12px;fill:#7A7264}.v{text-anchor:end;font-weight:600;fill:#1A1714}</style>",
    '<defs><pattern id="range" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#B8D8D5"/><rect width="3" height="6" fill="#7FB5B0"/></pattern></defs>',
    `<text x="0" y="18" class="t">${escapeHtml(chart.title)}</text>`,
    chart.note ? `<text x="0" y="38" class="n">${escapeHtml(chart.note)}</text>` : "",
    ...bars,
    `<rect x="0" y="${legendY - 9}" width="10" height="10" rx="2" fill="#0E6C69"/><text x="16" y="${legendY}" class="k">Amount</text>`,
    hasRange ? `<rect x="90" y="${legendY - 9}" width="10" height="10" fill="url(#range)"/><text x="106" y="${legendY}" class="k">Upper end of a range</text>` : "",
    "</svg>",
    "```",
  ].filter(Boolean).join("\n");
}

function renderTable(table) {
  const header = `| ${table.columns.map(cell).join(" | ")} |`;
  const rule = `| ${table.numeric.map((n) => (n ? "---:" : "---")).join(" | ")} |`;
  const rows = table.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [`## ${prose(sectionTitle(table.title))}`, "", ...(table.note ? [prose(table.note), ""] : []), header, rule, ...rows];
}

function renderAction(item) {
  const due = item.due ? ` (due ${item.due})` : "";
  const task = inline(item.task);
  if (item.owner) return `- [ ] ${inline(item.owner.replace(/[[\]:]/g, ""))}: ${task}${due}`;
  return `- [ ] ${task.replace(/[.\s]+$/, "")}${due}. No one was named on the call.`;
}

/**
 * The body of `## Summary`, from `readSummaryOutput`'s answer: plain
 * paragraphs, then `##` sections a person would have written by hand.
 *
 * @param {ReturnType<typeof readSummaryOutput>} output
 */
export function renderSummary(output) {
  const out = [];
  for (const paragraph of output.summary) out.push(prose(paragraph), "");
  if (output.decisions.length) out.push("## Decisions", "", ...output.decisions.map((d) => `- ${inline(d)}`), "");
  for (const table of output.tables) out.push(...renderTable(table), "");
  if (output.chart) out.push(renderChart(output.chart), "");
  if (output.action_items.length) out.push("## Action items", "", ...output.action_items.map(renderAction), "");
  if (output.open_questions.length) out.push("## Open questions", "", ...output.open_questions.map((q) => `- ${inline(q)}`), "");
  return out.join("\n").replace(/\n+$/, "");
}
