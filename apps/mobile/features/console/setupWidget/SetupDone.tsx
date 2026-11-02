import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { Icon } from "../../design/components/Icon";
import { leading, pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * A-09 — "You're set up.", in the console, the moment the fourth row turns.
 *
 * Drawn over the workspace once, then put away for good on this device
 * (`useSetupWidget`). It is only ever drawn with all four facts true — a
 * summary that could say "set up" over a bucket that never verified was the
 * old closing screen's worst sentence, and `rules.ts` makes it unreachable.
 *
 * The canvas's Download button is a sentence instead: any folder downloads as
 * a .zip from Files, and a managed context moves every raw object to a bucket
 * its owner controls from Settings → Storage. The sentence names both real
 * exits instead of drawing a button that would do less than it says.
 *
 * **It always fits the window and always closes** (Dev2, 2026-10-10: it
 * "bombards you and you couldn't even close it", short of zooming the browser
 * out). Its only way out used to be Close at the foot of a card taller than a
 * laptop window, drawn with no scroll. Now the card is capped at the window's
 * height (`doneCardMaxHeight`), its body scrolls, a close mark sits in its
 * corner outside the scrolling part, and Escape closes it.
 *
 * The cap is measured against the layer the host draws it in (`areaHeight`),
 * not the window: in the console that layer sits under the top bar and above
 * the status line, so a cap taken from the window let the card's foot run
 * past the layer's bottom edge and be cut off with nothing left to scroll
 * (Dev2, 2026-10-29). The window is only the fallback before the first layout.
 *
 * **And it should never need the scroll** (Dev2, same day: "we shouldn't need
 * to scroll, this could be much much more compact"). The badge sits beside the
 * title rather than above it, the exit is one sentence rather than a boxed
 * panel, each "What's next" row is a title, one short line and a small button,
 * and the second Close at the foot is gone: the corner mark and Escape close
 * it. With every row present it is about 360pt tall, so it fits a laptop
 * window under the console's bars; the scroll is only for a window shorter
 * than that.
 */
export function SetupDone({
  onClose,
  onNewWorkspace,
  onCopyBootstrap,
  onJoinCommunity,
  invitesLeft,
  onInviteFriends,
  closeOnEscape = true,
  areaHeight,
}: {
  onClose: () => void;
  /** The height of the layer the card is drawn in, once laid out; the cap is taken from it. */
  areaHeight?: number;
  /** False while something is open over the card, so Escape closes that instead. */
  closeOnEscape?: boolean;
  onNewWorkspace?: () => void;
  onCopyBootstrap: () => Promise<boolean>;
  /**
   * The referrals artboard's end-of-setup rows (2026-09-29): the community's
   * join link when staff have set one, and the invites this person can send.
   */
  onJoinCommunity?: () => void;
  invitesLeft?: number;
  onInviteFriends?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState<boolean | null>(null);
  const { height } = useWindowDimensions();
  useEscape(closeOnEscape, onClose);

  const rows: NextRow[] = [];
  if (onNewWorkspace) {
    rows.push({
      title: "Add a shared workspace",
      body: "Its own storage and members, for a team.",
      action: "Start",
      onPress: onNewWorkspace,
      testID: "setup-done-shared",
    });
  }
  if (onJoinCommunity) {
    rows.push({
      title: "Join the community",
      body: "Early users and the Context team, on Discord.",
      action: "Join",
      onPress: onJoinCommunity,
      testID: "setup-done-community",
    });
  }
  if (onInviteFriends && invitesLeft !== undefined && invitesLeft > 0) {
    rows.push({
      title: `You have ${invitesLeft} ${invitesLeft === 1 ? "invite" : "invites"}`,
      body: "Friends you invite skip the waitlist.",
      action: "Invite",
      onPress: onInviteFriends,
      testID: "setup-done-invite",
    });
  }
  rows.push({
    title: "Bring in what your AI knows",
    body:
      copied === true
        ? "Copied. Paste it into Claude or ChatGPT."
        : "One prompt for Claude or ChatGPT fills your folders.",
    status: copied !== null,
    action: "Copy prompt",
    onPress: () => {
      void onCopyBootstrap().then(setCopied);
    },
    testID: "setup-done-bootstrap",
  });

  return (
    <View
      style={[styles.card, { maxHeight: doneCardMaxHeight(areaHeight ?? height) }]}
      testID="setup-done"
      role="dialog"
      aria-label="You're set up"
    >
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} testID="setup-done-body">
        <View style={styles.head}>
          <View style={styles.badge} aria-hidden>
            <Text style={styles.badgeMark}>✓</Text>
          </View>
          <View style={styles.headText}>
            <Text role="heading" aria-level={2} style={styles.title}>
              You're set up.
            </Text>
            <Text style={styles.lede}>Handle, storage, notes and a tool are all connected.</Text>
          </View>
        </View>

        <Text style={styles.exit} testID="setup-done-exit">
          Every note is plain Markdown. Any folder downloads as a .zip from Files, and it can all
          move to your own bucket in Settings → Storage. Free, any time.
        </Text>

        <View style={styles.next}>
          {rows.map((row, index) => (
            <View key={row.testID} style={[styles.nextRow, index > 0 ? styles.nextRule : null]}>
              <View style={styles.nextText}>
                <Text style={styles.nextTitle}>{row.title}</Text>
                <Text style={styles.nextBody} role={row.status ? "status" : undefined}>
                  {row.body}
                </Text>
              </View>
              <Button label={row.action} variant="mini" onPress={row.onPress} testID={row.testID} />
            </View>
          ))}
        </View>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        aria-label="Close"
        onPress={onClose}
        hitSlop={8}
        style={styles.dismiss}
        testID="setup-done-dismiss"
      >
        <Icon name="close" size={16} />
      </Pressable>
    </View>
  );
}

interface NextRow {
  title: string;
  body: string;
  /** The body is a result someone is waiting on, so it is announced. */
  status?: boolean;
  action: string;
  onPress: () => void;
  testID: string;
}

/** Where the host draws the card from its layer's top, and what it keeps below. */
export const DONE_TOP = 60;
const DONE_BOTTOM = 24;

/**
 * The tallest the card may be in a layer this high: from where the host
 * draws it to a margin above the bottom edge, so nothing in it is ever out of
 * reach. The rest scrolls.
 */
export function doneCardMaxHeight(windowHeight: number): number {
  return Math.max(0, windowHeight - DONE_TOP - DONE_BOTTOM);
}

function useEscape(enabled: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      width: "100%",
      maxWidth: 460,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: 14,
      backgroundColor: colors.ground,
      overflow: "hidden",
      boxShadow: "0 20px 48px rgba(26,23,20,.16)",
    },
    scroll: { flexGrow: 0 },
    body: { padding: 20, gap: 14 },
    dismiss: {
      position: "absolute",
      top: 10,
      right: 10,
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    head: { flexDirection: "row", alignItems: "center", gap: 12, paddingRight: 28 },
    badge: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.hintWash,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeMark: { fontSize: t.ui, fontWeight: "700", color: colors.accent },
    headText: { flex: 1, minWidth: 0 },
    title: { fontSize: t.h3, fontWeight: "600", color: colors.text },
    lede: { marginTop: 2, fontSize: t.meta, lineHeight: leading(t.meta, 1.5), color: colors.text2 },
    exit: { fontSize: t.meta, lineHeight: leading(t.meta, 1.5), color: colors.text2 },
    next: { borderTopWidth: 1, borderTopColor: colors.line },
    nextRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
    nextRule: { borderTopWidth: 1, borderTopColor: colors.line },
    nextText: { flex: 1, minWidth: 0 },
    nextTitle: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    nextBody: { marginTop: 1, fontSize: t.meta, color: colors.text2, lineHeight: leading(t.meta, 1.45) },
  });
