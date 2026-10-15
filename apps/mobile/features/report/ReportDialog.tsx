import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { useFieldFont } from "../design/fieldFont";
import { fonts, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { newClientReportId } from "../feedback/model";
import {
  DETAILS_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  canSend,
  describeReportFailure,
  personLabel,
  receiptCode,
  reportArgs,
  type ReportPerson,
  type ReportReason,
  type ReportTarget,
} from "./model";

/** Below this the dialog rises from the bottom as a sheet, like feedback's. */
const SHEET_BELOW = 600;

type Phase =
  | { kind: "editing" }
  | { kind: "sending" }
  | { kind: "sent"; code: string; blocked: boolean }
  | { kind: "failed"; message: string };

/**
 * Report something another person put in front of you, and optionally block
 * them in the same call. Feedback's dialog shape (`FeedbackDialog`): a card on
 * a pointer layout, a sheet on a phone.
 *
 * The server resolves `target` for this person and answers every report with
 * the same receipt, so nothing here can tell whether the target was real —
 * and nothing here tries to.
 */
export function ReportDialog({
  target,
  person,
  onClose,
}: {
  target: ReportTarget;
  /** Who sent it, to offer "Also block"; `null` where there is nobody to block. */
  person: ReportPerson | null;
  onClose: () => void;
}) {
  const submit = useAction(api.functions.reports.submitReport);
  return <ReportDialogView target={target} person={person} onClose={onClose} submit={submit} />;
}

/** The dialog with its server call passed in: what the tests mount. */
export function ReportDialogView({
  target,
  person,
  onClose,
  submit,
}: {
  target: ReportTarget;
  person: ReportPerson | null;
  onClose: () => void;
  submit: (args: ReturnType<typeof reportArgs>) => Promise<{ eventId: string }>;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const { width } = useWindowDimensions();
  const sheet = width < SHEET_BELOW;

  const [clientReportId] = useState(newClientReportId);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const send = () => {
    if (reason === null) return;
    setPhase({ kind: "sending" });
    const blocking = person !== null && alsoBlock;
    submit(reportArgs({ clientReportId, target, reason, details, alsoBlock: blocking })).then(
      ({ eventId }) => setPhase({ kind: "sent", code: receiptCode(eventId), blocked: blocking }),
      (error: unknown) => setPhase({ kind: "failed", message: describeReportFailure(error) }),
    );
  };

  const editing = phase.kind === "editing" || phase.kind === "sending" || phase.kind === "failed";
  const dismissable = phase.kind !== "sending";

  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismissable ? onClose : () => {}}>
      <Pressable
        style={[styles.scrim, sheet ? styles.scrimSheet : null]}
        accessibilityLabel="Close"
        onPress={dismissable && details.trim() === "" ? onClose : undefined}
        testID="report-dialog"
      >
        <Pressable style={[styles.card, sheet ? styles.sheet : null]} onPress={() => {}}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {editing ? (
              <View style={styles.form}>
                <Text variant="paneTitle" role="heading" aria-level={2}>
                  {person === null ? "Report" : "Report or block"}
                </Text>
                <Text variant="eyebrow">What's wrong?</Text>
                <View style={styles.list} role="radiogroup">
                  {REPORT_REASONS.map((key, index) => (
                    <Pressable
                      key={key}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: reason === key }}
                      accessibilityLabel={REPORT_REASON_LABELS[key]}
                      onPress={() => setReason(key)}
                      style={[styles.item, index === 0 ? styles.itemFirst : null]}
                      testID={`report-reason-${key}`}
                    >
                      <View style={[styles.radio, reason === key ? styles.radioOn : null]} />
                      <Text variant="rowTitle">{REPORT_REASON_LABELS[key]}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text variant="eyebrow">Anything we should know? (optional)</Text>
                <TextInput
                  style={[styles.details, fieldFont]}
                  value={details}
                  onChangeText={setDetails}
                  placeholder="What happened"
                  placeholderTextColor={colors.muted}
                  multiline
                  maxLength={DETAILS_MAX}
                  accessibilityLabel="Anything we should know?"
                  testID="report-details"
                />
                {person === null ? null : (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: alsoBlock }}
                    accessibilityLabel={`Also block ${personLabel(person)}`}
                    onPress={() => setAlsoBlock(!alsoBlock)}
                    style={styles.blockRow}
                    testID="report-also-block"
                  >
                    <View style={[styles.box, alsoBlock ? styles.boxOn : null]}>
                      {alsoBlock ? <Text style={styles.tick}>✓</Text> : null}
                    </View>
                    <View style={styles.grow}>
                      <Text variant="rowTitle">{`Also block ${personLabel(person)}`}</Text>
                      <Text variant="rowSub">
                        Nothing they share with you or invite you to will reach you. They are not told.
                      </Text>
                    </View>
                  </Pressable>
                )}
                {phase.kind === "failed" ? (
                  <Text variant="rowSub" style={styles.problem} testID="report-failed">
                    {phase.message}
                  </Text>
                ) : null}
                <Text variant="hint" style={styles.consent}>
                  Goes to the Context team, who review every report within 24 hours. The note's text is not sent.
                </Text>
                <View style={styles.buttons}>
                  <Button label="Cancel" variant="dialog" onPress={onClose} testID="report-cancel" />
                  <Button
                    label={phase.kind === "sending" ? "Sending…" : "Send report"}
                    variant="dialogPrimary"
                    onPress={send}
                    disabled={!canSend(reason, details) || phase.kind === "sending"}
                    testID="report-send"
                  />
                </View>
              </View>
            ) : (
              <View style={styles.form} testID="report-sent">
                <Text variant="paneTitle" role="heading" aria-level={2}>
                  Thanks, we got it
                </Text>
                <Text variant="paneSub">
                  {`Report ${phase.code}. We review every report within 24 hours.${
                    phase.blocked && person !== null ? ` ${personLabel(person)} is blocked.` : ""
                  }`}
                </Text>
                <View style={styles.buttons}>
                  <Button label="Done" variant="dialogPrimary" onPress={onClose} testID="report-done" />
                </View>
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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
    },
    sheet: {
      maxWidth: undefined,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderBottomWidth: 0,
    },
    body: { paddingVertical: 20, paddingHorizontal: 20 },
    form: { gap: 10 },
    list: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.lg, overflow: "hidden" },
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 9,
      paddingHorizontal: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    itemFirst: { borderTopWidth: 0 },
    radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.muted },
    radioOn: { borderWidth: 5, borderColor: colors.accent },
    details: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      color: colors.text,
      minHeight: 72,
      maxHeight: 160,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
      textAlignVertical: "top",
    },
    blockRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
    box: {
      width: 16,
      height: 16,
      marginTop: 2,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    tick: { fontSize: t.label, lineHeight: 13, color: colors.ink, fontWeight: "700" },
    grow: { flex: 1, minWidth: 0, gap: 1 },
    problem: { color: colors.critText },
    consent: { color: colors.muted },
    buttons: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });
