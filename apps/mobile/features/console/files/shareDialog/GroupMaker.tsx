import { Pressable, TextInput, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { AccessMember } from "../access";
import { canMakeGroup, memberLabel, previewGroupName } from "../../groups/groups";
import { makeStyles } from "./styles";

/**
 * Making a group without leaving the note.
 *
 * A label and a set of people, and nothing else — no role, no description, no
 * nesting. A group here is a *name a folder rule can point at*; everything
 * else about it is decided in the Groups panel, which is where renaming one and
 * dropping somebody from every folder at once still live.
 *
 * The assembled name is shown as you type because **the prefix is not yours to
 * enter** — `buildGroupName` derives it from the workspace slug, so a field
 * that accepted `supa-leads` would produce `@supa-supa-leads`. Same reasoning,
 * and the same words, as `GroupsPanel`'s greyed prefix.
 */
export function GroupMaker({
  slug,
  members,
  state,
  problem,
  onChange,
  onCancel,
  onCreate,
}: {
  slug: string;
  members: readonly AccessMember[];
  state: { label: string; picked: string[] };
  /** What the server refused, or `null`. */
  problem: string | null;
  onChange: (next: { label: string; picked: string[] }) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const ready = canMakeGroup(state.label, state.picked);

  return (
    <View style={styles.maker} testID="share-group-maker">
      <View style={styles.makerRow}>
        <TextInput
          value={state.label}
          onChangeText={(label) => onChange({ ...state, label })}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="Group name"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Group name"
        />
        <Button label="Create" disabled={!ready} onPress={onCreate} />
        <Button label="Cancel" onPress={onCancel} />
      </View>

      {problem === null ? null : (
        <Text variant="meta" style={styles.routeDanger} testID="share-group-problem">
          {problem}
        </Text>
      )}

      <Text variant="meta" style={styles.suggestionDetail}>
        {`Name the people you keep picking together. Will be ${previewGroupName(slug, state.label)} — the prefix is this context's, not yours to type.`}
      </Text>

      {/*
        Every member, with the ones already picked marked. Not `addableMembers`
        — that excludes who is already in an existing group, and this group does
        not exist yet.
      */}
      <View style={styles.pickList}>
        {members.map((member) => {
          const on = state.picked.includes(member.userId);
          return (
            <Pressable
              key={member.userId}
              style={[styles.pick, on && styles.pickOn]}
              /*
                Web props, like `AudienceControl` beside it. The RN-flavoured
                `accessibilityRole` / `accessibilityState` pair does not reach
                the DOM as `aria-checked` here, so a screen reader was told this
                was a checkbox and never told whether it was ticked.
              */
              role="checkbox"
              aria-checked={on}
              accessibilityLabel={memberLabel(member)}
              testID={`share-group-pick-${member.userId}`}
              onPress={() =>
                onChange({
                  ...state,
                  picked: on
                    ? state.picked.filter((id) => id !== member.userId)
                    : [...state.picked, member.userId],
                })
              }
            >
              <Text variant="meta" style={on ? undefined : styles.suggestionMuted}>
                {`${on ? "✓ " : ""}${memberLabel(member)}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
