/**
 * Invite friends: up to three addresses skip the waitlist.
 *
 * Opened from the account menu and from "You're set up." (the referrals
 * artboard, approved 2026-09-29). One field, a row of dots for what is left,
 * and the invites already sent with what became of each. A waiting invite can
 * be cancelled, with Undo instead of a confirm; everything else is read from
 * the server, so the list is always what actually happened.
 *
 * Only mounted while open and only where there is a Convex client, so the
 * fixtures and the homepage demo never subscribe.
 */

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useFieldFont } from "../design/fieldFont";
import { useThemedStyles, type Colors } from "../design/theme";
import { pointerType as t, radii, space } from "../design/tokens";
import { blocker, describeInvite, dots, sendError, UNDO_SHOWN_MS, type Tone } from "./invites";

type Notice = { tone: "ok" | "error"; text: string; undo?: Id<"referralInvites"> };

export function InviteFriendsDialog({ onClose }: { onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const mine = useQuery(api.functions.referrals.mine, {});
  const send = useMutation(api.functions.referrals.send);
  const cancel = useMutation(api.functions.referrals.cancel);
  const undoCancel = useMutation(api.functions.referrals.undoCancel);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Undo is a moment, not a standing offer.
  useEffect(() => {
    if (notice?.undo === undefined) return;
    const timer = setTimeout(() => setNotice(null), UNDO_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const stop = mine === undefined || mine === null ? null : blocker(mine);
  const canSend = mine !== undefined && mine !== null && stop === null && email.trim().length > 3 && !busy;

  async function submit() {
    if (!canSend) return;
    const typed = email.trim();
    setBusy(true);
    setNotice(null);
    try {
      const result = await send({ email: typed });
      setNotice(
        result.status === "already"
          ? { tone: "ok", text: `${typed} can already sign in. Your invite wasn't used.` }
          : { tone: "ok", text: `Invite sent to ${typed}. It works for 14 days.` },
      );
      setEmail("");
    } catch (caught) {
      const code = caught instanceof ConvexError ? (caught.data as { code?: string } | undefined)?.code : undefined;
      setNotice({ tone: "error", text: sendError(code) });
    } finally {
      setBusy(false);
    }
  }

  async function cancelOne(id: Id<"referralInvites">, address: string) {
    const { changed } = await cancel({ inviteId: id }).catch(() => ({ changed: false }));
    setNotice(
      changed
        ? { tone: "ok", text: `Invite to ${address} cancelled.`, undo: id }
        : { tone: "error", text: "That invite can't be cancelled any more." },
    );
  }

  async function undo(id: Id<"referralInvites">) {
    const { changed } = await undoCancel({ inviteId: id }).catch(() => ({ changed: false }));
    setNotice(changed ? { tone: "ok", text: "Invite restored." } : { tone: "error", text: "Too late to undo." });
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Invite friends" testID="invite-friends">
          <View style={styles.head}>
            <Text variant="paneTitle" role="heading" aria-level={2}>
              Invite friends
            </Text>
            {mine ? (
              <View style={styles.dots} accessibilityLabel={`${mine.left} of ${mine.total} left`}>
                {dots(mine).map((used, index) => (
                  <View key={index} style={[styles.dot, used ? styles.dotUsed : null, mine.locked ? styles.dotLocked : null]} />
                ))}
              </View>
            ) : null}
          </View>
          <Text variant="hint">They skip the waitlist. Each invite works for one email, for 14 days.</Text>

          {mine === undefined ? (
            <View style={styles.skeleton} />
          ) : stop !== null ? (
            <Text style={styles.blocker} testID="invite-blocker">
              {stop}
            </Text>
          ) : (
            <View style={styles.field}>
              <TextInput
                value={email}
                onChangeText={setEmail}
                onSubmitEditing={() => void submit()}
                placeholder="friend@work.com"
                accessibilityLabel="Friend's email"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
                autoFocus
                style={[styles.input, fieldFont]}
                testID="invite-email"
              />
              <Button
                label={busy ? "Sending…" : "Send invite"}
                onPress={() => void submit()}
                variant="dialogPrimary"
                disabled={!canSend}
                testID="invite-send"
              />
            </View>
          )}

          {notice !== null ? (
            <View style={styles.notice} role="status">
              <Text variant={notice.tone === "error" ? "error" : "hint"} style={styles.flex}>
                {notice.text}
              </Text>
              {notice.undo !== undefined ? (
                <TextLink label="Undo" onPress={() => void undo(notice.undo!)} testID="invite-undo" />
              ) : null}
            </View>
          ) : null}

          {mine && mine.invites.length > 0 ? (
            <ScrollView style={styles.list}>
              {mine.invites.map((invite) => {
                const said = describeInvite(invite);
                return (
                  <View key={invite.id} style={styles.row} testID={`invite-row-${invite.status}`}>
                    <View style={styles.flex}>
                      <Text variant="rowTitle" numberOfLines={1}>
                        {invite.email}
                      </Text>
                      <Text variant="hint">{said.sub}</Text>
                    </View>
                    <View style={[styles.pill, pillTone(styles, said.tone)]}>
                      <Text variant="mini" style={pillText(styles, said.tone)}>
                        {said.pill}
                      </Text>
                    </View>
                    {invite.status === "pending" ? (
                      <TextLink
                        label="Cancel"
                        onPress={() => void cancelOne(invite.id as Id<"referralInvites">, invite.email)}
                        testID="invite-cancel"
                      />
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          ) : mine ? (
            <Text variant="hint">People you invite show up here.</Text>
          ) : null}

          <View style={styles.actions}>
            <Button label="Done" onPress={onClose} variant="dialog" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

type Styles = ReturnType<typeof makeStyles>;
function pillTone(styles: Styles, tone: Tone) {
  return tone === "positive" ? styles.pillPositive : tone === "attention" ? styles.pillAttention : tone === "negative" ? styles.pillNegative : styles.pillNeutral;
}
function pillText(styles: Styles, tone: Tone) {
  return tone === "positive" ? styles.textPositive : tone === "attention" ? styles.textAttention : tone === "negative" ? styles.textNegative : styles.textNeutral;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    card: {
      width: "100%",
      maxWidth: 480,
      maxHeight: "92%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 22,
      paddingHorizontal: 22,
      gap: 12,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    dots: { flexDirection: "row", gap: 6 },
    dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.accent },
    dotUsed: { backgroundColor: colors.accent },
    dotLocked: { borderColor: colors.lineStrong, backgroundColor: "transparent" },
    field: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    input: {
      flexGrow: 1,
      flexBasis: 200,
      minWidth: 0,
      fontSize: t.ui,
      color: colors.text,
      paddingVertical: 9,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    blocker: { fontSize: t.ui, color: colors.text2 },
    skeleton: { height: 38, borderRadius: radii.lg, backgroundColor: colors.well },
    notice: { flexDirection: "row", alignItems: "center", gap: 10 },
    list: { maxHeight: 280 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 9,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    flex: { flex: 1, minWidth: 0 },
    pill: { paddingHorizontal: 9, paddingVertical: 2, borderRadius: radii.pill },
    pillPositive: { backgroundColor: colors.okWash },
    pillAttention: { backgroundColor: colors.warnWash },
    pillNegative: { backgroundColor: colors.critWash },
    pillNeutral: { backgroundColor: colors.well },
    textPositive: { color: colors.okText },
    textAttention: { color: colors.warnText },
    textNegative: { color: colors.critText },
    textNeutral: { color: colors.muted },
    actions: { flexDirection: "row", justifyContent: "flex-end", marginTop: space.x1 },
  });
