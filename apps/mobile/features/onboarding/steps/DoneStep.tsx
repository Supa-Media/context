import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { CopyField } from "../../design/components/CopyField";
import { Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading, pointerType as t, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MCP_ENDPOINT, placeholderIngestionAddress } from "../../console/placeholderData";
import { storageWarning, stepsFor } from "../flow";
import type { OnboardingController } from "../useOnboarding";

/**
 * A-09 — done, and what's next.
 *
 * Deliberately short. Somebody thirty seconds into a product does not read a
 * tour, and everything here is discoverable in the console anyway.
 *
 * The endpoint used to go first, on the reasoning that it is the one thing not
 * written down anywhere else. It now belongs to the tools step, which is about
 * it — but only a run whose bucket connected reaches that step, so this screen
 * still carries it for a run that skipped storage. The lede moves with it:
 * telling somebody to "paste this endpoint" beside no endpoint was the bug that
 * conditional introduced.
 *
 * The one thing this screen has to be careful about is the bucket. It is the
 * last screen of the run, so a context that has nowhere to keep notes has to
 * say so here or not at all — and the person who most needs telling is the one
 * whose bucket check *failed*, which this used to be silent about.
 * `storageWarning` owns that sentence; see `flow.ts`.
 *
 * The capture address is the other thing it has to be careful about, for the
 * same reason and with the opposite failure: this screen told people to
 * forward mail to an address with no receiver behind it, and they did. Whether
 * it may say that is `controller.captureReceivesMail`, which comes from the
 * control plane rather than from this file — see `receivesMail` in
 * `console/ingestion/settings.ts`.
 */
