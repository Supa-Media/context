import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";

/**
 * Deletion is two presses, the second one expires, and the button sits beside
 * Sign out. What it does is behind "How this works", because the button is the
 * only thing most people need to see.
 *
 * What the disclosure says, in order:
 *
 *  - **Notes in your own storage stay exactly where they are.** They are not
 *    ours to delete. This is the fact people fear getting wrong.
 *  - **Every context you solely own is destroyed, even where editors and
 *    members remain.** `account.ts` states that edge deliberately — "an
 *    ownerless context has nobody who can rebind storage or revoke a grant,
 *    which is not a state to leave anybody in" — so somebody you invited loses
 *    access.
 *  - **Your name is released**, and because ingestion is on the apex that
 *    includes your capture address: `you@context.lc` becomes claimable.
 *
 *  - **Notes in storage we run are erased** (decided by the owner,
 *    2026-10-15): nobody could reach them once the account is gone. The
 *    workspaces this applies to are named, each with its download (or a way
 *    to open it and download), before the second press.
 *
 * The arming window is `useArming`'s, which expires, so an armed Delete does
 * not stay armed until something presses it.
 *
 * It lives under `settings/` because the account scope of the settings overlay
 * is its only caller.
 */
/** A workspace this deletion erases: on storage we run, owned by nobody else. */
export interface ErasedWorkspace {
  id: string;
  slug: string;
  /** The one open now, whose download is a button here. */
  current: boolean;
}

export function DeleteAccountCard({
  deleteAccount,
  erased = [],
  onDownload,
  onOpen,
}: {
  deleteAccount: () => Promise<void>;
  /** Workspaces whose notes this erases; empty while loading or when none. */
  erased?: readonly ErasedWorkspace[];
  /** Download everything in the workspace open now. Absent where there is none. */
  onDownload?: () => void;
  /** Open another workspace, so its download is one press away. */
  onOpen?: (id: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const arming = useArming(deleteAccount);
  const [explained, setExplained] = useState(false);
  const erasing = erased.length > 0;
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Button
          label={
            arming.stage === "working"
              ? "Deleting…"
              : arming.stage === "armed"
                ? erasing
                  ? "Press again to delete and erase"
                  : "Press again to delete"
                : "Delete account"
          }
          variant="danger"
          disabled={arming.stage === "working"}
          testID="delete-account"
          onPress={arming.press}
        />
        <TextLink
          label={explained ? "Hide" : "How this works"}
          onPress={() => setExplained((open) => !open)}
          testID="delete-account-explain"
        />
      </View>
      {/* Always shown once armed: the second press must not be blind to what it deletes. */}
      {explained || arming.stage === "armed" ? (
        <Text variant="rowSub" style={styles.explain} testID="delete-account-explanation">
          Notes in your own bucket or Dropbox stay exactly where they are — they are not
          ours to delete. Notes and attachments in storage Context runs for you are
          permanently erased, so download a copy first. What else goes is everything
          Context knows: your workspaces, storage connections, memberships and sign-in.
          Any workspace you are the only owner of is deleted with it, so people you
          invited lose access. Your name is released, including your capture address,
          which somebody else can then claim.
        </Text>
      ) : null}
      {erasing && (explained || arming.stage === "armed") ? (
        <View style={styles.erased} testID="delete-account-erased">
          <Text variant="rowSub" style={styles.erasedHead}>
            Erased permanently with your account:
          </Text>
          {erased.map((workspace) => (
            <View key={workspace.id} style={styles.row}>
              <Text variant="rowSub">@{workspace.slug}</Text>
              {workspace.current && onDownload !== undefined ? (
                <Button
                  variant="mini"
                  label="Download everything"
                  accessibilityLabel={`Download every note in @${workspace.slug}, as a .zip`}
                  onPress={onDownload}
                  testID={`delete-account-download-${workspace.slug}`}
                />
              ) : onOpen !== undefined ? (
                <Button
                  variant="mini"
                  label="Open to download"
                  accessibilityLabel={`Open @${workspace.slug} to download its notes`}
                  onPress={() => onOpen(workspace.id)}
                  testID={`delete-account-open-${workspace.slug}`}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    wrap: { flexShrink: 1, gap: space.x2 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    explain: { maxWidth: 420 },
    erased: { gap: space.x1, maxWidth: 420 },
    erasedHead: { fontWeight: "600" },
  });
