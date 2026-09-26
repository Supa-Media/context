/**
 * Words in use that the folder's status list does not hold, each with the
 * one question it raises, for an owner or editor above a List or Board:
 *
 * - An ordinary lifecycle word (`active`) already sits in its group, so the
 *   question is whether it is a status of its own or another spelling of one
 *   the folder has: "Merge into In progress" or "Keep as a status".
 * - A word nobody placed (`exploration`) sits in Needs a group until
 *   somebody says which group it is in; nothing guesses for them.
 *
 * Merging rewrites notes, so it asks first with the count
 * (`useStatusEdits.planMerge`); placing or keeping a word only adds it to the
 * list. A member sees none of this: the board shows the same bands, and
 * nothing here is theirs to answer.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { GROUPS, GROUP_LABELS, type StatusGroup, type UndeclaredStatus } from "./statuses";
import { StatusPill } from "./StatusPill";

export function TidyStatuses({
  words,
  onPlace,
  onMerge,
}: {
  words: readonly UndeclaredStatus[];
  onPlace: (word: string, group: StatusGroup) => void;
  onMerge: (word: string, into: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (words.length === 0) return null;
  return (
    <View style={styles.box} testID="folder-tidy">
      {words.map((each) => {
        const here = each.count === 1 ? "1 item here" : `${each.count} items here`;
        return (
          <View key={each.word.toLowerCase()} style={styles.line} testID="folder-tidy-word">
            <StatusPill value={each.word} tone={each.group ?? "unplaced"} />
            {each.group === null ? (
              <>
                <Text variant="tree" style={styles.words}>
                  {`is on ${here} but isn’t one of this folder’s statuses. Which group is it in?`}
                </Text>
                {GROUPS.map((group) => (
                  <Action key={group} label={GROUP_LABELS[group]} onPress={() => onPlace(each.word, group)} testID={`folder-tidy-place-${group}`} />
                ))}
              </>
            ) : (
              <>
                <Text variant="tree" style={styles.words}>
                  {`is on ${here} and reads as ${GROUP_LABELS[each.group]}.`}
                </Text>
                {each.mergeInto !== null && each.mergeInto.toLowerCase() !== each.word.toLowerCase() ? (
                  <Action
                    label={`Merge into ${each.mergeInto.charAt(0).toUpperCase()}${each.mergeInto.slice(1)}`}
                    onPress={() => onMerge(each.word, each.mergeInto!)}
                    testID="folder-tidy-merge"
                  />
                ) : null}
                <Action label="Keep as a status" onPress={() => onPlace(each.word, each.group!)} testID="folder-tidy-keep" />
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

function Action({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={6}
      testID={testID}
    >
      <Text variant="tree" style={[styles.action, hovered && styles.actionHover]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { gap: space.x2 },
    line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.x3, rowGap: 4 },
    words: { color: colors.muted, flexShrink: 1 },
    action: { color: colors.accentText, fontWeight: "600" },
    actionHover: { textDecorationLine: "underline" },
  });
