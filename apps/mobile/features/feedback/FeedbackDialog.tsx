import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { useReachability } from "../offline/reachability";
import { formatActivity, recentActivity } from "../observability/activity";
import { FeedbackForm, type ShotState } from "./FeedbackForm";
import { bytesToBase64, newClientReportId, type FeedbackDraft } from "./model";
import { discard, enqueue, submit, type SubmitOutcome } from "./queue";
import { captureScreen } from "./screenshot";
import type { OpenReport } from "./request";

/**
 * The feedback report as a dialog on a pointer layout and a sheet on a phone.
 *
 * It owns the report while it is on screen: the message, which attachments
 * stay ticked, the screenshot in both its covered and shown forms, and what
 * happened when it was sent. `queue.ts` owns it from the moment it cannot go.
 */

/**
 * `data-feedback-exclude` on the web, which `screenshot.web.ts` strips from its
 * copy of the page; dropped on native. Spread because `dataSet` is not in
 * React Native's props — the same widening `Icon.tsx` explains.
 */
const EXCLUDE_FROM_SCREENSHOT: Record<string, unknown> = { dataSet: { feedbackExclude: "true" } };

/** Below this the report rises from the bottom as a sheet. */
const SHEET_BELOW = 600;

type Phase = { kind: "editing" } | { kind: "sending" } | SubmitOutcome;

export function FeedbackDialog({ report, onClose }: { report: OpenReport; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const sheet = width < SHEET_BELOW;
  const online = useReachability() !== "offline";

  const [clientReportId] = useState(newClientReportId);
  // The log as it stood when the report opened: what "See it" shows is what goes.
  const [activity] = useState(() => formatActivity(recentActivity()));
  const [message, setMessage] = useState("");
  const [includeActivity, setIncludeActivity] = useState(true);
  const [includeShot, setIncludeShot] = useState(true);
  const [shot, setShot] = useState<ShotState>({ kind: "taking" });
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  useEffect(() => {
    let live = true;
    void report.screenshot.then((masked) => {
      if (!live) return;
      setShot(masked === null ? { kind: "none" } : { kind: "ready", masked, shown: null, showingText: false });
    });
    return () => {
      live = false;
    };
  }, [report]);

  const showText = (next: boolean) => {
    if (shot.kind !== "ready") return;
    if (!next || shot.shown !== null) {
      setShot({ ...shot, showingText: next });
      return;
    }
    void captureScreen({ showText: true }).then((shown) => {
      setShot((now) => (now.kind === "ready" && shown !== null ? { ...now, shown, showingText: true } : now));
    });
  };

  const draft = (): FeedbackDraft => {
    const picture = shot.kind === "ready" && includeShot ? (shot.showingText && shot.shown ? shot.shown : shot.masked) : null;
    return {
      clientReportId,
      message: message.trim(),
      source: report.source,
      screen: report.screen,
      errorEventId: report.errorEventId,
      activity: includeActivity && activity !== "" ? activity : undefined,
      screenshot:
        picture === null ? undefined : { base64: bytesToBase64(picture.data), contentType: picture.contentType },
    };
  };

  const send = () => {
    setPhase({ kind: "sending" });
    void submit(draft(), { online }).then(setPhase, () => setPhase({ kind: "failed" }));
  };

  const editing = phase.kind === "editing" || phase.kind === "sending";
  // A tap outside never throws away words somebody typed.
  const dismissable = !editing || (message.trim() === "" && phase.kind === "editing");

  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismissable ? onClose : () => {}}>
      <Pressable
        style={[styles.scrim, sheet ? styles.scrimSheet : null]}
        accessibilityLabel="Close"
        onPress={dismissable ? onClose : undefined}
        {...EXCLUDE_FROM_SCREENSHOT}
        testID="feedback-dialog"
      >
        <Pressable style={[styles.card, sheet ? styles.sheet : null]} onPress={() => {}}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {editing ? (
              <FeedbackForm
                title={report.errorEventId === undefined ? "Send feedback" : "Report this problem"}
                message={message}
                onMessage={setMessage}
                aboutError={report.errorEventId !== undefined}
                activity={activity}
                includeActivity={includeActivity}
                onIncludeActivity={setIncludeActivity}
                shot={includeShot ? shot : { kind: "none" }}
                includeShot={includeShot}
                onIncludeShot={setIncludeShot}
                onShowText={showText}
                sending={phase.kind === "sending"}
                onCancel={onClose}
                onSend={send}
              />
            ) : (
              <Outcome
                phase={phase}
                onDone={onClose}
                onRetry={send}
                onLater={() => {
                  void enqueue(draft()).then(onClose);
                }}
                onDelete={() => {
                  void discard(clientReportId).then(onClose);
                }}
              />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Outcome({
  phase,
  onDone,
  onRetry,
  onLater,
  onDelete,
}: {
  phase: SubmitOutcome;
  onDone: () => void;
  onRetry: () => void;
  onLater: () => void;
  onDelete: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const copy = OUTCOME_COPY[phase.kind];
  return (
    <View style={styles.outcome} testID={`feedback-${phase.kind}`}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {copy.title}
      </Text>
      <Text variant="paneSub" style={phase.kind === "failed" || phase.kind === "rejected" ? styles.problem : null}>
        {phase.kind === "sent"
          ? `Report ${phase.code}. We read every one. If we need more, we'll email you.`
          : copy.body}
      </Text>
      <View style={styles.buttons}>
        {phase.kind === "failed" ? (
          <>
            <Button label="Send later" variant="dialog" onPress={onLater} testID="feedback-later" />
            <Button label="Try again" variant="dialogPrimary" onPress={onRetry} testID="feedback-retry" />
          </>
        ) : phase.kind === "offline" ? (
          <>
            <Button label="Delete report" variant="dialog" onPress={onDelete} testID="feedback-delete" />
            <Button label="Keep and close" variant="dialogPrimary" onPress={onDone} testID="feedback-keep" />
          </>
        ) : (
          <Button label="Done" variant="dialogPrimary" onPress={onDone} testID="feedback-done" />
        )}
      </View>
    </View>
  );
}

export const OUTCOME_COPY: Record<SubmitOutcome["kind"], { title: string; body: string }> = {
  sent: { title: "Thanks, we got it", body: "" },
  offline: {
    title: "You're offline",
    body: "Your report is saved on this device and sends when you're back online.",
  },
  limited: {
    title: "That's a lot of reports today",
    body: "You can send 10 a day. This one is saved on this device and sends when there's room again.",
  },
  rejected: {
    title: "Couldn't send this report",
    body: "Something in it wasn't in a shape Context accepts, so nothing was sent.",
  },
  failed: { title: "Couldn't send", body: "Context didn't answer. Your report is still here." },
};

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: colors.scrim,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    scrimSheet: { justifyContent: "flex-end", padding: 0 },
    card: {
      width: "100%",
      maxWidth: 480,
      maxHeight: "90%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    sheet: {
      maxWidth: undefined,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderBottomWidth: 0,
    },
    body: { paddingVertical: 20, paddingHorizontal: 20 },
    outcome: { gap: 12 },
    problem: { color: colors.critText },
    buttons: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });
