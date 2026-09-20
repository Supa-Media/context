import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../design/components/Button";
import { FormError } from "../../design/components/Input";
import { TextField } from "../../design/components/Input";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { PluginSettingControl, PluginSettingRow, RuntimeView } from "./runtime";

/**
 * A plugin's own settings pane, drawn by the console.
 *
 * ## Why the plugin does not draw it
 *
 * `display()` is the most hostile thing a plugin runs on Context's behalf. The
 * pane this was built against opens with a **sponsor iframe** and a **tracking
 * image**, both set through `innerHTML`, before it reaches a single control —
 * so forwarding what a plugin builds would mean Context serving somebody
 * else's ads and somebody else's analytics from inside a customer's console.
 *
 * So `display()` runs in the sandbox, against a real `containerEl`, and what
 * crosses is a *description*: a kind, a name, a sentence, a value, a list of
 * options. The console draws its own controls from that, and a change goes back
 * as an index. The same inversion as the suggestion dialog and `Modal`, applied
 * where it matters most.
 *
 * ## What that costs, said rather than hidden
 *
 * A link in a plugin's settings arrives as plain words — the anchor does not
 * survive, because an anchor is markup. `LINKS_NOTE` says so once at the foot
 * of the pane rather than leaving a reader to wonder why "Support us" is not
 * clickable. A refusal that carries its route out is the rule everywhere else
 * in this feature; this is the same move.
 *
 * ## The rows are the plugin's, in the plugin's order
 *
 * Document order from its own `containerEl`, so a heading it wrote between two
 * settings lands between them. Nothing is re-sorted and nothing is grouped:
 * this is somebody else's pane, and rearranging it would make their own
 * documentation wrong.
 */
