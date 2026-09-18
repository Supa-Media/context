import { StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";

/**
 * The Macs this person has approved, and the one thing settings can do about
 * one: revoke it.
 *
 * It was "Your devices", a row of its own in the settings index, and before
 * that it was `ThisMachineCard` drawn inside *workspace* settings — a machine
 * belongs to a person, not to whichever context happens to be open.
 * `apps/convex/functions/authorizations.ts`'s `listMyMachines` fixed the
 * scoping; this change takes away the row rather than the control.
 *
 * **The row went; the revoke did not, and that is the point.** A grant here
 * lets a Mac capture into private notes, so the person who has lost that Mac
 * has to be able to cut it off from the phone in their hand — every other
 * revoke in this product is reachable from any client, and this one is not
 * allowed to be the exception (`CLAUDE.md`: never weaken revocability; raise
 * it instead). So it is a card at the foot of Profile, next to signing out,
 * which is where somebody dealing with a lost machine is already looking.
 *
 * This card does not draw `ThisMachineCard` and does not replace it — that
 * component (approve-with-one-click, iMessage import) lives inside the desktop
 * shell's own window under `features/meetings/`. What is here is the list of
 * what has *already* been approved, and `functions/grants.revokeGrant`,
 * unchanged: the id `listMyMachines` returns is the id that mutation takes.
 *
 * Reads Convex directly rather than through `ConsoleData`: a device list is a
 * property of the signed-in person, not of whichever context's data happens to
 * be passed to this overlay. `"skip"` while signed out — the landing page's
 * copy of this overlay has no session, and a query gated on `requireAuthId`
 * throws during render rather than answering an empty list.
 */
export function MachinesCard() {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const machines = useQuery(
    api.functions.authorizations.listMyMachines,
    isAuthenticated ? {} : "skip",
  );
  const revoke = useMutation(api.functions.grants.revokeGrant);

  return (
    <View>
      <Text variant="eyebrow" style={styles.head}>
        Your Macs
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        Every Mac approved to capture into one of your contexts. Revoking one does
        not sign it out of anything else — it is its own credential, separate from
        this session.
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
