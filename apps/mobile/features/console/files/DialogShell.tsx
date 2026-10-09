import type { ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TargetedEvent,
} from "react-native";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The console's dialog frame: a card in the middle of the window, or a sheet
 * on the bottom edge of a phone's glass. Its own file so a dialog outside
 * `Dialogs.tsx` (`NewFolderForm`) can use it without the two importing each
 * other.
 */
export function Shell({
  title,
  children,
  onClose,
  sheet = false,
  anchor,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /**
   * Anchored to the bottom edge with only its top corners rounded, rather
   * than a card in the middle. For the phone's create menu (owner,
   * 2026-09-27, the phone artboards): its rows are a thumb's, and a thumb is
   * at the bottom of the glass.
   */
  sheet?: boolean;
  /**
   * Where the thing that raised it is, in window coordinates: the card opens
   * there as a popover, over a clear scrim, instead of in the middle of a
   * dimmed window. A folder's icon in the tree raises its picker this way
   * (owner, 2026-10-09: "have the icon menu popup inline"). Ignored for a
   * sheet, which belongs on the bottom edge whatever raised it.
   */
  anchor?: DialogAnchor;
}) {
  const styles = useThemedStyles(makeStyles);
  const frame = useWindowDimensions();
  const placed = anchor === undefined || sheet ? null : placeAnchored(anchor, frame);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable
        style={[styles.scrim, sheet && styles.sheetScrim, placed !== null && styles.anchoredScrim]}
        accessibilityLabel="Close"
        onPress={onClose}
        {...(Platform.OS === "web" ? { onFocus: intoFirstField } : {})}
      >
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable
          style={[styles.card, sheet && styles.sheet, placed !== null && [styles.anchored, placed]]}
          onPress={() => {}}
          accessibilityLabel={title}
          testID={sheet ? "dialog-sheet" : undefined}
        >
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {title}
          </Text>
          <View style={styles.body}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A point in window coordinates: the top-left corner the card should open at. */
export interface DialogAnchor {
  x: number;
  y: number;
}

/** The anchored card's width, and the height it is assumed to need when deciding whether it fits below. */
export const ANCHORED_WIDTH = 360;
export const ANCHORED_HEIGHT = 520;
const EDGE = 8;

/**
 * Where an anchored card goes: at the anchor, pulled back inside the window
 * by the 8pt edge when it would spill past the right or the bottom, and never
 * taller than the window. Exported for its tests.
 */
export function placeAnchored(
  anchor: DialogAnchor,
  frame: { width: number; height: number },
): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.min(ANCHORED_WIDTH, frame.width - EDGE * 2);
  const maxHeight = frame.height - EDGE * 2;
  const left = Math.max(EDGE, Math.min(anchor.x, frame.width - width - EDGE));
  const top = Math.max(EDGE, Math.min(anchor.y, frame.height - Math.min(ANCHORED_HEIGHT, maxHeight) - EDGE));
  return { left, top, width, maxHeight };
}

/**
 * Focus arriving on the scrim from outside the dialog goes to its first
 * field instead.
 *
 * A dialog opened from a menu sheet opened while that sheet was closing: the
 * sheet gave focus back to the button that raised it, which took it from the
 * dialog's own `autoFocus` field, and react-native-web's modal then pulled it
 * back in to the first thing it could focus, the scrim. So Rename, Tags and
 * the rest opened with no caret and no keyboard. Web only: it is the web
 * modal's focus trap that lands here.
 */
function intoFirstField(event: NativeSyntheticEvent<TargetedEvent>) {
  // On the web this is React DOM's focus event, with the DOM's own nodes on it.
  const dom = event as unknown as { target: unknown; currentTarget: HTMLElement; relatedTarget: unknown };
  const scrim = dom.currentTarget;
  if (dom.target !== scrim) return;
  const from = dom.relatedTarget;
  if (from instanceof Node && scrim.contains(from)) return;
  const field = scrim.querySelector<HTMLElement>("input, textarea");
  // After the trap's own walk, which goes on to the next thing it can focus once this one has let go.
  if (field !== null) setTimeout(() => field.focus(), 0);
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 22,
    paddingHorizontal: 24,
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  /** The scrim under a bottom sheet: the card sits on the bottom edge. */
  sheetScrim: { justifyContent: "flex-end", padding: 0 },
  /**
   * A bottom sheet: full width, flat along the edge it sits on, and paid
   * enough at the foot to clear a home indicator.
   */
  sheet: {
    maxWidth: "100%",
    borderBottomWidth: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingBottom: 34,
  },
  body: { marginTop: 12, gap: 12 },
  /** Under a popover the window stays as it was: the card is the only thing that changed. */
  anchoredScrim: { backgroundColor: "transparent", alignItems: "stretch", justifyContent: "flex-start", padding: 0 },
  anchored: {
    position: "absolute",
    maxWidth: undefined,
    paddingVertical: 16,
    paddingHorizontal: 16,
    boxShadow: "0 24px 60px -20px rgba(0,0,0,.9)",
  },
});
