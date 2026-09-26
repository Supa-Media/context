import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType as t, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { paraFolderLines } from "../../../onboarding/structure";
import { makeStyles as makePaneStyles } from "./styles";

/**
 * The card as a page: where a note would be, under the workspace's name, in
 * the same column `Empty` uses beside the sidebar.
 */
export function LayingOutPage({
  contextLabel,
  done,
  standard = true,
  shared = false,
}: {
  contextLabel: string;
  done: boolean;
  /** The standard five are being written; `false` for a kind that names its own. */
  standard?: boolean;
  /** A shared workspace, whose folders start open to its members. */
  shared?: boolean;
}) {
  const pane = useThemedStyles(makePaneStyles);
  return (
    <View style={pane.empty}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {contextLabel}
      </Text>
      <LayingOutFolders done={done} standard={standard} shared={shared} />
    </View>
  );
}

/**
 * "Setting up your folders" — the five folders "Start fresh" promised, being written,
 * drawn in the console the person has already landed in.
 *
 * The first run no longer holds anybody on a screen of its own while this
 * happens (the owner asked for it here, 2026-09-25): "Take me to the console →"
 * goes to the console, and the console says what is being written until it is.
 * `useBrowseNotices` decides when — a layout the control plane has queued and
 * not yet answered, then a moment of ticks once it lands.
 *
 * **One line and a row of chips, and that size is the design.** Its first
 * version — a row per folder, each with its description, boxed inside the
 * notice band's own box across the whole pane — filled the screen and pushed
 * the workspace it was announcing out of view. It is drawn where a note would
 * be now (`LayingOutPage`), and the folder descriptions are the fork's to
 * explain; here the names are enough.
 *
 * Every chip turns at once, and that is honest rather than lazy: the job writes
 * the folders and the privacy file in one run and reports back once, so there
 * is no per-folder progress to show. Ticking them one by one would be a
 * progress bar about nothing.
 *
 * **Chips only for the standard five.** A shared workspace can be laid out as a
 * business, an agency or a project (`features/workspace/presets.ts`), and the
 * console is not told which folders that choice named — so it draws the line
 * alone rather than five PARA chips the bucket is not getting. The tree beside
 * it shows the real folders the moment they land.
 */
export function LayingOutFolders({
  done,
  standard = true,
  shared = false,
}: {
  done: boolean;
  standard?: boolean;
  shared?: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const rows = standard ? [...paraFolderLines().map(({ folder }) => folder), "privacy.md"] : [];
  return (
    <View style={styles.card} testID="browse-laying-out">
      <Text style={styles.headline} role="status">
        <Text style={styles.title}>{done ? "Your folders are ready" : "Setting up your folders"}</Text>
        {done
          ? shared
            ? " — open to everyone in the workspace."
            : " — each one private until you share it."
          : " — this takes a few seconds."}
      </Text>
      <View style={styles.chips}>
        {rows.map((folder) => (
          <View key={folder} style={styles.chip} testID={`browse-laying-out-${folder}`}>
            {done ? (
              <Text style={styles.tick} aria-label="written">
                ✓
              </Text>
            ) : (
              <ActivityIndicator size={12} color={colors.text2} />
            )}
            <Text style={styles.folder}>{folder}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.x2 },
    headline: { color: colors.text2, fontSize: t.ui },
    title: { fontWeight: "600", color: colors.text },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 3,
      paddingHorizontal: space.x2,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    tick: { fontSize: t.meta, fontWeight: "700", color: colors.okText, width: 12, textAlign: "center" },
    folder: { fontFamily: fonts.mono, fontSize: t.meta, color: colors.text },
  });
