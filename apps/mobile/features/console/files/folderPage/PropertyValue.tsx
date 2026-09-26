/**
 * One property value on a folder page — a project's status or owner — and,
 * for somebody who may change it, the menu that does.
 *
 * The React Native counterpart of the list block's `ValueMenu`, offering the
 * same choices in the same order: the values already in use (checked when it
 * is this one), then "New value…", which turns the value into a one-line
 * field, then "Clear" where there is something to clear. When the write would
 * create the note it lands in, the menu says so before anything is pressed.
 * The menu is the app's own `Menu` — a popover under a pointer, a sheet under
 * a thumb — so this draws no chrome of its own.
 *
 * A status is offered in its groups instead (`sections`): each group's name
 * as a heading, No status first in Not started, and "Edit statuses…" in
 * place of "New value…" — a status is added to a group, never typed loose
 * onto one note, so it always has a group (`statuses.ts`).
 *
 * An owner is chosen, never typed: given `owners`, pressing the value opens
 * `OwnerPicker` — the workspace's people and connected agents, searched on the
 * server — in place of the menu, and there is no "New value…" to press.
 *
 * Unset and editable, it reads `Set status`: muted, and accent under the
 * pointer, the one affordance a folder needs to become a project. Unset and
 * not editable, it draws nothing — a member is not shown a control that
 * would only ever fail.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Menu } from "../../../design/components/Menu";
import { Text, type TextVariant } from "../../../design/components/Text";
import { fonts, pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { MenuItem } from "../menu";
import type { OwnerSearch } from "../owners";
import { OwnerPicker } from "./OwnerPicker";

export interface PropertyValueProps {
  /** The frontmatter key, which names the menu and the field. */
  property: string;
  /** The value as written, or `""` when unset. */
  value: string;
  choices: readonly string[];
  /** `overview.md` when choosing would create it; shown in the menu. */
  savesTo?: string | null;
  /** Null when the reader may not change it. */
  onChoose: ((value: string | null) => void) | null;
  /** Offer these groups of values instead of `choices`, with no "New value…"; `""` is none. */
  sections?: readonly { readonly label: string; readonly words: readonly string[] }[];
  /** "Edit statuses…" at the foot of a sectioned menu; null or absent to leave it out. */
  onEditList?: (() => void) | null;
  /** Pick from people and agents instead of the menu; `prefer` is the folder's owners, most used first. */
  owners?: { readonly search: OwnerSearch; readonly prefer: readonly string[] };
  variant?: TextVariant;
  /**
   * Drawn invisible until something asks for it — a row under the pointer —
   * but still there, so its menu does not close when the pointer moves into
   * it and leaves the row.
   */
  quiet?: boolean;
  /** The colour of a set value; unset and hovered have their own. */
  style?: StyleProp<TextStyle>;
  testID?: string;
}

type Id = `choice:${number}` | `head:${number}` | "new" | "clear" | "saves" | "edit";

