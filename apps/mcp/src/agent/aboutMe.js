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

export const ABOUT_ME_PATH = "tex/about-me.md";

/** The most of the note a prompt carries. Past it, the note is too long to be a summary. */
export const MAX_ABOUT_ME_CHARS = 6_000;

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
  try {
    const result = await callTool("read_note", { path: ABOUT_ME_PATH });
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

/** What the system prompt says about it, given whether this turn may write. */
export function aboutMePrompt(text, { edits }) {
  const body = typeof text === "string" ? text.trim() : "";
  const keep = edits
    ? `When you learn something lasting about them (a preference, a correction, someone in their life, how they like things done), add it to ${ABOUT_ME_PATH} in their own workspace with write_note: read it first and keep the rest. Keep it short: facts, not a diary.`
    : "";
  if (body.length === 0) {
    return edits ? `\n\nYou keep what you learn about them in ${ABOUT_ME_PATH} in their own workspace. It doesn't exist yet. ${keep}` : "";
  }
  const shown =
    body.length > MAX_ABOUT_ME_CHARS ? `${body.slice(0, MAX_ABOUT_ME_CHARS)}\n[cut: the note is longer; read it for the rest]` : body;
  return [
    "",
    "",
    `What you know about them, from ${ABOUT_ME_PATH} (yours to keep current):`,
    shown,
    ...(keep ? ["", keep] : []),
  ].join("\n");
}
