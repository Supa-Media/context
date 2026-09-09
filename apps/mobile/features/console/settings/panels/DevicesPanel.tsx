import { StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { settingsSectionLabel } from "../sections";

/**
 * "Your devices" — the account-scope home for a person's own Macs.
 *
 * This used to be `ThisMachineCard`, drawn inside *workspace* settings — a
 * machine belongs to a person, not to whichever context happens to be open,
 * and a card in workspace settings is visible to every other member of that
 * workspace. `apps/convex/functions/authorizations.ts`'s `listMyMachines` is
 * the fix: scoped to the signed-in identity and to nothing wider, on the same
 * auth path (`requireAuthId`) every other query in that file uses.
 *
 * This panel does not draw `ThisMachineCard` itself, and does not replace it —
 * that component (approve-with-one-click, iMessage import) lives entirely
 * inside the desktop shell's own window and stays where it is; a sibling
 * agent owns `features/meetings/`, which is where it lives. What is here is
 * the list of what has *already* been approved, and the one thing every
 * account settings surface can already do with a grant: revoke it
 * (`functions/grants.revokeGrant`, unchanged — the id `listMyMachines`
 * returns is exactly the id that mutation takes).
 *
 * Reads Convex directly rather than through `ConsoleData`: a device list is a
 * property of the signed-in person, not of whichever context's data happens
 * to be passed to this overlay, and `ThisMachineCard` already established the
 * pattern of an account-adjacent settings component calling its own hooks.
 * `"skip"` while signed out — the landing page's copy of this overlay has no
 * session, and a query gated on `requireAuthId` throws during render rather
 * than answering an empty list, which `useFileBrowser.ts`'s own `"skip"` guard
 * on `listShares` already documents as the reason to ask the capability first.
 */
export function DevicesPanel() {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const machines = useQuery(
    api.functions.authorizations.listMyMachines,
    isAuthenticated ? {} : "skip",
  );
  const revoke = useMutation(api.functions.grants.revokeGrant);

  return (
    <View>
      <Text variant="paneTitle" style={styles.head}>
        {settingsSectionLabel("devices")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Every Mac that has been approved to capture into one of your contexts, and
        what it may capture. Revoking one here does not sign it out of anything
        else — it is its own credential, separate from this session.
      </Text>
      <Card>
        {machines === undefined ? (
          <Row>
            <Grow>
              <Text variant="rowSub">Loading…</Text>
            </Grow>
          </Row>
        ) : machines.length === 0 ? (
          <Row>
            <Grow>
              <Text variant="rowSub">
                No Macs connected yet. Open the desktop app and sign in to add one.
              </Text>
            </Grow>
          </Row>
        ) : (
          machines.map((machine, index) => (
            <Row key={machine.grantId} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{machine.name}</Text>
                <Text variant="rowSub" style={styles.rowSub}>
                  {`Approved ${formatApprovedAt(machine.approvedAt)} · ${captureLine(machine.tier)}`}
                </Text>
              </Grow>
              <Button
                label="Revoke"
                variant="danger"
                accessibilityLabel={`Revoke ${machine.name}'s access`}
                onPress={() => {
                  void revoke({ grantId: machine.grantId });
                }}
                testID={`revoke-machine-${machine.grantId}`}
              />
            </Row>
          ))
        )}
      </Card>
    </View>
  );
}

/** What a tier means to somebody deciding whether to revoke it. */
function captureLine(tier: "team" | "private"): string {
  return tier === "private"
    ? "can capture into private notes"
    : "can capture team-visible notes only";
}

function formatApprovedAt(approvedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(approvedAt));
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    rowSub: { marginTop: 2 },
  });
