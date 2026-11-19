import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { nextMeeting } from "@context/meetings/scheduled";

import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { callName, startsWhen } from "../../meetings/join";
import { duration } from "../../meetings/format";
import { noteEditorHref } from "../../meetings/noteLink";
import { folderLabel, newestMeetings, pastWhenLabel, type PastMeeting } from "../../meetings/pastMeetings";
import type { CalendarEvent } from "../../meetings/protocol";
import type { MeetingRecord } from "../../meetings/record";
import { oneRowPerMeeting } from "../../meetings/resume";
import { useScheduledMeetings } from "../../meetings/scheduled";
import { useTick } from "../../meetings/useMeetings";
import { usePastMeetings, type PastWorkspace } from "../../meetings/usePastMeetings";
import { noteHref } from "../nav";
import { JoinPill, MeetingRow, OpenNoteButton, SectionHead } from "./MeetingRows";
import { NO_MEETING } from "./tabs";

/**
 * The Meetings tab when nothing is recording: Today from the calendar, Past
 * from the person's meeting notes, and nothing else (owner, 2026-11-19).
 *
 * Past is one list from two places: the meeting notes the server knows, in
 * any folder and from any device, and this device's own recordings, which
 * carry what a note cannot yet (a meeting still landing, Resume). A recording
 * whose note the server already lists is drawn once, as the recording.
 */
export function MeetingLists({
  records,
  onOpenRecord,
  onOpenNote,
  onJoin,
  pastFrom,
}: {
  records: readonly MeetingRecord[];
  onOpenRecord: (id: string) => void;
  onOpenNote: ((href: string, path: string) => void) | null;
  onJoin: ((meeting: CalendarEvent) => void) | null;
  pastFrom: readonly PastWorkspace[] | null;
}) {
  return pastFrom === null || pastFrom.length === 0 ? (
    <Lists records={records} onOpenRecord={onOpenRecord} onOpenNote={onOpenNote} onJoin={onJoin} notes={[]} />
  ) : (
    <WithNotes records={records} onOpenRecord={onOpenRecord} onOpenNote={onOpenNote} onJoin={onJoin} pastFrom={pastFrom} />
  );
}

/** Mounted only where there is a control plane to ask, so the demo and the render tests need no Convex client. */
function WithNotes(props: {
  records: readonly MeetingRecord[];
  onOpenRecord: (id: string) => void;
  onOpenNote: ((href: string, path: string) => void) | null;
  onJoin: ((meeting: CalendarEvent) => void) | null;
  pastFrom: readonly PastWorkspace[];
}) {
  const notes = usePastMeetings(props.pastFrom);
  return <Lists {...props} notes={notes} />;
}

/** Past rows drawn before Show more, and how many each press adds. */
export const PAST_SHOWN = 8;

type PastRow =
  | { kind: "note"; key: string; when: string; meeting: PastMeeting }
  | { kind: "record"; key: string; when: string; record: MeetingRecord };

