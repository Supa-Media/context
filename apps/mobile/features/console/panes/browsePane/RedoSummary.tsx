import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { MAX_INSTRUCTION_CHARS } from "@context/meetings/summary";
import { Button } from "../../../design/components/Button";
import { place } from "../../../design/components/popoverPlacement";
import { Text } from "../../../design/components/Text";
import { useDismissOnOutside } from "../../../design/useDismissOnOutside";
import { useFieldFont } from "../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { Shadows } from "../../../design/tokens/shadows";
import type { MeetingSummary } from "../../../meetings/useMeetingSummary";

/** The four quick choices. Each one fills the field; the person can still edit it. */
const CHIPS: readonly { label: string; text: string }[] = [
  { label: "Shorter", text: "Make it shorter." },
  { label: "More detail", text: "Give more detail." },
  { label: "Just action items", text: "Only list the action items." },
  { label: "Add dates", text: "Add the dates that were mentioned." },
];

const WIDTH = 300;
const HEIGHT = 250;
const PANEL_TESTID = "browse-redo-panel";
const TRIGGER_TESTID = "browse-redo";

/**
 * "Redo summary" for an open meeting note, with a small panel for what should
 * change. Shown only where the note is a meeting and the person may edit it.
 *
 * The panel closes on a press outside it or Escape, the rule `FilterMenu` and
 * the other console popovers follow. The gateway writes the new summary into
 * the note, so nothing here changes the note's text.
 */
export function RedoSummary({ summary }: { summary: MeetingSummary }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const view = useWindowDimensions();
  const trigger = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [instruction, setInstruction] = useState("");

  const close = () => setOpen(false);
  useDismissOnOutside(open, [PANEL_TESTID, TRIGGER_TESTID], close);

  const openPanel = () => {
    trigger.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x: x + width - WIDTH, y: y + height + space.x1 });
    });
    setOpen(true);
  };

  const redo = () => {
    summary.redo(instruction);
    setInstruction("");
    close();
  };

  const box = anchor === null ? null : place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, { minHeight: 120 });

  return (
    <View style={styles.wrap}>
      <Pressable
        ref={trigger}
        role="button"
        accessibilityLabel={summary.pending ? "Writing summary" : "Redo summary"}
        accessibilityState={{ disabled: summary.pending, expanded: open }}
        disabled={summary.pending}
        onPress={openPanel}
        testID={TRIGGER_TESTID}
        style={[styles.trigger, open && styles.triggerOpen]}
      >
        <Text variant="treeMeta" style={summary.pending ? styles.triggerBusy : styles.triggerText}>
          {summary.pending ? "Writing summary…" : "Redo summary"}
        </Text>
      </Pressable>
      {summary.message === null ? null : (
        <Text variant="treeMeta" style={styles.message} role="status">
          {summary.message}
        </Text>
      )}
      <Modal transparent visible={open} animationType="none" onRequestClose={close}>
        <Pressable style={styles.scrim} accessibilityLabel="Close redo summary" onPress={close}>
          <Pressable
            onPress={() => {}}
            role="dialog"
            accessibilityLabel="Redo summary"
            testID={PANEL_TESTID}
            style={[styles.panel, box === null ? null : { left: box.left, top: box.top, width: box.width }]}
          >
            <TextInput
              autoFocus
              value={instruction}
              onChangeText={(text) => setInstruction(text.slice(0, MAX_INSTRUCTION_CHARS))}
              onSubmitEditing={redo}
              placeholder="What should change? (optional)"
              placeholderTextColor={colors.muted}
              accessibilityLabel="What should change"
              maxLength={MAX_INSTRUCTION_CHARS}
              autoCorrect={false}
              style={[styles.field, fieldFont]}
              testID="browse-redo-instruction"
            />
            <View style={styles.chips}>
              {CHIPS.map((chip) => (
                <Pressable key={chip.label} role="button" accessibilityLabel={chip.label} onPress={() => setInstruction(chip.text)} style={styles.chip}>
                  <Text variant="treeMeta" style={styles.chipText}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text variant="treeMeta" style={styles.note}>
              Redoing replaces the summary, including any changes made to it.
            </Text>
            <View style={styles.actions}>
              <Button label="Cancel" variant="dialog" onPress={close} testID="browse-redo-cancel" />
              <Button label="Redo summary" variant="dialogPrimary" onPress={redo} testID="browse-redo-go" />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    wrap: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    trigger: { paddingHorizontal: space.x2, paddingVertical: space.x1, borderRadius: radii.sm },
    triggerOpen: { backgroundColor: colors.accentDim },
    triggerText: { color: colors.muted },
    triggerBusy: { color: colors.chromeMuted },
    message: { color: colors.muted, maxWidth: 360 },
    scrim: { flex: 1 },
    panel: {
      position: "absolute",
      padding: space.x3,
      gap: space.x2,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: shadows.floating,
    },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 32,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    chip: { paddingHorizontal: space.x2, paddingVertical: space.x1, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.sm },
    chipText: { color: colors.text },
    note: { color: colors.muted },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
  });
