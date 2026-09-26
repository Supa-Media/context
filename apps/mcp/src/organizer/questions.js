/**
 * Auto-organize: what Jev is shown and what it is asked.
 *
 * Jev reads well and counts badly, and it reads dates as text. So everything
 * that is arithmetic — how long a folder has been quiet, how many checkboxes
 * are ticked — is computed here and handed over as a plain sentence, and Jev
 * is only asked what reading is for: does this say the work shipped, does it
 * still list things to do, which folder does this belong in.
 *
 * Every choice carries an explicit way out ("unclear", "stay"), because Jev
 * always picks one of the options it is given.
 */

import { CLOSED_STATUSES } from "../lists/grammar.js";
import { noteHeading, noteProperties } from "../lists/properties.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Of a note's body, what Jev reads. Its window is 32K tokens; this is ~4K. */
export const STATE_BODY_CHARS = 16_000;

/** Ticked and unticked Markdown checkboxes, outside code fences. */
export function checkboxCounts(text) {
  let done = 0;
  let open = 0;
  let fence = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const box = /^\s*[-*+]\s+\[([ xX])\]\s/.exec(line);
    if (!box) continue;
    if (box[1] === " ") open += 1;
    else done += 1;
  }
  return { done, open };
}

export function quietDays(updatedAt, now) {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return Math.max(0, Math.floor((now - updatedAt) / DAY_MS));
}

/** "3 weeks", "5 days", "2 months": how a person would say it. */
export function spokenSpan(days) {
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function isClosedStatus(status) {
  return CLOSED_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

/** Facts about one project, all computed, none guessed. */
export function projectFacts(project, text, now) {
  const properties = noteProperties(text);
  const status = typeof properties.status === "string" ? properties.status.trim() : null;
  const boxes = checkboxCounts(text);
  const quiet = quietDays(project.updatedAt, now);
  return {
    status,
    closed: isClosedStatus(status),
    title: noteHeading(text) || project.title,
    boxes,
    quiet,
    optedOut: String(properties.organize ?? "").trim().toLowerCase() === "off",
  };
}

function factSentences(facts) {
  const lines = [];
  if (facts.status) lines.push(`Its status field says "${facts.status}".`);
  if (facts.boxes.done + facts.boxes.open > 0) {
    lines.push(
      facts.boxes.open === 0
        ? `All ${facts.boxes.done} of its checklist items are ticked.`
        : `${facts.boxes.open} of its ${facts.boxes.done + facts.boxes.open} checklist items are still unticked.`,
    );
  }
  if (facts.quiet !== null) {
    lines.push(facts.quiet === 0 ? "It was edited today." : `Nothing in it has changed for ${spokenSpan(facts.quiet)}.`);
  }
  return lines;
}

function body(text) {
  const source = String(text ?? "");
  return source.length > STATE_BODY_CHARS ? `${source.slice(0, STATE_BODY_CHARS)}\n[…]` : source;
}

/** The Jev request for one open project. */
export function projectRequest(project, text, facts) {
  const state = [
    `Project: ${facts.title}`,
    "Facts (computed, reliable):",
    ...factSentences(facts).map((line) => `- ${line}`),
    "",
    "The project's note:",
    body(text),
  ].join("\n");
  return {
    state,
    questions: {
      stage: {
        type: "choice",
        instructions: "Judging by the note and the facts, where is this project now?",
        criteria: {
          active: "Work is still going on or planned",
          blocked: "It is waiting on someone or something",
          done: "The work it describes is finished",
          unclear: "The note does not say enough to tell",
        },
      },
      shipped: {
        type: "noul",
        instructions: "Does the note say the work shipped, merged, launched, was fixed or was completed?",
        criteria: { true: "It says the work is done or live", false: "It does not say that" },
      },
      open_steps: {
        type: "noul",
        instructions: "Does the note still list next steps or open items that are not done?",
        criteria: { true: "There are still open next steps", false: "No open next steps remain" },
      },
    },
  };
}

/** Choice option keys: `stay`, then `d0`…`dN` in destination order. */
export function destinationKey(index) {
  return `d${index}`;
}

/** The Jev request for one inbox note, with every destination as an option. */
export function inboxRequest(note, text, destinations) {
  const criteria = { stay: "None of these: leave it in the inbox" };
  destinations.forEach((destination, index) => {
    criteria[destinationKey(index)] = `${destination.title} (${destination.group})`;
  });
  return {
    state: [`Note: ${noteHeading(text) || note.title}`, note.meeting ? "It is a meeting note." : "", "", body(text)]
      .filter((line, index) => line !== "" || index > 1)
      .join("\n"),
    questions: {
      destination: {
        type: "choice",
        instructions: "Which folder is this note about or does it belong in?",
        criteria,
      },
    },
  };
}
