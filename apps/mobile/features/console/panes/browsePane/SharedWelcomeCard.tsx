import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType as t, radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { WELCOME_ROUTE } from "../../../onboarding/route";
import { appSectionHref } from "../../nav";
import type { SharedWelcome } from "../../sharedWelcome";

/**
 * B2-02, drawn: the intro band as a welcome, for somebody who has just joined.
 *
 * `text` is the intro's own sentence — what this reader cannot see or cannot
 * write — kept word for word under "You're in", because the reason the band
 * exists is that sentence, and a friendlier card that dropped it would be the
 * filtered listing with nobody saying so.
 */
export function SharedWelcomeCard({
  welcome,
  text,
  onDismiss,
  onNavigate,
}: {
  welcome: SharedWelcome;
  text: string;
  onDismiss: () => void;
  onNavigate?: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const go = (href: string) => (onNavigate === undefined ? undefined : () => onNavigate(href));
  return (
    <View style={styles.card} testID="browse-context-intro">
      <View style={styles.head}>
        <Text style={styles.title}>Welcome to {welcome.handle}</Text>
        <Text style={styles.pill} testID="shared-welcome-role">
          {welcome.roleLabel}
        </Text>
      </View>

      <Row mark="✓" done title="You're in" sub={text} />
      <Row
        mark="●"
        title="Connect a tool to your Context"
        sub="One endpoint reads every workspace you belong to."
        action="Open →"
        onPress={go(appSectionHref("connections"))}
        testID="shared-welcome-connect"
      />
      {welcome.offerPersonal ? (
        <Row
          mark="○"
          title="Get a personal workspace of your own"
          sub="Alongside this one, whenever you like."
          action="Set up →"
          onPress={go(WELCOME_ROUTE)}
          testID="shared-welcome-personal"
        />
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={onDismiss}
        style={styles.dismiss}
        testID="browse-context-intro-dismiss"
      >
        <Text style={styles.dismissText}>Dismiss when you're settled in</Text>
      </Pressable>
    </View>
  );
}

function Row({
  mark,
  done = false,
  title,
  sub,
  action,
  onPress,
  testID,
}: {
  mark: string;
  done?: boolean;
  title: string;
  sub: string;
  action?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      <Text style={[styles.mark, done && styles.markDone]} aria-hidden>
        {mark}
      </Text>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {sub}
        </Text>
      </View>
      {action && onPress !== undefined ? <Text style={styles.action}>{action}</Text> : null}
    </>
  );
  if (onPress === undefined) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="link" onPress={onPress} style={styles.row} testID={testID}>
      {body}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: space.x4,
      paddingHorizontal: space.x5,
      gap: space.x3,
      maxWidth: 560,
    },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    title: { fontSize: t.h3, fontWeight: "600", color: colors.text },
    pill: {
      fontSize: t.label,
      fontWeight: "600",
      color: colors.accent,
      backgroundColor: colors.hintWash,
      borderRadius: 999,
      paddingVertical: 2,
      paddingHorizontal: space.x2,
      overflow: "hidden",
    },
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.x3 },
    mark: { width: 16, fontSize: t.ui, color: colors.accent, textAlign: "center" },
    markDone: { color: colors.okText },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    rowSub: { color: colors.text2 },
    action: { fontSize: t.ui, fontWeight: "600", color: colors.accent },
    dismiss: { alignSelf: "flex-start", paddingVertical: space.x1 },
    dismissText: { fontSize: t.meta, color: colors.muted, textDecorationLine: "underline" },
  });
