import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemedStyles } from "../design/theme";
import { useChaosView } from "./ChaosContext";
import { ChaosPanel } from "./ChaosPanel";
import { scoreShown } from "./chaosModel";
import { makeChaosStyles } from "./styles";
import { densityFor } from "../app/frame";

/**
 * The chaos panel, from a folder page's line or the phone's @name menu. A bottom
 * sheet on a phone, as `RecentSheet` is; a floating card in the middle of a wider window, where a sheet from the bottom edge
 * would be a long way from the line that asked for it.
 */
export function ChaosSheet() {
  const view = useChaosView();
  const styles = useThemedStyles(makeChaosStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (view === undefined || view.panel !== "sheet" || !scoreShown(view.result)) return null;
  const wide = densityFor(width) !== "compact";
  return (
    <Modal transparent animationType={wide ? "fade" : "slide"} visible onRequestClose={view.closePanel}>
      <Pressable
        style={[styles.scrim, wide && styles.scrimWide]}
        accessibilityLabel="Close chaos score"
        onPress={view.closePanel}
      >
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={wide ? styles.sheetWide : [styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Chaos score"
          testID="chaos-panel"
        >
          {wide ? null : <View style={styles.grabber} aria-hidden />}
          <ScrollView style={styles.scroll}>
            <ChaosPanel result={view.result} onOpen={view.open} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
