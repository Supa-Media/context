import { Pressable, StyleSheet, View } from "react-native";
import { CAST_EDIT_KINDS, type CastActor, type CastEditKind, type CastStep } from "@context/shared";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { StudioInlineField } from "./StudioInlineField";
import type { ScriptEdits } from "./scriptEdits";

/** What each kind is called in the editor, in plain words. */
const KIND_LABEL: Record<CastEditKind, string> = {
  line: "types",
  comment: "comments",
  reply: "replies",
  resolve: "resolves",
  open: "opens a page",
  join: "comes in",
  leave: "leaves",
  wait: "pause",
};

/** The kind a step shows as in the editor; steps it cannot switch to show none. */
function kindOf(step: CastStep): CastEditKind | null {
  return (CAST_EDIT_KINDS as readonly string[]).includes(step.kind) ? (step.kind as CastEditKind) : null;
}

/**
 * A step opened on the rail: who does it, what they do, what a comment is
 * about, where it sits, and taking it out. The words themselves are typed in
 * the row above, where they always are.
 */
export function StudioStepEditor({
  index,
  step,
  count,
  cast,
  edits,
  onRemoved,
  onClose,
}: {
  index: number;
  step: CastStep;
  count: number;
  cast: readonly CastActor[];
  edits: ScriptEdits;
  /** After the step is taken out, with it, so it can be put back. */
  onRemoved: (index: number, step: CastStep) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = kindOf(step);
  const fallback = cast[0] ?? { name: "@you", kind: "person" as const };
  return (
    <View style={styles.editor} testID="studio-step-editor">
      {!("actor" in step) ? null : (
        <View style={styles.group}>
          <Text variant="treeMetaMono" style={styles.label}>
            Who
          </Text>
          <View style={styles.chips} accessibilityRole="radiogroup" aria-label="Who">
            {cast.map((actor) => {
              const on = actor.name === step.actor.name;
              return (
                <Pressable
                  key={actor.name}
                  onPress={() => edits.actor(index, actor)}
                  accessibilityRole="radio"
                  aria-checked={on}
                  style={[styles.chip, on ? styles.chipOn : null]}
                  testID={`studio-who-${actor.name}`}
                >
                  <Text variant="rowSub" style={on ? styles.chipTextOn : styles.chipText}>
                    {actor.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
      <View style={styles.group}>
        <Text variant="treeMetaMono" style={styles.label}>
          Does
        </Text>
        <View style={styles.chips} accessibilityRole="radiogroup" aria-label="Does">
          {CAST_EDIT_KINDS.map((kind) => {
            const on = kind === current;
            return (
              <Pressable
                key={kind}
                onPress={() => (on ? undefined : edits.kind(index, kind, fallback))}
                accessibilityRole="radio"
                aria-checked={on}
                style={[styles.chip, on ? styles.chipOn : null]}
                testID={`studio-kind-${kind}`}
              >
                <Text variant="rowSub" style={on ? styles.chipTextOn : styles.chipText}>
                  {KIND_LABEL[kind]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {step.kind === "comment" ? (
        <View style={styles.group}>
          <Text variant="treeMetaMono" style={styles.label}>
            On the words
          </Text>
          <View style={styles.quote}>
            <StudioInlineField
              value={step.quote}
              onCommit={(quote) => edits.quote(index, quote)}
              label="The words the comment is about"
              testID="studio-comment-quote"
            />
          </View>
        </View>
      ) : null}
      <View style={styles.foot}>
        <View style={styles.chips}>
          <Pressable
            onPress={() => edits.move(index, index - 1)}
            disabled={index === 0}
            accessibilityRole="button"
            accessibilityLabel="Move up"
            style={[styles.tool, index === 0 ? styles.off : null]}
            testID="studio-move-up"
          >
            <Icon name="chevronUp" size={14} />
          </Pressable>
          <Pressable
            onPress={() => edits.move(index, index + 1)}
            disabled={index >= count - 1}
            accessibilityRole="button"
            accessibilityLabel="Move down"
            style={[styles.tool, index >= count - 1 ? styles.off : null]}
            testID="studio-move-down"
          >
            <Icon name="chevronDown" size={14} />
          </Pressable>
          {step.kind === "wait" ? null : (
            <Pressable
              onPress={() => edits.insert(index, { kind: "wait", ms: 1000 })}
              accessibilityRole="button"
              style={styles.tool}
              testID="studio-pause-before"
            >
              <Icon name="clock" size={14} />
              <Text variant="rowSub" style={styles.chipText}>
                Pause before
              </Text>
            </Pressable>
          )}
        </View>
        <View style={styles.chips}>
          <Pressable
            onPress={() => {
              edits.remove(index);
              onRemoved(index, step);
            }}
            accessibilityRole="button"
            style={styles.tool}
            testID="studio-delete-step"
          >
            <Icon name="trash" size={14} />
            <Text variant="rowSub" style={styles.danger}>
              Delete
            </Text>
          </Pressable>
          <Pressable onPress={onClose} accessibilityRole="button" style={[styles.tool, styles.close]} testID="studio-editor-close">
            <Text variant="rowSub" style={styles.chipTextOn}>
              Close
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    editor: {
      marginLeft: space.x6,
      marginRight: space.x1,
      marginBottom: space.x2,
      padding: space.x3,
      gap: space.x3,
      borderRadius: radii.xl,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    group: { gap: space.x1 },
    label: { color: colors.muted },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x1, alignItems: "center" },
    chip: { minHeight: 32, paddingHorizontal: space.x3, justifyContent: "center", borderRadius: radii.lg, backgroundColor: colors.chipFill },
    chipOn: { backgroundColor: colors.text },
    chipText: { color: colors.text },
    chipTextOn: { color: colors.surface, fontWeight: "600" },
    quote: { flexDirection: "row", borderRadius: radii.md, backgroundColor: colors.chipFill, paddingLeft: space.x2 },
    foot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    tool: { flexDirection: "row", alignItems: "center", gap: space.x1, minHeight: 32, minWidth: 32, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.lg },
    off: { opacity: 0.35 },
    close: { backgroundColor: colors.text },
    danger: { color: colors.critText },
  });
