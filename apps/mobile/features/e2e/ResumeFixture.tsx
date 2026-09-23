import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import type { ConsoleData } from "../console/types";
import type { TabsState } from "../console/files/tabs";
import { densityFor } from "../app/frame";
import { useColors } from "../design/theme";
import { VoiceHostProvider, type VoiceHost } from "../voice/VoiceHost";
import { CreatePrompt } from "../console/files/Dialogs";
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
import { continuationFromRecord, resumeRowFor } from "../meetings/resume";
import { MeetingNoteScreen } from "../meetings/MeetingNoteScreen";
import { LiveMeetingScreen } from "../meetings/LiveMeetingScreen";

/**
 * Every surface that offers a stopped meeting back, drawn for looking at.
 *
 * Resume first shipped on five surfaces (#849) and none of them was on any
 * browser-reachable screen: each one needs a meeting that has *stopped* on
 * this device, with a note in the bucket, less than two hours ago — a state
 * that takes a real recording and a real gateway to reach. So nobody looked at
 * them together before they merged, which is the failure `AppFrameVisualFixture`'s
 * own header names. The redesign that followed has two places, and this draws
 * both at both densities.
 *
 * `/e2e-fixture?screen=resume&surface=…` draws one of them on the shipping
 * component, over a meetings controller seeded with one filed meeting:
 *
 *  - `menu` — the `+` and its Resume meeting row: `CreateButton`'s menu at a
 *    pointer density (the harness presses the `+`), `CreatePrompt`'s sheet on
 *    a phone. With the meeting's note open, so the row reads "Adds to this
 *    note."; `note=0` leaves the demo note open instead, and the row names the
 *    meeting that just stopped.
 *  - `aside` — the console's right panel on Meetings; the harness presses the
 *    row to reach the filed meeting and its Resume button.
 *  - `page` — `MeetingNoteScreen`, the `/meetings/[id]` page of that meeting,
 *    with its record disc.
 *  - `live` — `LiveMeetingScreen` for the part Resume starts, whose clock
 *    carries on from the first part.
 *
 * Everything behind it is the suite's fakes — an in-memory store, a gateway
 * with no network, the notes-only recorder that opens no device — so nothing
 * here can reach a microphone, a bucket or an account. The data is invented:
 * a "Weekly sync" in `@seyi`'s demo tree. Same `EXPO_PUBLIC_E2E_FIXTURE` gate
 * as the rest of this folder.
 *
 * The screenshot harness is `scripts/capture-resume-shots.mjs`.
 */
export type ResumeSurface = "menu" | "aside" | "page" | "live";

export function isResumeSurface(value: string | undefined): value is ResumeSurface {
  return value === "menu" || value === "aside" || value === "page" || value === "live";
}

const WORKSPACE_ID = "w1";
const CONTEXT_SLUG = "seyi";
const MEETING_ID = "mtg_7k2m9p4q8r3s6t1v5wxy";
const TITLE = "Weekly sync";
const FOLDER = "1-projects/launch";
const NOTE_PATH = `${FOLDER}/2026-09-23-weekly-sync.md`;
const RECORDED_MS = 32 * 60_000;
/** Stopped this long before the board opened — inside the `+` row's two-hour window. */
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
 * The `+`'s row as `console/_layout` builds it (`resumeRowFor`), minus the
 * demo/canEdit gate this fixture's data would trip.
 */
function useResumeRow(markdown: string | null): { detail: string; onResume: () => void } | null {
  const snapshot = useMeetingsSnapshot();
  return useMemo(() => {
    const row = resumeRowFor({
      records: snapshot.records,
      live: snapshot.live,
      canContinue: snapshot.canContinue,
      now: Date.now(),
      openNote:
        markdown === null ? null : { contextSlug: CONTEXT_SLUG, path: NOTE_PATH, markdown },
    });
    return row === null
      ? null
      : { detail: row.detail, onResume: () => void meetings.continueMeeting(row.input) };
  }, [snapshot, markdown]);
}

function ConsoleBoard({ surface, noteOpen }: { surface: "menu" | "aside"; noteOpen: boolean }) {
  const phone = densityFor(useWindowDimensions().width) === "compact";
  const markdown = useMemo(() => {
    const record = meetings.getSnapshot().records.find((r) => r.session.id === MEETING_ID);
    return record === undefined
      ? ""
      : renderMeetingNote(record.session, { now: record.session.endedAt ?? undefined });
  }, []);
  const withNote = surface === "menu" && noteOpen;
  const resume = useResumeRow(withNote ? markdown : null);
  const voiceHost = useMemo<VoiceHost>(
    () => ({
      page: { context: null, notePath: NOTE_PATH, writable: true, noteVisibility: "team" },
      onRecordMeeting: () => {},
      createButton: !phone,
    }),
    [phone],
  );
  const shape = useMemo(
    () => (withNote ? { data: withMeetingNote(markdown), tabs: MEETING_TABS } : undefined),
    [withNote, markdown],
  );
  return (
    <View style={styles.fill}>
      <VoiceHostProvider value={voiceHost}>
        <AppFrameVisualFixture
          panel={surface === "aside"}
          fakeMeeting={false}
          onOpenNote={() => {}}
          shape={shape}
          resume={resume}
        />
      </VoiceHostProvider>
      {/*
        The phone's `+` is the bottom row's key, which raises this sheet; drawn
        open here, because pressing a key in a fixture with no bottom row has
        nothing to press.
      */}
      {surface === "menu" && phone ? (
        <CreatePrompt
          folder={FOLDER}
          canEdit
          onCancel={() => {}}
          onCreateNote={() => {}}
          onCreateDrawing={() => {}}
          onCreateFolder={() => {}}
          onNewMeeting={() => {}}
          onNewChat={() => {}}
          onResumeMeeting={resume}
        />
      ) : null}
    </View>
  );
}

export function ResumeFixture({
  surface,
  noteOpen = true,
}: {
  surface: ResumeSurface;
  noteOpen?: boolean;
}) {
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
      <ConsoleBoard surface={surface} noteOpen={noteOpen} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
