/**
 * A panel docked at the right edge of the page region, full height, beside
 * the page's scroller rather than inside it — the Areas prototype's side panel
 * (the owner, 2026-11-24: "this is not a side panel" of a card drawn inside
 * the page's column). Opening it narrows the page, which centres its column
 * again in what is left; the panel scrolls on its own.
 *
 * The pointer layout's page surface (`DocumentSurface`) hosts it; a page puts
 * a panel there with `usePageDock`. Nothing hosts it on a phone, where a press
 * opens the area's page instead, so `usePageDock` answers null there.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../../../design/theme";

/** The docked panel's width, the prototype's. */
export const PAGE_DOCK_WIDTH = 340;
/** Its padding each side, so what it draws is `PAGE_DOCK_WIDTH - 2 * PAGE_DOCK_PAD` wide. */
export const PAGE_DOCK_PAD = 18;

type SetDock = (panel: ReactNode | null) => void;

const DockContext = createContext<SetDock | null>(null);

/** The setter for the region's dock, or null where nothing hosts one. */
export function usePageDock(): SetDock | null {
  return useContext(DockContext);
}

/** Shows `panel` in the region's dock while it is not null, and takes it away after. */
export function useDockedPanel(panel: ReactNode | null): boolean {
  const setDock = usePageDock();
  useEffect(() => {
    if (setDock === null) return;
    setDock(panel);
  }, [setDock, panel]);
  useEffect(() => () => setDock?.(null), [setDock]);
  return setDock !== null;
}

/** The page's scroller with the dock beside it. */
export function PageDockHost({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const [panel, setPanel] = useState<ReactNode | null>(null);
  return (
    <DockContext.Provider value={setPanel}>
      <View style={styles.row}>
        <View style={styles.main}>{children}</View>
        {panel === null ? null : (
          <View style={styles.dock} testID="page-dock">
            <ScrollView contentContainerStyle={styles.content}>{panel}</ScrollView>
          </View>
        )}
      </View>
    </DockContext.Provider>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flex: 1, minHeight: 0, flexDirection: "row" },
    main: { flex: 1, minWidth: 0, minHeight: 0 },
    dock: {
      width: PAGE_DOCK_WIDTH,
      flexShrink: 0,
      borderLeftWidth: 1,
      borderLeftColor: colors.line,
      backgroundColor: colors.surface,
    },
    content: { paddingTop: PAGE_DOCK_PAD, paddingBottom: 28, paddingHorizontal: PAGE_DOCK_PAD },
  });
