/**
 * A folder, as somewhere you are rather than a settings panel about it.
 *
 * What was here before: the folder's path, one sentence about visibility, a
 * "Make this folder private" button, and then a screenful of nothing. On a
 * phone that is most of the screen empty, and it was the *only* thing a folder
 * did — the notes inside it were reachable only through the tree drawer, which
 * is the one surface a phone makes hardest to get at.
 *
 * So the contents are the screen now, and everything that was here is a header
 * above them. That also makes a folder navigable without the drawer: tap a
 * folder, see what is in it, tap a note.
 *
 * ## What it deliberately does not do
 *
 * **It does not list what the caller cannot see.** The rows come from the same
 * `listings` the tree draws, which the server already filtered at the caller's
 * scope — a private note is absent for a member rather than present and
 * refused, and this must not invent a count that says otherwise. An empty
 * folder and a folder full of notes somebody may not read look identical here,
 * which is the point.
 */

import { StyleSheet, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { baseName } from "./paths";
import type { FileEntry, FolderListing, Visibility } from "./types";

export function FolderView({
  entry,
  listing,
  canSetVisibility,
  canShare,
  onSetVisibility,
  onSelect,
  onShare,
}: {
  entry: FileEntry;
  /** The folder's own listing, or `undefined` while it loads. */
  listing: FolderListing | undefined;
  /**
   * Owner-only, like every visibility control. This pane's button said
   * `canEdit` once, which put "Make this folder private" in front of an editor
   * on somebody else's context — offered, then refused by the server. Absent
   * is the truth.
   */
  canSetVisibility: boolean;
  canShare: boolean;
  onSetVisibility: (visibility: Visibility) => void;
  onSelect: (path: string) => void;
  onShare: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const isTeam = entry.visibility === "team";
  const rows = listing?.entries ?? [];

  return (
    <View style={styles.folder}>
      <View style={styles.head}>
        <View style={styles.title}>
          <Text variant="eyebrow">FOLDER</Text>
          <Text variant="noteTitle" role="heading" aria-level={2}>
            {baseName(entry.path) || entry.path}
          </Text>
        </View>
        {/*
          Share is offered for a folder, and it is the *team link* only — a
          folder has an address and an address is a sentence that means
          something. A per-person folder share is deliberately not built: it
          would have to decide what a folder share reaches, and "the notes in
          this folder, but not its subfolders, unless they are also team" is a
          rule nobody could predict. Outsiders get per-note shares.
        */}
        {canShare ? <Button label="Share…" onPress={onShare} testID="folder-share" /> : null}
      </View>

      <Text variant="paneSub">
        {isTeam
          ? "Everything in this folder is visible to the people you have granted team access, unless a note is held back as an exception."
          : "Everything in this folder is yours alone, unless a note is shared as an exception."}
      </Text>

      {canSetVisibility ? (
        <Button
          label={isTeam ? "Make this folder private" : "Share this folder with your team"}
          variant="white"
          style={styles.action}
          onPress={() => onSetVisibility(isTeam ? "private" : "team")}
        />
      ) : null}

      <View style={styles.contents}>
        <Text variant="eyebrow">IN THIS FOLDER</Text>
        {listing === undefined ? (
          <Text variant="meta">Loading…</Text>
        ) : rows.length === 0 ? (
          /*
            "Nothing you can see", not "nothing here". A member reading a
            folder whose notes are all private would otherwise be told the
            folder is empty, which is a different and untrue statement — and
            the one the visibility rules exist to avoid making.
          */
          <Text variant="meta">
            {canSetVisibility
              ? "This folder has nothing in it yet."
              : "Nothing in this folder is shared with you."}
          </Text>
        ) : (
          rows.map((row) => (
            <PressRow
              key={row.path}
              onPress={() => onSelect(row.path)}
              style={styles.row}
              accessibilityLabel={row.name}
              testID="folder-row"
            >
              <Text variant="body" style={styles.rowName} numberOfLines={1}>
                {row.kind === "folder" ? `${row.name}/` : row.name}
              </Text>
              {/*
                The tree marks **only exceptions**, and so does this: drawing a
                folder's default on every one of its files buries the one note
                that differs from it. See `FileEntry.exception`.
              */}
              {row.exception ? (
                <Text variant="treeMeta" style={styles.marker}>
                  {row.visibility === "team" ? "shared" : "private"}
                </Text>
              ) : null}
            </PressRow>
          ))
        )}
        {listing?.truncated ? (
          <Text variant="treeMeta">
            This folder has more in it than is shown here.
          </Text>
        ) : null}
      </View>

      <Text variant="treeMeta">
        team means named people you granted access to. There is no public tier.
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  folder: { gap: space.x3 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.x2 },
  title: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 },
  action: { alignSelf: "flex-start" },
  contents: { gap: space.x1, marginTop: space.x2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  rowName: { flexGrow: 1, flexShrink: 1, color: colors.text },
  marker: { color: colors.muted },
});
