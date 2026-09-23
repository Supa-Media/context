import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { fonts, layout, leading, pointerType as t, radii, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { writeClipboard } from "../design/clipboard";
import { FOLDER_REJECTED_NOTICE, meetingLanding, rejectionNotice } from "./landing";
import { noteEditorHref } from "./noteLink";
import { NotesPad } from "./components/NotesPad";
import { meetings } from "./controller";
import { renderMeetingNote } from "./note";
import { isMeetingId } from "./protocol";
import { attendeeCount, dayHeading, duration, sourceLabel } from "./format";
import { notesOnlyOnDevice, pendingSteps } from "./record";
import type { MeetingRecord } from "./record";
import { MEETINGS_ROUTE } from "./route";
import { useMeetingsSnapshot } from "./useMeetings";
import { continuationFromRecord, mayResume, meetingIdOf } from "./resume";
import { useResumeMeeting } from "./useResumeMeeting";
import { endedAudioLine, transcriptIncompleteLine } from "./keptAudio";

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

  /*
    Stable across every render of this screen, so the pad below is never
    re-rendered by an enhancement landing or a sync settling while somebody is
    typing into it. `NotesPad`'s own header is the argument; this is the same
    `useCallback` `LiveMeetingScreen` holds, at the other end of the meeting.
  */
  const onChangeNotes = useCallback(
    (text: string) => meetings.setNotes(meetingId, text),
    [meetingId],
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
  /*
    "The note has not been written yet", said as the two states in which that
    is true. `empty` is excluded with `complete` and for the stronger reason:
    that session captured nothing and is terminal, so there is no note now and
    never will be one — a pad over it would be collecting words for a file that
    is not coming. Its own branch in `Landing` offers a new recording instead,
    which is where those words belong.
  */
  const notesEditable = session.state === "finalizing" || session.state === "failed";
  const noteHrefForRecord = noteEditorHref(record);

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

      {/*
        The title is the note's `# ` heading, so renaming a finished meeting is
        editing the note — and the first thing somebody does when they want to
        rename something is press its name. That press used to land on nothing:
        *"i can't even edit the meeting title."*

        It is a second door to the same place `Edit note` opens rather than an
        editor of its own, because `complete` is terminal and the path is
        claimed: the app cannot rename this meeting, only the note it became.
        Where there is no note to open — still finalizing, failed, empty, or a
        record with no context to address — it stays the heading it was, with
        no affordance and nothing to press.

        Renaming *before* End is the live screen's field, which is the window
        in which a rename is still the meeting's own.
      */}
      {noteHrefForRecord === null ? (
        <Text variant="paneTitle" style={styles.title} testID="meeting-title">
          {session.title}
        </Text>
      ) : (
        <Pressable
          onPress={() => router.push(noteHrefForRecord)}
          accessibilityRole="link"
          accessibilityLabel={`${session.title}. Open the note to rename it or edit it.`}
          style={({ pressed }) => pressed && styles.pressed}
          testID="meeting-title"
        >
          <Text variant="paneTitle" style={styles.title}>
            {session.title}
          </Text>
        </Pressable>
      )}

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
      {/*
        The Summary's own "still waiting" sentence covers a meeting whose note is
        being held for its audio. A meeting that is already a note, or has
        failed, has a Summary about something else — so what is still on the
        phone is said beside it rather than not at all.
      */}
      {record.session.state !== "finalizing" ? (
        <KeptAudioNote record={record} />
      ) : null}

      {/*
        THE NOTES THIS SCREEN USED TO SHOW AND NOT TAKE.

        A meeting ends and the thing you actually want is to add the two lines
        you did not have time to type while somebody was talking. This card
        printed them and offered no way in — the owner's words: *"there's no way
        to add post meeting notes."*

        **Whether it takes them is decided by whether the note exists yet**, and
        that is a correctness rule rather than a preference:

         - **Before the note is written** (`finalizing`, or `failed` and waiting
           on a retry) the note is composed *from this session* when the
           finalize runs, so what is typed here lands in the file. On the
           gateway path the same text rides the `notes` route, which accepts it
           in every state but `complete`.
         - **Once the note is in the bucket** there is nothing left that would
           ever write these words out. The gateway says so in its own refusal —
           *"this session is already complete; edit the note instead"* — and
           `createConvexGateway` has already done its one write. So the card
           goes back to being a record of what was typed, and `Landing` below
           carries the way to the note, which is the thing to edit now.

        A pad that took keystrokes into a meeting nothing will write again would
        be the appears-to-work-and-does-nothing defect this feature keeps being
        rewritten for. The one narrow seam is a keystroke landing in the seconds
        between the two, which `notesOnlyOnDevice` names and `Landing` says.
      */}
      <View style={styles.ownNotes} testID="meeting-own-notes">
        <View style={styles.ownNotesHead}>
          <Icon name="file" size={13} color={colors.muted} />
          <Text variant="railHead">{notesEditable ? "My notes" : "My notes, unchanged"}</Text>
        </View>
        {notesEditable ? (
          <NotesPad
            initialValue={session.notes}
            onChangeText={onChangeNotes}
            placeholder="Add what you did not have time to type…"
            style={styles.ownNotesPad}
            testID="meeting-own-notes-pad"
          />
        ) : (
          <Text style={styles.ownNotesBody}>
            {session.notes.trim() === "" ? "You didn't type anything during this one." : session.notes}
          </Text>
        )}
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


/** Audio of this meeting still on the phone, for a meeting past `finalizing`. */
function KeptAudioNote({ record }: { record: MeetingRecord }) {
  const snapshot = useMeetingsSnapshot();
  const line = endedAudioLine(
    snapshot.audio[record.session.id],
    snapshot.offline,
    record.session.state,
  );
  if (line === null) return null;
  return (
    <Text variant="rowSub" testID="meeting-audio-kept">
      {line}
    </Text>
  );
}

/** The generated note, or the honest absence of one. */
function Summary({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
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

          **Three outstanding things now, not two**, and the new one is first
          because it is the one a person is most likely to be looking at.
          Splitting `recorder.stop()` from `recorder.drain()` ends the meeting
          the moment End is pressed and moves the transcription wait behind it,
          which is what stopped the clock running over a finished meeting — and
          it left this screen saying the only thing it had for a meeting with no
          note yet: *"Waiting to reach your context."* True, and not the answer.
          Nothing is wrong with the connection; the last of the audio is still
          being turned into words, and the finalize is held on purpose until it
          is, so the note is not written without the end of the meeting. Telling
          somebody about a network problem they do not have is the same defect
          as telling them nothing, one sentence further on.
        */}
        {endedAudioLine(snapshot.audio[session.id], snapshot.offline, session.state) ??
        (snapshot.transcribing === session.id
          ? "Still turning the last of the audio into words. The note is written once they are in."
          : record.acked.finalized
            ? "Your context is writing this up. It will appear here."
            : "Waiting to reach your context. Your notes are safe on this device until it does.")}
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
  const snapshot = useMeetingsSnapshot();
  const segments = record.session.transcript;
  /*
    Audio of this meeting still on the phone means this transcript is not the
    whole meeting yet, and it says so above the words rather than letting a
    short transcript pass for a short meeting. "A typed session" below would be
    false outright while there is audio waiting.
  */
  const incomplete = transcriptIncompleteLine(snapshot.audio[record.session.id]);

  return (
    <View style={styles.section} testID="meeting-transcript">
      <Text variant="railHead">Transcript</Text>
      {incomplete === null ? null : (
        <Text variant="rowSub" testID="meeting-transcript-incomplete">
          {incomplete}
        </Text>
      )}
      {segments.length === 0 ? (
        incomplete === null ? (
          <Text variant="rowSub">
            Nothing was transcribed for this meeting — it was a typed session.
          </Text>
        ) : null
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

/** The folder notice, said by both surfaces; it lives in `landing.ts`. */
export { FOLDER_REJECTED_NOTICE } from "./landing";

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
  const snapshot = useMeetingsSnapshot();
  const resume = useResumeMeeting();
  const { session } = record;
  const href = noteEditorHref(record);
  /*
    Pick it back up, on the page of a meeting that is in the bucket — the
    same rules the bar and the note ask (`resume.ts`), so this is offered for
    as long as the meeting exists and never while a part of it is still on
    its way or anything is recording.
  */
  const continues =
    session.state === "complete" &&
    mayResume({
      records: snapshot.records,
      live: snapshot.live,
      canContinue: snapshot.canContinue,
      meetingId: meetingIdOf(record),
    })
      ? continuationFromRecord(snapshot.records, record)
      : null;

  /*
    WHICH OF THESE IS TRUE IS NOT THIS SCREEN'S TO DECIDE.

    The branch order below — path first, then nothing-captured, then a refusal,
    then a failed finalize — used to be written out here in JSX, in a file that
    imports `expo-router`. The console's Meetings panel could not import a line
    of it, so it grew a second and much worse vocabulary for the same states:
    one sentence, *"This meeting has not been written to your context yet"*,
    for all of them, with nothing to press. `landing.ts` is that order and
    those sentences, pure, and both surfaces read it. What stays here is the
    *drawing* — the icons, the tone, and the two controls that are this
    screen's rather than the rule's.
  */
  const landing = meetingLanding(record);

  if (landing?.kind === "empty") {
    return (
      <View style={styles.landing} testID="meeting-landing">
        <Icon name="folder" size={18} color={colors.muted} />
        <View style={styles.landingText}>
          <Text variant="mini" testID="meeting-empty-reason">
            {landing.title}
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
    `NOTHING_CAPTURED` reaching the sync queue is the same fact as `empty`
    arriving by a different road, so it is drawn the same way — same icon, same
    neutral tone, same absence of a Retry. "This meeting has not left the
    device" would be true in the narrow sense that nothing was sent, and reads
    as a meeting waiting to depart, which is the retry-forever framing this
    branch exists to avoid. What it does not get is Record again: the recording
    exists, and `empty`'s offer would be a second one over the top of it.
  */
  if (landing?.kind === "nothing-captured") {
    return (
      <View style={styles.landing} testID="meeting-landing">
        <Icon name="folder" size={18} color={colors.muted} />
        <View style={styles.landingText}>
          <Text variant="mini" testID="meeting-rejection">
            {landing.title}
          </Text>
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

    That order is now `meetingLanding`'s, which answers `null` for anything
    with a path; the refusal is said underneath the tick instead, further down.

    THE RETRY IS NEW, AND IT IS THE HALF THIS BRANCH WAS MISSING.

    `rejectionNotice` has always ended these sentences with something to *do*
    — connect the machine again, answer the conflict — and then this screen
    offered no way to say "done, try it now". The only press that reaches
    `retrySync` was the header's **Re-run**, labelled for the enhancement,
    which is not what somebody who has just reconnected a machine goes looking
    for. `retrySync` clears `rejection` on the way through for exactly this.
  */
  if (landing?.kind === "refused") {
    return (
      <View style={[styles.landing, styles.landingCrit]} testID="meeting-landing">
        <Icon name="close" size={18} color={colors.crit} />
        <View style={styles.landingText}>
          <Text variant="mini" style={styles.landingCritTitle}>
            {landing.title}
          </Text>
          <Text variant="rowSub" testID="meeting-rejection">{landing.detail}</Text>
          <Pressable
            onPress={() => void meetings.retry(session.id)}
            accessibilityRole="button"
            accessibilityLabel="Try sending this meeting again"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="meeting-retry-sync"
          >
            <Icon name="plus" size={15} color={colors.text} />
            <Text variant="mini">Retry</Text>
          </Pressable>
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
  if (landing?.kind === "failed") {
    return (
      <View style={[styles.landing, styles.landingCrit]} testID="meeting-landing">
        <Icon name="close" size={18} color={colors.crit} />
        <View style={styles.landingText}>
          <Text variant="mini" style={styles.landingCritTitle} testID="meeting-failed-reason">
            {landing.title}
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

  if (landing !== null) {
    return (
      <View style={styles.landing} testID="meeting-landing">
        <Icon name="folder" size={18} color={colors.muted} />
        <View style={styles.landingText}>
          <Text variant="mini">{landing.title}</Text>
          <Text variant="rowSub">{landing.detail}</Text>
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
        {/*
          THE WAY IN, WHICH IS THE ANSWER TO "HOW DO I EDIT ANY OF THIS".

          `complete` is terminal by the contract and deliberately so: *"once the
          note is in the customer's bucket, the note is the meeting and it is
          edited as a note"*. That is a good decision and it was missing its
          other half — the app printed the address and offered no door, so the
          title, the summary, the notes and the transcript were all visibly
          there and all read-only, on a screen whose whole point is that the
          meeting is now a file the customer owns.

          This is that door, and it is the console's ordinary file page rather
          than a meetings-only editor: one editor, one set of conflict rules,
          one audit trail. A deep link, not a share — `noteHref`'s own header —
          so it grants nothing and shows the note only to somebody whose
          membership already reaches it.

          Drawn only when this device can address the note: the path is the
          gateway's and the context is the destination the recording was
          started with, and a record from a build before destinations existed
          has none. No slug, no honest link — so no button, rather than one
          that guesses a context and opens somebody else's.
        */}
        {continues === null ? null : (
          <Pressable
            onPress={() =>
              void resume({ continues, title: session.title, destination: record.destination })
            }
            accessibilityRole="button"
            accessibilityLabel="Resume recording this meeting, into the same note"
            style={({ pressed }) => [styles.action, styles.resume, pressed && styles.pressed]}
            testID="meeting-resume"
          >
            <Icon name="undo" size={15} color={colors.ground} />
            <Text variant="mini" style={styles.resumeLabel}>
              Resume recording
            </Text>
          </Pressable>
        )}
        {href === null ? null : (
          <Pressable
            onPress={() => router.push(href)}
            accessibilityRole="button"
            accessibilityLabel="Open this meeting's note to edit it"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="meeting-edit-note"
          >
            <Icon name="file" size={15} color={colors.text} />
            <Text variant="mini">Edit note</Text>
          </Pressable>
        )}
        {notesOnlyOnDevice(record) ? (
          <Text variant="rowSub" testID="meeting-notes-stranded">
            What you typed after this was written up is on this device only —
            {href === null
              ? " open the note in your context to add it."
              : " open the note to add it."}
          </Text>
        ) : null}
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

/** A refusal in words somebody can act on; it lives in `landing.ts`. */
export { rejectionNotice } from "./landing";

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
  title: {
    fontSize: t.h2,
    lineHeight: leading(t.h2, 1.2),
    letterSpacing: tracking(t.h2, -0.03),
  },
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
  summaryBody: { fontSize: t.lede, lineHeight: 24, color: colors.text },
  segment: { fontSize: t.lede, lineHeight: 23, color: colors.text2 },
  ownNotes: {
    borderRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
    padding: 15,
    gap: 10,
  },
  ownNotesHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  ownNotesBody: { fontSize: t.lede, lineHeight: 23, color: colors.text2 },
  /*
    `NotesPad` in a card rather than as the screen: no `flex: 1` (this sits in
    a scroll view, where a flexing child has no height to take), no reading
    margin (the card's own padding is the margin here), and a floor so the
    control reads as something to type into rather than as one blank line.
    Everything about the *text* is left to the pad — the human's notes look the
    same wherever they are typed.
  */
  ownNotesPad: {
    flex: undefined,
    minHeight: 92,
    paddingHorizontal: 0,
    paddingTop: 0,
    fontSize: t.lede,
    lineHeight: 23,
  },
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
  /* Teal, never red: picking a meeting back up is a continuation, not a repair. */
  resume: { backgroundColor: colors.accent, borderColor: colors.accent },
  resumeLabel: { color: colors.ground, fontWeight: "600" },
  path: {
    fontFamily: fonts.mono,
    fontSize: t.label,
    color: colors.muted,
  },
});
