import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { fonts, leading, pointerType as t, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { paraFolderLines } from "../structure";

/**
 * "Setting up @you" — the five folders "Start fresh" promised, being written.
 *
 * The run waits here until the layout has actually landed (`useOnboarding`'s
 * `layout`), because going to the console a few seconds early showed a new
 * owner a privacy warning about a `privacy.md` that did not exist *yet*.
 *
 * Every row turns at once, and that is honest rather than lazy: the job writes
 * the folders and the privacy file in one run and reports back once, so there
 * is no per-folder progress to show. Drawing them tick one by one would be a
 * progress bar about nothing.
 */
export function LayingOutFolders({ slug, done }: { slug: string | null; done: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const rows = [
    ...paraFolderLines(),
    { folder: "privacy.md", line: "Your privacy rules — every folder private until you share it." },
  ];
  return (
    <View testID="welcome-laying-out">
      <Text variant="rowSub" style={styles.lede} role="status">
        {done
          ? `${slug === null ? "Your workspace" : `@${slug}`} is ready. Opening it now…`
          : "Your bucket is ready. Writing the folders you start with — this takes a few seconds."}
      </Text>
      <View style={styles.list}>
        {rows.map(({ folder, line }, index) => (
          <View
            key={folder}
            style={[styles.row, index > 0 && styles.rule]}
            testID={`welcome-laying-out-${folder}`}
          >
            <View style={styles.mark}>
              {done ? (
                <Text style={styles.tick} aria-label="written">
                  ✓
                </Text>
              ) : (
                <ActivityIndicator size="small" color={colors.text2} />
              )}
            </View>
            <View style={styles.text}>
              <Text style={styles.folder}>{folder}</Text>
              <Text style={styles.line}>{line}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { color: colors.text2, fontSize: t.lede, lineHeight: leading(15, 1.6), marginBottom: space.x5 },
    list: {
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingHorizontal: space.x4,
    },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x3 },
    rule: { borderTopWidth: 1, borderTopColor: colors.line },
    mark: { width: 20, alignItems: "center" },
    tick: { fontSize: t.ui, fontWeight: "700", color: colors.okText },
    text: { flex: 1, minWidth: 0, gap: 2 },
    folder: { fontFamily: fonts.mono, fontSize: t.ui, color: colors.text },
    line: { fontSize: t.meta, color: colors.text2, lineHeight: leading(t.meta, 1.5) },
  });
