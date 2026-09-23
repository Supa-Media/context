import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import type { ConsoleData } from "../console/types";
import type { TabsState } from "../console/files/tabs";
import { densityFor } from "../app/frame";
import { useColors } from "../design/theme";
import { VoiceHostProvider, type VoiceHost } from "../voice/VoiceHost";
import { meetings } from "../meetings/controller";
import { fakeGateway } from "../meetings/fakeGateway";
import { notesOnlyRecorder } from "../meetings/capture";
import { memoryStore } from "../offline/memory";
import { saveMeeting } from "../meetings/local";
import { currentEpoch } from "../offline/epoch";
import { emptyAck, metadataFingerprint, type MeetingRecord } from "../meetings/record";
import { renderMeetingNote } from "../meetings/note";
import { PROTOCOL_VERSION } from "../meetings/protocol";
import { seedSession } from "../meetings/session";
import { useMeetingsSnapshot } from "../meetings/useMeetings";
import {
  continuationFromNote,
  continuationFromRecord,
  destinationForNote,
  mayResume,
  type NoteResumeOffer,
} from "../meetings/resume";
import { ResumeBar } from "../meetings/components/ResumeBar";
import { MeetingNoteScreen } from "../meetings/MeetingNoteScreen";
import { LiveMeetingScreen } from "../meetings/LiveMeetingScreen";

/**
 * Every surface that offers a stopped meeting back, drawn for looking at.
 *
 * Resume shipped on five surfaces at once (#849) and none of them was on any
 * browser-reachable screen: each one needs a meeting that has *stopped* on
 * this device, with a note in the bucket, less than two hours ago — a state
 * that takes a real recording and a real gateway to reach. So nobody looked at
 * them together before they merged, which is the failure `AppFrameVisualFixture`'s
 * own header names.
 *
 * `/e2e-fixture?screen=resume&surface=…` draws one of them on the shipping
 * component, over a meetings controller seeded with one filed meeting:
 *
 *  - `bar` — the console, with the floating `ResumeBar` over it.
 *  - `note` — the console with that meeting's note open, so `BrowsePane`
 *    draws its "pick this meeting back up" band. The bar is up too, because
 *    it is in the product: the note is where somebody goes after stopping.
 *  - `aside` — the console's right panel on Meetings; the harness presses the
 *    row to reach the filed meeting and its Resume button.
 *  - `page` — `MeetingNoteScreen`, the `/meetings/[id]` page of that meeting.
 *  - `live` — `LiveMeetingScreen` for the part Resume starts, with its
 *    "Part 2 · adding to …" header.
 *
 * `bar=0` takes the floating bar off the console boards, to see a surface on
 * its own.
 *
 * Everything behind it is the suite's fakes — an in-memory store, a gateway
 * with no network, the notes-only recorder that opens no device — so nothing
 * here can reach a microphone, a bucket or an account. The data is invented:
 * a "Weekly sync" in `@seyi`'s demo tree. Same `EXPO_PUBLIC_E2E_FIXTURE` gate
 * as the rest of this folder.
 *
 * The screenshot harness is `scripts/resume-shots.mjs`.
 */
export type ResumeSurface = "bar" | "note" | "aside" | "page" | "live";

export function isResumeSurface(value: string | undefined): value is ResumeSurface {
  return value === "bar" || value === "note" || value === "aside" || value === "page" || value === "live";
}

const WORKSPACE_ID = "w1";
const CONTEXT_SLUG = "seyi";
const MEETING_ID = "mtg_7k2m9p4q8r3s6t1v5wxy";
const TITLE = "Weekly sync";
const FOLDER = "1-projects/launch";
const NOTE_PATH = `${FOLDER}/2026-09-23-weekly-sync.md`;
const RECORDED_MS = 32 * 60_000;
/** Stopped this long before the board opened — inside the bar's two-hour window. */
const STOPPED_AGO_MS = 4 * 60_000;

