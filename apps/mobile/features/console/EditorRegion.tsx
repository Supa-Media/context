import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { FormError } from "../design/components/Input";
import { space } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { ScreenScroll } from "../app/Screen";
import { canReload, reloadApp } from "../app/reload";
import { TabStrip } from "./files/TabStrip";
import type { useTabs } from "./files/useTabs";
import type { ConsoleData } from "./types";

/**
 * The editor region's scrolling, which is not one answer.
 *
 * **Browse owns its own.** It is a tab strip and a breadcrumb pinned to the top
 * edge with a document filling the rest, and the document is a textarea that
 * scrolls itself. Wrapping that in a page scroller puts a second scrollbar
 * around the first and lets the strip slide out of view — which is the shape
 * this whole rebuild exists to remove.
 *
 * **Everything else scrolls as a page.** Map, Connections and Settings are
 * documents of stacked cards with no internal scroller of their own, and they
 * are routinely taller than the viewport.
 */
export function EditorRegion({
  browse,
  failure,
  tabs,
  onCloseTab,
  phone,
  children,
}: {
  browse: boolean;
  failure: ConsoleData["failure"];
  /** Absent on a route with no notes open, and on every non-Browse pane. */
  tabs: ReturnType<typeof useTabs> | null;
  /** Closes a tab, asking first when it holds an unsaved draft. */
  onCloseTab: (path: string) => void;
  /** Compact. Decides the document panes' measure, not which regions exist. */
  phone: boolean;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The console's own subscription came back as an error rather than data. It
    reaches here as a value — `useLiveConsoleData` reads it with `useQueries` —
    where a `useQuery` would have re-thrown during render and blanked the page.
    So: say what happened, offer the one thing that helps, and keep the chrome
    around it so there is still a way out.
  */
  const banner =
    failure === null ? null : (
      <View style={styles.failure} testID="console-failure">
        <FormError
          headline={failure.headline}
          next={[failure.next, failure.detail].filter(Boolean).join(" ")}
        />
        {canReload ? (
          <View style={styles.failureActions}>
            <Button label="Reload" variant="white" onPress={reloadApp} />
          </View>
        ) : null}
      </View>
    );

  if (browse) {
    return (
      <View style={styles.browseRegion}>
        {/*
          At the very top edge of the region, not inside the document's
          padding: an inset tab strip reads as a control belonging to the note
          rather than to the frame.
        */}
        {tabs !== null && tabs.state.tabs.length > 0 ? (
          <TabStrip
            state={tabs.state}
            onActivate={tabs.activate}
            onClose={onCloseTab}
            onCloseOthers={tabs.closeOthers}
            onReopen={tabs.reopen}
          />
        ) : null}
        {banner === null ? null : <View style={styles.bannerInset}>{banner}</View>}
        {children}
      </View>
    );
  }

  /*
    Map, Connections and Settings, and the reason this is a `ScreenScroll`.

    It was a bare `ScrollView` with a flat `paddingTop: 12`, which is the whole
    of the settings screen's safe-area bug: at compact the frame deliberately
    does not pad itself and floats its bars over a full-bleed document, so a
    scroller that pays nothing puts its first line — "@seyi settings", the
    Connected pill, Done — under the clock and the Dynamic Island. `BrowsePane`
    and `NoteEditor` were already paying it and these three panes were not,
    which is exactly the per-screen arithmetic `Screen.tsx` exists to end.

    The pane's own gutters follow the padding rather than replacing it: they are
    listed after it in the array, and they set no vertical padding of their own
    any more — `space.x6`/`space.x3` at the top was clearing chrome the inset
    now accounts for.
  */
  return (
    <ScreenScroll
      /*
        The pane's own gutters, declared here rather than in the stylesheet.

        A `paddingTop` in `contentContainerStyle` would *replace* the inset —
        style arrays resolve last-wins — so the gutter has to be added to it
        instead of set beside it. `chrome` is that addition, and at compact it
        is zero on purpose: the frame's own floating toggle already accounts for
        the top band there, exactly as it does for `BrowsePane`.
      */
      chrome={phone ? PANE_GUTTER_PHONE : PANE_GUTTER}
      contentContainerStyle={[styles.paneContent, phone && styles.paneContentPhone]}
    >
      {banner}
      {children}
    </ScreenScroll>
  );
}

/** See `EditorRegion`'s `chrome`. Frozen so they are not fresh objects a render. */
const PANE_GUTTER = { top: space.x6, bottom: space.x8 } as const;
const PANE_GUTTER_PHONE = { top: 0, bottom: space.x6 } as const;

const makeStyles = () => StyleSheet.create({
  /** Browse fills its region and scrolls inside itself. */
  browseRegion: { flex: 1, minHeight: 0 },
  bannerInset: { paddingHorizontal: space.x7, paddingTop: space.x5 },
  /**
   * Every other pane scrolls as a page inside the region.
   *
   * **Horizontal only.** The vertical gutters are `EditorRegion`'s `chrome`
   * prop, because a `paddingTop` here would overwrite the safe-area inset
   * `ScreenScroll` puts on the same container rather than adding to it — which
   * is how the settings screen came to draw its title under the clock.
   */
  paneContent: { paddingHorizontal: space.x7 },
  /**
   * A phone's gutter.
   *
   * 28pt either side of a 390pt screen leaves a 334pt measure for a document
   * of cards; 20 leaves 350, which is a whole word per line on the settings
   * copy.
   */
  paneContentPhone: { paddingHorizontal: space.x5 },

  failure: { marginBottom: 18 },
  failureActions: { marginTop: 14, flexDirection: "row", gap: 14 },
});
