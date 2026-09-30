import { useState } from "react";
import { Pressable, Text as Inline, StyleSheet, View } from "react-native";
import type { CastActor } from "@context/shared";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { pointerType, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { StudioInlineField } from "./StudioInlineField";

/**
 * The same name as a person or as an agent: `@maya` is a person, and as an
 * agent is `Maya`; `@jon's Claude` is an agent, and as a person is `@jon`.
 */
export function asOtherKind(actor: CastActor): string {
  if (actor.kind === "person") {
    const bare = actor.name.replace(/^@/, "");
    return bare.slice(0, 1).toUpperCase() + bare.slice(1);
  }
  const owner = /^(@[^']+)'s /.exec(actor.name);
  return owner !== null ? owner[1]! : `@${actor.name.toLowerCase().replace(/\s+/g, "-")}`;
}

/**
 * Everyone in the scene, above the script. Pressing one opens their name to
 * change, everywhere they appear, and whether they are a person or an agent.
 */
export function StudioCastStrip({
  cast,
  colors: memberColors,
  onRename,
}: {
  cast: readonly CastActor[];
  colors: ReadonlyMap<string, string>;
  /** Absent where the script cannot be changed; `false` when the name cannot be used. */
  onRename?: (from: string, to: string) => boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const fallbackFace = useColors().muted;
  const [open, setOpen] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const opened = cast.find((actor) => actor.name === open) ?? null;
  if (cast.length === 0) return null;
  const rename = (from: string, to: string) => {
    if (onRename === undefined) return;
    if (onRename(from, to)) {
      setRefused(null);
      setOpen(to);
    } else setRefused(to);
  };
  return (
    <View style={styles.strip}>
      <Text variant="eyebrow" style={styles.head}>
        Cast
      </Text>
      <View style={styles.chips}>
        {cast.map((actor) => {
          const on = actor.name === open;
          return (
            <Pressable
              key={actor.name}
              onPress={onRename === undefined ? undefined : () => setOpen(on ? null : actor.name)}
              disabled={onRename === undefined}
              accessibilityRole={onRename === undefined ? undefined : "button"}
              aria-expanded={onRename === undefined ? undefined : on}
              style={[styles.chip, on ? styles.chipOn : null]}
              testID={`studio-cast-${actor.name}`}
            >
              <View style={[styles.face, { backgroundColor: memberColors.get(actor.name) ?? fallbackFace }]}>
                {actor.kind === "agent" ? (
                  <Icon name="robot" size={12} color="#FFFFFF" />
                ) : (
                  <Inline style={styles.initial}>{actor.name.replace(/^@/, "").slice(0, 1).toUpperCase()}</Inline>
                )}
              </View>
              <Text variant="rowSub" numberOfLines={1} style={styles.name}>
                {actor.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {opened !== null && onRename !== undefined ? (
        <View style={styles.editor} testID="studio-cast-editor">
          <Text variant="treeMetaMono" style={styles.label}>
            Name
          </Text>
          <View style={styles.nameField}>
            <StudioInlineField
              value={opened.name}
              onCommit={(name) => rename(opened.name, name)}
              label="Name"
              testID="studio-cast-name"
            />
          </View>
          {refused !== null ? (
            <Text variant="rowSub" style={styles.refused}>
              {`“${refused}” can’t be a name in the script. Use @name for a person, or a plain name for an agent.`}
            </Text>
          ) : null}
          <View style={styles.chips} accessibilityRole="radiogroup" aria-label="Person or agent">
            {(["person", "agent"] as const).map((kind) => {
              const on = opened.kind === kind;
              return (
                <Pressable
                  key={kind}
                  onPress={on ? undefined : () => rename(opened.name, asOtherKind(opened))}
                  accessibilityRole="radio"
                  aria-checked={on}
                  style={[styles.kind, on ? styles.kindOn : null]}
                  testID={`studio-cast-${kind}`}
                >
                  <Text variant="rowSub" style={on ? styles.kindTextOn : styles.name}>
                    {kind === "person" ? "A person" : "An agent"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text variant="rowSub" style={styles.label}>
            A new name changes every step they are in. People are written @name; agents get the robot face.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    strip: { paddingHorizontal: space.x4, paddingTop: space.x4, paddingBottom: space.x3, gap: space.x2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    head: { color: colors.muted },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    chip: { flexDirection: "row", alignItems: "center", gap: space.x1, height: 32, paddingLeft: 4, paddingRight: space.x3, borderRadius: 16, backgroundColor: colors.chipFill, maxWidth: 200 },
    chipOn: { backgroundColor: colors.accentDim },
    face: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
    initial: { color: "#FFFFFF", fontSize: pointerType.label, fontWeight: "700" },
    name: { color: colors.text },
    editor: { gap: space.x2, padding: space.x3, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
    label: { color: colors.muted },
    nameField: { flexDirection: "row", borderRadius: radii.md, backgroundColor: colors.chipFill, paddingLeft: space.x2 },
    refused: { color: colors.critText },
    kind: { minHeight: 32, paddingHorizontal: space.x3, justifyContent: "center", borderRadius: radii.lg, backgroundColor: colors.chipFill },
    kindOn: { backgroundColor: colors.text },
    kindTextOn: { color: colors.surface, fontWeight: "600" },
  });
