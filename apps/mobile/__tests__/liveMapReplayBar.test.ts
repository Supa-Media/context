/**
 * THE REPLAY BAR'S CLOCK, AND THE SIDEBAR'S COUNTS WHILE THE MAP IS OPEN.
 *
 * A replay covers a stretch of time: the past 24 hours, the past week, or a
 * custom stretch picked from the history. The stretch is fixed when the replay
 * starts, so a rolling window ends at the moment it was chosen. A replay takes
 * one of three lengths (2 minutes, 30 seconds or 10 seconds) whatever the
 * stretch is, and the speed follows from the two. The bar is a slider: arrows
 * step it, play stops at the end and starts again from the beginning, and the
 * clock reads as a wall clock does. The sidebar's top-folder counts follow the
 * playhead. Times are built in local time so the suite reads the same in any
 * timezone.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { actorsAt, folderCountsAt } from "../features/console/map/live/engine";
import { mapFolderCount, setMapFolderCounts } from "../features/console/map/live/mapCounts";
import {
  DAY_MS,
  DEFAULT_LENGTH,
  HOUR_MS,
  REPLAY_LENGTHS,
  clockText,
  dayText,
  fractionOf,
  keyStep,
  lengthLabel,
  lengthSpoken,
  placeMoments,
  replayBadge,
  replayIdleMs,
  replayReducer,
  replayTicks,
  rollingWindow,
  startReplay,
  stretchText,
  type ReplayLength,
  type ReplayState,
  type Stretch,
} from "../features/console/map/live/replayClock";
import { tickLabels } from "../features/console/map/live/ui/zoomTicks";
import { ev, para } from "./liveMapFixture";

const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m).getTime();
const dayOf = (month: number, day: number) => new Date(2026, month, day).getTime();
/** A stretch of the working day, from 8am to 6pm, ending now. */
const workday: Stretch = { from: at(8), to: at(18), open: true };

describe("the clock reads as a wall clock", () => {
  test("12-hour times and the day under them", () => {
    expect(clockText(at(12, 20))).toBe("12:20 pm");
    expect(clockText(at(8, 5))).toBe("8:05 am");
    expect(clockText(at(0, 0))).toBe("12:00 am");
    expect(dayText(at(12, 20), at(18))).toBe("Today, Wed 7 Oct");
    expect(dayText(at(12, 20, 6), at(18))).toBe("Yesterday, Tue 6 Oct");
    expect(dayText(at(12, 20, 3), at(18))).toBe("Sat 3 Oct");
  });

  test("a stretch is named in plain words: a date and now, or two dates", () => {
    expect(stretchText({ from: dayOf(8, 25), to: at(18), open: true })).toBe("25 Sep – now");
    // The end is the midnight the stretch stops at, so its last day is the one before.
    expect(stretchText({ from: dayOf(7, 12), to: dayOf(8, 4), open: false })).toBe("12 Aug – 3 Sep");
  });

  test("the badge says what is replaying, and how long it takes", () => {
    const now = at(18, 20);
    const rolling = (range: "day" | "week", length: ReplayLength) => ({ ...rollingWindow(range, now), range, length });
    expect(replayBadge(rolling("day", 30_000))).toBe("Replaying the past 24 hours · 30 s");
    expect(replayBadge(rolling("week", 120_000))).toBe("Replaying the past week · 2 min");
    expect(replayBadge({ range: "custom", from: dayOf(8, 25), to: now, open: true, length: 10_000 })).toBe(
      "Replaying 25 Sep – now · 10 s",
    );
  });
});