export function DoneStep({
  controller,
  onOpenConsole,
  onNewWorkspace,
}: {
  controller: OnboardingController;
  onOpenConsole: () => void;
  /** "Add a shared workspace" — absent where there is nowhere to send it. */
  onNewWorkspace?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const slug = controller.claimed?.slug ?? "you";
  const warning = storageWarning(controller.shape);
  const sawAgentsStep = stepsFor(controller.shape).includes("agents");
  const complete = warning === null;

  return (
    <View>
      {/*
        A-09's card. "You're set up" only where it is true: a run that skipped
        storage, or carried on past a check that failed, gets the heading that
        says so, and the warning under it that `storageWarning` owns.
      */}
      <View style={styles.hero} testID="welcome-done-hero">
        <View style={[styles.badge, !complete && styles.badgeWarn]}>
          <Text style={[styles.badgeMark, !complete && styles.badgeMarkWarn]}>{complete ? "✓" : "!"}</Text>
        </View>
        <Text style={styles.heroTitle}>{complete ? "You're set up." : `@${slug} is yours — storage isn't yet.`}</Text>
        <Text variant="rowSub" style={styles.heroBody}>
          {complete
            ? `@${slug} is yours and its storage answers. Your endpoint is on the tools screen and in the console, under Connections.`
            : "Everything else can wait; storage is the one thing the workspace needs before it can keep a note."}
        </Text>
      </View>

      {warning !== null ? (
        <Notice tone="warn" style={styles.warning}>
          <Text variant="check" role="status" style={styles.warnText} testID="welcome-storage-warning">
            {warning}
          </Text>
        </Notice>
      ) : null}

      {/*
        The endpoint moved to the tools step, which is *about* it — but that
        step only exists on a run whose bucket connected. A run that skipped
        storage lands here having never been shown the one thing the product is
        for, so this screen keeps it in exactly that case.
      */}
      {sawAgentsStep ? null : (
        <>
          <Text variant="eyebrow" style={styles.head}>
            Your MCP endpoint
          </Text>
          <CopyField value={MCP_ENDPOINT} label="Copy your MCP endpoint" testID="welcome-endpoint" />
          <Text variant="foot" style={styles.under}>
            The same URL for everyone. Your client signs in and gets its own grant, which you can revoke on
            its own at any time.
          </Text>
        </>
      )}

      <Text variant="eyebrow" style={styles.head}>
        Your capture address
      </Text>
      {/*
        Copyable only once something is receiving. A copy button is an
        instruction to go and use the address, and until the Email Worker ships
        the only thing that comes back is a bounce — which is how this was
        found. The address stays on screen and selectable; what is withheld is
        the invitation to act on it today.
      */}
      <CopyField
        value={placeholderIngestionAddress(slug)}
        copyable={controller.captureReceivesMail}
        label="Copy your capture address"
        testID="welcome-capture"
      />
      {controller.captureReceivesMail ? (
        <Text variant="foot" style={styles.under}>
          Forward anything here and it lands in your workspace. Only senders you allow can post to it — it
          starts closed, with just your own account email.
        </Text>
      ) : (
        <Text variant="foot" style={styles.under} testID="welcome-capture-not-receiving">
          This address is reserved for you, but nothing is receiving mail at it yet — anything sent to it
          today bounces.
        </Text>
      )}

      {/*
        A-09 draws a Download button here. There is no whole-workspace download
        to wire it to yet — the console downloads any folder as a .zip — so the
        promise is stated with where to act on it, rather than as a button that
        would have to do less than it says.
      */}
      <View style={styles.exit} testID="welcome-exit">
        <Text style={styles.exitTitle}>Take everything with you</Text>
        <Text variant="rowSub" style={styles.exitBody}>
          Every note is a plain Markdown file. Any folder downloads as a .zip from Files — free, today and
          after you cancel.
        </Text>
      </View>

      <View style={styles.next}>
        <Text variant="eyebrow" style={styles.nextHead}>
          What's next
        </Text>
        {onNewWorkspace ? (
          <NextRow
            title="Add a shared workspace for your team"
            body="A separate context with its own storage and members."
            action="Start →"
            onPress={onNewWorkspace}
            testID="welcome-next-shared"
          />
        ) : null}
        <NextRow
          title="Connect another tool"
          body="One endpoint for every client you use. Each gets its own grant you can revoke."
          action="Open →"
          onPress={onOpenConsole}
          testID="welcome-next-tools"
          ruled={onNewWorkspace !== undefined}
        />
      </View>

      <View style={styles.actions}>
        <Button label="Open your workspace" variant="white" onPress={onOpenConsole} testID="welcome-done" />
      </View>
    </View>
  );
}

function NextRow({
  title,
  body,
  action,
  onPress,
  testID,
  ruled = false,
}: {
  title: string;
  body: string;
  action: string;
  onPress: () => void;
  testID: string;
  ruled?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.nextRow, ruled && styles.nextRule]}>
      <View style={styles.nextText}>
        <Text style={styles.nextTitle}>{title}</Text>
        <Text variant="rowSub" style={styles.nextBody}>
          {body}
        </Text>
      </View>
      <Button label={action} variant="ghost" onPress={onPress} testID={testID} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    hero: {
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 32,
      paddingHorizontal: 24,
      marginBottom: 18,
    },
    badge: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.hintWash,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 16,
    },
    badgeWarn: { backgroundColor: colors.warnWash },
    badgeMark: { fontSize: t.h2, fontWeight: "700", color: colors.accent },
    badgeMarkWarn: { color: colors.warnText },
    heroTitle: { fontSize: t.h2, fontWeight: "600", color: colors.text, textAlign: "center" },
    heroBody: { marginTop: 10, textAlign: "center", color: colors.text2, lineHeight: leading(14.5, 1.55) },
    warning: { marginBottom: 18 },
    warnText: { color: colors.warnText },
    head: { marginTop: 4, marginBottom: 8 },
    under: { marginTop: 8, marginBottom: 18, lineHeight: leading(12.5, 1.6) },
    exit: {
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.md,
      backgroundColor: colors.hintWash,
      paddingVertical: 14,
      paddingHorizontal: 18,
      gap: 2,
    },
    exitTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    exitBody: { color: colors.text2 },
    next: {
      marginTop: 18,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.well,
      paddingVertical: 14,
      paddingHorizontal: 18,
    },
    nextHead: { marginBottom: 4, color: colors.muted },
    nextRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 10 },
    nextRule: { borderTopWidth: 1, borderTopColor: colors.line },
    nextText: { flex: 1, minWidth: 0 },
    nextTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    nextBody: { marginTop: 2, color: colors.text2 },
    actions: { marginTop: 22, alignSelf: "stretch" },
  });
