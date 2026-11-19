import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { Button } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { CallAudioWarning } from "../../meetings/components/CallAudioWarning";
import { LiveMeters } from "../../meetings/components/LiveMeters";
import { MeetingTitleField } from "../../meetings/components/MeetingTitleField";
import { TransportMark } from "../../meetings/components/TransportMark";
import { OpenCallButton } from "../../meetings/components/OpenCallButton";
import type { CalendarEvent } from "../../meetings/protocol";
import { writeClipboard } from "../../design/clipboard";
import { meetingElapsedMs, meetings } from "../../meetings/controller";
import { safeJoinUrl } from "@context/meetings/scheduled";
import { describeDestination } from "../../meetings/destination";
import { clock, meetingSubtitle } from "../../meetings/format";
import { meetingLanding } from "../../meetings/landing";
import { renderMeetingNote } from "../../meetings/note";
import { noteEditorHref } from "../../meetings/noteLink";
import type { MeetingRecord } from "../../meetings/record";
import { UNTITLED_MEETING } from "../../meetings/session";
import { appendTypedNote } from "../../meetings/typedNote";
import {
  continuationFromRecord,
  mayResume,
  meetingIdOf,
} from "../../meetings/resume";
import { useMeetingsSnapshot, useTick } from "../../meetings/useMeetings";
import { MeetingLists } from "./MeetingLists";
import type { PastWorkspace } from "../../meetings/usePastMeetings";
import { useFieldFont } from "../../design/fieldFont";

/**
 * The Meetings tab: a meeting you can work in, not a window onto one.
 *
 * ## What changed, and why the tab grew
 *
 * This used to be three facts and a press that took you away — the title, the
 * clock, and a card that navigated to `/meetings/:id`, which is a full page
 * that replaced whatever note you were reading. The owner's reading of that
 * page is the reason this exists: *"meetings should stop opening up in the big
 * ugly page and only open up in the side panel"*.
 *
 * So everything the live screen holds that is worth 330pt of column is here:
 * the name, the clock, the meter, where the note is going, the notes somebody
 * types while it runs, and the two controls that end it. The note stays open
 * beside it, which is the whole point — a meeting is a thing that happens
 * *next to* your work rather than instead of it.
 *
 * ## What is deliberately not here
 *
 * **A second notepad.** `NotesPad` on the meeting's own screen is a page to
 * write in; this is a composer that takes one line at a time and stamps it with
 * the meeting's clock (`typedNote.ts`). The two write to the same `notes`, so
 * there is one copy of what the human typed and no merge.
 *
 * **A rename or a note composer on a *finished* meeting.** A meeting that has
 * been filed is a Markdown file in somebody's bucket, and the console already
 * has an editor for those — the one behind this panel. Offering a second, worse
 * editor here would be writing to a record whose note has already been written,
 * which is how a rename ends up in a local record and never in the file. The
 * finished meeting offers **Open the note** instead, which is the console doing
 * what it is for.
 *
 * ## Discard asks twice, because nothing else in this product destroys anything
 *
 * `controller.discard` is "the only path that destroys a recording" and until
 * now it had no caller at all. A one-press Discard 12pt from Stop, on a control
 * somebody reaches for in a hurry, is the wrong shape for the one irreversible
 * button in the app — so the press arms it and the second press does it, in
 * place, with the sentence in the label.
 */
export function MeetingsTab({
  onOpenNote,
  onJoin = null,
  pastFrom = null,
}: {
  /**
   * Open a finished meeting's note in the console, by its href.
   *
   * `null` on the demo console and the fixtures, where there is no real note
   * behind it — and the row is then absent rather than pressable and inert.
   */
  onOpenNote: ((href: string, path: string) => void) | null;
  /** Join and take notes, for today's meetings on the calendar. `null` where there is none. */
  onJoin?: ((meeting: CalendarEvent) => void) | null;
  /**
   * The workspaces whose meeting notes the Past list reads, from the server.
   * `null` on the demo console and the fixtures, which have no control plane:
   * Past then lists this device's recordings alone.
   */
  pastFrom?: readonly PastWorkspace[] | null;
}) {
  const snapshot = useMeetingsSnapshot();
  const live = snapshot.live;
  const [openId, setOpenId] = useState<string | null>(null);

  /*
    The meeting being read, or `null`. Looked up rather than held, so a record
    that is discarded or finalized under the panel cannot leave a stale copy on
    screen; `openId` is the only state and it names a meeting rather than
    holding one.
  */
  const opened = useMemo(
    () => snapshot.records.find((record) => record.session.id === openId) ?? null,
    [snapshot.records, openId],
  );

  /*
    Stop & save leaves the panel on the meeting that just ended, not on the
    list — the rule `RecordingBar.end` follows on the phone, where a note that
    vanished the moment it was saved read as a note that was lost. It is also
    what puts Resume one row below where Stop was pressed.
  */
  const lastLive = useRef<string | null>(null);
  const liveId = live?.session.id ?? null;
  useEffect(() => {
    if (liveId === null && lastLive.current !== null) setOpenId(lastLive.current);
    lastLive.current = liveId;
  }, [liveId]);

  if (live !== null) return <LiveMeeting record={live} />;

  if (opened !== null) {
    return (
      <PastMeeting
        record={opened}
        onBack={() => setOpenId(null)}
        onOpenNote={onOpenNote}
      />
    );
  }

  return (
    <MeetingLists
      records={snapshot.records}
      onOpenRecord={setOpenId}
      onOpenNote={onOpenNote}
      onJoin={onJoin}
      pastFrom={pastFrom}
    />
  );
}