export function PropertyValue({
  property,
  value,
  choices,
  savesTo = null,
  onChoose,
  sections,
  onEditList = null,
  owners,
  variant = "tree",
  quiet = false,
  style,
  testID,
}: PropertyValueProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const trigger = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [typing, setTyping] = useState(false);
  const [hovered, setHovered] = useState(false);
  // A keyboard reaches a quiet value by Tab; it shows while focused, as it does under the pointer.
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");

  if (onChoose === null) {
    return value === "" ? null : (
      <Text variant={variant} style={style} numberOfLines={1} testID={testID}>
        {isolateForDisplay(value)}
      </Text>
    );
  }

  if (typing) {
    const done = (save: boolean) => {
      setTyping(false);
      const next = draft.trim();
      if (save && next !== "" && next !== value) onChoose(next);
    };
    return (
      <TextInput
        autoFocus
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={() => done(true)}
        onBlur={() => done(false)}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") done(false);
        }}
        placeholder={`New ${property}`}
        placeholderTextColor={colors.chromeMuted}
        accessibilityLabel={`New ${property}`}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.field}
        testID={testID === undefined ? undefined : `${testID}-field`}
      />
    );
  }

  const current = value === "" ? null : value;
  let all: string[];
  let items: MenuItem<Id>[];
  if (sections !== undefined) {
    // Groups as dimmed headings, the way "Saves to" is a dimmed line: said, not pressed.
    all = [];
    items = [];
    sections.forEach((section, at) => {
      items.push({ id: `head:${at}`, label: section.label, disabled: true, separatorBefore: at > 0 });
      for (const word of section.words) {
        items.push({
          id: `choice:${all.length}`,
          label: word === "" ? `No ${property}` : isolateForDisplay(word),
          checked: word.toLowerCase() === value.toLowerCase(),
        });
        all.push(word);
      }
    });
    if (current !== null && !all.some((word) => word.toLowerCase() === current.toLowerCase())) {
      // A word the list does not hold is still this note's; shown checked, apart.
      items.unshift({ id: `choice:${all.length}`, label: isolateForDisplay(current), checked: true });
      all.push(current);
    }
    if (onEditList !== null) items.push({ id: "edit", label: `Edit ${property === "status" ? "statuses" : property}…`, separatorBefore: true });
  } else {
    all = current !== null && !choices.some((c) => c.toLowerCase() === current.toLowerCase()) ? [current, ...choices] : [...choices];
    items = [
      ...all.map((choice, index) => ({
        id: `choice:${index}` as const,
        label: isolateForDisplay(choice),
        // No check gutter at all when nothing is chosen, so the rows line up with "New value…".
        ...(current === null ? {} : { checked: choice.toLowerCase() === current.toLowerCase() }),
      })),
      { id: "new", label: "New value…", separatorBefore: all.length > 0 },
      ...(current === null ? [] : [{ id: "clear" as const, label: "Clear" }]),
    ];
  }
  // Said before anything is pressed: this choice writes a file that is not there yet.
  if (savesTo !== null) items.push({ id: "saves", label: `Saves to ${savesTo}`, disabled: true, separatorBefore: true });

  const open = () => {
    if (owners !== undefined) {
      // Opened where the value is once measured, so a popover does not start life as a sheet.
      const measure = trigger.current?.measureInWindow;
      if (measure === undefined) setPicking(true);
      else
        trigger.current?.measureInWindow((x, y, _width, height) => {
          setMenu({ x, y: y + height + 4 });
          setPicking(true);
        });
      return;
    }
    setMenu({ x: 0, y: 0 });
    trigger.current?.measureInWindow?.((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
  };

  return (
    <View ref={trigger} collapsable={false}>
      <Pressable
        onPress={open}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        role="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null || picking}
        accessibilityLabel={current === null ? `Set ${property}` : `Change ${property}, ${current}`}
        hitSlop={6}
        testID={testID}
      >
        <Text
          variant={variant}
          numberOfLines={1}
          style={[style, current === null && styles.unset, hovered && styles.hover, quiet && !hovered && !focused && menu === null && styles.quiet]}
        >
          {current === null ? `Set ${property}` : isolateForDisplay(current)}
        </Text>
      </Pressable>
      {owners === undefined || !picking ? null : (
        <OwnerPicker
          current={value}
          search={owners.search}
          prefer={owners.prefer}
          anchor={menu}
          savesTo={savesTo}
          onChoose={onChoose}
          onDismiss={() => {
            setPicking(false);
            setMenu(null);
          }}
        />
      )}
      {menu === null || owners !== undefined ? null : (
        <Menu<Id>
          items={items}
          {...(menu.x === 0 && menu.y === 0 ? {} : { anchor: menu })}
          title={property.charAt(0).toUpperCase() + property.slice(1)}
          onDismiss={() => setMenu(null)}
          onSelect={(id) => {
            setMenu(null);
            if (id === "new") {
              setDraft("");
              setTyping(true);
            } else if (id === "clear") onChoose(null);
            else if (id === "edit") onEditList?.();
            else if (id.startsWith("choice:")) {
              const choice = all[Number(id.slice("choice:".length))];
              if (choice === undefined || choice.toLowerCase() === value.toLowerCase()) return;
              onChoose(choice === "" ? null : choice);
            }
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    unset: { color: colors.chromeMuted },
    hover: { color: colors.accentText },
    quiet: { opacity: 0 },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      minWidth: 120,
      height: 24,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
  });
