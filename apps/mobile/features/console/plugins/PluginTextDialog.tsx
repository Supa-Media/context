import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { RuntimeView } from "./runtime";

/**
 * A plain dialog a running plugin asked to show, drawn by the console.
 *
 * ## Why this exists rather than an inert `Modal`
 *
 * A plugin extends `Modal` at module scope, so the class has to be there or the
 * bundle never finishes evaluating — that is how it was found, on the real
 * Bible Reference release, which died on `extends undefined` before `onload`.
 *
 * But a base class that exists and does nothing is the other half of the same
 * trap: the plugin loads, somebody presses its command, and nothing happens
 * anywhere. So the dialog is real, by the same inversion the suggestion dialog
 * and `registerEditorSuggest` use — the plugin builds into a `contentEl` inside
 * the sandbox, and only what that element *says* crosses.
 *
 * ## Text, and only text
 *
 * `title` and `text` are `textContent` read in the guest. A plugin cannot put
 * markup, a link, an image or a script in front of a reader through this,
 * which is the whole reason the inversion exists.
 *
 * It follows that a control built into `contentEl` does not work — a button
 * drawn in the sandbox is a button in a document nobody sees. Read-only
 * dialogs are what this serves, and they are most of them: a verse, a summary,
 * a word of explanation. The scanner reports the rest rather than hiding it.
 *
 * ## It updates while it is open
 *
 * The guest re-sends whenever the dialog's own DOM changes, because a plugin
 * may fill it after an await — Bible Reference's verse of the day opens the
 * dialog and *then* fetches. A dialog drawn once, when `open()` returned, would
 * be reliably empty for the plugin it was written for.
 */
export function PluginTextDialog({ runtime }: { runtime?: RuntimeView }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /*
    Optional for `PluginSuggestDialog`'s reason, which was a crash rather than
    a preference: a viewer who is not the owner has no runtime, and neither
    does the landing page's demo.
  */
  const modal = runtime?.textModal ?? null;
  const dismiss = runtime?.actions?.dismissTextModal;

  if (modal === null) return null;

  const touch = Platform.OS !== "web" || width < layout.narrowBreakpoint;

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={() => dismiss?.()}
      testID="plugin-text-dialog"
    >
      <Pressable style={styles.scrim} onPress={() => dismiss?.()} accessibilityLabel="Close">
        <View style={[styles.centre, touch ? styles.centreTouch : styles.centrePointer]}>
          {/*
            The panel swallows its own presses, so a press inside it is not a
            dismiss. `onStartShouldSetResponder` rather than a nested Pressable,
            which would make the Close button a double target.
          */}
          <View
            style={[styles.panel, { paddingBottom: touch ? insets.bottom : 0 }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.head}>
              {/* Who is showing this. A reader is being shown something by
                  third-party code, and that is the first thing to say. */}
              <Text variant="treeMeta" style={styles.who}>
                {modal.pluginId}
              </Text>
              {modal.title === "" ? null : (
                <Text variant="rowTitle" testID="plugin-text-title">
                  {modal.title}
                </Text>
              )}
            </View>
            <ScrollView style={styles.body}>
              {modal.text === "" ? (
                /*
                  Empty is a real state rather than a broken one: the dialog is
                  sent the moment it opens, so a plugin fetching its content has
                  a window where there is nothing to show. Saying so beats an
                  empty box, and the text replaces this when it lands.
                */
                <Text variant="rowSub" style={styles.empty} testID="plugin-text-empty">
                  Nothing to show yet.
                </Text>
              ) : (
                <Text variant="rowSub" testID="plugin-text-body">
                  {modal.text}
                </Text>
              )}
            </ScrollView>
            <View style={styles.foot}>
              <Button label="Close" onPress={() => dismiss?.()} testID="plugin-text-close" />
            </View>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The literal the other overlays here use rather than `colors.scrim`, which
    // no overlay in this codebase uses yet — see `Overlay`.
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    centre: { flex: 1, alignItems: "center" },
    centrePointer: { paddingTop: "12%" },
    centreTouch: { justifyContent: "flex-end" },
    panel: {
      width: "100%",
      maxWidth: 560,
      backgroundColor: colors.surface,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      overflow: "hidden",
    },
    head: {
      paddingHorizontal: space.x3,
      paddingTop: space.x3,
      paddingBottom: space.x2,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    who: { color: colors.muted },
    body: { maxHeight: 360, paddingHorizontal: space.x3, paddingVertical: space.x3 },
    empty: { color: colors.muted },
    foot: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      alignItems: "flex-end",
    },
  });
