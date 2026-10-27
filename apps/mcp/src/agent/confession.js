/**
 * A CONFESSION THE RECORD CONTRADICTS.
 *
 * On 2026-10-27 a person asked where a time-log entry came from, then got
 * angry. Tex had read their calendar, searched their mail and listed the
 * note's changes (the turn's own record says so), yet answered "I made up
 * 10:03 … I also said I'd looked through your calendar and mail, and I
 * hadn't." The first claim was wrong the other way (10:03 was a real change,
 * Tex's own write), the second was false. Agreeing with an angry correction
 * without checking is the same dishonesty as the mistake it apologizes for
 * (@context-lc areas/tex-reviews/themes/caves-under-pressure.md).
 *
 * So an answer that disowns a read, or calls a figure made up, is checked
 * against the tools this turn and the last few texts actually ran. When the
 * record says otherwise, the model gets one more round to look at what those
 * reads returned and say plainly which part of the correction is right.
 */

/** What a person calls a source, and the tools that read it. */
const SOURCES = [
  { name: "calendar", words: /\bcalendar\b/i, tools: ["read_calendar", "calendar_days"] },
  { name: "mail", words: /\b(?:e-?mails?|mail|inbox|gmail)\b/i, tools: ["search_email", "read_email"] },
  { name: "notes", words: /\bnotes?\b|\bedits?\b|\bchanges?\b/i, tools: ["read_note", "search_notes", "list_notes", "list_changes", "read_activity"] },
];

/** "I hadn't checked", "I didn't look at", "I never searched", "I haven't read". */
const DISOWNS =
  /\bI\s+(?:had\s*n[o']t|hadn['’]t|did\s*n[o']t|didn['’]t|never|have\s*n[o']t|haven['’]t|was\s*n[o']t|wasn['’]t)\s+(?:actually\s+|really\s+)?(?:check|checked|look|looked|search|searched|read|go\s+through|gone\s+through|went\s+through|open|opened)\b[^.!?\n]*/gi;
/** "I made up 10:03", "I made that up", "I invented it", "I just guessed". */
const MADE_UP = /\bI\s+(?:just\s+)?(?:made\s+(?:it|that|this|those|them|\S+)\s+up|made\s+up(?!\s+(?:nothing|none|anything))|invented|guessed|fabricated)\b/i;

/** An answer conceding a correction: "made up" alone may be an honest "the invite has no end, so I guessed 4". */
const CONCEDES = /\byou(?:'|’)?re right\b|\byou are right\b|\bI was wrong\b|\bsorry\b|\bmy (?:bad|mistake)\b|\bI shouldn(?:'|’)?t have\b/i;

/** How many of the latest texts count as "what I said I checked". */
const RECENT_TEXTS = 6;

/** The read tools this turn and the last few answers ran, by name. */
function readsOnRecord(history, steps) {
  const names = new Set((steps ?? []).filter((step) => step?.ok !== false).map((step) => step.name));
  const recent = (Array.isArray(history) ? history : []).slice(-RECENT_TEXTS);
  for (const turn of recent) if (turn?.role === "assistant" && Array.isArray(turn.tools)) for (const name of turn.tools) names.add(name);
  return names;
}

/**
 * The sources an answer says Tex never read, or that it made a figure up,
 * which the record contradicts: `{ disowned, ran }`, or null when the record
 * agrees with it (or it disowns nothing).
 */
export function contradictedConfession(answer, { history = [], steps = [] } = {}) {
  const said = String(answer ?? "");
  const ran = readsOnRecord(history, steps);
  const disowned = [];
  for (const [clause] of said.matchAll(DISOWNS)) {
    for (const source of SOURCES) {
      if (source.words.test(clause) && source.tools.some((tool) => ran.has(tool)) && !disowned.includes(source.name)) disowned.push(source.name);
    }
  }
  const madeUp = MADE_UP.test(said) && CONCEDES.test(said) && SOURCES.some((source) => source.tools.some((tool) => ran.has(tool)));
  if (disowned.length === 0 && !madeUp) return null;
  const tools = [...ran].filter((name) => SOURCES.some((source) => source.tools.includes(name)));
  return { disowned, madeUp, tools };
}

/** The notice for `contradictedConfession`. */
export function confessionNotice({ disowned, madeUp, tools }) {
  const what = disowned.length > 0 ? `you never read their ${disowned.join(" or ")}` : "you made a figure up";
  return (
    `Before this goes: your answer says ${what}, but your own record shows these ran in this chat: ${tools.join(", ")}. ` +
    "Don't confess to something the record contradicts to calm them down. Look at what those reads returned, then say plainly " +
    "which part of their correction is right and which isn't, and where your figure came from (a change you made yourself counts: say it was your own edit, not theirs). " +
    "If a read really found nothing, say that. One short, steady answer; no apology spiral, and no bug report unless they ask for one."
  );
}
