import { useAudioLevel } from "../capture";
import { Waveform } from "./Waveform";

/**
 * The meter, and the only thing in this app that subscribes to a level.
 *
 * It exists as its own component for one reason and it is a load-bearing one:
 * `LiveMeetingScreen`'s whole promise is that **nothing moves while you type**,
 * and a level arriving ten times a second into that component's own state
 * would re-render the screen — the head, the chips, the transport — at 10Hz for
 * the life of every meeting. Subscribed here, the re-render stops at this leaf.
 * `NotesPad` is memoised on a stable callback and never learns a meter exists;
 * `meetingsTyping.test.ts` is the check that keeps it that way.
 *
 * `live` is the screen's own fact — an input is open **and** this build can
 * actually capture — and it is what makes "not recording" flat and grey rather
 * than flat and green. See `Waveform` for the three states.
 */
export function LiveWaveform({
  live,
  size,
  testID,
}: {
  /** An input is genuinely open right now. Paused counts as closed. */
  live: boolean;
  size?: number;
  testID?: string;
}) {
  const level = useAudioLevel(live);
  return (
    <Waveform
      tone={live ? "ok" : "muted"}
      live={live}
      level={level}
      size={size}
      testID={testID}
    />
  );
}
