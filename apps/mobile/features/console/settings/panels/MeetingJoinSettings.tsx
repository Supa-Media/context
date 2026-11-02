import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { Card, Grow, Row } from "../../../design/components/Card";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import type { GoogleConnection } from "../../google/GoogleConnectionsCard";
import { ASK_BEFORE_OPTIONS, askBeforeKey, askBeforeMs, type AskBefore } from "../../../meetings/joinPreferences";
import { refreshScheduledMeetings } from "../../../meetings/scheduled";
import { setShellAskBefore } from "../../../meetings/shellCalendar";
import { PickMenu } from "./PickMenu";

/**
 * Settings › Meetings, Joining from the calendar (boards j1-j3, 2026-10-27):
 * which connected calendars offer "Join and take notes", and how long before
 * a meeting the Mac app asks. Kept on the account, so the phone and the Mac
 * agree. A switch shows at once and saves behind it.
 */
export function MeetingJoinSettings({ connections }: { connections: readonly GoogleConnection[] }) {
  // Nothing to read or save without a client: the demo and the render tests.
  return useConvex() === undefined ? null : <MeetingJoinSettingsLive connections={connections} />;
}

function MeetingJoinSettingsLive({ connections }: { connections: readonly GoogleConnection[] }) {
  const saved = useQuery(api.functions.meetingPreferences.myMeetingPreferences, {});
  const save = useMutation(api.functions.meetingPreferences.setMyMeetingPreferences);
  const [off, setOff] = useState<readonly string[]>([]);
  const [ask, setAsk] = useState<AskBefore>("1");
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    if (saved === undefined) return;
    setOff(saved?.calendarsOff ?? []);
    setAsk(askBeforeKey(saved === null ? 60_000 : saved.askBeforeMs));
  }, [saved]);

  function store(nextOff: readonly string[], nextAsk: AskBefore) {
    setOff(nextOff);
    setAsk(nextAsk);
    setShellAskBefore(askBeforeMs(nextAsk));
    setProblem(false);
    save({ calendarsOff: [...nextOff], askBeforeMs: askBeforeMs(nextAsk) })
      .then(() => refreshScheduledMeetings())
      .catch(() => setProblem(true));
  }

  return (
    <MeetingJoinSettingsView
      calendars={connections.filter((connection) => connection.syncServices.calendar).map((connection) => connection.email)}
      off={off}
      ask={ask}
      problem={problem}
      onToggle={(address, next) => store(next ? off.filter((entry) => entry !== address) : [...off, address], ask)}
      onAsk={(key) => store(off, key)}
    />
  );
}

/** What the card draws, with no client behind it: the live card and the screenshot fixture. */
export function MeetingJoinSettingsView({
  calendars,
  off,
  ask,
  problem,
  onToggle,
  onAsk,
}: {
  calendars: readonly string[];
  off: readonly string[];
  ask: AskBefore;
  problem: boolean;
  onToggle: (address: string, on: boolean) => void;
  onAsk: (key: AskBefore) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="eyebrow" style={styles.head}>
        Joining from your calendar
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Meetings on these calendars show Join and take notes. Nothing records until you press it.
      </Text>
      <Card>
        {calendars.length === 0 ? (
          <Row>
            <Grow>
              <Text variant="rowTitle">No calendar connected</Text>
              <Text variant="rowSub" style={styles.rowSub}>
                Connect Google in Settings › Mail and calendar to join meetings from here.
              </Text>
            </Grow>
          </Row>
        ) : (
          calendars.map((email, index) => {
            const address = email.toLowerCase();
            const on = !off.includes(address);
            return (
              <Row key={address} divided={index > 0}>
                <Grow>
                  <Text variant="rowTitle" numberOfLines={1}>
                    {email}
                  </Text>
                  <Text variant="rowSub" style={styles.rowSub}>
                    {on ? "Its meetings offer Join" : "Its meetings are not offered"}
                  </Text>
                </Grow>
                <Switch
                  value={on}
                  onValueChange={(next) => onToggle(address, next)}
                  label={`Join meetings from ${email}`}
                  testID={`meeting-join-calendar-${index}`}
                />
              </Row>
            );
          })
        )}
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Ask on the Mac</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              The Mac app asks once, with Join and take notes or Not now.
            </Text>
          </Grow>
          <PickMenu
            label={ASK_BEFORE_OPTIONS.find((option) => option.key === ask)?.label ?? "1 minute before"}
            options={ASK_BEFORE_OPTIONS}
            selected={ask}
            onPick={onAsk}
            accessibilityLabel="When the Mac app asks before a meeting"
            testID="meeting-join-ask"
          />
        </Row>
      </Card>
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="meeting-join-unsaved">
          Couldn't save that. Check your connection and try again.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginTop: space.x6 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    rowSub: { marginTop: 2 },
    problem: { marginTop: space.x2 },
  });