describe("the three lengths a replay takes", () => {
  test("2 minutes, 30 seconds and 10 seconds, the default 30 seconds, for every range", () => {
    expect(REPLAY_LENGTHS).toEqual([120_000, 30_000, 10_000]);
    expect(DEFAULT_LENGTH).toBe(30_000);
    for (const range of ["day", "week", "custom"] as const) {
      expect(startReplay(range, workday).length).toBe(30_000);
    }
  });

  test("the speed is the stretch over the length, computed when the length is chosen", () => {
    const s = startReplay("day", workday);
    expect(s.speed).toBe((10 * HOUR_MS) / 30_000);
    const two = replayReducer(s, { type: "length", length: 120_000 });
    expect(two).toMatchObject({ length: 120_000, speed: (10 * HOUR_MS) / 120_000 });
    expect(replayReducer(two, { type: "length", length: 10_000 }).speed).toBe((10 * HOUR_MS) / 10_000);
  });

  test("a week at its shortest length runs at the speed the stretch over the length says", () => {
    const week = startReplay("week", rollingWindow("week", at(18)));
    expect(replayReducer(week, { type: "length", length: 10_000 }).speed).toBe((7 * DAY_MS) / 10_000);
  });

  test("a length the bar does not offer is refused, and a new replay starts at the default", () => {
    const s = startReplay("day", workday);
    expect(replayReducer(s, { type: "length", length: 60_000 as ReplayLength })).toBe(s);
    const changed = replayReducer(s, { type: "length", length: 10_000 });
    expect(replayReducer(changed, { type: "start", range: "day", span: workday }).length).toBe(30_000);
  });

  test("the bar names them in plain words, for a screen reader as well", () => {
    expect(REPLAY_LENGTHS.map(lengthLabel)).toEqual(["2 min", "30 s", "10 s"]);
    expect(REPLAY_LENGTHS.map(lengthSpoken)).toEqual(["2 minutes", "30 seconds", "10 seconds"]);
  });
});

describe("what a stretch is, and how long people stay on it", () => {
  test("the past 24 hours and the past week end now and roll with the clock", () => {
    const now = at(18, 20);
    expect(rollingWindow("day", now)).toEqual({ from: now - DAY_MS, to: now, open: true });
    expect(rollingWindow("week", now)).toEqual({ from: now - 7 * DAY_MS, to: now, open: true });
  });

  test("the idle window scales with the stretch: thirty minutes for a day, three hours for a week", () => {
    expect(replayIdleMs(DAY_MS)).toBe(30 * 60_000);
    expect(replayIdleMs(7 * DAY_MS)).toBe(3 * HOUR_MS);
    // Clamped at both ends.
    expect(replayIdleMs(HOUR_MS)).toBe(30 * 60_000);
    expect(replayIdleMs(365 * DAY_MS)).toBe(6 * HOUR_MS);
  });

  test("a day's replay keeps somebody half an hour after their last step", () => {
    // Somebody working in bursts: a step at 12:00 and the next at 12:40.
    const NOTE = "1-projects/launch.md";
    const events = [ev.edit(at(12), "ws-a", NOTE), ev.edit(at(12, 40), "ws-a", NOTE)];
    expect(actorsAt(events, at(12, 20), replayIdleMs(DAY_MS)).map((a) => a.name)).toEqual(["Maya"]);
    expect(actorsAt(events, at(13, 20), replayIdleMs(DAY_MS))).toEqual([]);
  });

  test("a week's keeps them three hours, so a sped-up week is not an empty map", () => {
    const NOTE = "1-projects/launch.md";
    const events = [ev.edit(at(12), "ws-a", NOTE), ev.edit(at(12, 40), "ws-a", NOTE)];
    expect(actorsAt(events, at(15), replayIdleMs(7 * DAY_MS))).toHaveLength(1);
    expect(actorsAt(events, at(16), replayIdleMs(7 * DAY_MS))).toEqual([]);
  });
});

