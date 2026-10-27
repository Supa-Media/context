/**
 * The changes a page may make to its own note, worked out from the note.
 *
 * The page runtime runs in a sealed frame and says what the reader did: typed
 * over these runs, ticked this task, picked this option, commented on these
 * words. The app turns each into a change of the note here, after reading the
 * note again, and refuses anything that does not land exactly on what the
 * note holds now. So the frame can only ever ask for an edit of words a reader
 * can see on the page, never a write to the front matter, a box's code or the
 * comment threads, and a request made against an older copy of the note is
 * refused rather than applied to the wrong characters.
 */

const { parsePage } = require("./parse.cjs");
const { escapeText } = require("./inline.cjs");

/** Every run of words the page draws as editable, as `from:to` keys. */
function editableRuns(page) {
  const keys = new Set();
  const add = (runs) => {
    for (const run of runs ?? []) if (!run.image && run.editable !== false && run.to > run.from) keys.add(`${run.from}:${run.to}`);
  };
  for (const node of page.nodes) {
    if (node.runs) add(node.runs);
    if (node.type === "list") for (const item of node.items) add(item.runs);
    if (node.type === "table") for (const row of [node.head, ...node.rows]) for (const cell of row) add(cell);
    if (node.type === "block") {
      for (const item of node.items) {
        if (item.label) add(item.label.runs);
        for (const part of item.parts) add(part.runs);
      }
    }
  }
  return keys;
}

/** Apply `{ from, to, text }` replacements, each of a whole editable run, or say why not. */
function applyRunEdits(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 200) return { error: "no edits" };
  const keys = editableRuns(parsePage(source));
  const sorted = [...edits].sort((a, b) => b.from - a.from);
  let prevFrom = Infinity;
  for (const edit of sorted) {
    if (!Number.isInteger(edit?.from) || !Number.isInteger(edit?.to) || typeof edit.text !== "string") return { error: "bad edit" };
    if (edit.text.length > 20_000) return { error: "too long" };
    if (!keys.has(`${edit.from}:${edit.to}`)) return { error: "stale" };
    if (edit.to > prevFrom) return { error: "overlap" };
    prevFrom = edit.from;
  }
  let text = source;
  for (const edit of sorted) text = text.slice(0, edit.from) + escapeText(edit.text) + text.slice(edit.to);
  return { text };
}

/** Tick or untick the task whose `[ ]` box starts at `at`. */
function toggleTask(source, at, checked) {
  const page = parsePage(source);
  for (const node of page.nodes) {
    if (node.type !== "list") continue;
    for (const item of node.items) {
      if (item.task && item.task.at === at) {
        const mark = checked ? "x" : " ";
        return { text: source.slice(0, at) + mark + source.slice(at + 1) };
      }
    }
  }
  return { error: "stale" };
}

/**
 * Write the reader's pick into a `choose` block as its `chosen:` setting, or
 * clear it with an empty option. Only a name the block offers is written.
 */
function chooseOption(source, blockFrom, option) {
  const page = parsePage(source);
  const block = page.nodes.find((node) => node.type === "block" && node.kind === "choose" && node.from === blockFrom);
  if (!block) return { error: "stale" };
  const names = block.items.map((item) => (item.label ? item.label : item.parts[0]).runs.map((run) => run.text ?? "").join("").trim());
  const value = typeof option === "string" ? option.trim() : "";
  if (value !== "" && !names.includes(value)) return { error: "not an option" };
  const written = value.replace(/[\r\n]+/g, " ");
  const chosen = block.settings.chosen;
  if (chosen) return { text: source.slice(0, chosen.lineFrom) + `chosen:${written ? ` ${written}` : ""}` + source.slice(chosen.lineTo) };
  if (written === "") return { text: source };
  if (!block.closed) return { error: "unclosed" };
  return { text: source.slice(0, block.closeFrom) + `chosen: ${written}\n` + source.slice(block.closeFrom) };
}

/** Whether `[from, to)` is words a reader sees: both ends inside editable runs, and not empty. */
function commentableRange(source, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > 2000) return false;
  const runs = [...editableRuns(parsePage(source))].map((key) => key.split(":").map(Number));
  const inside = (pos, end) => runs.some(([a, b]) => (end ? pos > a && pos <= b : pos >= a && pos < b));
  return inside(from, false) && inside(to, true);
}

module.exports = { editableRuns, applyRunEdits, toggleTask, chooseOption, commentableRange };
