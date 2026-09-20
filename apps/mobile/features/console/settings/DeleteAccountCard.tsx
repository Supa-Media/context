import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";

/**
 * Deletion is two presses, the second one expires, and the copy says what it
 * does first.
 *
 * The lead is still the fact people fear getting wrong: notes in their own
 * storage are not ours to delete and stay where they are. What follows it are
 * two consequences that reach other people:
 *
 *  - **Every context you solely own is destroyed, even where editors and
 *    members remain.** `account.ts` states that edge deliberately — "an
 *    ownerless context has nobody who can rebind storage or revoke a grant,
 *    which is not a state to leave anybody in" — so somebody you invited loses
 *    access, and the old wording ("removes your … memberships") read as though
 *    only yours went.
 *  - **Your name is released**, and because ingestion is on the apex that
 *    includes your capture address: `you@context.lc` becomes claimable.
 *
 * The arming window is `useArming`'s, which expires. It was a bare `useState`
 * with no way back to `idle`, so an armed Delete stayed armed until something
 * pressed it.
 *
 * It lives under `settings/` because the account scope of the settings overlay
 * is its only caller. It was previously an export of `panes/ConnectionsPane`
 * and rendered there as well — two live Delete buttons for one account, on two
 * surfaces that had to be kept in step by hand.
 */
export function DeleteAccountCard({ deleteAccount }: { deleteAccount: () => Promise<void> }) {
  const styles = useThemedStyles(makeStyles);
  const arming = useArming(deleteAccount);
  return (
    <View>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Delete this account</Text>
            <Text variant="rowSub" style={styles.sub}>
              Notes in your own bucket or Dropbox stay exactly where they are — they
              are not ours to delete. What goes is everything Context knows: your
              contexts, storage connections, memberships and sign-in. Any context you
              are the only owner of is deleted with it, so people you invited lose
              access, and your name is released — including your capture address, which
              somebody else can then claim.
            </Text>
          </Grow>
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
        </Row>
      </Card>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    sub: { maxWidth: 520 },
  });
