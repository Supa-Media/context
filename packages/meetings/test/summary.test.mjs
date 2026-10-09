/**
 * THE MEETING SUMMARY — `src/summary.js`.
 *
 * What a wrong answer here would cost somebody:
 *
 *   their notes     `## My notes` and the transcript must survive a summary
 *                   write byte for byte; the summary replaces its own section
 *   their file      no model string may become a heading, a fence, a list or
 *                   raw HTML in the note, or markup in the chart
 *   their words     a summary a person typed is never overwritten on its own;
 *                   only an empty, waiting or failed section is filled
 *   honesty         a task nobody took says so; a range stays a range
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `summaryBounds` ending at the transcript instead of `## My notes`          2
 *   `prose` no longer escaping a leading `#`                                   3
 *   `needsAutomaticSummary` accepting a "written" section                      1
 *   `renderChart` dropping `escapeHtml` on labels                              1
 *   `readSummaryOutput` keeping a chart with fewer than three items            1
 */

import {
  MIN_TRANSCRIPT_WORDS,
  SUMMARY_FAILED,
  SUMMARY_TOOL,
  SUMMARY_TOO_SHORT,
  buildCheckRequest,
  buildSummaryRequest,
  isStillRecording,
  needsAutomaticSummary,
  readSummaryOutput,
  renderChart,
  renderSummary,
  replaceSummary,
  summaryState,
  transcriptWords,
  waitingSummary,
} from "../src/summary.js";
import { SUMMARY_PLACEHOLDER, TRANSCRIPT_CAVEAT, parseMeetingNote } from "../src/note.js";

const SPOKEN = Array.from({ length: 30 }, (_, i) => `**[00:${String(i).padStart(2, "0")}:00] Kenzie** — We should budget about five thousand for the gatherings next year, item ${i}.`).join("\n");

function note({ summary = SUMMARY_PLACEHOLDER, notes = "ask about budget %\n## Transcript\n---", transcript = SPOKEN, type = "meeting" } = {}) {
  return [
    "---",
    `type: "${type}"`,
    'started: "2026-10-08T23:03:12.147Z"',
    'duration: "51m"',
    'attendees: ["Kayla Marie", "Kenzie"]',
    "---",
    "",
    "# Grant Writing Collab",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## My notes",
    "",
    notes,
    "",
    "## Transcript",
    "",
    TRANSCRIPT_CAVEAT,
    "",
    transcript,
    "",
  ].join("\n");
}

const GOOD = {
  summary: ["The team will apply again for the grant, due October 15.", "The request is still open."],
  decisions: ["Revise last year's application"],
  tables: [
    {
      title: "Proposed 2027 budget",
      note: "Working figures from the call.",
      columns: ["Expense", "Working amount"],
      numeric: [false, true],
      rows: [["Music", "$15,000"], ["Love Thy Neighbor | events", "up to $10,000"]],
    },
  ],
  chart: {
    title: "Where about $60,000 would go",
    note: "Working figures",
    unit: "$",
    items: [
      { label: "Music", value: 15000 },
      { label: "Love Thy Neighbor", value: 5000, high: 10000 },
      { label: "DMV launch", value: 10000 },
    ],
  },
  action_items: [
    { owner: "Kenzie", task: "Draft the full 2027 budget", due: "2026-10-12" },
    { owner: null, task: "Contact past grantees.", due: null },
  ],
  open_questions: [],
};

