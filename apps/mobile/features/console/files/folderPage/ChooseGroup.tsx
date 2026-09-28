/**
 * "Choose group": the one control a word nobody has placed gets, drawn in
 * the heading of its No group yet group (List) or its column (Board), and on
 * its row in "Edit statuses…". It opens the folder's three groups; picking
 * one adds the word to the folder's list in that group, and the notes keep
 * their word.
 *
 * It is never a sentence above the page. A folder's words are its owner's
 * business, so the question sits on the thing it is about and nowhere else,
 * and somebody who may not change the list is not given it at all.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { MenuItem } from "../menu";
import { GROUPS, GROUP_LABELS, type StatusGroup } from "./statuses";

type ChoiceId = `to:${StatusGroup}` | "edit";

export function ChooseGroup({
  word,
  onPlace,
  onEditList,
}: {
  word: string;
  onPlace: (word: string, group: StatusGroup) => void;
  /** "Rename or merge…", which opens the folder's statuses; null leaves it out. */
  onEditList: (() => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const trigger = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const items: MenuItem<ChoiceId>[] = [
    ...GROUPS.map((group) => ({ id: `to:${group}` as const, label: GROUP_LABELS[group] })),
    ...(onEditList === null ? [] : [{ id: "edit" as const, label: "Rename or merge…", separatorBefore: true }]),
  ];
  const open = () => {
    setMenu({ x: 0, y: 0 });
    trigger.current?.measureInWindow?.((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
  };
  return (
    <View ref={trigger} collapsable={false}>
      <Pressable
        role="button"
        aria-haspopup="menu"
        accessibilityLabel={`Choose a group for ${word}`}
        onPress={open}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={[styles.button, hovered && styles.hover]}
        testID="folder-choose-group"
      >
        <Text variant="meta" style={styles.label}>
          Choose group
        </Text>
        <Icon name="chevronDown" size={12} color={colors.warnText} />
      </Pressable>
      {menu === null ? null : (
        <Menu<ChoiceId>
          items={items}
          {...(menu.x === 0 && menu.y === 0 ? {} : { anchor: menu })}
          title={`Put ${word} in`}
          onDismiss={() => setMenu(null)}
          onSelect={(id) => {
            setMenu(null);
            if (id === "edit") onEditList?.();
            else onPlace(word, id.slice("to:".length) as StatusGroup);
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: 26,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.warnBorder,
    },
    hover: { backgroundColor: colors.warnWash },
    label: { color: colors.warnText, fontWeight: "600" },
  });