describe("the ticks along the bar", () => {
  test("hours for a stretch of a day and a half or less, at most seven of them", () => {
    expect(replayTicks(at(8), at(18)).map((t) => t.label)).toEqual(["8am", "10am", "12pm", "2pm", "4pm", "6pm"]);
    expect(replayTicks(at(9), at(12)).map((t) => t.label)).toEqual(["9am", "10am", "11am", "12pm"]);
  });

  test("a rolling day from the afternoon is ticked in hours across two dates", () => {
    const ticks = replayTicks(at(14, 0, 6), at(14, 0, 7));
    expect(ticks.map((t) => t.label)).toEqual(["4pm", "8pm", "12am", "4am", "8am", "12pm"]);
  });

  test("up to two weeks, the start of each day by its weekday", () => {
    const week = replayTicks(at(0, 0, 1), at(18));
    expect(week.map((t) => t.label)).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
    expect(week[0]!.frac).toBe(0);
    for (const tick of week) expect(tick.frac).toBeGreaterThanOrEqual(0);
  });

  test("longer than that, the dates, at most eight, evenly chosen", () => {
    const ticks = replayTicks(dayOf(7, 12), dayOf(8, 4));
    expect(ticks.map((t) => t.label)).toEqual(["12 Aug", "15 Aug", "18 Aug", "21 Aug", "24 Aug", "27 Aug", "30 Aug", "2 Sep"]);
    for (const tick of ticks) expect(tick.frac).toBeGreaterThanOrEqual(0);
  });
});

describe("the playhead", () => {
  const start = (): ReplayState => startReplay("day", { from: at(8), to: at(18), open: true });

  test("starts at the beginning, playing at the default length", () => {
    expect(start()).toMatchObject({ from: at(8), to: at(18), at: at(8), seek: at(8), playing: true, length: 30_000 });
  });

  test("play and pause; the engine's ticks move it without seeking", () => {
    let s = start();
    s = replayReducer(s, { type: "tick", at: at(9) });
    expect(s).toMatchObject({ at: at(9), seek: at(8), playing: true });
    s = replayReducer(s, { type: "toggle" });
    expect(s).toMatchObject({ playing: false, seek: at(9) });
    s = replayReducer(s, { type: "length", length: 120_000 });
    s = replayReducer(s, { type: "play" });
    expect(s.playing).toBe(true);
  });

  test("stops at the end, and play there starts again from the beginning", () => {
    let s = replayReducer(start(), { type: "tick", at: at(23) });
    expect(s).toMatchObject({ at: at(18), playing: false });
    s = replayReducer(s, { type: "play" });
    expect(s).toMatchObject({ at: at(8), seek: at(8), playing: true });
  });

  test("dragging seeks, clamped to the bar", () => {
    let s = replayReducer(start(), { type: "scrub", at: at(12, 20) });
    expect(s).toMatchObject({ at: at(12, 20), seek: at(12, 20) });
    s = replayReducer(s, { type: "scrub", at: at(2) });
    expect(s.at).toBe(at(8));
    expect(fractionOf(at(13), at(8), at(18))).toBe(0.5);
  });

  test("a stretch of a day steps five minutes, an hour with Shift; Home and End go to the ends", () => {
    let s = replayReducer(start(), { type: "scrub", at: at(12) });
    s = replayReducer(s, { type: "key", key: "ArrowRight" });
    expect(s.at).toBe(at(12, 5));
    s = replayReducer(s, { type: "key", key: "ArrowLeft", shift: true });
    expect(s.at).toBe(at(11, 5));
    expect(replayReducer(s, { type: "key", key: "End" }).at).toBe(at(18));
    expect(replayReducer(s, { type: "key", key: "Home" }).at).toBe(at(8));
    expect(replayReducer(s, { type: "key", key: "x" })).toBe(s);
  });

  test("a stretch of up to two weeks steps an hour, a day with Shift", () => {
    let s = startReplay("week", rollingWindow("week", at(18)));
    s = replayReducer(s, { type: "key", key: "ArrowRight" });
    expect(s.at - s.from).toBe(HOUR_MS);
    s = replayReducer(s, { type: "key", key: "ArrowRight", shift: true });
    expect(s.at - s.from).toBe(HOUR_MS + DAY_MS);
  });

  test("the step scales with the span: a day, then a week with Shift for a longer one", () => {
    expect(keyStep(30 * DAY_MS, false)).toBe(DAY_MS);
    expect(keyStep(30 * DAY_MS, true)).toBe(7 * DAY_MS);
    expect(keyStep(14 * DAY_MS, false)).toBe(HOUR_MS);
    expect(keyStep(36 * HOUR_MS, false)).toBe(5 * 60_000);
    expect(keyStep(36 * HOUR_MS, true)).toBe(HOUR_MS);
  });
});

