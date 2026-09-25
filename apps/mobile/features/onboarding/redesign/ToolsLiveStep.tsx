import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { TextLink } from "../../design/components/TextLink";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * A-11 — the live moment.
 *
 * The screen that closes the loop: the client you connected has read your
 * context, called `orient`, and written its first notes. Until it has, this
 * screen sits and waits — but visibly, with the tail of events from the audit
 * log so somebody who came back after making a cup of coffee sees what
 * happened rather than a spinner.
 */
export interface LiveEvent {
  id: string;
  when: string;
  client: string;
  /** What the agent did, as the activity log reports it: it read a note, or wrote one. */
  action: "read" | "wrote";
  target?: string;
}

export function ToolsLiveStep({
  state,
  events,
  onContinue,
}: {
  state: "waiting" | "connected";
  events: readonly LiveEvent[];
  onContinue: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const connected = state === "connected";

  return (
    <View>
      <View style={styles.hero}>
        <Pill tone={connected ? "ok" : "warn"} dashed={!connected}>
          {connected ? "Live" : "Waiting for a first call"}
        </Pill>
        <Text style={styles.headline}>
          {connected
            ? "Your tools are talking to your context."
            : "Waiting for your first tool call."}
        </Text>
        <Text variant="rowSub" style={styles.body}>
          {connected
            ? "A tool you connected has reached your context. This screen is safe to leave — the console keeps showing what your tools read and write."
            : "This turns live the moment a tool you connected makes its first call. If it hasn't, paste the bootstrap prompt into it. The log below refreshes every half minute."}
        </Text>
      </View>

      <Text variant="eyebrow" style={styles.head}>
        Live event log
      </Text>
      <View style={styles.log}>
        {events.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="foot" style={styles.emptyText}>
              Nothing yet. Paste the bootstrap prompt into your connected client
              and this fills in.
            </Text>
          </View>
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </View>

      <View style={styles.actions}>
        {connected ? (
          <Button label="Continue" variant="accent" onPress={onContinue} testID="welcome-live-continue" />
        ) : (
          <TextLink label="Skip for now" onPress={onContinue} testID="welcome-live-continue" />
        )}
        {!connected && (
          <Text variant="foot" style={styles.hint}>
            You can leave this open on another tab.
          </Text>
        )}
      </View>
    </View>
  );
}

function EventRow({ event }: { event: LiveEvent }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.eventRow}>
      <Text style={styles.when}>{event.when}</Text>
      <Text style={styles.actionText}>
        <Text style={styles.client}>{event.client}</Text>
        <Text style={styles.dim}> {event.action} </Text>
        {event.target ? <Text style={styles.mono}>{event.target}</Text> : null}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    hero: {
      paddingVertical: space.x5,
      alignItems: "flex-start",
      gap: space.x3,
    },
    headline: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(22, 1.2),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(22, -0.02),
    },
    body: { color: colors.text2, lineHeight: leading(12.5, 1.7) },
    head: { marginTop: space.x3, marginBottom: space.x2 },
    log: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    empty: {
      padding: space.x5,
    },
    emptyText: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
    eventRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    when: {
      fontFamily: fonts.mono,
      fontSize: t.label,
      color: colors.muted,
      minWidth: 56,
    },
    actionText: {
      fontFamily: fonts.body,
      fontSize: t.meta,
      color: colors.text,
      flex: 1,
      lineHeight: leading(12.5, 1.55),
    },
    client: { fontWeight: "600", color: colors.text },
    mono: { fontFamily: fonts.mono, color: colors.accent },
    dim: { color: colors.muted },
    actions: {
      marginTop: space.x6,
      gap: space.x3,
    },
    hint: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
  });
