import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { fonts, layout, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { writeClipboard } from "../design/clipboard";
import { meetings } from "./controller";
import { renderMeetingNote } from "./note";
import { ERRORS, isMeetingId } from "./protocol";
import { attendeeCount, dayHeading, duration, sourceLabel } from "./format";
import { pendingSteps } from "./record";
import type { MeetingRecord } from "./record";
import { MEETINGS_ROUTE } from "./route";
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
 * And the converse, which this screen got wrong until a person watched it
 * happen: **a refusal is never allowed to un-say the path.** A meeting whose
 * note is in the bucket and whose *later* write was refused is saved and
 * incomplete, not unsent; saying "This meeting has not left the device"
 * underneath a path this same screen had been printing for ten minutes is two
 * contradictory claims about one meeting, and the false one is the newer.
 * `Landing` decides on `notePath` first and says the refusal underneath.
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
  /**
   * What the last press of Copy actually did.
   *
   * Three states rather than two, and neither of the outcomes clears itself.
   * A copy is invisible — `app-and-console.md` argues that at length for the
   * share dialog — so the confirmation has to outlive the press, and a
   * *failure* that faded after a second and a half would be the silence this
   * whole branch is about. It is replaced by the next press, which is the only
   * thing that makes it stale.
   */
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const record = useMemo(
    () => snapshot.records.find((candidate) => candidate.session.id === meetingId) ?? null,
    [snapshot.records, meetingId],
  );

  /**
   * Put the whole note on the clipboard, and say which of the two happened.
   *
   * Rendered lazily rather than held in state: a forty-minute transcript is
   * tens of kilobytes, and building it on every render of a screen nobody is
   * copying from is a cost for nothing.
   */
  const copy = useCallback(() => {
    if (record === null) return;
    void (async () => {
      const ok = await writeClipboard(renderMeetingNote(record.session));
      setCopied(ok ? "copied" : "failed");
    })();
  }, [record]);

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
        {/*
          The way out of the device, and on this build the only one.

          A finished meeting can be complete, correct, on the phone and
          reachable by nothing else — the person can see it and cannot use it.
          That was every meeting once, while nothing here could reach the
          bucket; it is now the ones the queue has not landed: offline, no
          bucket connected, a refusal parked for a person to answer.

          What lands on the clipboard is `renderMeetingNote`'s output, which is
          the same function `convexGateway` writes the bucket with, so what they
          paste into their vault is the note they would have had rather than a
          screen's summary of it — byte for byte, but for the `updated` stamp,
          which is when the text was produced and cannot be the same twice.

          Drawn whatever state the meeting is in, and deliberately: a meeting
          that reached the bucket can be opened from the console, from Obsidian
          or through any connected client, and the one that has not is exactly
          the one with nowhere else to be read.
        */}
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel="Copy the whole note to the clipboard"
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="meeting-copy"
        >
          <Icon name="copy" size={15} color={colors.text} />
          <Text variant="mini">Copy note</Text>
        </Pressable>

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

      {/*
        Said, never assumed. `writeClipboard` answers a boolean precisely so a
        refusal can reach a person — its own header calls a discarded `false`
        "the small lie nobody forgives" — and a phone with no clipboard is the
        case where somebody most needs to know the text is still only here.
      */}
      {copied === "copied" ? (
        <Text variant="rowSub" testID="meeting-copy-said">
          The whole note is on your clipboard — paste it wherever you keep notes.
        </Text>
      ) : null}
      {copied === "failed" ? (
        <Text variant="error" testID="meeting-copy-said">
          Couldn&apos;t reach the clipboard on this device, so nothing was copied. The
          note is still here.
        </Text>
      ) : null}

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

/**
 * Said under the path when the folder somebody picked was not the one used.
 *
 * **It used to say "so this is the default folder", and that is only one of the
 * two cases.** `folderRejected` means "the folder you named is not where this
 * note is", which is wider than "the string you sent was malformed": the
 * gateway also sets it when the folder was perfectly legal and *a different one
 * had already been claimed* — a second finalize naming somewhere else, or a
 * retry after a failed write (`folderFlag` in `apps/mcp/src/meetings/ingest.js`,
 * and the `IngestAck` contract in `packages/meetings/src/protocol.js`). In that
 * case the note is in the folder the first finalize claimed, which is not the
 * default and not the one on screen.
 *
 * So the sentence says what is true in both: not where you chose, here instead,
 * move it if you want it elsewhere. The path above is what answers "where",
 * which is the question somebody actually has — and the notice still names no
 * folder, because the ack carries no copy of what was sent.
 */
export const FOLDER_REJECTED_NOTICE =
  "Your context did not file this meeting in the folder you chose, so this is where the note is. Move it if you want it elsewhere.";

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
 * where it is spent. For a folder the gateway will not file into it falls back
 * to the default rather than losing a meeting over one bad string —
 * `meeting_invalid` is the code a client does not retry, so refusing would park
 * somebody's forty minutes — and that trade is only defensible if the person is
 * told. A fallback nobody hears about *is* the destination control that appears
 * to work and does nothing, which is the defect this whole seam exists to close.
 *
 * The flag is **wider than that one case**, and the notice's own comment says
 * how: it is equally set when the folder was legal and the claim had already
 * reserved another. One sentence covers both because one sentence is true of
 * both — the note is not where you pointed it, and the path says where it is.
 *
 * It sits under `Saved to your bucket` rather than replacing it, because both
 * are true and the more important one is that the meeting is safe. And it does
 * not name the folder that was refused: the ack carries no copy of it, on
 * purpose, so the screen has none either — the path above says where the note
 * *is*, which is the answer somebody actually needs.
 *
 * ## A session that captured nothing is not a note that has not landed yet
 *
 * `session.notePath === null` is also true of an `empty` session, and reading
 * it as "Not in your bucket yet" would be a lie in the direction this feature
 * cannot afford: that sentence promises "sent as soon as your context
 * answers", and a session with no transcript and no typed notes will never be
 * sent — there is nothing for a gateway to write. So `empty` is checked first
 * and gets its own honest sentence, naming the reason the device gave, and a
 * way back to a fresh recording rather than a status to wait out.
 */
function Landing({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const router = useRouter();
  const { session } = record;

  if (session.state === "empty") {
    return (
      <View style={styles.landing} testID="meeting-landing">
        <Icon name="folder" size={18} color={colors.muted} />
        <View style={styles.landingText}>
          <Text variant="mini" testID="meeting-empty-reason">
            Nothing was captured: {session.emptyReason ?? "no transcript and no typed notes."}
          </Text>
          <Pressable
            onPress={() => router.push(MEETINGS_ROUTE)}
            accessibilityRole="button"
            accessibilityLabel="Record this meeting again"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="meeting-record-again"
          >
            <Icon name="plus" size={15} color={colors.text} />
            <Text variant="mini">Record again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  /*
    A REFUSAL IS SAID ABOUT WHAT WAS REFUSED, NOT ABOUT THE WHOLE MEETING.

    This branch used to run before the `notePath` one and claimed "This meeting
    has not left the device" whenever anything about the session had been
    refused. For the defect this screen was rewritten for that was flatly
    false and visibly so: the note was in the bucket, its path had been on this
    screen since the finalize landed, and then the same page started saying the
    meeting had never been sent — because *one* later write, a transcript batch
    the console had addressed to the wrong meeting, was refused. Two
    contradictory claims about one meeting, and the second was the wrong one.

    So the note's own path decides which sentence is true, and the refusal is
    said underneath rather than instead: with a path, the meeting is saved and
    something about it did not go; with no path, nothing has left. Neither
    sentence shows the person an HTTP status — `rejectionNotice` turns the
    gateway's own words into something a person can act on and keeps the
    gateway's sentence only as the last line of a fallback.
  */
  if (record.rejection !== undefined && session.notePath === null) {
    return (
      <View style={[styles.landing, styles.landingCrit]} testID="meeting-landing">
        <Icon name="close" size={18} color={colors.crit} />
        <View style={styles.landingText}>
          <Text variant="mini" style={styles.landingCritTitle}>
            This meeting has not left the device
          </Text>
          <Text variant="rowSub" testID="meeting-rejection">{rejectionNotice(record.rejection)}</Text>
        </View>
      </View>
    );
  }

  /*
    A `failed` session is not "not in your bucket *yet*" either, and for a
    sharper reason than an `empty` one: recovery's own `fail` is what puts a
    meeting here, `pendingSteps` offers a finalize only for a session in
    `finalizing`, and so nothing sends this meeting again on its own. The
    sentence says it was not filed, names the reason the badge carries, and
    the control beside it is the `failed -> finalizing` the contract has
    always allowed — the "Retry a person presses" this feature's decision
    record promises.
  */
  if (session.state === "failed") {
    return (
      <View style={[styles.landing, styles.landingCrit]} testID="meeting-landing">
        <Icon name="close" size={18} color={colors.crit} />
        <View style={styles.landingText}>
          <Text variant="mini" style={styles.landingCritTitle} testID="meeting-failed-reason">
            Not filed: {session.failureReason ?? "the finalize did not complete."}
          </Text>
          <Pressable
            onPress={() => void meetings.retryFinalize(session.id)}
            accessibilityRole="button"
            accessibilityLabel="Try filing this meeting again"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="meeting-retry-finalize"
          >
            <Icon name="plus" size={15} color={colors.text} />
            <Text variant="mini">Retry</Text>
          </Pressable>
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

  /*
    The note is in the bucket. Two things can still be true beside that, and
    each gets its own line under the path rather than replacing the tick:

     - **Something was refused.** Said here, in words, with no status code.
     - **Something has not been sent yet.** `pendingSteps` is the queue's own
       answer to "is there more of this meeting still on the device", and while
       words or typing are waiting in it this page may not imply the file is
       finished — the rule in `docs/decisions/app-and-console.md` that a UI
       never claims a write it has not seen land, applied to the writes that
       come *after* the one that created the file.

       Content steps only. A `session` step is pending on every finished
       meeting the instant its note lands, because folding the gateway's
       `written` answer changes the metadata fingerprint — so reading "anything
       pending" as "unfinished" would put this line under every meeting this
       app has ever saved, which is the crying-wolf version of the honesty it
       is here for. `segments` and `notes` are the two that mean words are
       still on the device.
  */
  const stillSending =
    record.rejection === undefined &&
    pendingSteps(record).some((step) => step.kind === "segments" || step.kind === "notes");
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
        {record.rejection !== undefined ? (
          <Text variant="rowSub" testID="meeting-rejection">
            Part of this meeting was not sent. {rejectionNotice(record.rejection)}
          </Text>
        ) : null}
        {stillSending ? (
          <Text variant="rowSub" testID="meeting-still-sending">
            The rest of this meeting is still being sent from this device.
          </Text>
        ) : null}
        {record.folderRejected === true ? (
          <Text variant="rowSub" testID="meeting-folder-rejected">
            {FOLDER_REJECTED_NOTICE}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A REFUSAL, IN WORDS SOMEBODY CAN DO SOMETHING WITH.
 *
 * What this screen showed instead was `record.rejection.message`, and for the
 * whole life of the desktop app that string was **"gateway answered 400"** —
 * `postEntry` read a `message` field this gateway does not send, so the
 * sentence explaining the refusal was parsed off the wire and dropped. A person
 * was shown a status code and no action, about their own meeting.
 *
 * The client reads `error_description` now, so the gateway's sentence does
 * arrive; this maps the codes whose recovery is a thing a *person* does, and
 * falls through to the gateway's own words for everything else. The fallback
 * is deliberately the gateway's sentence rather than a generic one: a refusal
 * this app has never seen before is exactly the one worth quoting.
 */
export function rejectionNotice(rejection: { code: string; message: string }): string {
  if (rejection.code === ERRORS.forbidden) {
    return "This machine's access to your context was refused. Connect it again from Settings.";
  }
  if (rejection.code === ERRORS.conflict) {
    return "Something else changed this meeting while it was being written. Try again.";
  }
  if (rejection.code === ERRORS.invalid) {
    return `Your context would not accept it: ${rejection.message}`;
  }
  return rejection.message;
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