/** The first part, as it landed: complete, filed, and stopped a few minutes ago. */
function filedMeeting(now: number): MeetingRecord {
  const endedAt = new Date(now - STOPPED_AGO_MS).toISOString();
  const startedAt = new Date(now - STOPPED_AGO_MS - RECORDED_MS - 60_000).toISOString();
  const session = {
    ...seedSession({
      id: MEETING_ID,
      version: PROTOCOL_VERSION,
      title: TITLE,
      startedAt,
      source: { kind: "in-person" },
      device: { platform: "web" },
      transcription: "on-device",
    }),
    state: "complete" as const,
    endedAt,
    recordedMs: RECORDED_MS,
    attendees: [
      { name: "Ada" },
      { name: "Tomi" },
    ],
    notes: "- launch moves to the 14th\n- Tomi owns the pricing page\n- revisit onboarding copy",
    transcript: [
      {
        id: "s1",
        startMs: 0,
        endMs: 9_000,
        text: "Okay, let's start with where the launch date landed.",
        speaker: "A",
        channel: "mic" as const,
        confidence: null,
      },
      {
        id: "s2",
        startMs: 9_500,
        endMs: 21_000,
        text: "We moved it to the fourteenth so the pricing page can ship with it.",
        speaker: "B",
        channel: "mic" as const,
        confidence: null,
      },
    ],
    enhanced:
      "Launch moves to the 14th so the pricing page ships with it. Tomi owns pricing; onboarding copy gets another pass next week.",
    notePath: NOTE_PATH,
  };
  return {
    version: 1,
    workspaceId: WORKSPACE_ID,
    session,
    acked: {
      ...emptyAck(),
      metadata: metadataFingerprint(session),
      segmentIds: session.transcript.map((segment) => segment.id),
      notes: session.notes,
      finalized: true,
    },
    destination: {
      kind: "currentPage",
      contextSlug: CONTEXT_SLUG,
      folder: FOLDER,
      label: "This folder",
    },
    runningSince: null,
    updatedAt: now,
    attempts: 0,
  };
}

/**
 * Seed the module-level controller with the filed meeting, and for `live`,
 * press Resume on it. Answers the live part's id once there is one.
 */
