import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { noteFromQuery, settingsHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { BrowsePane } from "../../../../features/console/panes/BrowsePane";

/**
 * `/console/@:slug` — a context's default view, optionally opened on one note.
 *
 * Selecting a context in the rail navigates here rather than swapping a
 * variable, so the URL says which context you are in and a reload keeps you
 * there. `?note=` extends that to *which note*, which is what makes a console
 * URL something you can send to somebody who already has access — no token, no
 * grant, just an address. See `noteHref`.
 */
export default function ContextBrowseRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);
  const params = useLocalSearchParams<{ note?: string | string[] }>();
  const note = noteFromQuery(params.note);

  /**
   * Open the note the URL names, once.
   *
   * Once, and not on every render, because `select` is also what the *person*
   * calls by clicking the tree — re-applying the URL afterwards would drag them
   * back to the linked note every time they opened anything else. The ref
   * records which URL has been honoured rather than a bare boolean, so a second
   * link followed within the same mount is still obeyed.
   *
   * It waits for the right context to be selected. The layout resolves the slug
   * to a context id asynchronously, and reading a note against the previous
   * context would ask the wrong bucket for a path it does not have.
   */
  const applied = useRef<string | null>(null);
  const { files, selectedContextId } = data;
  useEffect(() => {
    if (note === null || selectedContextId === null) return;
    const key = `${selectedContextId}:${note}`;
    if (applied.current === key) return;
    applied.current = key;
    files.select(note);
  }, [files, note, selectedContextId]);

  return (
    <BrowsePane
      data={data}
      onOpenSettings={slug === null ? undefined : () => router.push(settingsHref(slug))}
    />
  );
}
