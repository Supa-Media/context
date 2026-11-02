/**
 * ONE CHECKED ACCOUNT OF A SAVE, AND NO CAUSE THE RECORD CAN'T SHOW.
 *
 * Tex Devs, 2026-10-29 (@context-lc areas/tex-reviews/themes/page-save-fails.md):
 * a background job's page update failed, and Tex texted "I couldn't save the
 * page update. The workspace stopped responding mid-save", with a bug report
 * drafted for the team. Minutes later another text said "The save went
 * through after all". Asked about the contradiction, Tex answered "I said I
 * couldn't save it, then signed in anyway with the code": no sign-in, login
 * or code step had run anywhere in that chat.
 *
 * Two checks, each once a turn, beside the confession check (`confession.js`):
 *
 * - An answer saying a note didn't save, when the turn's last failed save of
 *   it was never read back, is sent back to read it first. A save can land
 *   even when its answer fails (a slow merge, a dropped connection), so the
 *   failure is told only once the note itself says so; and one that a later
 *   save of the same note already fixed is told as saved.
 * - An answer explaining what happened with a sign-in or a code, when no
 *   browser, login or code step is on the record of this turn or the last
 *   few texts, is sent back to say what the record shows, or that it doesn't
 *   know why, rather than a cause it made up.
 */

/** "I couldn't save the page update", "the save failed", "it wasn't saved", "stopped responding mid-save". */
const SAYS_UNSAVED = new RegExp(
  [
    String.raw`\b(?:could\s*n[o']t|couldn['’]t|could\s+not|was\s*n[o']t\s+able\s+to|wasn['’]t\s+able\s+to|unable\s+to|failed\s+to)\s+(?:get\s+\S+(?:\s+\S+)?\s+)?(?:save|write|store|finish\s+saving)\b`,
    String.raw`\b(?:the\s+|that\s+|my\s+|your\s+)?(?:save|write)\s+(?:failed|did\s*n[o']t\s+(?:go\s+through|work|land)|didn['’]t\s+(?:go\s+through|work|land))\b`,
    String.raw`\b(?:was\s*n[o']t|wasn['’]t|was\s+not|is\s*n[o']t|isn['’]t|never\s+got|did\s*n[o']t\s+get|didn['’]t\s+get)\s+saved\b`,
    String.raw`\bstopped\s+responding\s+mid-?\s*save\b`,
  ].join("|"),
  "i",
);

/** "signed in anyway", "logged back in", "with the code", "entered the verification code". */
const SAYS_SIGNED_IN =
  /\b(?:I|we|Tex)\s+(?:then\s+|had\s+|just\s+|finally\s+)?(?:signed|logged)\s+(?:back\s+)?(?:in|on)\b|\bsign(?:ed)?[- ]?in\s+(?:anyway|again|went\s+through)\b|\b(?:with|using|entered|typed\s+in|put\s+in)\s+the\s+(?:code|passcode|verification\s+code|2fa\s+code|one-time\s+code|login\s+code)\b/i;

/** Tools that sign in, enter a code, or hand a sign-in to someone: a sign-in is on record only when one ran. */
const SIGN_IN_TOOL = /^(?:browse|fill_login|fill_card|sign_out_browser|delegate|text_progress)$|computer|vault|login|sign_?in/i;

/** How many of the latest texts count as what Tex did earlier in the chat. */
const RECENT_TEXTS = 6;

/** A step's note, as the claim watcher keeps it: the workspace and the path, lowercased. */
export function noteKey(args) {
  const path = typeof args?.path === "string" ? args.path.trim().replace(/^\/+/, "").toLowerCase() : "";
  if (path === "") return null;
  const context = typeof args?.context === "string" ? args.context.trim().toLowerCase() : "";
  return `${context}:${path}`;
}

/** A step's note and whether it was a save, kept with the claim watcher's steps; nothing for a step that is neither. */
export function noteStep(name, args, write) {
  if (!write && name !== "read_note") return {};
  const note = noteKey(args);
  return note === null ? {} : { note, ...(write ? { write: true } : {}) };
}

/**
 * An answer telling a save as failed without the note saying so:
 * `{ path, saved }` (`saved`: a later save of it worked this turn), or null.
 * `steps` are the turn's tool steps in order, a note step carrying `note` (`noteKey`) and `write`.
 */
export function uncheckedFailedSave(answer, steps = []) {
  if (!SAYS_UNSAVED.test(String(answer ?? ""))) return null;
  const list = Array.isArray(steps) ? steps : [];
  const last = list.findLastIndex((step) => step?.write === true && step.ok === false && typeof step.note === "string");
  if (last === -1) return null;
  const note = list[last].note;
  const after = list.slice(last + 1).filter((step) => step?.note === note && step.ok !== false);
  const path = note.slice(note.indexOf(":") + 1);
  if (after.some((step) => step.write === true)) return { path, saved: true };
  if (after.some((step) => step.name === "read_note")) return null;
  return { path, saved: false };
}

/** The notice for `uncheckedFailedSave`. */
export function failedSaveNotice({ path, saved }) {
  if (saved) {
    return (
      `Before this goes: your answer says ${path} didn't save, but a later save of it worked in this turn. ` +
      "Tell them it's saved, with its link, and leave the failure out: one account of the save, no bug report."
    );
  }
  return (
    `Before this goes: your answer says ${path} didn't save, but you haven't read it back since that save failed, and a save can land even when its answer fails. ` +
    "Read it once now (read_note). If your new content is there, it saved: say so, with its link. If it isn't, say plainly it didn't save. " +
    "Give one account either way, and no bug report over a single failed save."
  );
}

/** The tools this turn and the last few texts ran, by name. */
function toolsOnRecord(history, steps) {
  const names = new Set((Array.isArray(steps) ? steps : []).filter((step) => step?.ok !== false).map((step) => step.name));
  for (const turn of (Array.isArray(history) ? history : []).slice(-RECENT_TEXTS)) {
    if (turn?.role === "assistant" && Array.isArray(turn.tools)) for (const name of turn.tools) names.add(name);
  }
  return names;
}

/** An answer giving a sign-in or a code as what happened, with none on the record. */
export function inventedSignIn(answer, { history = [], steps = [] } = {}) {
  if (!SAYS_SIGNED_IN.test(String(answer ?? ""))) return false;
  return ![...toolsOnRecord(history, steps)].some((name) => typeof name === "string" && SIGN_IN_TOOL.test(name));
}

export const INVENTED_CAUSE_NOTICE =
  "Before this goes: your answer says you signed in or used a code, but nothing on your record did: no browser, login or code step ran in this chat. " +
  "Never explain what happened with a cause your record doesn't show. If they caught your texts disagreeing, say which one was wrong by what the record shows " +
  "(a save that worked, a read that failed), or say you don't know why, and where things stand now. One short answer, no apology spiral, no new offers.";

/**
 * Both checks for one turn, each at most once: a notice, or null to let the answer go.
 * "I couldn't save the page" with the note never read back since is read first; "then signed in
 * anyway with the code", with no sign-in anywhere on record, says what the record shows instead.
 */
export function saveAccountCheck() {
  let saveNoticed = false;
  let causeNoticed = false;
  return (answer, { history = [], steps = [] } = {}) => {
    const unsaved = saveNoticed ? null : uncheckedFailedSave(answer, steps);
    if (unsaved !== null) {
      saveNoticed = true;
      return failedSaveNotice(unsaved);
    }
    if (!causeNoticed && inventedSignIn(answer, { history, steps })) {
      causeNoticed = true;
      return INVENTED_CAUSE_NOTICE;
    }
    return null;
  };
}
