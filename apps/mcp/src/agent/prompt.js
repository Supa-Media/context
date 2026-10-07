/**
 * WHAT THE MODEL IS TOLD BEFORE THE QUESTION.
 *
 * The built-in words live here; `instructions.js` reads the editable ones from
 * the pinned `@context-lc` workspace, which take their place when present.
 */

/** The longest any one field of the ambient place may be. A path, not a page. */
const MAX_PLACE_FIELD = 512;

/**
 * How a texted answer reads (the owner, 2026-10-07: "this is text, so please
 * use a natural style").
 *
 * iMessage shows Markdown as the characters themselves, so a `**name**` or a
 * `[path](path)` arrives as punctuation. The texting Worker strips what slips
 * through (`apps/agent/src/format.ts`), but an answer written for a phone in
 * the first place reads better than one with the formatting scraped off.
 *
 * The last two lines are about speed as much as style: every tool call is
 * another round on the model, and a text that takes a minute to answer is
 * not a conversation. One search usually answers a question about a person
 * or a plan; `orient` is a map of the whole context, and paying for it on
 * "who's my brother" is most of the wait.
 */
const TEXTING_STYLE = [
  "Write the way a thoughtful friend texts: plain words, short sentences, the answer first.",
  "No Markdown at all. No asterisks or bold, no headings, no tables, no [text](link) links, no code formatting: iMessage shows those characters as they are.",
  "Don't name note paths or say which note something came from unless they ask where it's written.",
  "Keep it short: usually one to three short paragraphs. A blank line between paragraphs sends them as separate texts. For a list, write one short line per item starting with \"- \".",
  "Put a web link on its own line, as the bare URL.",
  "If their notes don't say, tell them so in one sentence.",
  "Be quick. For most questions one search_notes call is enough; read a note only when the search result doesn't already answer it, and don't call orient for a simple question.",
];

/**
 * What Context is, said first and in so many words. Without it a model fills
 * the gap from the folder names it sees, and a context imported from another
 * notes app had the assistant introducing itself as that app (the owner,
 * 2026-10-07). The editable `assistant/instructions.md` replaces this.
 */
const BUILTIN_IDENTITY = [
  "You are Context, the assistant built into Context (context.lc).",
  "Context is the person's own notes, kept as Markdown files in storage they own, and shared with every AI tool they connect. You are part of Context itself, not of any other notes app, even when their folders came from one.",
  "Answer from their notes rather than from memory: search before you answer.",
  "Their notes are the record — when a note and your recollection disagree, the note wins.",
];

/**
 * The system prompt.
 *
 * Deliberately short. A long one competes with the tool descriptions, which are
 * written for exactly this reader and are already the product's best statement
 * of what each call is for.
 *
 * `notes` are the editable words from `@context-lc` (`instructions.js`):
 * `instructions` stands in for the built-in identity, `texting` for the
 * built-in texting style. What the code decides — that the agent proposes
 * rather than edits, and where the person is — is said here either way, so a
 * note can add to the agent's understanding but never misdescribe its reach.
 */
export function systemPrompt(place, { texting = false, notes = null } = {}) {
  const identity = notes?.instructions ? [notes.instructions] : BUILTIN_IDENTITY;
  const lines = texting
    ? [
        ...identity,
        "This turn is a text message they sent you from their phone.",
        "You cannot edit their notes. To suggest a change, use propose_note; they review and decide.",
        "",
        ...(notes?.texting ? [notes.texting] : TEXTING_STYLE),
      ]
    : [
        ...identity,
        "Be brief. Cite the note path you took something from.",
        "You cannot edit their notes. To suggest a change, use propose_note; they review and decide.",
      ];

  const where = describePlace(place);
  if (where) lines.push("", where);
  return lines.join("\n");
}

/**
 * Where the person is, as a sentence.
 *
 * References only — a path, a visibility, whether something is unsaved. The
 * note's text is not here and must not be: the agent reads it through the same
 * tools and the same privacy engine as any other caller, or the ambient context
 * becomes a way to hand a model something the clamp never approved.
 */
export function describePlace(place) {
  if (!place || typeof place !== "object") return "";
  const parts = [];
  const name = bounded(place.context);
  if (name) parts.push(`They are in the context @${name}.`);
  const note = place.note;
  const path = note && typeof note === "object" ? bounded(note.path) : "";
  if (path) {
    const state = note.unsaved === true ? " (with unsaved edits)" : "";
    parts.push(`The note open in front of them is ${path}${state}.`);
    if (note.readable === false) {
      // Said out loud rather than left to a failed read. A note that has never
      // been written, or one this build cannot decrypt, is not a note the agent
      // can fetch — and a model that knows why stops trying.
      parts.push("Its contents are not readable through your tools right now.");
    }
  }
  if (place.meetingLive === true) parts.push("A meeting is being recorded right now.");
  return parts.join(" ");
}

/**
 * A short string from the place, or nothing.
 *
 * The app builds the place and the app is the person's own client, so this is
 * not a trust boundary — it is a *length* boundary. Every field here ends up in
 * the system prompt on a request the customer pays for by the token, and a
 * client with a bug that puts a whole document in `note.path` should cost them
 * one confused answer rather than a bill.
 */
function bounded(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PLACE_FIELD
    ? value
    : "";
}
