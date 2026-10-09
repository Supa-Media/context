/**
 * The replay bar's clock: which stretch of time a replay covers, where the
 * playhead is, how long the replay takes to play, and the words and ticks the
 * bar draws. Pure, and in the viewer's local time, because "12:20 pm" and
 * "Tue 7 Oct" are read off a wall clock.
 *
 * A stretch is the past 24 hours, the past week (both rolling, ending at the
 * moment they were chosen), or a custom stretch picked from the history. The
 * replay takes one of three lengths whatever the stretch: the speed is the
 * stretch over that length, so a week in thirty seconds and a day in thirty
 * seconds are the same bar played at different speeds.
 *
 * The engine advances the playhead while it plays (`onTime`); this module is
 * the state the bar keeps around it. `seek` is the last place a person put the
 * playhead, and is what the engine is told: handing it every frame's position
 * back would rebuild the map sixty times a second.
 */

/** Which kind of stretch the replay covers. */
export type ReplayRange = "day" | "week" | "custom";

/** A stretch of time. `open` means it ends now, and `to` is the moment it was fixed. */
export type Stretch = { from: number; to: number; open: boolean };

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** How long a whole replay takes to play, whatever the stretch. */
export type ReplayLength = 120_000 | 30_000 | 10_000;

/** The lengths the bar offers, longest first. */
export const REPLAY_LENGTHS: readonly ReplayLength[] = [120_000, 30_000, 10_000];

export const DEFAULT_LENGTH: ReplayLength = 30_000;

/** "2 min", "30 s": the bar's own words for a length. */
export function lengthLabel(ms: number): string {
  return ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`;
}

/** "2 minutes", "30 seconds", for a screen reader. */
export function lengthSpoken(ms: number): string {
  return ms >= 60_000 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`;
}

/**
 * How long somebody stays on a replayed map after their last step. Live, ten
 * minutes of quiet means they have gone; played back over a whole stretch that
 * is seconds, and the map empties between bursts of work that were one sitting.
 * So the window grows with how much time the stretch covers: thirty minutes
 * at least, six hours at most, and about one fifty-sixth of the stretch between.
 */
