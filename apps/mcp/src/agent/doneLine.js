/**
 * The line a texted yes gets back once the held call has run.
 *
 * An approval's summary is the gateway's own imperative ("send a bug report to
 * the Context team"), because it is first read as a question: the approvals
 * list, the ask line, "I tried to …". Echoed back after the yes it read as an
 * order, "Done: send a bug report to the Context team." (owner, 2026-10-18).
 * So the confirmation puts each clause's leading verb in the past tense:
 * "Done, I sent a bug report to the Context team."
 *
 * Only verbs listed here are changed. Every summary the gateway builds starts
 * with one; a summary that starts with anything else (a tool's bare name) keeps
 * the old "Done: …" form rather than guessing at a word.
 */

const PAST = {
  add: "added",
  cancel: "cancelled",
  change: "changed",
  claim: "claimed",
  fetch: "fetched",
  invite: "invited",
  let: "let",
  make: "made",
  move: "moved",
  publish: "published",
  save: "saved",
  send: "sent",
  share: "shared",
  take: "took",
  write: "wrote",
};

/** "verb rest" → "past rest", or null when the clause does not start with a known verb. */
function pastClause(clause) {
  const match = /^([a-z]+)(\b[\s\S]*)$/.exec(clause);
  const past = match ? PAST[match[1]] : undefined;
  return past === undefined ? null : past + match[2];
}

/**
 * Split on ", and " outside double quotes: facets of one call are joined that
 * way (`privacy/widening.js`), and an email subject or event title may carry
 * the same words without starting a clause.
 */
function clauses(summary) {
  const parts = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < summary.length; i += 1) {
    if (summary[i] === '"') quoted = !quoted;
    else if (!quoted && summary.startsWith(", and ", i)) {
      parts.push(summary.slice(start, i));
      start = i + ", and ".length;
      i = start - 1;
    }
  }
  parts.push(summary.slice(start));
  return parts;
}

/** "send a bug report to the Context team" → "Done, I sent a bug report to the Context team." */
export function doneLine(summary) {
  const text = String(summary ?? "").trim().replace(/[.\s]+$/, "");
  if (text === "") return "Done.";
  const parts = clauses(text);
  const first = pastClause(parts[0]);
  if (first === null) return `Done: ${text}.`;
  const rest = parts.slice(1).map((part) => pastClause(part) ?? part);
  return `Done, I ${[first, ...rest].join(", and ")}.`;
}
