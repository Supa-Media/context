import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View, type GestureResponderEvent } from "react-native";
import { PressRow } from "../design/components/Button";
import { Dot, type DotTone } from "../design/components/Dot";
import { Icon, type IconName } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { Text } from "../design/components/Text";
import { KeyboardSticky } from "../design/keyboardSticky";
import { useFieldFont } from "../design/fieldFont";
import { fonts, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import type { InputMode } from "./remoteGesture";
import { MAX_TYPED, type TexAction } from "./texComputer";

/** The two things the "⋯" menu holds, and nothing else. */
export type TexMenuId = "handBack" | "stop";

/** One of the top bar's icon-only buttons. */
function ToolButton(props: { icon: IconName; label: string; onPress: (event: GestureResponderEvent) => void; on?: boolean; menu?: boolean; testID: string }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={props.label}
      onPress={props.onPress}
      radius={radii.md}
      style={[styles.tool, props.on ? styles.toolOn : null]}
      hoverStyle={styles.toolHover}
      {...(props.menu ? { ariaHasPopup: "menu" as const, ariaExpanded: props.on ?? false } : {})}
      testID={props.testID}
    >
      <Icon name={props.icon} size={19} color={props.on ? colors.text : colors.text2} />
    </PressRow>
  );
}

/**
 * The top bar: a small status on the left, and on the right the keyboard,
 * the trackpad/touch toggle and a "⋯" menu, all icons. `controls` is false
 * while nothing is running, and then only the status shows.
 */
export function TexToolbar(props: {
  status: { tone: DotTone; label: string; where: string | null };
  busy: boolean;
  controls: boolean;
  keyboard: boolean;
  mode: InputMode;
  onKeyboard: () => void;
  onMode: () => void;
  onMenu: (id: TexMenuId) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <View style={styles.toolbar} testID="tex-toolbar">
      <View style={styles.status} testID="tex-status">
        <Dot tone={props.status.tone} />
        <Text variant="rowSub" style={styles.statusLabel} numberOfLines={1}>
          {props.status.label}
          {props.status.where ? <Text variant="rowSub" style={styles.where}>{` · ${props.status.where}`}</Text> : null}
        </Text>
        {props.busy ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      </View>
      {props.controls ? (
        <View style={styles.tools}>
          <ToolButton
            icon={props.keyboard ? "keyboardHide" : "keyboard"}
            label={props.keyboard ? "Hide the keyboard" : "Show the keyboard"}
            on={props.keyboard}
            onPress={props.onKeyboard}
            testID="tex-keyboard"
          />
          <ToolButton
            icon={props.mode === "trackpad" ? "mouse" : "touch"}
            label={props.mode === "trackpad" ? "Trackpad mode. Switch to touch mode" : "Touch mode. Switch to trackpad mode"}
            onPress={props.onMode}
            testID="tex-mode"
          />
          <ToolButton
            icon="more"
            label="More"
            menu
            on={menuAt !== null}
            onPress={(event) => setMenuAt({ x: event.nativeEvent.pageX ?? 0, y: event.nativeEvent.pageY ?? 0 })}
            testID="tex-menu"
          />
        </View>
      ) : null}
      {menuAt !== null ? (
        <Menu<TexMenuId>
          anchor={menuAt}
          title="Tex's browser"
          items={[
            { id: "handBack", label: "Hand back to Tex", testID: "tex-hand-back" },
            { id: "stop", label: "Stop browser", danger: true, testID: "tex-stop" },
          ]}
          onSelect={(id) => {
            setMenuAt(null);
            props.onMenu(id);
          }}
          onDismiss={() => setMenuAt(null)}
        />
      ) : null}
    </View>
  );
}

/**
 * Remote Desktop's "Send text" bar: what is typed goes to whatever field is
 * focused on the page, once, and is not kept here. Return sends the text and
 * then Enter; the two keys press Backspace and Enter on the page.
 */
export function SendTextBar({ send, focus }: { send: (action: TexAction) => void; focus: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const field = useRef<TextInput>(null);
  const [text, setText] = useState("");
  // 16px or more on a phone, so focusing the field does not zoom the page.
  const fieldFont = useFieldFont(t.body);
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);
  const enter = () => {
    if (text.length > 0) send({ kind: "type", text });
    send({ kind: "key", name: "Enter" });
    setText("");
  };
  return (
    <KeyboardSticky style={styles.sendBar} testID="tex-send-bar">
      <PressRow accessibilityLabel="Type" onPress={() => field.current?.focus()} radius={radii.md} style={styles.key} testID="tex-send-focus">
        <Icon name="keyboard" size={19} color={colors.text2} />
      </PressRow>
      <TextInput
        ref={field}
        value={text}
        onChangeText={setText}
        onSubmitEditing={enter}
        submitBehavior="submit"
        placeholder="Send text"
        placeholderTextColor={colors.muted}
        maxLength={MAX_TYPED}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        accessibilityLabel="Send text to the page"
        style={[styles.sendInput, fieldFont]}
        testID="tex-send-input"
      />
      <PressRow accessibilityLabel="Backspace" onPress={() => send({ kind: "key", name: "Backspace" })} radius={radii.md} style={styles.key} testID="tex-key-backspace">
        <Icon name="backspace" size={19} color={colors.text2} />
      </PressRow>
      <PressRow accessibilityLabel="Return" onPress={enter} radius={radii.md} style={styles.key} testID="tex-key-enter">
        <Icon name="enter" size={19} color={colors.text2} />
      </PressRow>
    </KeyboardSticky>
  );
}


const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    status: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, paddingLeft: 4 },
    statusLabel: { color: colors.text, flexShrink: 1 },
    where: { color: colors.muted },
    tools: { flexDirection: "row", alignItems: "center", gap: 2 },
    tool: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    toolOn: { backgroundColor: colors.surface3 },
    toolHover: { backgroundColor: colors.surface2 },
    sendBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 8,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    key: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    sendInput: {
      flex: 1,
      minHeight: 40,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: t.body,
    },
  });
