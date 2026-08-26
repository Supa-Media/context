import { useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { settingsHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { BrowsePane } from "../../../../features/console/panes/BrowsePane";

/**
 * `/console/@:slug` — a context's default view.
 *
 * Selecting a context in the rail navigates here rather than swapping a
 * variable, so the URL says which context you are in and a reload keeps you
 * there.
 */
export default function ContextBrowseRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);

  return (
    <BrowsePane
      data={data}
      onOpenSettings={slug === null ? undefined : () => router.push(settingsHref(slug))}
    />
  );
}
