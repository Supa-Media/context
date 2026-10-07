/**
 * The replay bar's clock: which stretch of time Today and This week cover,
 * where the playhead is, how fast it runs, and the words and ticks the bar
 * draws. Pure, and in the viewer's local time, because "12:20 pm" and "Tue 7
 * Oct" are read off a wall clock.
 *
 * The engine advances the playhead while it plays (`onTime`); this module is
 * the state the bar keeps around it. `seek` is the last place a person put the
 * playhead, and is what the engine is told: handing it every frame's position
 * back would rebuild the map sixty times a second.
 */

export type ReplayRange = "today" | "week";

export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The stretch a replay covers, ending now. Today starts at the hour of the
 * day's first change rather than at midnight, so the bar is the working day
 * and not six empty hours; This week is the last seven days, today included.
 */
export function replayWindow(range: ReplayRange, now: number, firstAt?: number): { from: number; to: number } {
  const day = startOfDay(now);
  if (range === "week") return { from: day - 6 * DAY_MS, to: now };
  let from = day;
  if (firstAt !== undefined && firstAt > day && firstAt < now) from = firstAt - (firstAt - day) % HOUR_MS;
  return { from, to: Math.max(now, from + HOUR_MS) };
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

/** The line under the clock: "Today, Tue 7 Oct", "Yesterday, Mon 6 Oct", "Sat 4 Oct". */
export function dayText(t: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
  if (days === 0) return `Today, ${dateText(t)}`;
  if (days === 1) return `Yesterday, ${dateText(t)}`;
  return dateText(t);
}

/** "8am", "12pm". */
function hourLabel(t: number): string {
  const h = new Date(t).getHours();
  return `${h % 12 || 12}${h >= 12 ? "pm" : "am"}`;
}

export type ReplayTick = { at: number; label: string; frac: number };

/**
 * The marks along the bar: hours for a day (every one, two, three, four or six
 * of them, whichever keeps it to seven or fewer), and the start of each day for
 * a week, named by its weekday.
 */
export function replayTicks(range: ReplayRange, from: number, to: number): ReplayTick[] {
  const span = to - from;
  if (span <= 0) return [];
  const out: ReplayTick[] = [];
  const add = (at: number, label: string) => out.push({ at, label, frac: (at - from) / span });
  if (range === "week") {
    for (let day = startOfDay(from); day <= to; day += DAY_MS) {
      // Re-derive midnight each step: a day with a clock change is not 24 hours long.
      const at = startOfDay(day + HOUR_MS * 2);
      if (at >= from) add(at, WEEKDAYS[new Date(at).getDay()]!);
    }
    return out;
  }
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

export type ReplayState = {
  range: ReplayRange;
  from: number;
  to: number;
  /** Where the playhead is drawn. */
  at: number;
  /** Where a person last put it: what the engine is told to jump to. */
  seek: number;
  playing: boolean;
  speed: ReplaySpeed;
};

export type ReplayAction =
  | { type: "start"; range: ReplayRange; now: number; firstAt?: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "speed"; speed: ReplaySpeed }
  | { type: "scrub"; at: number }
  /** The engine moved the playhead while playing. */
  | { type: "tick"; at: number }
  | { type: "key"; key: string; shift?: boolean };

const clampTo = (state: Pick<ReplayState, "from" | "to">, at: number) => Math.max(state.from, Math.min(state.to, at));

/** How far one arrow press moves the playhead: a step the bar can show. */
export function keyStep(range: ReplayRange, shift: boolean): number {
  if (range === "week") return shift ? DAY_MS : HOUR_MS;
  return shift ? HOUR_MS : 5 * 60_000;
}

/** A replay of `range` ending now, from its start, playing at 60×. */
export function startReplay(range: ReplayRange, now: number, firstAt?: number): ReplayState {
  const { from, to } = replayWindow(range, now, firstAt);
  return { range, from, to, at: from, seek: from, playing: true, speed: 60 };
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "start":
      return startReplay(action.range, action.now, action.firstAt);
    case "play":
      // Play at the end starts again from the beginning.
      return state.at >= state.to ? { ...state, at: state.from, seek: state.from, playing: true } : { ...state, playing: true, seek: state.at };
    case "pause":
      return { ...state, playing: false, seek: state.at };
    case "toggle":
      return replayReducer(state, { type: state.playing ? "pause" : "play" });
    case "speed":
      return { ...state, speed: action.speed };
    case "scrub": {
      const at = clampTo(state, action.at);
      return { ...state, at, seek: at };
    }
    case "tick": {
      const at = clampTo(state, action.at);
      return { ...state, at, playing: state.playing && at < state.to };
    }
    case "key": {
      let at: number;
      if (action.key === "Home") at = state.from;
      else if (action.key === "End") at = state.to;
      else if (action.key === "ArrowLeft" || action.key === "ArrowDown") at = state.at - keyStep(state.range, !!action.shift);
      else if (action.key === "ArrowRight" || action.key === "ArrowUp") at = state.at + keyStep(state.range, !!action.shift);
      else return state;
      return replayReducer(state, { type: "scrub", at });
    }
  }
}

/** 0..1 along the bar. */
export function fractionOf(at: number, from: number, to: number): number {
  return to > from ? Math.max(0, Math.min(1, (at - from) / (to - from))) : 0;
}

/** "Replaying today · 60× speed". */
export function replayBadge(range: ReplayRange, speed: ReplaySpeed): string {
  return `Replaying ${range === "today" ? "today" : "this week"} · ${speed}× speed`;
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
