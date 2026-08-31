import { useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { appSectionHref, browseHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { SettingsPane } from "../../../../features/console/panes/SettingsPane";

/**
 * `/console/@:slug/settings` — the storage binding and the ingestion rules.
 *
 * A real URL rather than a transient overlay, for the same reason every other
 * pane has one: "look at my storage settings" should survive being pasted into
 * a chat, and closing it should be a back button rather than a lost place.
 */
export default function ContextSettingsRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);

  return (
    <SettingsPane
      data={data}
      onClose={() => router.replace(browseHref(slug ?? "you"))}
      /*
        Map and Connections are reached from here now rather than from the rail
        — see `SettingsPane`. `push`, not `replace`: they are somewhere you go
        and come back from, and the back gesture is the way back.
      */
      onOpenSection={(section) => router.push(appSectionHref(section))}
    />
  );
}
