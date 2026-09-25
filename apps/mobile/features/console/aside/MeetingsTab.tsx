import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { Button } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { LiveWaveform } from "../../meetings/components/LiveWaveform";
import { MeetingTitleField } from "../../meetings/components/MeetingTitleField";
import { TransportMark } from "../../meetings/components/TransportMark";
import { writeClipboard } from "../../design/clipboard";
import { meetingElapsedMs, meetings } from "../../meetings/controller";
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
  oneRowPerMeeting,
} from "../../meetings/resume";
import { useMeetingsSnapshot, useTick } from "../../meetings/useMeetings";
import { NO_MEETING } from "./tabs";

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
}: {
  /**
   * Open a finished meeting's note in the console, by its href.
   *
   * `null` on the demo console and the fixtures, where there is no real note
   * behind it — and the row is then absent rather than pressable and inert.
   */
  onOpenNote: ((href: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
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
    <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
      <Text variant="rowSub" style={styles.empty} testID="aside-no-meeting">
        {NO_MEETING}
      </Text>
      {snapshot.records.length === 0 ? null : (
        <View style={styles.recent}>
          <Text variant="railHead" style={styles.recentHead}>
            Recent
          </Text>
          {oneRowPerMeeting(snapshot.records)
            .slice(0, RECENT)
            .map((record) => (
              <Pressable
                key={record.session.id}
                onPress={() => setOpenId(record.session.id)}
                role="button"
                accessibilityLabel={`${record.session.title}, ${meetingSubtitle(record.session)}`}
                style={styles.row}
                testID={`aside-meeting-row-${record.session.id}`}
              >
                <Text variant="rowTitle" style={styles.rowTitle} numberOfLines={1}>
                  {record.session.title}
                </Text>
                <Text variant="foot" style={styles.rowSub} numberOfLines={1}>
                  {meetingSubtitle(record.session)}
                </Text>
              </Pressable>
            ))}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * How many meetings the panel lists.
 *
 * Enough to reach the one you recorded this morning, not a list to scroll —
 * `/meetings` is the list, and it is still reachable from the switcher. A panel
 * that grows without bound beside a note is a panel that stops being a panel.
 */
const RECENT = 6;

function LiveMeeting({ record }: { record: MeetingRecord }) {
  const styles = useThemedStyles(makeStyles);
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

  return (
    <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
      <View style={styles.liveCard} testID="aside-live-meeting">
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
            testID="aside-meeting-title"
          />
        ) : (
          <Text variant="paneTitle" numberOfLines={2} testID="aside-meeting-title-static">
            {record.session.title}
          </Text>
        )}

        <View style={styles.liveHead}>
          <Dot tone={paused ? "warn" : "crit"} />
          <Text variant="mono" style={styles.liveClock} testID="aside-live-clock">
            {elapsed}
          </Text>
          {/*
            The one thing on this card that moves is the meter, and there is one
            of it — `Waveform`'s rule, which the phone's transport learned the
            hard way: a mark shaped like a meter claims to be measuring whether
            or not anything is.
          */}
          <LiveWaveform live={!paused && !ending} testID="aside-live-level" />
        </View>

        <Text variant="foot" style={styles.dest} testID="aside-live-destination">
          {record.continues !== undefined
            ? `→ ${record.continues.path}`
            : record.destination === null
              ? "Filed into your inbox when you stop."
              : `→ ${describeDestination(record.destination)}`}
        </Text>

        {ending ? (
          <Text variant="foot" style={styles.dest} testID="aside-live-ending">
            Ending — saving the last of the recording, so the end of the meeting is in the
            note.
          </Text>
        ) : null}

        <View style={styles.transport}>
          <Pressable
            onPress={paused ? () => void meetings.resume() : () => void meetings.pause()}
            role="button"
            accessibilityLabel={paused ? "Resume recording" : "Pause recording"}
            accessibilityState={{ disabled: ending }}
            disabled={ending}
            style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
            testID="aside-meeting-pause"
          >
            <TransportMark paused={paused} size={15} />
          </Pressable>

          {/*
            The pair `Button`'s own header prescribes for an action row:
            `dialogPrimary` for the default action and `dialog` for the quiet
            half, "one shape, differing only in fill". It was `white` beside
            `ghost` — the hero CTA next to a bare label — and the board showed
            exactly what that paragraph warns about: a black slab with twice
            the padding, and a Discard with no shape at all beside it.
          */}
          <Button
            label="Stop & save"
            variant="dialogPrimary"
            onPress={() => void meetings.end()}
            testID="aside-meeting-stop"
          />

          {/*
            Armed, then done. See the header: this is the only control in the
            product that destroys somebody's recording, and the second press is
            what makes the first one safe to put beside Stop.
          */}
          <Button
            label={arming ? "Discard for good" : "Discard"}
            variant="dialog"
            onPress={
              arming
                ? () => {
                    setArming(false);
                    void meetings.discard(id);
                  }
                : () => setArming(true)
            }
            testID={arming ? "aside-meeting-discard-confirm" : "aside-meeting-discard"}
          />
        </View>
      </View>

      <View style={styles.composer}>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={addNote}
          placeholder={`Add a note at ${elapsed}`}
          placeholderTextColor={colors.muted}
          style={styles.field}
          submitBehavior="submit"
          testID="aside-meeting-note-field"
        />
        <Pressable
          onPress={addNote}
          role="button"
          accessibilityLabel="Add this note to the meeting"
          style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
          testID="aside-meeting-note-add"
        >
          <Icon name="plus" size={16} color={colors.text} />
        </Pressable>
      </View>

      {record.session.notes.trim() === "" ? null : (
        <View style={styles.stream} testID="aside-meeting-notes">
          <Text variant="railHead" style={styles.recentHead}>
            Your notes
          </Text>
          <Text variant="rowSub" style={styles.notes}>
            {record.session.notes.trim()}
          </Text>
        </View>
      )}

      {record.session.transcript.length === 0 ? null : (
        <View style={styles.stream} testID="aside-meeting-transcript">
          <Text variant="railHead" style={styles.recentHead}>
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
  onOpenNote: ((href: string) => void) | null;
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
            onPress={() => onOpenNote(href)}
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
    empty: { color: colors.muted, padding: space.x4 },
    recent: { paddingHorizontal: space.x3, gap: space.x1 },
    recentHead: { color: colors.muted, paddingHorizontal: space.x1 },
    row: {
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.control,
      gap: 2,
    },
    rowTitle: { color: colors.text },
    rowSub: { color: colors.muted },
    liveCard: {
      margin: space.x3,
      padding: space.x4,
      gap: space.x2,
      borderRadius: radii.card,
      backgroundColor: colors.chrome,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    liveHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    liveClock: { color: colors.text, fontVariant: ["tabular-nums"] },
    dest: { color: colors.muted },
    transport: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    round: {
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface2,
    },
    roundPressed: { opacity: 0.7 },
    composer: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      paddingBottom: space.x2,
    },
    field: {
      flex: 1,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x3,
      borderRadius: radii.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      color: colors.text,
    },
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
