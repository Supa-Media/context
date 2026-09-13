import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  REVOKED_NOTE,
  isOwnerStop,
  isRevocation,
  rollbackTarget,
  runtimeDetail,
  runtimeFor,
  runtimeNote,
  runtimePill,
  type RuntimeView,
} from "../../plugins/runtime";
import { standingFor, type GrantsView } from "../../plugins/grants";
import type { ConsolePlugin } from "../../plugins/plugins";

/**
 * Whether this plugin is actually running.
 *
 * The first component in this section allowed to use the word, and it only ever
 * repeats the server. A plugin with no runtime row renders nothing — not
 * "stopped", not "idle" — because the absence of a row means the sandbox host
 * has never reported on this bundle, and a screen that turned that into a status
 * would be inventing the one fact this whole section was careful not to claim.
 */
export function PluginRuntimeCard({
  plugin,
  view,
  grants,
}: {
  plugin: ConsolePlugin;
  view: RuntimeView;
  grants: GrantsView;
}) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (view.states === undefined || grants.grants === undefined) return null;

  const state = runtimeFor(plugin, view.states);
  const standing = standingFor(plugin, grants.grants);
  const fingerprint = plugin.bundleFingerprint;
  const canStart = standing.kind === "active" && fingerprint !== null && view.actions !== undefined;

  async function act(action: "start" | "stop") {
    if (!canStart || fingerprint === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await view.actions?.[action](plugin.id, fingerprint);
    } catch (error) {
      const data = (error as { data?: { message?: unknown } } | null)?.data;
      setFailure(typeof data?.message === "string"
        ? data.message
        : action === "start"
          ? "The plugin did not start. Its access and your notes are unchanged."
          : "The plugin could not be stopped here. Revoke its access to stop it immediately.");
    } finally {
      setBusy(false);
    }
  }

  if (state === null) {
    if (!canStart) return null;
    return (
      <View testID={`plugin-runtime-${plugin.id}`} style={styles.wrap}>
        <Row style={styles.head}>
          <Grow><Text variant="rowSub">Approved is permission, not execution. Start it when you want this bundle to run.</Text></Grow>
          <Button label={busy ? "Starting…" : "Start"} disabled={busy} onPress={() => void act("start")} />
        </Row>
        {failure ? <Text variant="error">{failure}</Text> : null}
      </View>
    );
  }

  const revoked = isRevocation(state);
  const stopped = isOwnerStop(state);
  const pill = revoked ? { label: "Access revoked", tone: "neutral" as const } : runtimePill(state);
  const detail = revoked || stopped ? null : runtimeDetail(state);
  const rollback = rollbackTarget(state);

  return (
    <View testID={`plugin-runtime-${plugin.id}`} style={styles.wrap}>
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowSub">
            {revoked
              ? REVOKED_NOTE
              : stopped
                ? "You stopped this bundle. Its approval is still in place, so you can start it again."
                : runtimeNote(state)}
          </Text>
        </Grow>
        <Pill
          tone={pill.tone}
          leading={pill.tone === "ok" ? <Dot tone="ok" /> : undefined}
        >
          {pill.label}
        </Pill>
      </Row>

      {detail ? (
        <Text variant="mono" style={styles.detail}>
          {detail}
        </Text>
      ) : null}

      {rollback ? (
        <Text variant="rowSub">
          {`A version Context can go back to is on record (${rollback.slice(0, 12)}…). Install it again to return to it.`}
        </Text>
      ) : null}

      {canStart && !revoked ? (
        <Button
          label={busy ? (state.status === "loaded" ? "Stopping…" : "Starting…") : (state.status === "loaded" ? "Stop" : "Start again")}
          disabled={busy}
          onPress={() => void act(state.status === "loaded" ? "stop" : "start")}
        />
      ) : null}
      {failure ? <Text variant="error">{failure}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: 8, gap: 6 },
  head: { alignItems: "flex-start", gap: 12 },
  detail: { color: colors.critText, fontSize: 12 },
});
