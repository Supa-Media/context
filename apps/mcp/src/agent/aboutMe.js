/**
 * WHAT TEX KNOWS ABOUT THE PERSON, IN A NOTE THEY CAN READ.
 *
 * Decided by the owner, 2026-10-14: Tex "knows nothing about me when the text
 * arrives", and its memory belongs in a `tex/` folder at the top of the
 * workspace, "memory about me that it's always updating", rather than in an
 * opaque store. So a texted turn reads `tex/about-me.md` from the person's own
 * workspace through the same dispatcher and privacy engine as any read, puts
 * it in the system prompt, and is told to keep it current with `write_note`.
 *
 * Read, never written, here: the note changes only through a tool call the
 * model makes, which is attributed and kept in the note's history like any
 * other write.
 */

import { identityPrompt } from "./identity.js";

export const ABOUT_ME_PATH = "tex/about-me.md";

/**
 * The note's hard size, in lines (the owner, 2026-10-14: "it doesn't need to
 * be more than 500 lines"). Every write to it is refused past this, from any
 * writer (`tools/notes/write.js`, which `remember` also goes through), so the
 * prompt always carries the whole note.
 */
export const MAX_ABOUT_ME_LINES = 500;

/** A bound on characters too, so 500 very long lines can't stand in for a book. */
export const MAX_ABOUT_ME_CHARS = 40_000;

/** Why a write of `content` to `path` is refused, or null. */
export function aboutMeTooLong(path, content) {
  if (path !== ABOUT_ME_PATH || typeof content !== "string") return null;
  const lines = content.replace(/\n$/, "").split("\n").length;
  if (lines <= MAX_ABOUT_ME_LINES && content.length <= MAX_ABOUT_ME_CHARS) return null;
  return (
    `too long: ${ABOUT_ME_PATH} holds at most ${MAX_ABOUT_ME_LINES} lines and ${MAX_ABOUT_ME_CHARS} characters ` +
    `(this is ${lines} lines, ${content.length} characters). Nothing was written. ` +
    "Condense it: merge repeated facts, drop what's stale, keep one short line per fact."
  );
}

/** read_note's header lines (`etag: …`, `path: …`) end at the first blank line. */
const HEADER_LINE = /^[a-z_]+: /;

function bodyOf(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && HEADER_LINE.test(lines[i])) i += 1;
  if (i === 0 || lines[i]?.trim() !== "") return null;
  return lines.slice(i + 1).join("\n").trim();
}

/**
 * The note's text, `""` when it doesn't exist yet or can't be read. Never
 * throws: a turn without it is a turn that knows less, not one that fails.
 *
 * @param {(name: string, args: object) => Promise<object>} callTool the session's dispatcher
 */
export async function readAboutMe(callTool) {
  return await readTexNote(callTool, ABOUT_ME_PATH);
}

/** Any note in Tex's own `tex/` folder, read the same way (`jobs.js` reads `tex/jobs.md`). */
export async function readTexNote(callTool, path) {
  try {
    const result = await callTool("read_note", { path });
    if (result?.isError === true) return "";
    const text = (Array.isArray(result?.content) ? result.content : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return bodyOf(text) ?? "";
  } catch {
    return "";
  }
}

/**
 * What the system prompt says about it, given whether this turn may write,
 * after who they are by their account (`identity.js`) when that is known.
 */
export function aboutMePrompt(text, { edits, identity = null }) {
  return identityPrompt(identity) + noteFacts(text, { edits });
}

function noteFacts(text, { edits }) {
  const body = typeof text === "string" ? text.trim() : "";
  const keep = edits
    ? `When you learn something lasting about them (a preference, a correction, someone in their life, how they like things done), add it to ${ABOUT_ME_PATH} in their own workspace with write: fetch it first and keep the rest. One short line per fact, never more than ${MAX_ABOUT_ME_LINES} lines: when it's getting long, merge and drop what's stale.`
    : "";
  if (body.length === 0) {
    return edits ? `\n\nYou keep what you learn about them in ${ABOUT_ME_PATH} in their own workspace. It doesn't exist yet. ${keep}` : "";
  }
  const shown =
    body.length > MAX_ABOUT_ME_CHARS || body.split("\n").length > MAX_ABOUT_ME_LINES
      ? `${body.split("\n").slice(0, MAX_ABOUT_ME_LINES).join("\n").slice(0, MAX_ABOUT_ME_CHARS)}\n[cut: the note is over its limit; condense it]`
      : body;
  return [
    "",
    "",
    `What you know about them, from ${ABOUT_ME_PATH} (yours to keep current):`,
    shown,
    ...(keep ? ["", keep] : []),
  ].join("\n");
}
