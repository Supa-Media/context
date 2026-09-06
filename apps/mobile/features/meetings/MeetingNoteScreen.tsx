import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { fonts, layout, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { meetings } from "./controller";
import { isMeetingId } from "./protocol";
import { attendeeCount, dayHeading, duration, sourceLabel } from "./format";
import type { MeetingRecord } from "./record";
import { useMeetingsSnapshot } from "./useMeetings";

/**
 * The meeting after it has ended: finalizing, then the note.
 *
 * ## Four states, and none of them is a spinner over the last one
 *
 * `finalizing` with nothing back yet, `finalizing` with an enhanced note but no
 * path, `complete` with a path, and `failed`. They are genuinely different
 * things to be told and each gets its own words — the console's own rule that
 * "an absence is a claim, and a claim needs an answer".
 *
 * In particular **"Saved to your bucket" is drawn only when there is a path to
 * print**. The gateway acknowledging a finalize is not the customer's bucket
 * holding a note; only `notePath` says the second. A green tick over an
 * unfinished write is the invented-fact bug this repo has already shipped twice.
 *
 * ## The human's notes are shown, verbatim, beside the generated ones
 *
 * "`notes` is what the human typed — it is theirs and is never rewritten by the
 * enhancement pass. `enhanced` is the generated note, and it is regenerable, so
 * losing it is never data loss." The screen draws that asymmetry: the summary
 * is the top of the page and is disposable, and **My notes, unchanged** is a
 * bordered card underneath with the person's own words in it. Somebody has to
 * be able to see, in one glance, that the thing they typed survived.
 *
 * ## One file per meeting
 *
 * The transcript is a `## Transcript` section of the same note, not a second
 * file, so "Transcript" here expands a section of this screen rather than
 * navigating anywhere. Anywhere this UI says "the transcript" it means part of
 * the note whose path is printed at the bottom.
 */
export function MeetingNoteScreen({ meetingId }: { meetingId: string }) {
  const snapshot = useMeetingsSnapshot();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const router = useRouter();
  const [showTranscript, setShowTranscript] = useState(false);

  const record = useMemo(
    () => snapshot.records.find((candidate) => candidate.session.id === meetingId) ?? null,
    [snapshot.records, meetingId],
  );

  if (record === null) {
    /*
      Three different answers, and collapsing any two of them tells somebody
      something false.

      **A link that does not name a meeting** is a dead end whatever this device
      holds — `isMeetingId` is the protocol's own check, and no amount of
      reading the store will turn a missing or malformed id into a recording. It
      is answered immediately, which is what `note/[...address].tsx` does for
      the same shape of dead link.

      **Loading is not absence.** For a *real* id, "that meeting is not on this
      device" is a claim nothing has checked until the store has answered — and
      it is the claim somebody opening a meeting they do have would read for as
      long as the read takes. The console learned this twice ("An absence is a
      claim, and a claim needs an answer").
    */
    if (!isMeetingId(meetingId)) {
      return (
        <ScreenScroll contentContainerStyle={styles.content}>
          <Text variant="rowSub" testID="meeting-dead-link">
            That link doesn&apos;t point at a meeting.
          </Text>
        </ScreenScroll>
      );
    }
    if (snapshot.status !== "ready") {
      return (
        <ScreenScroll contentContainerStyle={styles.content} testID="meeting-loading">
          <View style={styles.quiet} />
        </ScreenScroll>
      );
    }
    return (
      <ScreenScroll contentContainerStyle={styles.content}>
        <Text variant="rowSub" testID="meeting-missing">
          That meeting is not on this device.
        </Text>
      </ScreenScroll>
    );
  }

  const { session } = record;
  const people = attendeeCount(session.attendees);

  return (
    <ScreenScroll contentContainerStyle={styles.content} testID="meeting-note">
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to meetings"
          style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
        >
          <Icon name="chevronDown" size={20} color={colors.text2} />
        </Pressable>
      </View>

      <Text variant="paneTitle" style={styles.title}>
        {session.title}
      </Text>

      <View style={styles.metaRow}>
        <Text variant="rowSub">
          {[
            dayHeading(session.startedAt),
            duration(session.recordedMs),
            sourceLabel(session.source),
          ]
            .filter((part) => part !== "")
            .join(" · ")}
        </Text>
        {people > 0 ? (
          <>
            <View style={styles.metaDot} aria-hidden />
            <Text variant="rowSub">{`${people} ${people === 1 ? "person" : "people"}`}</Text>
          </>
        ) : null}
      </View>

      <Summary record={record} />

      <View style={styles.ownNotes} testID="meeting-own-notes">
        <View style={styles.ownNotesHead}>
          <Icon name="file" size={13} color={colors.muted} />
          <Text variant="railHead">My notes, unchanged</Text>
        </View>
        <Text style={styles.ownNotesBody}>
          {session.notes.trim() === "" ? "You didn't type anything during this one." : session.notes}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => setShowTranscript((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showTranscript }}
          accessibilityLabel={
            showTranscript ? "Hide the transcript section" : "Show the transcript section"
          }
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="meeting-transcript-toggle"
        >
          <Icon name="file" size={15} color={colors.text} />
          <Text variant="mini">Transcript</Text>
        </Pressable>

        <Pressable
          onPress={() => void meetings.retry(session.id)}
          accessibilityRole="button"
          accessibilityLabel="Run the enhancement again"
          disabled={session.state === "finalizing"}
          style={({ pressed }) => [
            styles.action,
            session.state === "finalizing" && styles.disabled,
            pressed && styles.pressed,
          ]}
          testID="meeting-rerun"
        >
          <Icon name="plus" size={15} color={colors.text} />
          <Text variant="mini">Re-run</Text>
        </Pressable>
      </View>

      {showTranscript ? <Transcript record={record} /> : null}

      <Landing record={record} />
    </ScreenScroll>
  );
}

/** The generated note, or the honest absence of one. */
function Summary({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const { session } = record;

  if (session.enhanced !== null) {
    return (
      <View style={styles.section} testID="meeting-summary">
        <Text variant="railHead">Summary</Text>
        <Text style={styles.summaryBody}>{session.enhanced}</Text>
      </View>
    );
  }

  if (session.state === "failed") {
    return (
      <View style={styles.section} testID="meeting-summary">
        <Text variant="railHead">Summary</Text>
        <Text variant="rowSub">
          {session.failureReason ??
            "The enhancement didn't run. Your own notes are below, exactly as you typed them."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section} testID="meeting-summary">
      <Text variant="railHead">Summary</Text>
      <Text variant="rowSub">
        {/*
          Deliberately not "Generating…" with a spinner. The enhancement runs at
          the gateway and this device may be the one thing between it and the
          bucket — so the sentence says which of those is outstanding rather
          than implying somebody only has to wait.
        */}
        {record.acked.finalized
          ? "Your context is writing this up. It will appear here."
          : "Waiting to reach your context. Your notes are safe on this device until it does."}
      </Text>
    </View>
  );
}

/**
 * The transcript, as a section of this note.
 *
 * One file per meeting: this is `## Transcript` in the same Markdown note the
 * path at the bottom of the screen points at, not a separate file and not a
 * separate screen.
 */
function Transcript({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const segments = record.session.transcript;

  return (
    <View style={styles.section} testID="meeting-transcript">
      <Text variant="railHead">Transcript</Text>
      {segments.length === 0 ? (
        <Text variant="rowSub">
          Nothing was transcribed for this meeting — it was a typed session.
        </Text>
      ) : (
        segments.map((segment) => (
          <Text key={segment.id} style={styles.segment}>
            {segment.speaker === null ? segment.text : `${segment.speaker}: ${segment.text}`}
          </Text>
        ))
      )}
    </View>
  );
}

/** Said under the path when the folder somebody picked was not the one used. */
export const FOLDER_REJECTED_NOTICE =
  "Your context would not file a meeting there, so this is the default folder and not the folder you chose. Move it if you want it elsewhere.";

/**
 * Where the note landed, and nothing where it has not landed.
 *
 * The path is drawn in the monospace face because it is an address in somebody
 * else's storage, and it is the one thing on this screen that is worth reading
 * character by character.
 *
 * ## A folder that was not used is said here, under the path
 *
 * `IngestAck.folderRejected` reaches the record through the drain, and this is
 * where it is spent. The gateway falls back to the default rather than losing a
 * meeting over one bad string — `meeting_invalid` is the code a client does not
 * retry, so refusing would park somebody's forty minutes — and that trade is
 * only defensible if the person is told. A fallback nobody hears about *is* the
 * destination control that appears to work and does nothing, which is the
 * defect this whole seam exists to close.
 *
 * It sits under `Saved to your bucket` rather than replacing it, because both
 * are true and the more important one is that the meeting is safe. And it does
 * not name the folder that was refused: the ack carries no copy of it, on
 * purpose, so the screen has none either — the path above says where the note
 * *is*, which is the answer somebody actually needs.
 */
function Landing({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { session } = record;

  if (record.rejection !== undefined) {
    return (
      <View style={[styles.landing, styles.landingCrit]} testID="meeting-landing">
        <Icon name="close" size={18} color={colors.crit} />
        <View style={styles.landingText}>
          <Text variant="mini" style={styles.landingCritTitle}>
            This meeting has not left the device
          </Text>
          <Text variant="rowSub">{record.rejection.message}</Text>
        </View>
      </View>
    );
  }

  if (session.notePath === null) {
    return (
      <View style={styles.landing} testID="meeting-landing">
        <Icon name="folder" size={18} color={colors.muted} />
        <View style={styles.landingText}>
          <Text variant="mini">Not in your bucket yet</Text>
          <Text variant="rowSub">
            It is kept on this device and sent as soon as your context answers.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.landing, styles.landingOk]} testID="meeting-landing">
      <Icon name="check" size={18} color={colors.ok} />
      <View style={styles.landingText}>
        <Text variant="mini" style={styles.landingOkTitle}>
          Saved to your bucket
        </Text>
        <Text style={styles.path} numberOfLines={1}>
          {session.notePath}
        </Text>
        {record.folderRejected === true ? (
          <Text variant="rowSub" testID="meeting-folder-rejected">
            {FOLDER_REJECTED_NOTICE}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /*
    No `paddingBottom` here. `ScreenScroll` applies the caller's
    `contentContainerStyle` *after* its own padding, so a bottom number typed
    here silently replaces the home-indicator inset the surface owes — which is
    the exact trap `features/app/Screen.tsx` warns about and
    `__tests__/safeArea.test.ts` caught on the first run of this screen.
  */
  content: { paddingHorizontal: layout.readingMargin, gap: 18 },
  topBar: { flexDirection: "row", marginLeft: -12, marginBottom: -6 },
  round: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  roundPressed: { backgroundColor: colors.chromePressed },
  title: { fontSize: 25, lineHeight: 30, letterSpacing: -0.75 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    flexWrap: "wrap",
  },
  metaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.heroDim },
  section: { gap: 9 },
  quiet: { height: 120 },
  summaryBody: { fontSize: 15, lineHeight: 24, color: colors.text },
  segment: { fontSize: 14.5, lineHeight: 23, color: colors.text2 },
  ownNotes: {
    borderRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
    padding: 15,
    gap: 10,
  },
  ownNotesHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  ownNotesBody: { fontSize: 14.5, lineHeight: 23, color: colors.text2 },
  actions: { flexDirection: "row", gap: 9 },
  action: {
    flex: 1,
    height: 44,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface3,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  landing: {
    borderRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  landingOk: { borderColor: colors.okBorder, backgroundColor: colors.okWash },
  landingOkTitle: { color: colors.okText },
  landingCrit: { borderColor: colors.critBorder, backgroundColor: colors.critWash },
  landingCritTitle: { color: colors.critText },
  landingText: { flex: 1, minWidth: 0, gap: 3 },
  path: {
    fontFamily: fonts.mono,
    fontSize: 11.5,
    color: colors.muted,
  },
});