describe("the marked moments over the bar", () => {
  const at = (frac: number) => 1000 + frac * 1000;
  const moments = (fracs: number[]) => fracs.map((f, i) => ({ at: at(f), label: `m${i}` }));

  test("never overlap: a moment too close to both rows' last label is left out", () => {
    const placed = placeMoments(moments([0.1, 0.12, 0.14, 0.5, 0.52]), 1000, 2000, 0.2);
    expect(placed.map((p) => [p.label, p.row])).toEqual([
      ["m0", 0],
      ["m1", 1],
      ["m3", 0],
      ["m4", 1],
    ]);
    for (const row of [0, 1]) {
      const fracs = placed.filter((p) => p.row === row).map((p) => p.frac);
      for (let i = 1; i < fracs.length; i++) expect(fracs[i]! - fracs[i - 1]!).toBeGreaterThanOrEqual(0.2);
    }
  });

  test("a label near the end reads leftward from its dot, and is kept clear of the one before it", () => {
    // 0.35 apart, but the second reads leftward from 0.85, back over the first.
    const placed = placeMoments(moments([0.5, 0.85]), 1000, 2000, 0.3);
    expect(placed.map((p) => [p.label, p.row])).toEqual([
      ["m0", 0],
      ["m1", 1],
    ]);
  });

  test("only what falls inside the window, at its place along it", () => {
    const placed = placeMoments([{ at: 500, label: "before" }, { at: 1250, label: "in" }, { at: 2500, label: "after" }], 1000, 2000, 0.2);
    expect(placed).toEqual([{ at: 1250, label: "in", frac: 0.25, row: 0 }]);
  });
});

describe("the sidebar's counts follow the replay", () => {
  afterEach(() => setMapFolderCounts(null));

  test("counts at the playhead put a moved note back where it was", () => {
    const g = para("ws-a", "Personal", 3);
    const moved = g.nodes.find((n) => n.path.startsWith("0-inbox/"))!.path.replace("0-inbox/", "2-areas/");
    g.nodes = g.nodes.map((n) => (n.path.startsWith("0-inbox/note 0-inbox 0") ? { ...n, path: moved } : n));
    const events = [ev.move(at(10), "ws-a", "0-inbox/note 0-inbox 0.md", moved)];
    const before = folderCountsAt([g], events, at(9))["ws-a"]!;
    const after = folderCountsAt([g], events, at(11))["ws-a"]!;
    expect([before["0-inbox"], before["2-areas"]]).toEqual([3, 3]);
    expect([after["0-inbox"], after["2-areas"]]).toEqual([2, 4]);
  });

  test("a top folder of the workspace the map shows has a count; nothing else does, and closing clears it", () => {
    expect(mapFolderCount("ws-a", "0-inbox")).toBeNull();
    setMapFolderCounts({ workspaceId: "ws-a", byRoot: { "0-inbox": 2, "2-areas": 4 } });
    expect(mapFolderCount("ws-a", "0-inbox")).toBe(2);
    expect(mapFolderCount("ws-a", "1-projects")).toBe(0);
    expect(mapFolderCount("ws-a", "2-areas/sub")).toBeNull();
    expect(mapFolderCount("ws-b", "0-inbox")).toBeNull();
    setMapFolderCounts(null);
    expect(mapFolderCount("ws-a", "0-inbox")).toBeNull();
  });
});

describe("the zoom control's level names", () => {
  test("stops too close together keep one name, and the level you are at wins", () => {
    const stops = { all: 0, workspace: 0.4, folders: 0.8, notes: 0.9 };
    expect([...tickLabels(["all", "workspace", "folders", "notes"], stops, "all", 0.16)]).toEqual(["all", "workspace", "folders"]);
    expect([...tickLabels(["all", "workspace", "folders", "notes"], stops, "notes", 0.16)]).toEqual(["all", "workspace", "notes"]);
  });

  test("stops far enough apart are all named", () => {
    const stops = { workspace: 0, folders: 0.5, notes: 1 };
    expect([...tickLabels(["workspace", "folders", "notes"], stops, "workspace", 0.16)]).toEqual(["workspace", "folders", "notes"]);
  });
});