function LiveMeeting({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const colors = useColors();
  const snapshot = useMeetingsSnapshot();
  const id = record.session.id;
  const paused = record.session.state === "paused";
  const ending = snapshot.ending === id;
  const now = useTick(true);
  const elapsed = clock(meetingElapsedMs(record, now === 0 ? Date.now() : now));

  const [typed, setTyped] = useState("");
  const [arming, setArming] = useState(false);

  /*
    Stable across every render of this card, which is what keeps the title field
    from re-rendering while the clock ticks under it — `MeetingTitleField` is
    uncontrolled and memoised on exactly this callback, and the panel re-renders
    once a second for the whole of a meeting.
  */
  const onChangeTitle = useCallback((text: string) => meetings.setTitle(id, text), [id]);

  const addNote = useCallback(() => {
    /*
      The meeting's clock, not this part's: a note typed 4s into a resumed
      meeting belongs at 31:08, beside the transcript it was typed under.
    */
    const at = meetingElapsedMs(record, Date.now());
    const next = appendTypedNote(record.session.notes, typed, at);
    if (next === record.session.notes) return;
    meetings.setNotes(id, next);
    setTyped("");
  }, [id, record, typed]);

  /*
    No card, one quiet line of transport (owner, 2026-11-19: "restyle the
    sidebar once you actually join a meeting"). The clock and the controls
    that end it share the top line; the name reads whole under it; where the
    call is and where the note goes are one line of text; the meters sit side
    by side; and the note composer is a field with a rule over it rather than
    a boxed input beside a round button. Every control and test id the card
    had is still here, so what each press reaches is unchanged.
  */
  const where =
    record.continues !== undefined
      ? record.continues.path
      : record.destination === null
        ? "Inbox when you stop"
        : describeDestination(record.destination);
  return (
    <ScrollView contentContainerStyle={styles.liveBody} testID="aside-meetings">
      <View style={styles.live} testID="aside-live-meeting">
        <View style={styles.liveTop}>
          <Dot tone={paused ? "warn" : "crit"} />
          <Text variant="mono" style={styles.liveClock} testID="aside-live-clock">
            {elapsed}
          </Text>
          <View style={styles.grow} />
          {/*
            Armed, then done: this is the only control in the product that
            destroys somebody's recording, so the first press only changes
            its own words, and the second press does it.
          */}
          <Pressable
            onPress={
              arming
                ? () => {
                    setArming(false);
                    void meetings.discard(id);
                  }
                : () => setArming(true)
            }
            role="button"
            accessibilityLabel={arming ? "Discard for good" : "Discard"}
            style={styles.discard}
            testID={arming ? "aside-meeting-discard-confirm" : "aside-meeting-discard"}
          >
            <Text variant="rowSub" style={arming ? styles.discardArmed : styles.discardLabel}>
              {arming ? "Discard for good" : "Discard"}
            </Text>
          </Pressable>
          <Pressable
            onPress={paused ? () => void meetings.resume() : () => void meetings.pause()}
            role="button"
            accessibilityLabel={paused ? "Resume recording" : "Pause recording"}
            accessibilityState={{ disabled: ending }}
            disabled={ending}
            style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
            testID="aside-meeting-pause"
          >
            <TransportMark paused={paused} size={12} />
          </Pressable>
          <Pressable
            onPress={() => void meetings.end()}
            role="button"
            accessibilityLabel="Stop & save"
            style={({ pressed }) => [styles.stop, pressed && styles.roundPressed]}
            testID="aside-meeting-stop"
          >
            <View style={styles.stopMark} />
            <Text variant="mini" style={styles.stopLabel}>
              Stop
            </Text>
          </Pressable>
        </View>

        {/*
          Not renameable when this is a later part of a meeting: it is added to
          a note whose heading it keeps. `LiveMeetingScreen` has the argument.
        */}
        {record.continues === undefined ? (
          <MeetingTitleField
            key={id}
            initialValue={record.session.title}
            onChangeText={onChangeTitle}
            placeholder={UNTITLED_MEETING}
            compact
            testID="aside-meeting-title"
          />
        ) : (
          <Text variant="rowTitle" numberOfLines={3} testID="aside-meeting-title-static">
            {record.session.title}
          </Text>
        )}

        <View style={styles.metaLine}>
          {/*
            A meeting joined from the calendar in a browser: the share prompt
            spent the press, so the call is offered here once notes are running
            (board w2), as a link in the line rather than a slab.
          */}
          <OpenCallButton session={record.session} link testID="aside-open-call" />
          {safeCall(record) ? (
            <Text variant="rowSub" style={styles.dest}>
              ·
            </Text>
          ) : null}
          <Text variant="rowSub" style={styles.dest} numberOfLines={1} testID="aside-live-destination">
            {where}
          </Text>
        </View>

        {/*
          You and Call: seeing the call move is how somebody knows the other
          side is being heard (board m3, 2026-10-17).
        */}
        <LiveMeters live={!paused && !ending} inline testID="aside-live-level" />

        {ending ? (
          <Text variant="foot" style={styles.dest} testID="aside-live-ending">
            Saving the end of the recording…
          </Text>
        ) : null}

        <CallAudioWarning testID="aside-call-audio-warning" />
      </View>

      <View style={styles.composer}>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={addNote}
          placeholder={`Add a note at ${elapsed}…`}
          placeholderTextColor={colors.muted}
          style={[styles.field, fieldFont]}
          submitBehavior="submit"
          testID="aside-meeting-note-field"
        />
        {typed.trim() === "" ? null : (
          <Pressable
            onPress={addNote}
            role="button"
            accessibilityLabel="Add this note to the meeting"
            style={({ pressed }) => [styles.addNote, pressed && styles.roundPressed]}
            testID="aside-meeting-note-add"
          >
            <Icon name="enter" size={14} color={colors.text2} />
          </Pressable>
        )}
      </View>

      {record.session.notes.trim() === "" ? null : (
        <View style={styles.liveStream} testID="aside-meeting-notes">
          <Text variant="rowSub" style={styles.streamHead}>
            Your notes
          </Text>
          <Text variant="rowSub" style={styles.notes}>
            {record.session.notes.trim()}
          </Text>
        </View>
      )}

      {record.session.transcript.length === 0 ? null : (
        <View style={styles.liveStream} testID="aside-meeting-transcript">
          <Text variant="rowSub" style={styles.streamHead}>
            Transcript
          </Text>
          {record.session.transcript.slice(-TRANSCRIPT_LINES).map((segment) => (
            <Text key={segment.id} variant="rowSub" style={styles.segment}>
              {segment.speaker === null ? segment.text : `${segment.speaker} — ${segment.text}`}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

/** Whether the meeting has a call link the line names, so the dot between it and the folder is drawn. */
function safeCall(record: MeetingRecord): boolean {
  return safeJoinUrl(record.session.source?.url ?? null) !== null;
}

/**
 * The tail of the transcript, not the whole of it.
 *
 * The file is where a transcript is read; this is the panel saying words are
 * arriving. Rendering forty minutes of segments into a column beside a note is
 * a scroll position that fights the person every time a segment lands.
 */
const TRANSCRIPT_LINES = 12;

function PastMeeting({
  record,
  onBack,
  onOpenNote,
}: {
  record: MeetingRecord;
  onBack: () => void;
  onOpenNote: ((href: string, path: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const href = noteEditorHref(record);
  const snapshot = useMeetingsSnapshot();
  /*
    Resume, beside Open the note, on the rules `resume.ts` holds. Only where
    the note opens too: `onOpenNote` is `null` on the demo console and the
    fixtures, which have no recorder behind them either.

    The controller directly rather than `useResumeMeeting`: the part is shown
    by this tab, which draws the live meeting the moment there is one, so there
    is nowhere to navigate to — and that hook's router is a dependency this
    panel's render tests do not carry. A second press finds the first part
    live and is refused by `continueMeeting` itself.
  */
  const continues =
    onOpenNote !== null &&
    record.session.state === "complete" &&
    mayResume({
      records: snapshot.records,
      live: snapshot.live,
      canContinue: snapshot.canContinue,
      meetingId: meetingIdOf(record),
    })
      ? continuationFromRecord(snapshot.records, record)
      : null;

  return (
    <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
      <Pressable
        onPress={onBack}
        role="button"
        accessibilityLabel="Back to all meetings"
        style={styles.back}
        testID="aside-meeting-back"
      >
        <Text variant="foot" style={styles.backLabel}>
          ‹ All meetings
        </Text>
      </Pressable>

      <View style={styles.pastHead}>
        <Text variant="paneTitle" role="heading" aria-level={2}>
          {record.session.title}
        </Text>
        <Text variant="foot" style={styles.rowSub}>
          {meetingSubtitle(record.session)}
        </Text>
        {record.session.notePath === null ? null : (
          <Text variant="mono" style={styles.dest} testID="aside-meeting-path">
            {record.session.notePath}
          </Text>
        )}
      </View>

      {record.session.enhanced === null ? null : (
        <View style={styles.stream} testID="aside-meeting-summary">
          <Text variant="railHead" style={styles.recentHead}>
            Summary
          </Text>
          <Text variant="rowSub" style={styles.notes}>
            {record.session.enhanced}
          </Text>
        </View>
      )}

      {record.session.notes.trim() === "" ? null : (
        <View style={styles.stream}>
          <Text variant="railHead" style={styles.recentHead}>
            Your notes
          </Text>
          <Text variant="rowSub" style={styles.notes}>
            {record.session.notes.trim()}
          </Text>
        </View>
      )}

      {/*
        The note, in the editor behind this panel — which is where a filed
        meeting is renamed and added to, because by then it is a Markdown file
        like any other. `null` while the note has not landed yet, rather than a
        button that opens nothing.
      */}
      {href === null || onOpenNote === null ? (
        <Stranded record={record} />
      ) : (
        <View style={styles.pastActions}>
          {/*
            The live card's pair, so the row reads as the same transport one
            state later: Stop & save was here, and Resume is its quiet half,
            marked with the record dot rather than a colour of its own.
          */}
          <Button
            label="Open the note"
            variant="dialogPrimary"
            onPress={() => onOpenNote(href, record.session.notePath ?? "")}
            testID="aside-meeting-open-note"
          />
          {continues === null ? null : (
            <Button
              label="Resume"
              variant="dialog"
              leading={<Dot tone="crit" />}
              accessibilityLabel="Resume recording this meeting"
              onPress={() =>
                void meetings.continueMeeting({
                  continues,
                  title: record.session.title,
                  destination: record.destination,
                })
              }
              testID="aside-meeting-resume"
            />
          )}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * A MEETING THAT DID NOT LAND, AND WHAT TO DO ABOUT IT.
 *
 * This was one sentence — *"This meeting has not been written to your context
 * yet"* — for every one of the states below, with nothing beside it. The owner
 * recorded 31 minutes, opened it here, read that, and asked "how do I get
 * it???". The sentence was true and it was the whole of the panel's answer.
 *
 * Every fact drawn here already existed on `/meetings/:id`; what was missing
 * was this surface reaching it. So the classification and the words come from
 * `landing.ts`, which both screens read — a panel deciding for itself is how
 * one surface ended up offering nothing for states the other has always
 * offered a Retry for.
 *
 * ## Copy note, on this surface too
 *
 * A meeting can be complete, correct, on the device and reachable by nothing
 * else — no bucket connected, a refusal parked for a person to answer, a
 * finalize that will not go. When it is, the clipboard is the whole of what
 * somebody can do about it, and what lands there is `renderMeetingNote`'s
 * output: the same function `convexGateway` writes the bucket with, so what
 * they paste into their vault is the note they would have had rather than this
 * panel's summary of one.
 *
 * Drawn only where there is no note to open. A filed meeting has a path, and
 * the answer for that one is the editor behind this panel.
 *
 * ## `copied` is about one meeting, and nothing has to key it to keep it that way
 *
 * Worth checking rather than assuming, because `openId` names a meeting rather
 * than holding one and `record` is swapped underneath `PastMeeting`: a "copied"
 * message that survived the swap would be a claim about the wrong meeting. It
 * cannot, because the only way to reach another one from here is Back, and that
 * sets `openId` to `null` and unmounts this whole subtree on the way. A `key`
 * here would be a guard over a path that does not exist — and one no test could
 * fail, which is the same thing as no guard at all.
 */
function Stranded({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
  const landing = meetingLanding(record);
  const [copied, setCopied] = useState<"idle" | "copied" | "refused">("idle");

  const copy = useCallback(() => {
    void (async () => {
      const ok = await writeClipboard(renderMeetingNote(record.session));
      setCopied(ok ? "copied" : "refused");
    })();
  }, [record.session]);

  /*
    `null` is the meeting whose note *is* in the bucket and whose link this
    panel could not build — a record from a build before `destination` existed
    has no slug, and `noteEditorHref` refuses to guess one rather than open the
    right path in somebody else's context. The path is still the answer to
    "where is it", and `PastMeeting` has already printed it above.
  */
  const title = landing?.title ?? "This meeting is in your context, but this device cannot address it.";
  const detail = landing?.detail ?? "Its path is above — open it from any client connected to that context.";

  return (
    <View style={styles.landing} testID="aside-meeting-landing">
      <Text variant="foot" style={styles.landingTitle} testID="aside-meeting-landing-title">
        {title}
      </Text>
      {detail === null ? null : (
        <Text variant="foot" style={styles.dest}>
          {detail}
        </Text>
      )}

      <View style={styles.landingActions}>
        {landing?.retry == null ? null : (
          <Button
            label="Retry"
            variant="accent"
            onPress={
              landing.retry === "finalize"
                ? () => void meetings.retryFinalize(record.session.id)
                : () => void meetings.retry(record.session.id)
            }
            testID="aside-meeting-retry"
          />
        )}
        <Button
          label="Copy note"
          variant="dialog"
          onPress={copy}
          testID="aside-meeting-copy"
        />
      </View>

      {/*
        Said, never assumed. `writeClipboard` answers a boolean precisely so a
        refusal can reach a person, and a phone with no clipboard is where
        somebody most needs to know the text is still only on the device.
      */}
      {copied === "idle" ? null : (
        <Text variant="foot" style={styles.dest} testID="aside-meeting-copy-said">
          {copied === "copied"
            ? "The whole note is on your clipboard — paste it wherever you keep notes."
            : "Couldn't reach the clipboard. The note is still on this device."}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { paddingBottom: space.x4 },
    liveBody: { paddingBottom: space.x4, paddingHorizontal: space.x4, paddingTop: space.x2 },
    live: { gap: space.x2 },
    liveTop: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    grow: { flex: 1 },
    discard: { paddingHorizontal: space.x1, paddingVertical: space.x1 },
    discardLabel: { color: colors.muted },
    discardArmed: { color: colors.critText, fontWeight: "600" },
    stop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 28,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      backgroundColor: colors.white,
    },
    stopMark: { width: 8, height: 8, borderRadius: 1.5, backgroundColor: colors.ink },
    stopLabel: { color: colors.ink },
    metaLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    addNote: { width: 28, height: 28, borderRadius: radii.md, alignItems: "center", justifyContent: "center" },
    streamHead: { color: colors.muted },
    recentHead: { color: colors.muted, paddingHorizontal: space.x1 },
    rowSub: { color: colors.muted },
    liveClock: { color: colors.text, fontVariant: ["tabular-nums"] },
    dest: { color: colors.muted },
    round: {
      width: 28,
      height: 28,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    roundPressed: { opacity: 0.7 },
    composer: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      marginTop: space.x4,
      paddingTop: space.x1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    field: {
      flex: 1,
      minHeight: 36,
      paddingHorizontal: 0,
      color: colors.text,
      outlineWidth: 0,
      outlineStyle: "none" as never,
    },
    liveStream: { paddingTop: space.x3, gap: 2 },
    stream: { paddingHorizontal: space.x4, paddingTop: space.x2, gap: space.x1 },
    notes: { color: colors.text2 },
    segment: { color: colors.muted },
    back: { paddingHorizontal: space.x4, paddingTop: space.x3 },
    backLabel: { color: colors.accentText },
    pastHead: { paddingHorizontal: space.x4, paddingTop: space.x2, gap: 2 },
    pastActions: {
      paddingHorizontal: space.x4,
      paddingTop: space.x3,
      flexDirection: "row",
      gap: space.x2,
    },
    landing: { paddingHorizontal: space.x4, paddingTop: space.x3, gap: space.x1 },
    landingTitle: { color: colors.text },
    landingActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      flexWrap: "wrap",
      paddingTop: space.x1,
    },
  });
