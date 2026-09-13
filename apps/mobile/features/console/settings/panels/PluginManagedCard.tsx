import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useArming } from "../../useArming";
import {
  BUSY_NOTE,
  STUCK_NOTE,
  UNINSTALL_NOTE,
  isLifecycleBusy,
  uninstallBlocker,
  type BrowseView,
} from "../../plugins/lifecycle";
import type { ConsolePlugin } from "../../plugins/plugins";

/**
 * The controls that only a Context-managed install may have.
 *
 * Its whole job is a negative one. A `source: "obsidian"` row is the customer's
 * own vault copy, and this component offers it **nothing** — not a disabled
 * Remove, not a greyed one, none. An Uninstall drawn on a vault row is an offer
 * to delete a file out of the one directory this product promises never to
 * write to, and it would look completely ordinary right up until it was pressed.
 *
 * `uninstallCommunityPlugin` refuses that server-side as well. Both halves is
 * the intent: the UI must not be the only thing standing there, and it must not
 * be the thing that proposes it either.
 */
export function PluginManagedCard({
  plugin,
  view,
}: {
  plugin: ConsolePlugin;
  view: BrowseView;
}) {
  const styles = useThemedStyles(makeStyles);
  const actions = view.actions;
  const fingerprint = plugin.bundleFingerprint;

  const recoverArm = useArming(() => {
    void view.actions?.recover(plugin.id);
  });

  const arming = useArming(() => {
    if (fingerprint === null) return;
    void actions?.uninstall(plugin.id, fingerprint);
  });

  /*
    A vault row gets no card at all, rather than a card explaining what it
    cannot do. The inventory row above it already says where the plugin lives;
    saying it twice on every one of them is how a sentence stops being read.
  */
  if (plugin.source !== "context") return null;
  if (!actions) return null;

  const blocker = uninstallBlocker(plugin);

  /*
    The one refusal that needs a person.

    `PLUGIN_LIFECYCLE_BUSY` arrives for two opposite situations: an operation
    that is running, which wants patience, and one that stopped part-way, which
    wants `recoverPluginLifecycle`. The same code, and nothing on the client can
    tell them apart — so both sentences are shown and the reader decides which
    one they are looking at, rather than the console guessing and offering a
    recovery for a job that is simply still going.
  */
  const stuck =
    view.failedPluginId === plugin.id && isLifecycleBusy(view.failureCode) ? view.failureCode : null;

  return (
    <View testID={`plugin-managed-${plugin.id}`} style={styles.wrap}>
      {stuck ? (
        <View style={styles.stuck} testID={`plugin-stuck-${plugin.id}`}>
          <Text variant="rowSub">{BUSY_NOTE}</Text>
          <Text variant="rowSub">{STUCK_NOTE}</Text>
          <Button
            label={recoverArm.stage === "armed" ? "Recover — press again" : "It's stuck: recover"}
            onPress={recoverArm.press}
          />
        </View>
      ) : null}

      {blocker ? (
        <Text variant="rowSub">{blocker}</Text>
      ) : (
        <Row style={styles.controls}>
          <Grow>
            <Text variant="rowSub">{UNINSTALL_NOTE}</Text>
          </Grow>
          <Button
            label={arming.stage === "armed" ? "Remove — press again" : "Remove from Context"}
            variant="danger"
            onPress={arming.press}
          />
        </Row>
      )}
    </View>
  );
}

const makeStyles = (_colors: Colors) => StyleSheet.create({
  wrap: { marginTop: 8, gap: 8 },
  stuck: { gap: 7, alignItems: "flex-start" },
  controls: { gap: 12, alignItems: "flex-start" },
});
