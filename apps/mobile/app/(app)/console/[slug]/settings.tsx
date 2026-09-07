import { useRouter } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { appSectionHref, browseHref, noteHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";
import { SettingsPane } from "../../../../features/console/panes/SettingsPane";

/**
 * `/console/@:slug/settings` — the storage binding and the ingestion rules.
 *
 * A real URL rather than a transient overlay, for the same reason every other
 * pane has one: "look at my storage settings" should survive being pasted into
 * a chat, and closing it should be a back button rather than a lost place.
 *
 * ## Closing it names the note that is still open
 *
 * Settings is pushed *over* Browse and leaves it mounted, so the note somebody
 * had open is still there behind this pane and is what closing it returns to.
 * The URL has to say so: `/console/@slug` on its own means "the context's
 * root", and since `noteAddress.ts` gained a close step that is an instruction
 * rather than a stale address — so replacing with the bare href would shut the
 * open note as a side effect of dismissing a settings pane, and file that at
 * the root on the device on the way out.
 *
 * Read from the browser's own selection rather than from a remembered URL,
 * because the browser is what the pane behind this is drawing.
 */
export default function ContextSettingsRoute() {
  const data = useConsoleData();
  const router = useRouter();
  const slug = useContextSlug(data);
  const open = data.files.selectedPath;

  return (
    <SettingsPane
      data={data}
      onClose={() =>
        router.replace(
          slug === null
            ? browseHref("you")
            : open === null
              ? browseHref(slug)
              : noteHref(slug, open),
        )
      }
      /*
        Map and Connections are reached from here now rather than from the rail
        — see `SettingsPane`. `push`, not `replace`: they are somewhere you go
        and come back from, and the back gesture is the way back.
      */
      onOpenSection={(section) => router.push(appSectionHref(section))}
    />
  );
}
