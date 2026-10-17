import { useEffect, useState } from "react";
import { View } from "react-native";
import { MeetingsTab } from "../console/aside/MeetingsTab";
import { LiveMeetingScreen } from "../meetings/LiveMeetingScreen";
import { meetings } from "../meetings/controller";
import type { MeetingRecord } from "../meetings/record";
import { useColors } from "../design/theme";

/**
 * A live meeting whose call audio is missing, for screenshots of the warning.
 *
 * `/e2e-fixture?screen=meeting-card&warn=unshared|ended|desktop&at=aside|phone`.
 * The controller's snapshot is set directly: nothing records, nothing syncs.
 * The three sentences are copies of `capture/audioWeb/messages.ts` and
 * `capture/desktop.ts`, which nothing above `capture/` may import.
 */
const WARNINGS: Record<string, string> = {
  unshared: "Only your voice is being recorded.",
  ended: "Call audio stopped. Only your voice is being recorded.",
  desktop:
    "Only your voice is being recorded. Allow Context in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the meeting.",
};
export function MeetingCardFixture({ warn, at }: { warn?: string; at?: string }) {
  const colors = useColors();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const record = {
      version: 1,
      workspaceId: "ws1",
      session: {
        id: "m1",
        title: "Untitled meeting",
        state: "recording",
        startedAt: new Date(Date.now() - 22_000).toISOString(),
        recordedMs: 0,
        attendees: [],
        source: { kind: "unknown" },
        notes: "",
        transcript: [],
        notePath: null,
        enhanced: null,
        log: [],
      },
      acked: { notes: 0, transcript: 0, log: 0 },
      destination: { kind: "personalInbox", contextSlug: "seyi", folder: "0-inbox/meetings" },
      runningSince: new Date(Date.now() - 22_000).toISOString(),
      updatedAt: 0,
      attempts: 0,
    } as unknown as MeetingRecord;
    const desktop = warn === "desktop";
    meetings.set({
      ...meetings.snapshot,
      status: "ready",
      records: [record],
      live: record,
      capture: {
        audio: true,
        systemAudio: true,
        systemAudioNeedsPicker: !desktop,
        transcribesAt: "cloud",
        unavailableReason: null,
      },
      callAudioWarning: WARNINGS[warn ?? "unshared"] ?? WARNINGS.unshared,
    } as typeof meetings.snapshot);
    setReady(true);
  }, [warn]);
  if (!ready) return null;
  if (at === "phone") return <LiveMeetingScreen meetingId="m1" />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, alignItems: "flex-start" }}>
      <View style={{ width: 340 }} testID="meeting-card-fixture">
        <MeetingsTab onOpenNote={null} />
      </View>
    </View>
  );
}