function Lists({
  records,
  onOpenRecord,
  onOpenNote,
  onJoin,
  notes,
}: {
  records: readonly MeetingRecord[];
  onOpenRecord: (id: string) => void;
  onOpenNote: ((href: string, path: string) => void) | null;
  onJoin: ((meeting: CalendarEvent) => void) | null;
  /** `null` while the server has not answered. */
  notes: readonly PastMeeting[] | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const scheduled = useScheduledMeetings();
  const tick = useTick(true, 30_000);
  const now = tick === 0 ? Date.now() : tick;
  const [shown, setShown] = useState(PAST_SHOWN);

  const today = onJoin === null ? [] : scheduled.meetings.filter((m) => Date.parse(m.endsAt) > now);
  // The first one still to come, however far off: the one row whose Join shows without hover.
  const next = nextMeeting(today, now, Number.POSITIVE_INFINITY);

  const past = useMemo<PastRow[]>(() => {
    const local = oneRowPerMeeting([...records]).filter((record) => record.session.state !== "recording" && record.session.state !== "paused");
    const filed = new Set(local.map((record) => record.session.notePath).filter((path): path is string => path !== null));
    const fromNotes = newestMeetings(notes ?? [], now, 200).filter((meeting) => !filed.has(meeting.path));
    const rows: PastRow[] = [
      ...local.map((record) => ({ kind: "record" as const, key: `r:${record.session.id}`, when: record.session.startedAt, record })),
      ...fromNotes.map((meeting) => ({ kind: "note" as const, key: `n:${meeting.workspaceId}:${meeting.path}`, when: meeting.when, meeting })),
    ];
    return rows.sort((a, b) => b.when.localeCompare(a.when));
    // `now` moves every 30 s; the list only needs it for "not started yet".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, notes]);

  const empty = today.length === 0 && past.length === 0 && notes !== null && scheduled.reconnect.length === 0;

  return (
    <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
      {empty ? (
        <Text variant="rowSub" style={styles.empty} testID="aside-no-meeting">
          {NO_MEETING}
        </Text>
      ) : null}

      {today.length === 0 && scheduled.reconnect.length === 0 ? null : (
        <View style={styles.section} testID="aside-today">
          <SectionHead label="Today" />
          {today.map((meeting) => {
            const call = callName(meeting.conferenceUrl);
            const people = meeting.attendees.length;
            const detail = [call ?? "", people > 1 ? `${people} people` : ""].filter((p) => p !== "").join(" · ");
            const label = meeting.conferenceUrl === undefined ? "Take notes" : "Join";
            const join = () => onJoin?.(meeting);
            const isNext = next?.id === meeting.id;
            return (
              <MeetingRow
                key={meeting.id}
                when={startsWhen(meeting, now)}
                whenTone={isNext ? "now" : "muted"}
                title={meeting.title}
                pinned={isNext}
                onPress={join}
                accessibilityLabel={`${meeting.conferenceUrl === undefined ? "Take notes" : "Join and take notes"}: ${meeting.title}${detail === "" ? "" : `, ${detail}`}`}
                testID={`scheduled-${meeting.id}`}
                end={
                  <JoinPill
                    label={label}
                    filled={isNext}
                    onPress={join}
                    accessibilityLabel={`${meeting.conferenceUrl === undefined ? "Take notes" : "Join and take notes"}: ${meeting.title}`}
                    testID={`scheduled-join-${meeting.id}`}
                  />
                }
              />
            );
          })}
          {scheduled.reconnect.length === 0 ? null : (
            <Text variant="foot" style={styles.quiet} testID="aside-today-reconnect">
              {`Reconnect ${scheduled.reconnect.join(", ")} in Settings › Mail and calendar.`}
            </Text>
          )}
        </View>
      )}

      {past.length === 0 ? null : (
        <View style={styles.section} testID="aside-past">
          <SectionHead label="Past" />
          {past.slice(0, shown).map((row) =>
            row.kind === "note" ? (
              <NoteRow key={row.key} meeting={row.meeting} now={now} onOpenNote={onOpenNote} />
            ) : (
              <RecordRow key={row.key} record={row.record} now={now} onOpen={onOpenRecord} onOpenNote={onOpenNote} />
            ),
          )}
          {past.length <= shown ? null : (
            <Pressable
              onPress={() => setShown((n) => n + PAST_SHOWN)}
              role="button"
              accessibilityLabel="Show more past meetings"
              style={styles.more}
              testID="aside-past-more"
            >
              <Text variant="foot" style={styles.moreLabel}>
                More
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

function NoteRow({
  meeting,
  now,
  onOpenNote,
}: {
  meeting: PastMeeting;
  now: number;
  onOpenNote: ((href: string, path: string) => void) | null;
}) {
  const open = onOpenNote === null ? null : () => onOpenNote(noteHref(meeting.slug, meeting.path), meeting.path);
  const detail = [meeting.duration ?? "", meeting.folder].filter((p) => p !== "").join(" · ");
  return (
    <MeetingRow
      when={pastWhenLabel(meeting.when, now)}
      title={meeting.title}
      onPress={open}
      accessibilityLabel={`Open the note for ${meeting.title}${detail === "" ? "" : `, ${detail}`}`}
      testID={`aside-past-note-${meeting.path}`}
      end={
        open === null ? null : (
          <OpenNoteButton
            onPress={open}
            accessibilityLabel={`Open the note for ${meeting.title}`}
            testID={`aside-past-open-${meeting.path}`}
          />
        )
      }
    />
  );
}

function RecordRow({
  record,
  now,
  onOpen,
  onOpenNote,
}: {
  record: MeetingRecord;
  now: number;
  onOpen: (id: string) => void;
  onOpenNote: ((href: string, path: string) => void) | null;
}) {
  const href = noteEditorHref(record);
  const path = record.session.notePath;
  const detail = [
    record.session.recordedMs > 0 ? duration(record.session.recordedMs) : "",
    path === null ? "Not filed yet" : folderLabel(path),
  ]
    .filter((p) => p !== "")
    .join(" · ");
  return (
    <MeetingRow
      when={pastWhenLabel(record.session.startedAt, now)}
      title={record.session.title}
      onPress={() => onOpen(record.session.id)}
      accessibilityLabel={`${record.session.title}, ${detail}`}
      testID={`aside-meeting-row-${record.session.id}`}
      end={
        href === null || onOpenNote === null ? null : (
          <OpenNoteButton
            onPress={() => onOpenNote(href, path ?? "")}
            accessibilityLabel={`Open the note for ${record.session.title}`}
            testID={`aside-meeting-row-open-${record.session.id}`}
          />
        )
      }
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { paddingTop: space.x2, paddingBottom: space.x4, paddingHorizontal: space.x2, gap: space.x3 },
    empty: { color: colors.muted, paddingHorizontal: space.x2, paddingTop: space.x3 },
    section: { gap: 0, paddingTop: space.x1 },
    quiet: { color: colors.muted, paddingHorizontal: space.x2, paddingTop: space.x1 },
    more: { paddingHorizontal: space.x2, paddingVertical: space.x2, alignSelf: "flex-start" },
    moreLabel: { color: colors.muted },
  });
