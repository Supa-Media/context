/**
 * ```` ```join ```` fences: where a website page puts the waitlist field.
 *
 * Context is invite-only (Dev2, 2026-09-28), and the homepage asks for an
 * email in place: sign in if you're let in, join the list if not. Where that
 * field sits is the page's to say, like the rest of the page, so an author
 * writes an empty fence where the button used to be:
 *
 *     ```join
 *     ```
 *
 * Only the homepage draws the field there (`JoinSlot` in the app). Any other
 * site has no sign-in to offer, so a served page drops the fence
 * (`stripWebsiteJoin`), the way it drops a cast block.
 */

/** The fence's opening line: three or more backticks and the word `join`. */
export const JOIN_OPEN = /^ {0,3}(`{3,})\s*join\s*$/i;

/** Whether `line` closes a fence opened with `fence` (the same character, at least as many). */
function closes(line: string, fence: string): boolean {
  const text = line.trim();
  return text.length >= fence.length && [...text].every((c) => c === fence[0]);
}

/**
 * The page without its join fences. An unclosed one is left as it is, a code
 * block the author can see is wrong, rather than swallowing the rest of the
 * page. Other code blocks are never looked inside.
 */
export function stripWebsiteJoin(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (fence !== null) {
      if (closes(line, fence)) fence = null;
      out.push(line);
      continue;
    }
    const open = JOIN_OPEN.exec(line);
    if (open === null) {
      const other = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (other !== null) fence = other[1]!;
      out.push(line);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !closes(lines[end]!, open[1]!)) end += 1;
    if (end >= lines.length) {
      out.push(line);
      continue;
    }
    i = end;
    const previousBlank = out.length === 0 || out[out.length - 1]!.trim() === "";
    if (previousBlank && i + 1 < lines.length && lines[i + 1]!.trim() === "") i += 1;
  }
  return out.join("\n");
}
