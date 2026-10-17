import { useEffect, useState } from "react";
import { View } from "react-native";
import { MeetingsTab } from "../console/aside/MeetingsTab";
import { BrowserCallAudio } from "../console/settings/panels/MeetingsPanel";
import { LiveMeetingScreen } from "../meetings/LiveMeetingScreen";
import { CallAudioPrimer } from "../meetings/components/CallAudioPrimer";
import { noteCallAudioShare, publishRecorderSplit } from "../meetings/capture";
import { meetings } from "../meetings/controller";
import type { MeetingRecord } from "../meetings/record";
import { useColors } from "../design/theme";

/**
 * A live meeting's card in each call-audio state, for screenshots.
 *
 * `/e2e-fixture?screen=meeting-card&warn=<state>&at=aside|phone`, where state
 * is `ok` (both sides heard, meters moving), `unshared`, `ended`, `desktop`,
 * `skipped`, `room`, `cannot` (a browser that can never share sound),
 * `primer` (the first-time note) or `settings` (the Settings › Meetings row
 * for a browser that stopped being asked). The controller's snapshot is set
 * directly: nothing records, nothing syncs. The sentences are copies of
 * `capture/audioWeb/messages.ts` and `capture/desktop.ts`, which nothing
 * above `capture/` may import.
 */
const WARNINGS: Record<string, string> = {
  unshared: "Only your voice is being recorded.",
  ended: "Call audio stopped. Only your voice is being recorded.",
  desktop:
    "Only your voice is being recorded. Allow Context in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the meeting.",
};
const NOTES: Record<string, { kind: "skipped" | "room"; message: string }> = {
  skipped: {
    kind: "skipped",
    message: "Recording your voice only. Arc didn't share call audio the last two times.",
  },
  room: { kind: "room", message: "Recording the room." },
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
        title: "Onboarding with Zay and the whole leadership team",
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
    const cannot = warn === "cannot";
    meetings.set({
      ...meetings.snapshot,
      status: "ready",
      records: [record],
      live: record,
      capture: {
        audio: true,
        systemAudio: !cannot,
        systemAudioNeedsPicker: !desktop && !cannot,
        transcribesAt: "cloud",
        unavailableReason: null,
      },
      callAudioWarning: warn === undefined ? WARNINGS.unshared : (WARNINGS[warn] ?? null),
      callAudioNote: NOTES[warn ?? ""] ?? null,
    } as typeof meetings.snapshot);
    if (warn === "settings") for (let i = 0; i < 2; i += 1) noteCallAudioShare(false);
    setReady(true);
  }, [warn]);

  // Something to draw on the two lines: a voice on You, and on Call when heard.
  useEffect(() => {
    if (!ready) return;
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      const wave = (phase: number) => 0.35 + 0.3 * Math.abs(Math.sin(tick / 3 + phase));
      publishRecorderSplit({ you: wave(0), call: warn === "ok" ? wave(1.7) : null });
    }, 100);
    return () => clearInterval(timer);
  }, [ready, warn]);

  if (!ready) return null;
  if (warn === "primer") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }} testID="meeting-card-fixture">
        <CallAudioPrimer onContinue={() => {}} onRoom={() => {}} onClose={() => {}} />
      </View>
    );
  }
  if (warn === "settings") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface, padding: 40 }}>
        <View style={{ width: 600 }} testID="meeting-card-fixture">
          <BrowserCallAudio />
        </View>
      </View>
    );
  }
  if (at === "phone") return <LiveMeetingScreen meetingId="m1" />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, alignItems: "flex-start" }}>
      <View style={{ width: 340 }} testID="meeting-card-fixture">
        <MeetingsTab onOpenNote={null} />
      </View>
    </View>
  );
}
