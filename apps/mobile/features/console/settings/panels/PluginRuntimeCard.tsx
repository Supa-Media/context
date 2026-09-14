import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  REGISTRATION_NOTE,
  REVOKED_NOTE,
  STATUS_BAR_NOTE,
  editorCommandState,
  commandOutcomeFor,
  describeRegistrations,
  isOwnerStop,
  isRevocation,
  registrationsFor,
  rollbackTarget,
  runtimeDetail,
  runtimeFor,
  runtimeNote,
  runtimePill,
  statusItemsFor,
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
  /*
    Only while it is loaded. A stopped plugin's commands went with its frame,
    and a list left behind would say the console has something it does not.
  */
  const registered = registrationsFor(state, view.registrations);
  const registeredNote = describeRegistrations(registered);
  /*
    A name becomes a control only when there is something behind it: the
    runtime has to be able to reach the frame. Without `run` this renders
    exactly what it did before invoke existed — names, and the note saying so.
  */
  const run = view.actions?.run;
  /*
    The plugin's own words, under the same only-while-loaded rule. A reading is
    the worst thing in this card to leave behind: "412 words" beside a stopped
    plugin is not out of date, it is produced by nothing.
  */
  const status = statusItemsFor(state, view.statusItems);
  const outcome = commandOutcomeFor(registered, view.outcomes?.[plugin.id]);

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

      {status.length > 0 ? (
        <View style={styles.status} testID={`plugin-status-bar-${plugin.id}`}>
          <Text variant="rowSub" style={styles.statusNote}>{STATUS_BAR_NOTE}</Text>
          {status.map((one) => (
            <Text key={one.id} variant="rowSub">
              {one.text}
            </Text>
          ))}
        </View>
      ) : null}

      {registeredNote ? (
        <View style={styles.registrations} testID={`plugin-registrations-${plugin.id}`}>
          <Text variant="rowSub">{registeredNote}</Text>
          {registered.map((one) => {
            /*
              An editor command acts on the note its owner has open, so whether
              it can run at all is a fact this card holds. Drawn disabled with
              the reason rather than pressable and throwing — see
              `editorCommandState`.
            */
            const command = editorCommandState(one, view.openNote);
            return run ? (
              <View key={`${one.kind}:${one.id}`} style={styles.command}>
                <Button
                  label={command.label}
                  disabled={!command.runnable}
                  onPress={() => {
                    if (!command.runnable) return;
                    run(plugin.id, one.id);
                  }}
                />
                {command.hint ? (
                  <Text variant="rowSub" style={styles.registration}>
                    {command.hint}
                  </Text>
                ) : null}
              </View>
            ) : (
              <Text key={`${one.kind}:${one.id}`} variant="rowSub" style={styles.registration}>
                {command.label}
              </Text>
            );
          })}
          {/*
            Without `run` these stay names, and the note says why. It is the
            console that is unwired, never the sandbox: the guest has always
            handled an inbound `command`.
          */}
          {run ? null : (
            <Text variant="rowSub" style={styles.registration}>
              {REGISTRATION_NOTE}
            </Text>
          )}
          {outcome ? (
            <Text
              variant={outcome.ok ? "rowSub" : "error"}
              testID={`plugin-command-outcome-${plugin.id}`}
              style={outcome.ok ? styles.registration : undefined}
            >
              {outcome.ok
                ? `Ran ${outcome.name}.`
                : `${outcome.name} did not finish. The plugin reported: ${outcome.error}`}
            </Text>
          ) : null}
        </View>
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
  registrations: { gap: 3, marginTop: 2 },
  command: { gap: 3 },
  status: { gap: 2, marginTop: 2 },
  statusNote: { color: colors.muted },
  registration: { color: colors.muted },
  wrap: { marginTop: 8, gap: 6 },
  head: { alignItems: "flex-start", gap: 12 },
  detail: { color: colors.critText, fontSize: 12 },
});
