import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { getDesktopBridge, type ConnectionView, type DesktopBridge } from "@context/desktop-bridge";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { describeMachine, machineTitle } from "../thisMachine";

/**
 * The machine the console is running on, in this context's settings.
 *
 * Drawn **only inside the desktop shell**, and the check for that is the one
 * the whole feature uses: a frozen `window.desktop` carrying a bridge version
 * this bundle understands. In a browser and on a phone this component returns
 * `null` and costs a render — which is why `SettingsPane` can mount it
 * unconditionally instead of asking the question a second time.
 *
 * ## What it is for
 *
 * The shell records with no window open and queues what it recorded. That
 * needs a credential, and the credential is **this machine's own**: one OAuth
 * client per machine, so revoking the laptop you lost does not sign out the one
 * on your desk. The console's Convex session is not that credential and cannot
 * stand in for it — `features/meetings/gateway.ts` says why at length — so a
 * person who is signed in here can still have a machine that cannot send.
 * Without this card, that state has no surface at all in the one runtime.
 *
 * ## What it does not show
 *
 * Any part of the credential. The bridge exposes `connect()`, `disconnect()`
 * and three words, and `getDesktopBridge` refuses a bridge that grew anything
 * credential-shaped. `connect()` returns nothing; the token is minted, stored
 * and spent in the main process, and never becomes a value this page can hold.
 *
 * **`connect()` now navigates this window**, which is worth saying here because
 * it is the one call on this card whose effect is that the card goes away for a
 * moment: the shell sends the console window to the control plane's own approve
 * screen — where the person is already signed in, because it is this origin —
 * and brings it back afterwards. Nothing about that is this component's to
 * arrange and there is no new bridge member for it: it is the same `connect()`,
 * and the shell decides where the approval is shown. A launch with no window
 * still opens a browser. `docs/decisions/desktop.md` has the guard that makes
 * the return trip one address rather than a hole in the origin pin.
 */
export function ThisMachineCard() {
  const bridge = useDesktopBridge();
  if (bridge === null) return null;
  return <MachineCard bridge={bridge} />;
}

/**
 * The bridge, once.
 *
 * In state rather than read at render time: `getDesktopBridge()` walks an
 * object a page could in principle have changed between renders, and a
 * component whose identity flickers would tear down the subscription below
 * with it.
 */
function useDesktopBridge(): DesktopBridge | null {
  const [bridge] = useState(() => getDesktopBridge());
  return bridge;
}

function MachineCard({ bridge }: { bridge: DesktopBridge }) {
  const styles = useThemedStyles(makeStyles);
  const [connection, setConnection] = useState<ConnectionView | null>(null);

  /*
    Asked once and then subscribed, and the unsubscribe is used.

    This is the reason `docs/decisions/desktop.md` put an unsubscribe on every
    subscription rather than copying the shell's old `onState`: a settings pane
    is mounted and unmounted every time somebody opens and closes it, and a
    handler that could not be detached would be a leak per visit and a stale
    closure setting state on an unmounted component.
  */
  useEffect(() => {
    let live = true;
    void bridge.connection
      .get()
      .then((view) => {
        if (live) setConnection(view);
      })
      .catch(() => {
        // A shell that will not answer is not a machine to draw claims about.
        // The card stays on its loading line rather than inventing a state.
      });
    const off = bridge.connection.onChange((view) => {
      if (live) setConnection(view);
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  const title = machineTitle(bridge.shell);

  if (connection === null) {
    return (
      <Card>
        <Text variant="rowTitle">{title}</Text>
        <Text variant="rowSub" style={styles.sub} testID="this-machine-loading">
          Checking whether this machine is connected…
        </Text>
      </Card>
    );
  }

  const view = describeMachine(connection);

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle" testID="this-machine-title">
            {title}
          </Text>
          <Text variant="rowSub" style={styles.sub} testID="this-machine-sentence">
            {view.sentence}
          </Text>
        </View>
        <Pill tone={view.tone} leading={<Dot tone={view.tone} />}>
          {view.pill}
        </Pill>
      </View>

      {view.notice === null ? null : (
        <Text variant="rowSub" style={styles.notice} testID="this-machine-notice">
          {view.notice}
        </Text>
      )}

      {view.action === null || view.actionLabel === null ? null : (
        <View style={styles.actions}>
          <Button
            label={view.actionLabel}
            variant={view.action === "connect" ? "white" : undefined}
            onPress={() =>
              view.action === "connect"
                ? bridge.connection.connect()
                : bridge.connection.disconnect()
            }
            testID={`this-machine-${view.action}`}
          />
        </View>
      )}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headText: { flex: 1, minWidth: 0 },
  sub: { marginTop: 4 },
  notice: { marginTop: 8, color: colors.crit },
  actions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
});
