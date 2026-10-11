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
 * The arming window is `useArming`'s, which expires, so an armed Delete does
 * not stay armed until something presses it.
 *
 * It lives under `settings/` because the account scope of the settings overlay
 * is its only caller.
 */
export function DeleteAccountCard({ deleteAccount }: { deleteAccount: () => Promise<void> }) {
  const styles = useThemedStyles(makeStyles);
  const arming = useArming(deleteAccount);
  const [explained, setExplained] = useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Button
          label={
            arming.stage === "working"
              ? "Deleting…"
              : arming.stage === "armed"
                ? "Press again to delete"
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
          ours to delete. What goes is everything Context knows: your workspaces, storage
          connections, memberships and sign-in. Any workspace you are the only owner of is
          deleted with it, so people you invited lose access. Your name is released,
          including your capture address, which somebody else can then claim.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    wrap: { flexShrink: 1, gap: space.x2 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    explain: { maxWidth: 420 },
  });
