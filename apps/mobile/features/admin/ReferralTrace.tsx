/**
 * One referral traced: who sent it, what became of it, who that person has
 * invited since — and a way to give the sender more invites.
 *
 * Opens under the row it traces, so the answer sits beside the question. The
 * grant never emails anybody; the sentence after it says so, because a staff
 * member reading "Gave @maya 3 more invites" will otherwise wonder whether
 * @maya just got a notification they did not mean to send.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Text, leading, radii, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { Skeleton } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import {
  GRANT_AMOUNTS,
  grantedSentence,
  handle,
  onwardLine,
  statusPill,
  traceSteps,
  type ReferralRow,
  type TraceStep,
} from "./referrals";
import { shortDate } from "./waitlist";

export function ReferralTrace({ row }: { row: ReferralRow }) {
  const styles = useThemedStyles(makeStyles);
  const trace = useQuery(api.functions.admin.traceReferral, {
    inviteId: row.id as Id<"referralInvites">,
  });
  const grant = useMutation(api.functions.admin.grantInvites);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; sentence: string } | null>(null);

  async function give(add: number) {
    setBusy(true);
    setSaid(null);
    try {
      await grant({ userId: row.inviterUserId as Id<"users">, add });
      setSaid({ ok: true, sentence: grantedSentence(add, row.inviterHandle) });
    } catch (caught) {
      setSaid({ ok: false, sentence: messageFor(caught, "That did not work. Try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.box} testID={`admin-referral-trace-panel-${row.id}`}>
      {trace === undefined ? (
        <Skeleton width="100%" height={64} />
      ) : trace === null ? (
        <Text variant="meta">This invite is gone.</Text>
      ) : (
        <View style={styles.timeline}>
            {traceSteps(trace).map((step, index, all) => (
              <Step key={step.label} step={step} last={index === all.length - 1 && trace.status !== "joined"} />
            ))}
            {trace.status === "joined" ? (
              <View style={styles.step}>
                <View style={styles.rail}>
                  <View style={styles.dot} />
                </View>
                <View style={styles.stepBody}>
                  <Text variant="rowTitle" style={styles.stepLabel}>
                    {onwardLine(trace.joinedHandle, trace.onward.length)}
                  </Text>
                  {trace.onward.map((onward) => (
                    <Text key={`${onward.email}-${onward.sentAt}`} variant="meta">
                      {onward.email} · {statusPill(onward.status, null).label} · {shortDate(onward.sentAt)}
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}
        </View>
      )}

      <View style={styles.grant}>
        <Text variant="meta" style={styles.grantLabel}>
          Give {handle(row.inviterHandle)} more
        </Text>
        <View style={styles.grantButtons}>
          {GRANT_AMOUNTS.map((add) => (
            <Button
              key={add}
              label={`+${add}`}
              accessibilityLabel={`Give ${handle(row.inviterHandle)} ${add} more`}
              disabled={busy}
              onPress={() => give(add)}
              testID={`admin-referral-grant-${add}-${row.id}`}
            />
          ))}
        </View>
      </View>
      {said ? (
        <Text
          variant={said.ok ? "meta" : "error"}
          role={said.ok ? undefined : "alert"}
          testID={`admin-referral-grant-said-${row.id}`}
        >
          {said.sentence}
        </Text>
      ) : null}
    </View>
  );
}

function Step({ step, last }: { step: TraceStep; last: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const tones = { ok: styles.dotOk, crit: styles.dotCrit, warn: styles.dotWarn, neutral: null };
  const tone = tones[step.tone];
  return (
    <View style={styles.step}>
      <View style={styles.rail}>
        <View style={[styles.dot, tone]} />
        {last ? null : <View style={styles.line} />}
      </View>
      <View style={styles.stepBody}>
        <Text variant="rowTitle" style={styles.stepLabel}>
          {step.label}
        </Text>
        {step.at === null ? null : <Text variant="meta">{shortDate(step.at)}</Text>}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: {
      gap: space.x3,
      padding: space.x3,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    timeline: { gap: 0 },
    step: { flexDirection: "row", gap: space.x3, minHeight: 40 },
    rail: { width: 10, alignItems: "center", paddingTop: 6 },
    dot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.lineStrong },
    dotOk: { backgroundColor: colors.ok },
    dotWarn: { backgroundColor: colors.warn },
    dotCrit: { backgroundColor: colors.crit },
    line: { flex: 1, width: 1, marginTop: 4, backgroundColor: colors.line },
    stepBody: { flex: 1, minWidth: 0, gap: 2, paddingBottom: space.x2 },
    stepLabel: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    grant: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x3 },
    grantLabel: { color: colors.text, fontWeight: "500" },
    grantButtons: { flexDirection: "row", gap: space.x2 },
  });
