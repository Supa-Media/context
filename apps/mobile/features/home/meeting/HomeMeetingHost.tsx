import { useEffect, useRef } from "react";
import { Modal } from "react-native";
import { LiveMeetingScreen } from "../../meetings/LiveMeetingScreen";
import { RecordingBar } from "../../meetings/components/RecordingBar";
import { meetingElapsedMs, meetings } from "../../meetings/controller";
import { isLive } from "../../meetings/session";
import { useMeetingsSnapshot } from "../../meetings/useMeetings";
import { HOME_MEETINGS_WORKSPACE, HOME_MEETING_MS } from "./homeMeetings";

/**
 * The homepage's running meeting, where the console's frame has no place for
 * one: the two-minute stop, and on a phone the meeting's own screen.
 *
 * Its own component so the meetings snapshot, which changes on every word
 * transcribed and every key typed into the notes, re-renders this and not the
 * whole homepage.
 *
 * A pointer layout shows the meeting in the console's right panel and needs
 * nothing here but the stop. A phone has no panel, so it gets what the app's
 * `/meetings/<id>` route draws — `LiveMeetingScreen` over the page and the
 * floating `RecordingBar` when that is folded away — and the note opens in the
 * tree once it has been written.
 */
export function HomeMeetingHost({
  phone,
  shown,
  show,
  openNote,
  onStoppedAtLimit,
}: {
  phone: boolean;
  /** The meeting a phone is showing, or `null`. */
  shown: string | null;
  show: (meetingId: string | null) => void;
  openNote: (path: string) => void;
  onStoppedAtLimit: () => void;
}) {
  const snapshot = useMeetingsSnapshot();
  const live = snapshot.workspaceId === HOME_MEETINGS_WORKSPACE ? snapshot.live : null;

  /*
    The two-minute stop. Re-armed on every change to the live meeting, and
    counted from the meeting's own clock, so a pause pushes it back rather than
    cutting in early.
  */
  const stopped = useRef(onStoppedAtLimit);
  stopped.current = onStoppedAtLimit;
  useEffect(() => {
    if (live === null || live.session.state !== "recording") return;
    const left = HOME_MEETING_MS - meetingElapsedMs(live, Date.now());
    const timer = setTimeout(() => {
      void meetings.end();
      stopped.current();
    }, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [live]);

  const record = snapshot.records.find((candidate) => candidate.session.id === shown) ?? null;
  const showing = record !== null && isLive(record.session.state);
  const note = record?.session.notePath ?? null;
  useEffect(() => {
    if (note === null) return;
    openNote(note);
    show(null);
  }, [note, openNote, show]);

  if (!phone) return null;
  return (
    <>
      {showing ? null : <RecordingBar onOpen={show} />}
      <Modal visible={showing} animationType="slide" onRequestClose={() => show(null)}>
        {shown === null ? null : <LiveMeetingScreen meetingId={shown} onClose={() => show(null)} />}
      </Modal>
    </>
  );
}