export function PluginSettingsPane({ runtime }: { runtime?: RuntimeView }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /*
    Optional for `PluginSuggestDialog`'s reason, which was a crash rather than a
    preference: a viewer who is not the owner has no runtime, and neither does
    the landing page's demo.
  */
  const pane = runtime?.settingsPane ?? null;
  const change = runtime?.actions?.changeSetting;
  const close = runtime?.actions?.closeSettingsPane;

  if (pane === null) return null;

  const touch = Platform.OS !== "web" || width < layout.narrowBreakpoint;

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={() => close?.()}
      testID="plugin-settings-pane"
    >
      <Pressable style={styles.scrim} onPress={() => close?.()} accessibilityLabel="Close">
        <View style={[styles.centre, touch ? styles.centreTouch : styles.centrePointer]}>
          <View
            style={[styles.panel, { paddingBottom: touch ? insets.bottom : 0 }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.head}>
              {/* Whose settings these are. A reader is about to change how
                  third-party code behaves, and that is the first thing to say. */}
              <Text variant="treeMeta" style={styles.who}>
                {pane.pluginId}
              </Text>
              <Text variant="rowTitle">Settings</Text>
            </View>

            {pane.error === null ? null : (
              /*
                `display()` threw part-way. Said outright, because a pane that
                stops silently looks exactly like a plugin with fewer settings —
                the quieter failure and the worse one. Found for real: the shim
                was missing `hide()`, and seventeen of twenty-one rows vanished
                with no error anywhere.
              */
              <View style={styles.errorRow}>
                <FormError
                  headline="This plugin's settings stopped part-way"
                  next={`${pane.error} — what is below is what it managed to draw, and there may be more settings it did not reach.`}
                />
              </View>
            )}

            <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
              {pane.rows.length === 0 && pane.error === null ? (
                <Text variant="rowSub" style={styles.muted} testID="plugin-settings-empty">
                  This plugin drew no settings.
                </Text>
              ) : (
                pane.rows.map((row, at) => (
                  <Row key={rowKey(row, at)} row={row} onChange={change} />
                ))
              )}
            </ScrollView>

            <View style={styles.foot}>
              <Text variant="hint" style={styles.muted}>
                {LINKS_NOTE}
              </Text>
              <Button label="Done" onPress={() => close?.()} testID="plugin-settings-close" />
            </View>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * Said once, at the foot, rather than per row.
 *
 * A plugin's settings pane routinely carries links — to its documentation, its
 * repository, its author. None of them survive the boundary, because a link is
 * markup and only text crosses. Silence there reads as a broken pane; this
 * reads as a rule, which is what it is.
 */
export const LINKS_NOTE =
  "Links and images in a plugin's settings are shown as plain text — only words cross into Context.";

/**
 * A stable key that survives a redraw.
 *
 * The plugin re-describes its whole pane after a change, so keying on position
 * alone would remount every control on every keystroke in a text field. A
 * control keeps its `index`; a heading or a note keeps its words.
 */
function rowKey(row: PluginSettingRow, at: number): string {
  return "index" in row ? `c${row.index}` : `${row.kind}:${at}:${row.text}`;
}

function Row({
  row,
  onChange,
}: {
  row: PluginSettingRow;
  onChange?: (index: number, value: boolean | string | number) => void;
}) {
  const styles = useThemedStyles(makeStyles);

  if (row.kind === "heading") {
    return (
      <Text variant="listGroup" style={styles.heading} testID="plugin-settings-heading">
        {row.text}
      </Text>
    );
  }
  if (row.kind === "note") {
    return (
      <Text variant="rowSub" style={styles.note} testID="plugin-settings-note">
        {row.text}
      </Text>
    );
  }

  const label = (
    <View style={styles.labels}>
      <Text variant="rowTitle">{row.name}</Text>
      {row.desc === "" ? null : (
        <Text variant="rowSub" style={styles.muted}>
          {row.desc}
        </Text>
      )}
    </View>
  );

  if (row.kind === "toggle") {
    const on = row.value === true;
    return (
      <View style={styles.control} testID={`plugin-setting-${row.index}`}>
        {label}
        {/*
          A pill and a button rather than a switch, and not for want of one:
          this design system has no `Switch` primitive on purpose, and
          `ContextPluginsCard` states why. On/off is marked more than one way —
          a dot and a word — and the control is an ordinary button whose label
          says what pressing it does, so it reads correctly to a screen reader
          without an accessibility label restating the state.
        */}
        <Pill tone={on ? "ok" : "neutral"}>
          <Dot tone={on ? "ok" : "neutral"} />
          {on ? " On" : " Off"}
        </Pill>
        <Button
          label={on ? "Turn off" : "Turn on"}
          variant="mini"
          disabled={row.disabled}
          onPress={() => onChange?.(row.index, !on)}
          testID={`plugin-setting-toggle-${row.index}`}
        />
      </View>
    );
  }

  if (row.kind === "dropdown") {
    return (
      <View style={styles.stacked} testID={`plugin-setting-${row.index}`}>
        {label}
        <Options row={row} onChange={onChange} />
      </View>
    );
  }

  if (row.kind === "button") {
    return (
      <View style={styles.control} testID={`plugin-setting-${row.index}`}>
        {label}
        <Button
          label={row.label || "Run"}
          disabled={row.disabled}
          onPress={() => onChange?.(row.index, true)}
          testID={`plugin-setting-button-${row.index}`}
        />
      </View>
    );
  }

  /*
    `text` and `slider` both edit to a value the plugin reads back as one.

    Re-annotated rather than falling through: the checks above narrow the union
    to nothing, so TypeScript types the tail as `never` and every field read on
    it is an error. Naming the two kinds that reach here keeps the exhaustiveness
    honest — a sixth kind added to the union fails this line rather than being
    drawn as a text field.
  */
  const field: Extract<PluginSettingControl, { kind: "text" | "slider" }> = row;
  return (
    <View style={styles.stacked} testID={`plugin-setting-${field.index}`}>
      <TextField
        label={field.name}
        value={String(field.value ?? "")}
        placeholder={field.placeholder}
        editable={!field.disabled}
        keyboardType={field.kind === "slider" ? "numeric" : undefined}
        onChangeText={(next: string) =>
          onChange?.(field.index, field.kind === "slider" ? Number(next) || 0 : next)
        }
        autoCapitalize="none"
        autoCorrect={false}
        testID={`plugin-setting-text-${field.index}`}
      />
      {field.desc === "" ? null : (
        <Text variant="rowSub" style={styles.muted}>
          {field.desc}
        </Text>
      )}
    </View>
  );
}

/**
 * A dropdown's options, as a list rather than a native picker.
 *
 * Deliberately not `<select>`: this list can be long — the pane this was built
 * against offers sixty Bible translations — and a native picker on a phone
 * hides the current value behind a sheet. Collapsed to the chosen row with the
 * rest one press away keeps the pane readable at sixty options and at two.
 */
function Options({
  row,
  onChange,
}: {
  row: Extract<PluginSettingControl, { kind: "dropdown" }>;
  onChange?: (index: number, value: boolean | string | number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const chosen = row.options.find((option) => option.value === row.value);

  if (!open) {
    return (
      <Button
        label={chosen?.label ?? String(row.value ?? "Choose")}
        variant="mini"
        disabled={row.disabled}
        onPress={() => setOpen(true)}
        testID={`plugin-setting-dropdown-${row.index}`}
      />
    );
  }

  return (
    <View style={styles.options}>
      {row.options.map((option) => (
        <Pressable
          key={option.value}
          style={[styles.option, option.value === row.value && styles.optionActive]}
          accessibilityRole="button"
          onPress={() => {
            setOpen(false);
            onChange?.(row.index, option.value);
          }}
          testID={`plugin-setting-option-${row.index}-${option.value}`}
        >
          <Text variant="rowSub" numberOfLines={2}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The literal the other overlays here use rather than `colors.scrim`, which
    // no overlay in this codebase uses yet — see `Overlay`.
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    centre: { flex: 1, alignItems: "center" },
    centrePointer: { paddingTop: "8%" },
    centreTouch: { justifyContent: "flex-end" },
    panel: {
      width: "100%",
      maxWidth: 620,
      maxHeight: "88%",
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
    errorRow: { paddingHorizontal: space.x3, paddingTop: space.x3 },
    body: { paddingHorizontal: space.x3, paddingVertical: space.x2 },
    heading: { marginTop: space.x3, marginBottom: space.x1 },
    note: { color: colors.muted, marginVertical: space.x1 },
    control: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
    },
    stacked: { paddingVertical: space.x2, gap: space.x1 },
    labels: { flex: 1, gap: 2 },
    muted: { color: colors.muted },
    options: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      overflow: "hidden",
    },
    option: { paddingHorizontal: space.x3, paddingVertical: space.x2 },
    optionActive: { backgroundColor: colors.accentDim },
    foot: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      gap: space.x2,
    },
  });
