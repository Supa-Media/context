import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Hint } from "../../../design/components/Field";
import { FormError } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useArming } from "../../useArming";
import {
  describeShareFailure,
  shareLifetime,
  type ConsoleShare,
  type ShareActions,
  type ShareFailure,
  type SharesView,
} from "../../shares/shares";

/**
 * Every live link out of this context, with a Revoke beside each.
 *
 * Before this panel, `listShares` and `revokeShare` existed on the control
 * plane and nothing in the console subscribed to either — "what have I
 * shared?" was unanswerable in the product. This is that answer, and nothing
 * more than it: one row per row `listShares` returns, and a Revoke that calls
 * `revokeShare` and nothing else.
 *
 * Every control here comes from `view.actions`, which is **absent** — the
 * whole object — for anyone who is not the owner of this context, and in the
 * demo. `listShares` and `revokeShare` are both owner-only on the backend, so
 * rendering Revoke for anybody else would be offering a button whose only
 * possible outcome is a permission error.
 */
export function SharedLinksPanel({ view }: { view: SharesView }) {
  const styles = useThemedStyles(makeStyles);
  const { actions } = view;

  // A query that came back as an error is neither an empty list nor a
  // permanent "Loading…" — see `MembersSection`'s identical guard. It only
  // reaches here because `useShares` subscribes with `useQueries`.
  if (view.failure) {
    return (
      <View testID="shares-failure">
        <FormError
          headline={view.failure.headline}
          next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
        />
      </View>
    );
  }

  return (
    <View>
      <Text variant="rowTitle" style={styles.heading}>
        Links you&apos;ve shared
      </Text>
      <Card style={styles.list}>
        {view.shares.length === 0 ? (
          <Row>
            <Grow>
              <Text variant="rowSub">
                {view.loading
                  ? "Loading…"
                  : "Nothing shared yet. Share a note from Browse and it appears here."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {view.shares.map((share, index) => (
          <ShareRow key={share.shareId} share={share} actions={actions} first={index === 0} />
        ))}
      </Card>

      {actions === undefined && view.readOnlyReason !== undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          {view.readOnlyReason}
        </Text>
      ) : null}
    </View>
  );
}

function ShareRow({
  share,
  actions,
  first,
}: {
  share: ConsoleShare;
  actions?: ShareActions;
  first: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [failure, setFailure] = useState<ShareFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  /**
   * Two presses, and the second expires — the same arming `MembersSection`'s
   * Remove uses, for the same reason: revoking is immediate and takes the
   * link with it, so a mis-tap is exactly the input `useArming` guards
   * against.
   */
  const revocation = useArming(() => run(() => actions!.revoke(share.shareId)));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(describeShareFailure(error));
    } finally {
      setBusy(false);
    }
  }

  // The note's own title where the share carries it, else its file name.
  const name =
    share.previewTitle?.trim() ||
    (share.entryPath.split("/").pop() ?? share.entryPath).replace(/\.md$/i, "");
  const lifetime = share.expiresAt === undefined ? null : shareLifetime(share.expiresAt, now);

  return (
    <View style={first ? null : styles.divided}>
      <Row style={styles.wrapRow}>
        <Grow>
          <Text variant="rowTitle" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {[`${share.recipient} can view`, lifetime].filter(Boolean).join(" · ")}
          </Text>
        </Grow>
        {actions !== undefined ? (
          <Button
            label={revocation.stage === "idle" ? "Turn off link" : "Press again to turn off"}
            variant={revocation.stage === "idle" ? "mini" : "danger"}
            disabled={busy}
            accessibilityLabel={
              revocation.stage === "idle"
                ? `Turn off the link shared with ${share.recipient} over ${share.entryPath}`
                : `Confirm turning off the link shared with ${share.recipient}`
            }
            testID={`share-revoke-${share.shareId}`}
            onPress={revocation.press}
          />
        ) : null}
      </Row>
      {revocation.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            Turning this link off takes it away immediately — anyone still holding the URL
            loses access. Sharing this note again mints a brand-new link.
          </Text>
        </Hint>
      ) : null}
      {failure !== null ? (
        <FormError headline={failure.headline} next={failure.next} style={styles.rowError} />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    heading: { fontSize: 17, marginBottom: 10 },
    list: { paddingVertical: 0 },
    divided: { borderTopWidth: 1, borderTopColor: colors.line },
    rowSub: { marginTop: 2 },
    rowError: { marginTop: 8 },
    wrapRow: { flexWrap: "wrap" },
    readOnly: { marginTop: 13 },
  });
