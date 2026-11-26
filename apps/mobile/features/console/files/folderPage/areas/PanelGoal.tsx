/**
 * An area metric's goal in the side panel: its shape picked from a dropdown
 * (At least, At most, More than, Less than) and its number in a field beside
 * it, so no direction word is ever typed (the owner, 2026-11-26: "there
 * should just be a dropdown for the different shapes a metric can take", "it
 * shouldnt be typed out"). A goal written in words with no number keeps the
 * plain field it always had.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { GOAL_SHAPES, goalParts, goalTarget, type GoalWord } from "./goalDirection";
import { InlineField } from "./PanelSeatFields";
import { leadingNumber } from "./readings";

type Anchor = { x: number; y: number } | null;

export function PanelGoal({ target, canEdit, onSave }: { target: string | null; canEdit: boolean; onSave: (target: string | null) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const goal = goalParts(target);
  const [word, setWord] = useState<GoalWord>(goal.word);
  useEffect(() => setWord(goal.word), [goal.word]);
  const [menu, setMenu] = useState<{ anchor: Anchor } | null>(null);
  const node = useRef<View>(null);
  const shaped = goal.bar === "" || leadingNumber(goal.bar) !== null;
  const save = (next: string | null) => {
    if (next !== target) onSave(next);
  };
  const pick = (id: string) => {
    setMenu(null);
    const next = GOAL_SHAPES.find((shape) => shape.word === id)?.word;
    if (next === undefined) return;
    setWord(next);
    if (goal.bar !== "") save(goalTarget(next, goal.bar));
  };

  return (
    <View style={styles.goal}>
      <Text variant="treeMeta" style={styles.muted}>Goal</Text>
      {!shaped ? null : canEdit ? (
        <View ref={node} collapsable={false}>
          <Pressable
            onPress={() => {
              if (node.current?.measureInWindow === undefined) setMenu({ anchor: null });
              else node.current.measureInWindow((x, y, _width, height) => setMenu({ anchor: { x, y: y + height + 4 } }));
            }}
            role="button"
            aria-haspopup="menu"
            accessibilityLabel={`Goal shape: ${word}`}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.shape, hovered && styles.shapeHover]}
            testID="area-panel-goal-shape"
          >
            <Text variant="treeMeta" style={styles.shapeWord}>{word}</Text>
            <Icon name="chevronDown" size={12} color={colors.text2} />
          </Pressable>
        </View>
      ) : goal.bar === "" ? null : (
        <Text variant="treeMeta" style={styles.shapeWord} testID="area-panel-goal-shape">{word}</Text>
      )}
      <InlineField
        value={shaped ? goal.bar : (target ?? "")}
        label={shaped ? `Goal, ${word.toLowerCase()}` : "Goal"}
        placeholder={canEdit ? "Set one" : "None"}
        editable={canEdit}
        onCommit={(text) => save(shaped ? goalTarget(word, text) : text.trim() || null)}
        style={styles.field}
        testID="area-panel-goal"
      />
      {menu === null ? null : (
        <Menu<string>
          items={GOAL_SHAPES.map((shape) => ({ id: shape.word, label: shape.word, detail: shape.detail, checked: shape.word === word, testID: `area-panel-goal-${shape.word.toLowerCase().replace(" ", "-")}` }))}
          {...(menu.anchor === null ? {} : { anchor: menu.anchor })}
          title="Goal shape"
          onSelect={pick}
          onDismiss={() => setMenu(null)}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    goal: { flexDirection: "row", alignItems: "center", gap: space.x1, paddingLeft: space.x2, paddingRight: space.x1, borderRadius: radii.pill, backgroundColor: colors.chipFill },
    muted: { color: colors.muted },
    shape: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 1, paddingLeft: space.x2, paddingRight: space.x1, borderRadius: radii.pill, backgroundColor: colors.surface },
    shapeHover: { backgroundColor: colors.line },
    shapeWord: { color: colors.text, fontWeight: "600" },
    field: { fontSize: pointerType.meta, minWidth: 56, marginLeft: 0 },
  });
