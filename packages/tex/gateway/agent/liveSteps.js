/**
 * LIVE RUN CARD: WHAT TEX IS DOING WHILE A TURN RUNS.
 *
 * A turn in the app can take a while, and a person who only sees a spinner
 * cannot tell a slow answer from a stuck one. So the turn's own steps (the
 * model's thinking in words, and each tool call it makes) are shown as they
 * happen, in a small run card under the chat.
 *
 * This module is the shaping of those steps, and nothing else. It turns one
 * event the turn already reports (`turn.js`, `tell`) into a short plain step,
 * keeps the last few of them in order, and wraps the callback so a step that
 * fails to show never reaches the turn. It reads no note, sends nothing and
 * keeps nothing: the card is a view of the turn's own events, and the turn's
 * ledger and answer are unchanged by it.
 *
 * Text is cut short here so a card stays small. Argument values are shown
 * only for a few known keys (a search, a path, a recipient), and a result is
 * shown as its first line with the metadata lines the tools add skipped.
 * Nothing here logs.
 */

/** The most steps a card keeps: the last ones, the rest scrolled away. */
export const MAX_LIVE_STEPS = 40;

const THINK_CHARS = 280;
const NAME_CHARS = 40;
const WHAT_CHARS = 120;
const RES_CHARS = 140;

/** The argument keys a step's main value is read from, first match wins. */
const WHAT_KEYS = ["query", "q", "path", "prefix", "id", "url", "to", "subject", "text", "title"];

/** Result lines the tools put first that say nothing about what was found. */
const META_LINE = /^(etag|path|link|visibility|document_id):/;

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Cut a string to at most `max` characters, ending with "…" when it was cut.
 * Cuts on a word boundary when one falls in the back half of the text.
 */
function cut(text, max) {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  if (space >= Math.floor((max - 1) / 2)) head = head.slice(0, space);
  // Never leave half of a surrogate pair at the end.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

function mainArgument(args) {
  if (args === null || typeof args !== "object") return null;
  for (const key of WHAT_KEYS) {
    if (typeof args[key] !== "string") continue;
    const value = collapse(args[key]);
    if (value !== "") return cut(value, WHAT_CHARS);
  }
  return null;
}

function firstResultLine(result) {
  for (const line of result.split(/\r?\n/)) {
    if (META_LINE.test(line.trim())) continue;
    const value = collapse(line);
    if (value !== "") return cut(value, RES_CHARS);
  }
  return null;
}

/**
 * One turn event as a live step, or null when it is not one a card shows.
 *
 * `at` is milliseconds since the turn began. A thinking event becomes
 * `{ k: "think", at, text }`; a tool event becomes
 * `{ k: "tool", at, name, what?, ok, ms?, res?, held? }`, where a call the
 * model wrote as one of the six tools (`event.as`) shows as what it wrote.
 */
export function liveStepOf(event, at) {
  const when = Number.isFinite(at) ? at : 0;
  if (event === null || typeof event !== "object") return null;

  if (event.kind === "thinking") {
    if (typeof event.text !== "string") return null;
    const text = collapse(event.text);
    if (text === "") return null;
    return { k: "think", at: when, text: cut(text, THINK_CHARS) };
  }

  if (event.kind === "tool") {
    if (typeof event.name !== "string") return null;
    const name = typeof event.as?.name === "string" ? event.as.name : event.name;
    const step = { k: "tool", at: when, name: cut(collapse(name), NAME_CHARS), ok: event.ok !== false };

    const what = mainArgument(event.as?.args ?? event.args);
    if (what !== null) step.what = what;

    if (Number.isFinite(event.ms) && event.ms > 0) step.ms = Math.round(event.ms);

    if (step.ok === false && typeof event.reason === "string" && collapse(event.reason) !== "") {
      step.res = cut(collapse(event.reason), RES_CHARS);
    } else if (typeof event.result === "string" && event.result !== "") {
      const res = firstResultLine(event.result);
      if (res !== null) step.res = res;
    }

    if (event.held === true) step.held = true;
    return step;
  }

  return null;
}

/**
 * The card's steps with `step` added. Keeps the last MAX_LIVE_STEPS. A
 * thinking step right after another thinking step replaces it when its text
 * extends the earlier one, because thinking streams in pieces; otherwise it
 * is appended like any other step. A null step returns `steps` unchanged.
 */
export function keepLive(steps, step) {
  const list = Array.isArray(steps) ? steps : [];
  if (step === null || step === undefined) return steps;

  const last = list.at(-1);
  if (step.k === "think" && last?.k === "think") {
    // A cut text ends in "…", which the longer text that extends it does not have.
    const before = last.text.replace(/…$/, "");
    const after = step.text.replace(/…$/, "");
    if (before !== "" && after.startsWith(before)) return [...list.slice(0, -1), step];
  }

  const next = [...list, step];
  return next.length > MAX_LIVE_STEPS ? next.slice(next.length - MAX_LIVE_STEPS) : next;
}

/**
 * An observer for the turn's `observe` callback: each event becomes a live
 * step, timed from when this observer was made, and `write(step)` is called
 * with it. Never throws: a step that fails to show is dropped.
 */
export function liveObserver(write, now = Date.now) {
  let start = 0;
  try {
    start = now();
  } catch {
    // Timing is a nicety; the card still shows its steps.
  }
  return (event) => {
    try {
      const step = liveStepOf(event, now() - start);
      if (step !== null) write(step);
    } catch {
      // A step that failed to show costs a line of the card, never the turn.
    }
  };
}

/**
 * The turn's `observe` with the app's run card beside it: `live` (the stream's writer, `progress.js`) is handed each
 * step when the ask asked for it (`on`), after the turn's own observer has its event. Unchanged otherwise, and
 * never added to a turn that had no observer.
 */
export function withLive(live, on, observe) {
  // Never a watcher where the turn had none: that would change what its prompt is told (`turnPrompt.js`).
  if (typeof live !== "function" || on !== true || typeof observe !== "function") return observe;
  const card = liveObserver((step) => void Promise.resolve(live(step)).catch(() => {}));
  return (event) => {
    observe(event);
    card(event);
  };
}
