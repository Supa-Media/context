/**
 * THE NOTES AN EARLIER TURN SAYS IT WROTE (`worldChat.mjs` `earlier`).
 *
 * A Dev chat's earlier lines are texts only: a job's report or Tex's text names a page it wrote
 * (`context://@john/projects/lisbon-wedding/trip.md`), but the bench world never ran that turn, so the page was never
 * written, and a later turn that opens it finds nothing and says so (Dev set, 2026-11-17: three wedding-trip Front
 * door rows answered "I couldn't find the trip page"). Production would have the page. So when an earlier line links
 * a note that is not there, the bench writes it, as the person, at the line's time, through the same `write_note`
 * every client uses, and only what the chat itself says about it: the line's words and Tex's texts of the same turn,
 * the link taken out. Nothing is invented: no model writes it, so a page holds no fact the chat never stated, and a
 * run is no noisier for it. A link to a note that already exists (a fixture) leaves it alone, and one the person
 * cannot write (another person's workspace) is skipped and counted, never forced.
 */

/** Every `context://@workspace/path` link in `text`, trailing punctuation dropped, each once. */
export function linksIn(text) {
  const found = [];
  for (const [, context, path] of String(text ?? "").matchAll(/context:\/\/@([a-z0-9-]+)\/([^\s)"'<>]+)/gi)) {
    const clean = path.replace(/[.,;:!?]+$/, "");
    if (!clean || clean.split("/").includes("..")) continue;
    if (!found.some((l) => l.context === context && l.path === clean)) found.push({ context, path: clean });
  }
  return found;
}

/** The note's body: a title from its file name, then each line's words with the links taken out. */
export function noteBody(path, texts) {
  const title = path.split("/").pop().replace(/\.(?:page\.)?md$/, "").replace(/[-_]+/g, " ");
  const lines = texts
    .map((t) => String(t ?? "").replace(/context:\/\/@[a-z0-9-]+\/[^\s)"'<>]+/gi, "").replace(/[ \t]+/g, " ").replace(/\s*:\s*\.?\s*$/, ".").trim())
    .filter((t) => t !== "" && t !== ".");
  return `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n${lines.join("\n\n")}\n`;
}

/**
 * Write each note `texts` link that isn't there yet, through `dispatch` (`earlierPictures.mjs` clientDispatch, as the
 * person). Answers what was written and what was skipped, paths only.
 */
export async function seedLinkedNotes(dispatch, texts) {
  const written = [];
  const skipped = [];
  for (const { context, path } of linksIn(texts.join("\n"))) {
    const there = await dispatch("read_note", { path, context: `@${context}` });
    if (!there?.isError) continue;
    const result = await dispatch("write_note", { path, context: `@${context}`, content: noteBody(path, texts) });
    (result?.isError ? skipped : written).push(`@${context}/${path}`);
  }
  return { written, skipped };
}
