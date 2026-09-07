import { StyleSheet, View } from "react-native";
import { useColors } from "../../design/theme";

/**
 * The five bars that mean "this is live" — and, when something is listening,
 * how loud it is.
 *
 * Drawn from `View`s for the reason `features/design/components/Icon.tsx`
 * gives — a glyph is 17px wide in one face and 10.6 in another — and kept here
 * rather than added to `ICON_NAMES` because that set's own rule is "add an icon
 * when a control needs it, in the same change as the control", and this is not
 * an icon: it is a state, drawn at two sizes, in two tones, with a fixed
 * silhouette.
 *
 * ## It used to be static, and the argument for that was right until it was not
 *
 * This file said the heights were fixed and gave three reasons: a level-driven
 * bar is a second continuous source of re-renders on the one screen whose whole
 * promise is that nothing moves while you type; nothing in this build was
 * listening; and *"a meter that responds to sound is a capability claim"*.
 *
 * The second of those stopped being true — the desktop shell reads an
 * `AnalyserNode` and pushes a level over the bridge — and the third turns out
 * to cut the other way, which is what the owner found by losing an evening to
 * it. He concluded his microphone was dead, because the one control a person
 * reads as *"it can hear me"* looked **identical** whether the microphone was
 * live, denied, or nothing was running at all: *"the bar is still not moving.
 * And I can't tell that it can hear me talking."* A decoration in the shape of
 * a meter is a capability claim too. It is just one nobody can check.
 *
 * The first reason survives intact and is answered by where the subscription
 * lives rather than by refusing to animate: `LiveWaveform` is the only thing
 * that subscribes, so a level ten times a second re-renders **this leaf** and
 * not the screen around it. `NotesPad` never learns that a meter exists.
 *
 * ## The three states, which is the whole requirement
 *
 * A person has to be able to tell these apart at a glance, and before this they
 * could not tell any of them apart at all:
 *
 *  - **nothing is listening** (`live={false}`) — a flat, muted row at
 *    `WAVEFORM_IDLE`. Flat is **correct** here rather than broken, and it is
 *    drawn as a deliberate baseline in the muted tone so it reads that way.
 *  - **listening, and the room is quiet** (`live`, `level` at or near 0) — a
 *    flat row too, but at `WAVEFORM_FLOOR`, which is more than twice as tall,
 *    and in the live tone. "Live but quiet" is a state of its own, and it is the
 *    one the old mark could not say.
 *  - **listening, and it can hear you** (`live`, `level` above 0) — the
 *    silhouette, scaled by the level between the floor and full height. This is
 *    the one that moves with a voice.
 *
 * A fourth case is not a state so much as an absence: `level === null` is a
 * surface that has no meter to give — a phone, a browser, a shell older than
 * the level channel — and it draws the static silhouette it always did. Saying
 * "silent" there would be the invented fact this repo has shipped twice.
 *
 * `paused` dims it rather than replacing it, because the shape is what carries
 * "this is a recording" and swapping in a different mark for two seconds of
 * pause makes the bar flicker between two identities.
 */

/**
 * The mark's fixed profile, as fractions of `size`.
 *
 * The silhouette is the same at every size — the property `icons.test.ts`
 * asserts of every drawing in the icon set — and it is the same shape the
 * static version drew, so nothing about the app's resting appearance moved.
 */
export const WAVEFORM_SILHOUETTE: readonly number[] = Object.freeze([
  0.375, 0.8125, 0.5625, 1, 0.4375,
]);

/** How tall the bars sit when nothing is listening. A baseline, not a meter. */
export const WAVEFORM_IDLE = 0.12;

/**
 * ...and when something is, in a room with nothing in it.
 *
 * The gap between this and `WAVEFORM_IDLE` is the whole of what tells a person
 * their microphone is open in a silent room, so it is a wide gap on purpose:
 * two and a half times the height, in a different tone.
 */
export const WAVEFORM_FLOOR = 0.3;

export interface WaveformProfile {
  /** One fraction of `size` per bar. Never below `WAVEFORM_IDLE`. */
  fractions: readonly number[];
  /** Whether an input is genuinely open, which is what picks the tone. */
  live: boolean;
}

/**
 * The bar heights, as a pure function — so the three states are checkable
 * without a renderer, a theme or a bridge.
 */
export function waveformProfile({
  live = true,
  level = null,
}: {
  live?: boolean;
  level?: number | null;
} = {}): WaveformProfile {
  if (!live) {
    return { fractions: WAVEFORM_SILHOUETTE.map(() => WAVEFORM_IDLE), live: false };
  }
  // Nothing can report a level here — a phone, a browser, an older shell. The
  // mark says "recording" and declines to say anything about loudness.
  if (level === null || !Number.isFinite(level)) {
    return { fractions: [...WAVEFORM_SILHOUETTE], live: true };
  }
  const heard = Math.min(1, Math.max(0, level));
  return {
    fractions: WAVEFORM_SILHOUETTE.map(
      (fraction) => WAVEFORM_FLOOR + (1 - WAVEFORM_FLOOR) * heard * fraction,
    ),
    live: true,
  };
}

export function Waveform({
  tone = "ok",
  size = 16,
  paused = false,
  live = true,
  level = null,
  testID,
}: {
  /** `ok` while recording, `muted` when paused or when nothing is listening. */
  tone?: "ok" | "muted";
  /** The tallest bar, in points. The rest are fractions of it. */
  size?: number;
  paused?: boolean;
  /**
   * Whether an input is actually open.
   *
   * Defaults to `true`, which is what the two call sites that use this mark as
   * a *glyph* — the pause button and the recording bar — have always meant by
   * drawing it at all.
   */
  live?: boolean;
  /** 0–1 from something that is really listening, or `null` for no meter. */
  level?: number | null;
  testID?: string;
}) {
  const colors = useColors();
  // A dead input is drawn muted whatever the caller asked for: "flat and grey"
  // is the honest reading of nothing being open, and "flat and green" is the
  // bar that cost somebody an evening.
  const color = tone === "ok" && live ? colors.ok : colors.muted;
  /*
    `paused` is not read here, and that is deliberate. It dims and mutes, which
    is what it has always done for the two call sites that use this mark as a
    glyph — and a paused *meter* is not listening, so its caller says so with
    `live={false}` and gets the flat baseline rather than a bar frozen at
    whatever the room was doing when somebody pressed pause.
  */
  const profile = waveformProfile({ live, level });

  return (
    <View style={[styles.row, { height: size }]} aria-hidden testID={testID}>
      {profile.fractions.map((fraction, index) => (
        <View
          key={index}
          style={[
            styles.bar,
            {
              height: Math.max(2, Math.round(size * fraction)),
              backgroundColor: color,
              opacity: paused ? 0.45 : 1,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 2.5 },
  bar: { width: 2.5, borderRadius: 2 },
});
