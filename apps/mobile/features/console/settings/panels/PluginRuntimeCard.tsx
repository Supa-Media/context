import { StyleSheet, View } from "react-native";
import { Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  REVOKED_NOTE,
  isRevocation,
  rollbackTarget,
  runtimeDetail,
  runtimeFor,
  runtimeNote,
  runtimePill,
  type RuntimeView,
} from "../../plugins/runtime";
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
}: {
  plugin: ConsolePlugin;
  view: RuntimeView;
}) {
  const styles = useThemedStyles(makeStyles);
  if (view.states === undefined) return null;

  const state = runtimeFor(plugin, view.states);
  if (state === null) return null;

  const revoked = isRevocation(state);
  const pill = revoked ? { label: "Access revoked", tone: "neutral" as const } : runtimePill(state);
  const detail = revoked ? null : runtimeDetail(state);
  const rollback = rollbackTarget(state);

  return (
    <View testID={`plugin-runtime-${plugin.id}`} style={styles.wrap}>
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowSub">{revoked ? REVOKED_NOTE : runtimeNote(state)}</Text>
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
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: 8, gap: 6 },
  head: { alignItems: "flex-start", gap: 12 },
  detail: { color: colors.critText, fontSize: 12 },
});
