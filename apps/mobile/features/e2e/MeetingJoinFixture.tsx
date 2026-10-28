import { useEffect, useState } from "react";
import { View } from "react-native";
import { MeetingsTab } from "../console/aside/MeetingsTab";
import { NextUpRow } from "../meetings/components/NextUpRow";
import { MeetingsListScreen } from "../meetings/MeetingsListScreen";
import { meetings } from "../meetings/controller";
import type { CalendarEvent } from "../meetings/protocol";
import type { MeetingRecord } from "../meetings/record";
import { setScheduledMeetings } from "../meetings/scheduled";
import { useColors } from "../design/theme";
import { MeetingJoinSettingsView } from "../console/settings/panels/MeetingJoinSettings";
import type { AskBefore } from "../meetings/joinPreferences";

/**
 * Join and take notes, for screenshots (boards w1 and w2, 2026-10-27).
 *
 * `/e2e-fixture?screen=meeting-join&at=console|live|phone`: `console` draws the
 * sidebar's next-up row beside the Meetings tab's Today list, `live` the
 * running card with its Open Google Meet button, `phone` the meetings list,
 * `settings` the Settings › Meetings card.
 * The calendar store and the controller's snapshot are set directly: nothing
 * records and nothing reads Google.
 */
function at(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const PEOPLE = [
  { name: "Seyi", email: "seyi@example.test", self: true, via: "calendar" as const },
  { name: "Zay Okafor", email: "zay@example.test", via: "calendar" as const },
  { name: "Tomi A.", email: "tomi@example.test", via: "calendar" as const },
  { name: "Ruth", email: "ruth@example.test", via: "calendar" as const },
];

const DAY: CalendarEvent[] = [
  {
    id: "a:lw",
    title: "Supa Leadership Weekly with the whole team, the agenda and the Q4 roadmap review",
    startsAt: at(4),
    endsAt: at(64),
    attendees: PEOPLE,
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
  },
  { id: "a:zay", title: "Onboarding with Zay", startsAt: at(94), endsAt: at(124), attendees: PEOPLE.slice(0, 2), conferenceUrl: "https://acme.zoom.us/j/123" },
  { id: "b:pw", title: "Public Worship chapter leads", startsAt: at(184), endsAt: at(244), attendees: PEOPLE, conferenceUrl: "https://teams.microsoft.com/l/meetup-join/1" },
  { id: "a:ruth", title: "Dinner with Ruth", startsAt: at(334), endsAt: at(454), attendees: PEOPLE.slice(0, 1).concat(PEOPLE[3]!) },
];

export function MeetingJoinFixture({ view }: { view?: string }) {
  const colors = useColors();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setScheduledMeetings({ status: "ready", meetings: DAY, reconnect: view === "console" ? ["seyi.personal@gmail.example"] : [] });
    const live =
      view === "live"
        ? ({
            version: 1,
            workspaceId: "ws1",
            session: {
              id: "m1",
              title: DAY[0]!.title,
              state: "recording",
              startedAt: at(0),
              recordedMs: 0,
              attendees: [],
              source: { kind: "meet", url: DAY[0]!.conferenceUrl, calendarEventId: DAY[0]!.id },
              notes: "",
              transcript: [],
              notePath: null,
              enhanced: null,
              log: [],
            },
            acked: { notes: 0, transcript: 0, log: 0 },
            destination: { kind: "personalInbox", contextSlug: "seyi", folder: "inbox/meetings" },
            runningSince: at(0),
            updatedAt: 0,
            attempts: 0,
          } as unknown as MeetingRecord)
        : null;
    meetings.set({ ...meetings.snapshot, status: "ready", records: live === null ? [] : [live], live } as typeof meetings.snapshot);
    setReady(true);
  }, [view]);
  if (!ready) return null;
  if (view === "phone") return <MeetingsListScreen />;
  if (view === "settings") return <SettingsCard />;
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface, gap: 40, padding: 24 }} testID="meeting-join-fixture">
      <View style={{ width: 262, backgroundColor: colors.chrome }}>
        <NextUpRow onJoin={() => {}} />
      </View>
      <View style={{ width: 340 }}>
        <MeetingsTab onOpenNote={null} onJoin={() => {}} />
      </View>
    </View>
  );
}

function SettingsCard() {
  const colors = useColors();
  const [off, setOff] = useState<readonly string[]>(["seyi.personal.calendar.with.a.long.address@gmail.example"]);
  const [ask, setAsk] = useState<AskBefore>("1");
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, padding: 16, maxWidth: 640 }} testID="meeting-join-fixture">
      <MeetingJoinSettingsView
        calendars={["seyi@supa.example", "seyi.personal.calendar.with.a.long.address@gmail.example"]}
        off={off}
        ask={ask}
        problem={false}
        onToggle={(address, on) => setOff(on ? off.filter((entry) => entry !== address) : [...off, address])}
        onAsk={setAsk}
      />
    </View>
  );
}
