/**
 * A new note nobody has written in yet, which is never written to a bucket
 * (Dev2, 2026-10-18: *"new notes created on mobile but nothing written in it
 * doesn't get saved and is discarded"*). Asked by the editor's save
 * (`useSaving`), by leaving the note (`useOpenNote`) and by the queue's drain
 * (`sync.ts`), so an untitled note made offline and left empty is not sent
 * either. See `console/files/fileBrowser/unsentNotes.ts`.
 */

const DRAWING = /\.excalidraw\.md$/i;
const GENERATED = /^untitled-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/i;

/**
 * Nothing has been written in this new note: an untitled name, and either
 * nothing at all or only the heading it was made with (`# untitled-…`).
 *
 * Narrow on purpose. A note somebody named, or whose heading they typed (which
 * renames it, `useLinkedTitle`), has something in it; so has a drawing, which
 * is never seeded with a heading.
 */
export function isBlankNewNote(path: string, text: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (DRAWING.test(name) || !GENERATED.test(name)) return false;
  const body = text.trim();
  if (body === "") return true;
  const newline = body.indexOf("\n");
  const first = (newline === -1 ? body : body.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : body.slice(newline + 1).trim();
  return rest === "" && first.toLowerCase() === `# ${name.replace(/\.md$/i, "")}`.toLowerCase();
}
