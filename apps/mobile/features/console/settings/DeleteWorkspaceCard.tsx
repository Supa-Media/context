import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { FormError, Notice, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  deletionConfirmed,
  describeDeleteWorkspaceFailure,
  type KeyExportFailure,
  type WorkspaceDeletion,
} from "../advanced/advanced";

/**
 * Giving a workspace's name back.
 *
 * ## What this is the other half of
 *
 * A workspace claims its handle out of the global namespace at step 1 of its
 * creation flow — before a bucket, before a member, before anything — and
 * counts against the ten an account may own from that moment. Until this card
 * existed the only thing that released either was deleting the whole account,
 * so a workspace somebody named and never finished was a reservation nobody
 * could cancel. The creation flow's "nothing here expires" was true and read
 * as reassurance; this is what makes it one.
 *
 * ## Why a typed name rather than two presses
 *
 * `DeleteAccountCard` is armed by pressing twice, and that is right there:
 * there is exactly one account and the button is unambiguous. A person can
 * have ten workspaces open in as many tabs, all reached by the same settings
 * section, and "the one I was looking at" is not a guard. So the confirmation
 * is the name itself — and it is checked again on the server, which is what
 * actually enforces it (`account.deleteWorkspace`); this half is what stops
 * the press being the mistake.
 *
 * ## The sentence that comes first
 *
 * Notes in a bucket the customer owns are not ours to delete and are not
 * touched — that is `disconnectStorage`'s promise, and non-negotiable #1's,
 * applied to a whole workspace. It leads because it is the thing people are
 * afraid of getting wrong, and because a destructive control that does not
 * say what survives is one nobody presses even when they should.
 */
export function DeleteWorkspaceCard({ deletion }: { deletion: WorkspaceDeletion }) {
  const styles = useThemedStyles(makeStyles);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<KeyExportFailure | null>(null);
  const ready = deletionConfirmed(typed, deletion.slug);

  return (
    <View>
      <Text variant="rowTitle" style={styles.subHead}>
        Delete this workspace
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowSub" style={styles.sub}>
              Notes in the bucket behind @{deletion.slug} stay exactly where they are —
              they are not ours to delete. What goes is everything Context knows about
              this workspace: its storage connection, its members and their access, its
              invitations, grants, shared links and audit trail. Its name @
              {deletion.slug} is released for anybody to claim, and it stops counting
              against the workspaces you can own. This cannot be undone.
            </Text>
          </Grow>
        </Row>
        {deletion.blocked === null ? (
          <Row divided style={styles.confirmRow}>
            <Grow>
              <TextField
                label="Type its name to confirm"
                value={typed}
                onChangeText={(value) => {
                  setTyped(value);
                  setFailure(null);
                }}
                placeholder={deletion.slug}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!working}
                testID="delete-workspace-confirm"
              />
            </Grow>
            <Button
              label={working ? "Deleting…" : "Delete workspace"}
              accessibilityLabel={`Delete the workspace @${deletion.slug}`}
              variant="danger"
              disabled={!ready || working}
              testID="delete-workspace"
              onPress={() => {
                if (!ready || working) return;
                setWorking(true);
                setFailure(null);
                /*
                  The typed text goes to the server as typed. It checks the
                  name itself, so this hands over what the person wrote rather
                  than the slug it was compared against — a client that
                  "helpfully" sent the canonical name would be a client whose
                  confirmation the server could not actually verify.
                */
                void deletion
                  .delete(typed)
                  .catch((error: unknown) => setFailure(describeDeleteWorkspaceFailure(error)))
                  .finally(() => setWorking(false));
              }}
            />
          </Row>
        ) : (
          <Notice tone="warn" style={styles.blocked}>
            <Text variant="rowSub">{deletion.blocked}</Text>
          </Notice>
        )}
        {failure === null ? null : (
          <FormError headline={failure.headline} next={failure.next} style={styles.blocked} />
        )}
      </Card>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    subHead: { marginTop: 28, marginBottom: 6 },
    sub: { maxWidth: 520 },
    confirmRow: { marginTop: 12, alignItems: "flex-end", gap: 12 },
    blocked: { marginTop: 12 },
  });