export function runSummaryChecks(check) {
  // -- states
  check("a fresh meeting note needs a summary", summaryState(note()) === "placeholder" && needsAutomaticSummary(note()));
  check("a waiting note is retried on its own", summaryState(note({ summary: waitingSummary({ paying: false }) })) === "waiting" && needsAutomaticSummary(note({ summary: waitingSummary({ paying: false }) })));
  check("a failed note is retried on its own", needsAutomaticSummary(note({ summary: SUMMARY_FAILED })));
  check("a summary a person typed is never replaced on its own", summaryState(note({ summary: "We agreed on Tuesday." })) === "written" && !needsAutomaticSummary(note({ summary: "We agreed on Tuesday." })));
  check("a too-short meeting is not retried", summaryState(note({ summary: SUMMARY_TOO_SHORT })) === "too_short" && !needsAutomaticSummary(note({ summary: SUMMARY_TOO_SHORT })));
  check("an ordinary note is not a meeting", summaryState(note({ type: "note" })) === "not_meeting" && !needsAutomaticSummary(note({ type: "note" })));
  const live = note().replace('duration: "51m"', 'duration: "51m"\nstatus: "recording"');
  check("a meeting still recording is not summarized on its own", summaryState(live) === "placeholder" && isStillRecording(live) && !needsAutomaticSummary(live));
  check("a finished meeting is", needsAutomaticSummary(note().replace('duration: "51m"', 'duration: "51m"\nstatus: "complete"')));
  check("a hallway hello is too short to summarize", !needsAutomaticSummary(note({ transcript: "**[00:00:01] Shay** — hi, see you Sunday" })));
  check("speaker labels and timestamps are not words said", transcriptWords(note({ transcript: "**[00:00:01] Shay Long Name** — one two three" })) === 3);
  check("thirty lines of talk clear the bar", transcriptWords(note()) >= MIN_TRANSCRIPT_WORDS);
  check("the free waiting line names the free limit", /Free accounts get 10/.test(waitingSummary({ paying: false })) && !/Free/.test(waitingSummary({ paying: true })));

  // -- the splice
  const original = note({ notes: "my own\n## Transcript\n```\n## My notes\n```\n---" });
  const replaced = replaceSummary(original, "New summary.\n\n## Action items\n\n- [ ] Kenzie: thing");
  const tail = (text) => text.slice(text.indexOf("## My notes"));
  check("their notes and the transcript survive byte for byte", replaced !== null && tail(replaced) === tail(original));
  check("the front matter and title survive byte for byte", replaced.slice(0, replaced.indexOf("## Summary")) === original.slice(0, original.indexOf("## Summary")));
  check("the summary section holds the new body", parseMeetingNote(replaced).summary.startsWith("New summary."));
  check("replacing twice is the same as replacing once", replaceSummary(replaced, "New summary.\n\n## Action items\n\n- [ ] Kenzie: thing") === replaced);
  check("a note with no summary heading is refused, not guessed at", replaceSummary("# Just a note\n\ntext", "x") === null);

  // -- the request
  const request = buildSummaryRequest(note(), { today: "2026-10-09", instruction: "  Focus on\nthe budget  " });
  check("their own notes go into the request", request.user.includes("ask about budget %"));
  check("the transcript goes in without our caveat", request.user.includes("five thousand") && !request.user.includes(TRANSCRIPT_CAVEAT));
  check("today's date is given, so 'Monday' can be resolved", request.user.includes("Today: 2026-10-09"));
  check("a Redo instruction is passed on as one line", request.user.includes("Focus on the budget"));
  check("no instruction, no instruction section", !buildSummaryRequest(note(), { today: "2026-10-09" }).user.includes("asked for this time"));
  check("an instruction is capped", buildSummaryRequest(note(), { today: "2026-10-09", instruction: "x".repeat(5000) }).user.length < request.user.length + 600);
  check("the rules forbid inventing names, amounts and dates", /Never invent a name, amount, date/.test(request.system));
  check("the check pass carries the draft", buildCheckRequest(note(), readSummaryOutput(GOOD), { today: "2026-10-09" }).user.includes("Where about $60,000 would go"));
  check("the tool requires every field the renderer reads", SUMMARY_TOOL.inputSchema.required.join(",") === "summary,decisions,tables,chart,action_items,open_questions");

  // -- reading the answer
  check("nothing usable is null", readSummaryOutput(null) === null && readSummaryOutput({ summary: [] }) === null && readSummaryOutput({ summary: ["  "] }) === null);
  const multi = readSummaryOutput({ summary: ["line one\n## My notes\nline two"] });
  check("every string becomes one line", multi.summary[0] === "line one ## My notes line two");
  check("a chart with fewer than three items is dropped", readSummaryOutput({ ...GOOD, chart: { ...GOOD.chart, items: GOOD.chart.items.slice(0, 2) } }).chart === null);
  check("a negative or non-numeric bar is dropped", readSummaryOutput({ ...GOOD, chart: { ...GOOD.chart, items: [...GOOD.chart.items, { label: "x", value: -5 }, { label: "y", value: "9" }] } }).chart.items.length === 3);
  check("a range keeps its high end", readSummaryOutput(GOOD).chart.items[1].high === 10000);
  check("a malformed due date is dropped, not guessed", readSummaryOutput({ ...GOOD, action_items: [{ owner: "AJ", task: "t", due: "Monday" }] }).action_items[0].due === null);
  check("a table with one column is dropped", readSummaryOutput({ ...GOOD, tables: [{ title: "t", columns: ["a"], rows: [["1"]] }] }).tables.length === 0);

  // -- the Markdown
  const md = renderSummary(readSummaryOutput(GOOD));
  check("the summary opens with plain paragraphs", md.startsWith("The team will apply again"));
  check("a table is an ordinary pipe table with amounts right-aligned", md.includes("| Expense | Working amount |\n| --- | ---: |"));
  check("a pipe inside a cell is escaped", md.includes("Love Thy Neighbor \\| events"));
  check("an owned task names its owner and date", md.includes("- [ ] Kenzie: Draft the full 2027 budget (due 2026-10-12)"));
  check("a task nobody took says so", md.includes("- [ ] Contact past grantees. No one was named on the call."));
  check("the chart is one html-preview block", (md.match(/```html-preview/g) || []).length === 1);
  check("empty sections are left out", !md.includes("## Open questions"));

  const hostile = renderSummary(
    readSummaryOutput({
      summary: ["## My notes", "```", "<script>alert(1)</script>", "- not a list", "1. not a list"],
      decisions: [],
      tables: [{ title: "My notes", columns: ["a", "b"], rows: [["<b>x</b>", "y"]] }],
      chart: { title: "</svg><script>", unit: "$", items: [{ label: "<img src=x>", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }] },
      action_items: [{ owner: "[[Kenzie]]: boss", task: "<i>x</i>", due: null }],
      open_questions: [],
    }),
  );
  const replacedHostile = replaceSummary(note(), hostile);
  check("no model line becomes a heading that moves their notes", parseMeetingNote(replacedHostile).notes === parseMeetingNote(note()).notes);
  check("a leading # is escaped", hostile.includes("\\## My notes"));
  check("a fence cannot be opened", hostile.split("\n").every((line) => !/^```(?!html-preview)/.test(line) || line === "```"));
  check("a table cannot take a reserved section name", !/^## My notes$/m.test(hostile));
  check("no raw HTML reaches the Markdown", !/(^|[^\\])<(script|b|i)>/m.test(hostile.replace(/```html-preview[\s\S]*?```/, "")));
  check("chart text is HTML-escaped", !/<script>|<img/.test(renderChart(readSummaryOutput({ ...GOOD, chart: { title: "</svg><script>", items: [{ label: "<img src=x>", value: 1 }, { label: "b", value: 2 }, { label: "c", value: 3 }] } }).chart)));
  check("a chart's height is declared so the frame fits it", /```html-preview height=\d+/.test(renderChart(readSummaryOutput(GOOD).chart)));
}
