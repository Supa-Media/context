import { useEffect, useRef } from "react";
import type { FileBrowser } from "./files/browser";

/**
 * Open the note or folder a console URL names, once.
 *
 * `/console/@seyi?note=3-resources/engineering/foo.md` is the link the console
 * hands people to send each other — `teamShareLink` builds it, and it is the
 * readable one, chosen over `/s/<token>` precisely so the URL says what it
 * points at. All of that value is in the landing: a link that opens the
 * context and not the note is a link that did not work.
 *
 * It lives here rather than inline in the route because the bug it exists to
 * prevent is a *timing* bug between two components, and a rule that can only
 * be exercised by mounting a router is a rule nothing tests.
 * `__tests__/linkedNote.test.ts` drives it against the real `useFileBrowser`.
 *
 * ## It waits for the browser to be on this context
 *
 * `selectedContextId` is what the console has *chosen*; `files.contextId` is
 * what the file browser has caught up with, and for one commit they differ.
 * That commit is where this used to lose every cold-start link: the browser
 * forgets its previous context in an effect owned by the console **layout**,
 * and React runs a route's effects before its parent's — so the note this
 * selected was cleared microseconds later by a reset it could not see, and
 * the person landed on "Choose a note to read or edit it".
 *
 * Waiting is also the only version that is right rather than merely working.
 * A selection made before the reset is a selection made against the *previous*
 * context's state, which for a moving target is asking the wrong bucket about
 * a path it does not have.
 *
 * ## Once, not on every render
 *
 * `select` is also what the *person* calls by tapping the tree, so re-applying
 * the URL afterwards would drag them back to the linked note every time they
 * opened anything else. The ref records which URL has been honoured rather
 * than a bare boolean, so a second link followed within the same mount is
 * still obeyed — and it is keyed on the context too, so the same path in two
 * contexts is two different links.
 */
export function useLinkedNote(
  files: FileBrowser,
  note: string | null,
  selectedContextId: string | null,
): void {
  const applied = useRef<string | null>(null);
  const { select, contextId } = files;
  useEffect(() => {
    if (note === null || selectedContextId === null) return;
    if (contextId !== selectedContextId) return;
    const key = `${selectedContextId}:${note}`;
    if (applied.current === key) return;
    applied.current = key;
    select(note);
  }, [contextId, note, select, selectedContextId]);
}