function useSeededMeeting(live: boolean): { ready: boolean; liveId: string | null } {
  const [state, setState] = useState<{ ready: boolean; liveId: string | null }>({
    ready: false,
    liveId: null,
  });
  useEffect(() => {
    let current = true;
    void (async () => {
      meetings.reset();
      // Durable, so the screens do not add the private-browsing warning a
      // real signed-in browser would not show.
      const store = { ...memoryStore(), durable: true };
      const record = filedMeeting(Date.now());
      await saveMeeting(store, record, currentEpoch());
      await meetings.configure({
        workspaceId: WORKSPACE_ID,
        store,
        gateway: fakeGateway(),
        recorder: notesOnlyRecorder("web"),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
      let liveId: string | null = null;
      if (live) {
        const continues = continuationFromRecord([record], record);
        if (continues !== null) {
          liveId = await meetings.continueMeeting({
            continues,
            title: TITLE,
            destination: record.destination,
          });
        }
      }
      if (current) setState({ ready: true, liveId });
    })();
    return () => {
      current = false;
      meetings.reset();
    };
  }, [live]);
  return state;
}

/** The demo tree with the meeting's folder in it, and its note open. */
function withMeetingNote(markdown: string) {
  return (data: ConsoleData): ConsoleData => {
    const files = data.files;
    const projects = files.listings["1-projects"];
    const listings = { ...files.listings };
    if (projects !== undefined) {
      listings["1-projects"] = {
        ...projects,
        entries: [
          {
            kind: "folder",
            path: FOLDER,
            name: "launch",
            visibility: "team",
            inherited: "team",
            exception: false,
            readOnly: false,
          },
          ...projects.entries,
        ],
      };
    }
    listings[FOLDER] = {
      path: FOLDER,
      folderDefault: "team",
      truncated: false,
      manifestUsable: true,
      entries: [
        {
          kind: "file",
          path: NOTE_PATH,
          name: "2026-09-23-weekly-sync.md",
          visibility: "team",
          inherited: "team",
          exception: false,
          readOnly: false,
        },
      ],
    };
    return {
      ...data,
      files: {
        ...files,
        listings,
        expanded: new Set([...files.expanded, FOLDER]),
        selectedPath: NOTE_PATH,
        editor: {
          ...files.editor,
          status: "clean",
          path: NOTE_PATH,
          baseline: markdown,
          draft: markdown,
          etag: "fixture-1",
          readOnly: false,
          encrypted: false,
          visibility: "team",
          inherited: "team",
          exception: false,
        },
      },
    };
  };
}

const MEETING_TABS: TabsState = {
  tabs: [
    { path: "1-projects/context-lc.md", preview: false, dirty: false },
    { path: NOTE_PATH, preview: false, dirty: false },
  ],
  activePath: NOTE_PATH,
  closed: [],
};

/**
 * `noteResume` as the console layout builds it (`app/(app)/console/_layout`),
 * minus the demo/canEdit gate this fixture's data would trip: the note is a
 * meeting note, the device can continue it, nothing is recording.
 */
function useNoteResume(): (path: string, markdown: string) => NoteResumeOffer | null {
  const snapshot = useMeetingsSnapshot();
  return useCallback(
    (path: string, markdown: string) => {
      if (snapshot.status !== "ready") return null;
      const found = continuationFromNote(path, markdown);
      if (found === null) return null;
      if (
        !mayResume({
          records: snapshot.records,
          live: snapshot.live,
          canContinue: snapshot.canContinue,
          meetingId: found.continues.meetingId,
        })
      ) {
        return null;
      }
      return {
        recordedMs: found.continues.offsetMs,
        part: found.continues.part,
        onResume: () =>
          void meetings.continueMeeting({
            continues: found.continues,
            title: found.title,
            destination: destinationForNote(CONTEXT_SLUG, path),
          }),
      };
    },
    [snapshot],
  );
}

function ConsoleBoard({ surface, bar }: { surface: "bar" | "note" | "aside"; bar: boolean }) {
  const phone = densityFor(useWindowDimensions().width) === "compact";
  const noteResume = useNoteResume();
  const markdown = useMemo(() => {
    const record = meetings.getSnapshot().records.find((r) => r.session.id === MEETING_ID);
    return record === undefined
      ? ""
      : renderMeetingNote(record.session, { now: record.session.endedAt ?? undefined });
  }, []);
  const voiceHost = useMemo<VoiceHost>(
    () => ({
      page: { context: null, notePath: NOTE_PATH, writable: true, noteVisibility: "team" },
      onRecordMeeting: () => {},
      createButton: !phone,
      noteResume,
    }),
    [phone, noteResume],
  );
  const shape = useMemo(
    () =>
      surface === "note" ? { data: withMeetingNote(markdown), tabs: MEETING_TABS } : undefined,
    [surface, markdown],
  );
  return (
    <View style={styles.fill}>
      <VoiceHostProvider value={voiceHost}>
        <AppFrameVisualFixture
          panel={surface === "aside"}
          fakeMeeting={false}
          onOpenNote={() => {}}
          shape={shape}
        />
      </VoiceHostProvider>
      {bar ? <ResumeBar /> : null}
    </View>
  );
}

export function ResumeFixture({ surface, bar = true }: { surface: ResumeSurface; bar?: boolean }) {
  const colors = useColors();
  const seeded = useSeededMeeting(surface === "live");
  const snapshot = useMeetingsSnapshot();
  if (!seeded.ready || snapshot.status !== "ready") return null;

  if (surface === "page" || surface === "live") {
    const id = surface === "live" ? seeded.liveId : MEETING_ID;
    return (
      <View style={[styles.fill, { backgroundColor: colors.ground }]} testID="resume-fixture">
        {id === null ? null : surface === "live" ? (
          <LiveMeetingScreen meetingId={id} />
        ) : (
          <MeetingNoteScreen meetingId={id} />
        )}
      </View>
    );
  }
  return (
    <View style={styles.fill} testID="resume-fixture">
      <ConsoleBoard surface={surface} bar={bar || surface === "bar"} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
