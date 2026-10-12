/**
 * The small header over a contact page: who this is, how you reach them, and
 * a quiet "Contact" mark saying the app keeps this page. The Markdown body is
 * drawn below it exactly as it is — this adds a line of chrome, it does not
 * replace the note (owner, 2026-10-12: "a little bit of difference … not too
 * crazy").
 *
 * Nothing for any other note: `contactHeaderOf` decides, from the path and the
 * frontmatter, and answers `null` everywhere else. Every string here came out
 * of somebody's bucket — and an identifier out of a stranger's message — so it
 * is isolated for display and drawn as text, never as a link.
 */

import { StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { contactHeaderOf, type ContactChipKind } from "./contactPages";

const CHIP_ICON: Record<ContactChipKind, IconName> = {
  email: "mail",
  phone: "phone",
  imessage: "chat",
};

const CHIP_LABEL: Record<ContactChipKind, string> = {
  email: "Email",
  phone: "Phone",
  imessage: "iMessage",
};

export function ContactHeader({
  path,
  text,
  gutter,
}: {
  path: string | null;
  /** The note as it is in the editor now, front matter included. */
  text: string;
  /** Where the note's own first character is, so the header lines up with it. */
  gutter: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const view = contactHeaderOf(path, text);
  if (view === null) return null;
  const name = isolateForDisplay(view.name);
  return (
    <View style={[styles.wrap, { paddingLeft: gutter, paddingRight: gutter }]} testID="contact-header">
      <View style={styles.top}>
        <View style={styles.avatar} aria-hidden>
          <Text variant="rowTitle" style={styles.initial}>
            {initialOf(view.name)}
          </Text>
        </View>
        <View style={styles.titles}>
          <Text variant="rowTitle" numberOfLines={1} testID="contact-header-name">
            {name}
          </Text>
          <View style={styles.mark} accessibilityLabel="Contact, kept by Context">
            <Icon name="person" size={12} color={colors.muted} />
            <Text variant="treeMeta" style={styles.muted}>
              Contact
            </Text>
          </View>
        </View>
      </View>
      {view.identifiers.length === 0 ? null : (
        <View style={styles.chips}>
          {view.identifiers.map((identifier) => (
            <View
              key={`${identifier.kind}:${identifier.value}`}
              style={styles.chip}
              accessibilityLabel={`${CHIP_LABEL[identifier.kind]}: ${identifier.value}`}
              testID={`contact-chip-${identifier.kind}`}
            >
              <Icon name={CHIP_ICON[identifier.kind]} size={14} color={colors.text2} />
              <Text variant="treeMeta" style={styles.chipText} numberOfLines={1} selectable>
                {isolateForDisplay(identifier.value)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** The first letter a person would file them under, or nothing drawable. */
function initialOf(name: string): string {
  const first = [...name.trim()].find((character) => /\p{L}|\p{N}/u.test(character));
  return first === undefined ? "·" : first.toUpperCase();
}

const AVATAR = 36;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { paddingTop: space.x2, paddingBottom: space.x2, gap: space.x2 },
    top: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    avatar: {
      width: AVATAR,
      height: AVATAR,
      borderRadius: AVATAR / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentDim,
    },
    initial: { color: colors.accentText },
    titles: { flexShrink: 1, minWidth: 0 },
    mark: { flexDirection: "row", alignItems: "center", gap: 4 },
    muted: { color: colors.muted },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: "100%",
      paddingVertical: 3,
      paddingHorizontal: space.x2,
      borderRadius: radii.pill,
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
    },
    chipText: { color: colors.text2, flexShrink: 1 },
  });
