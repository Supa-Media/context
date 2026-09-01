import { useLocalSearchParams, useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { noteFromQuery, settingsHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { useLinkedNote } from "../../../../features/console/useLinkedNote";
import { BrowsePane } from "../../../../features/console/panes/BrowsePane";

/**
 * `/console/@:slug` — a context's default view, optionally opened on one note.
 *
 * Selecting a context in the rail navigates here rather than swapping a
 * variable, so the URL says which context you are in and a reload keeps you
 * there. `?note=` extends that to *which note*, which is what makes a console
 * URL something you can send to somebody who already has access — no token, no
 * grant, just an address. See `noteHref`.
 *
 * Honouring that query is `useLinkedNote`, which is a hook in `features/` and
 * not an effect here: what it has to get right is the order it runs in
 * relative to the console layout's own effects, and that is not something a
 * rule written inside a route file can be tested for.
 */
export default function ContextBrowseRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);
  const params = useLocalSearchParams<{ note?: string | string[] }>();

  useLinkedNote(data.files, noteFromQuery(params.note), data.selectedContextId);

  return (
    <BrowsePane
      data={data}
      onOpenSettings={slug === null ? undefined : () => router.push(settingsHref(slug))}
    />
  );
}