export function replayIdleMs(span: number): number {
  return Math.max(30 * 60_000, Math.min(6 * HOUR_MS, span / 56));
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Midnight at the start of the day after the one `t` falls in. */
export function nextDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** The past 24 hours, or the past week: rolling, ending at `now`. */
export function rollingWindow(range: "day" | "week", now: number): Stretch {
  return { from: now - (range === "week" ? 7 * DAY_MS : DAY_MS), to: now, open: true };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12:20 pm". */
export function clockText(t: number): string {
  const d = new Date(t);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
}

/** "Tue 7 Oct". */
export function dateText(t: number): string {
  const d = new Date(t);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "7 Oct": a date without its weekday, for a strip's labels and a stretch's name. */
export function dateShort(t: number): string {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The line under the clock: "Today, Tue 7 Oct", "Yesterday, Mon 6 Oct", "Sat 4 Oct". */
export function dayText(t: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days === 0) return `Today, ${dateText(t)}`;
  if (days === 1) return `Yesterday, ${dateText(t)}`;
  return dateText(t);
}

/**
 * A stretch in words: "25 Sep – now", or "12 Aug – 3 Sep". The end is the
 * midnight a stretch stops at, so its last day is the one before.
 */
export function stretchText(stretch: Stretch): string {
  return `${dateShort(stretch.from)} – ${stretch.open ? "now" : dateShort(stretch.to - 1)}`;
}

/** "8am", "12pm". */
function hourLabel(t: number): string {
  const h = new Date(t).getHours();
  return `${h % 12 || 12}${h >= 12 ? "pm" : "am"}`;
}

export type ReplayTick = { at: number; label: string; frac: number };

/** The local midnights that fall in [from, to]. */
function dayStartsIn(from: number, to: number): number[] {
  const out: number[] = [];
  for (let day = startOfDay(from); day <= to; day = nextDay(day)) {
    if (day >= from) out.push(day);
  }
  return out;
}

/**
 * The marks along the bar. A stretch of a day and a half or less is ticked in
 * hours, every one, two, three, four or six of them, whichever keeps it to
 * seven or fewer. Up to two weeks, the start of each day is named by its
 * weekday. Longer, eight dates at most, evenly chosen from the day starts.
 */
export function replayTicks(from: number, to: number): ReplayTick[] {
  const span = to - from;
  if (span <= 0) return [];
  const out: ReplayTick[] = [];
  const add = (at: number, label: string) => out.push({ at, label, frac: (at - from) / span });
  if (span <= 36 * HOUR_MS) {
    const hours = span / HOUR_MS;
    const step = [1, 2, 3, 4, 6].find((s) => hours / s <= 7) ?? 12;
    const day = startOfDay(from);
    for (let h = 0; h <= 48; h += step) {
      const at = day + h * HOUR_MS;
      if (at < from) continue;
      if (at > to) break;
      add(at, hourLabel(at));
    }
    return out;
  }
  const days = dayStartsIn(from, to);
  if (span <= 14 * DAY_MS) {
    for (const at of days) add(at, WEEKDAYS[new Date(at).getDay()]!);
    return out;
  }
  const step = Math.ceil(days.length / 8);
  days.forEach((at, i) => {
    if (i % step === 0) add(at, dateShort(at));
  });
  return out;
}

export type ReplayState = {
  range: ReplayRange;
  from: number;
  to: number;
  /** The stretch ends now. */
  open: boolean;
  /** Where the playhead is drawn. */
  at: number;
  /** Where a person last put it: what the engine is told to jump to. */
  seek: number;
  playing: boolean;
  /** One of `REPLAY_LENGTHS`. */
  length: ReplayLength;
  /** The stretch over the length: how many stretch-milliseconds pass each real millisecond. */
  speed: number;
};

export type ReplayAction =
  | { type: "start"; range: ReplayRange; span: Stretch }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "length"; length: ReplayLength }
  | { type: "scrub"; at: number }
  /** The engine moved the playhead while playing. */
  | { type: "tick"; at: number }
  | { type: "key"; key: string; shift?: boolean };

const clampTo = (state: Pick<ReplayState, "from" | "to">, at: number) => Math.max(state.from, Math.min(state.to, at));

/** A day or less is stepped in minutes, up to two weeks in hours, longer in days; Shift steps further. */
export function keyStep(span: number, shift: boolean): number {
  if (span <= 36 * HOUR_MS) return shift ? HOUR_MS : 5 * 60_000;
  if (span <= 14 * DAY_MS) return shift ? DAY_MS : HOUR_MS;
  return shift ? 7 * DAY_MS : DAY_MS;
}

/** The speed that plays a stretch in `length`. A stretch is never shorter than a millisecond. */
export function speedFor(span: number, length: ReplayLength): number {
  return Math.max(1, span) / length;
}

/** A replay of `span` from its start, playing, at `length`. */
export function startReplay(range: ReplayRange, span: Stretch, length: ReplayLength = DEFAULT_LENGTH): ReplayState {
  return {
    range,
    from: span.from,
    to: span.to,
    open: span.open,
    at: span.from,
    seek: span.from,
    playing: true,
    length,
    speed: speedFor(span.to - span.from, length),
  };
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "start":
      return startReplay(action.range, action.span);
    case "play":
      // Play at the end starts again from the beginning.
      return state.at >= state.to ? { ...state, at: state.from, seek: state.from, playing: true } : { ...state, playing: true, seek: state.at };
    case "pause":
      return { ...state, playing: false, seek: state.at };
    case "toggle":
      return replayReducer(state, { type: state.playing ? "pause" : "play" });
    case "length":
      // Only a length the bar offers: the speed follows from it, and from the stretch.
      if (!REPLAY_LENGTHS.includes(action.length)) return state;
      return { ...state, length: action.length, speed: speedFor(state.to - state.from, action.length) };
    case "scrub": {
      const at = clampTo(state, action.at);
      return { ...state, at, seek: at };
    }
    case "tick": {
      const at = clampTo(state, action.at);
      return { ...state, at, playing: state.playing && at < state.to };
    }
    case "key": {
      const step = keyStep(state.to - state.from, !!action.shift);
      let at: number;
      if (action.key === "Home") at = state.from;
      else if (action.key === "End") at = state.to;
      else if (action.key === "ArrowLeft" || action.key === "ArrowDown") at = state.at - step;
      else if (action.key === "ArrowRight" || action.key === "ArrowUp") at = state.at + step;
      else return state;
      return replayReducer(state, { type: "scrub", at });
    }
  }
}

/** 0..1 along the bar. */
export function fractionOf(at: number, from: number, to: number): number {
  return to > from ? Math.max(0, Math.min(1, (at - from) / (to - from))) : 0;
}

/** "Replaying the past 24 hours · 30 s", "Replaying 25 Sep – now · 10 s". */
export function replayBadge(state: Pick<ReplayState, "range" | "from" | "to" | "open" | "length">): string {
  const what =
    state.range === "day" ? "the past 24 hours" : state.range === "week" ? "the past week" : stretchText(state);
  return `Replaying ${what} · ${lengthLabel(state.length)}`;
}

export type PlacedMoment = { at: number; label: string; frac: number; row: 0 | 1 };

/**
 * Where the marked moments sit over the bar: two rows of labels, each label at
 * least `minGap` of the bar's width after the one before it in its row. A
 * moment with no room in either row is left out rather than drawn over its
 * neighbour; it is still on the map, and still in the feed.
 */
export function placeMoments(
  moments: ReadonlyArray<{ at: number; label: string }>,
  from: number,
  to: number,
  minGap: number,
): PlacedMoment[] {
  // Where each row's last label ends. A label is `minGap` wide and reads
  // rightward from its dot, except in the last `minGap` of the bar, where it
  // reads leftward so it stays on the bar (`ReplayBar` draws it that way).
  const end: [number, number] = [-Infinity, -Infinity];
  const out: PlacedMoment[] = [];
  for (const m of [...moments].sort((a, b) => a.at - b.at)) {
    if (m.at < from || m.at > to) continue;
    const frac = fractionOf(m.at, from, to);
    const start = frac > 1 - minGap ? frac - minGap : frac;
    const row = start >= end[0] ? 0 : start >= end[1] ? 1 : null;
    if (row === null) continue;
    end[row] = start + minGap;
    out.push({ at: m.at, label: m.label, frac, row });
  }
  return out;
}
