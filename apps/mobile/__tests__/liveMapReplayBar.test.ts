/**
 * THE REPLAY BAR'S CLOCK, AND THE SIDEBAR'S COUNTS WHILE THE MAP IS OPEN.
 *
 * Today and This week replay what happened, sped up: the bar is the day (or
 * the week), the playhead can be dragged or stepped with the arrow keys, play
 * stops at the end and starts again from the beginning, and the clock reads
 * as a wall clock does. The sidebar's top-folder counts follow the playhead.
 * Times are built in local time so the suite reads the same in any timezone.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { actorsAt, folderCountsAt } from "../features/console/map/live/engine";
import { mapFolderCount, setMapFolderCounts } from "../features/console/map/live/mapCounts";
import {
  DAY_MS,
  DEFAULT_SPEED,
  HOUR_MS,
  REPLAY_IDLE_MS,
  REPLAY_SPEEDS,
  clockText,
  dayText,
  fractionOf,
  placeMoments,
  playbackMs,
  replayBadge,
  replayReducer,
  replayTicks,
  replayWindow,
  startReplay,
  type ReplayState,
} from "../features/console/map/live/replayClock";
import { tickLabels } from "../features/console/map/live/ui/zoomTicks";
import { ev, para } from "./liveMapFixture";

const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m).getTime();

describe("the clock reads as a wall clock", () => {
  test("12-hour times and the day under them", () => {
    expect(clockText(at(12, 20))).toBe("12:20 pm");
    expect(clockText(at(8, 5))).toBe("8:05 am");
    expect(clockText(at(0, 0))).toBe("12:00 am");
    expect(dayText(at(12, 20), at(18))).toBe("Today, Wed 7 Oct");
    expect(dayText(at(12, 20, 6), at(18))).toBe("Yesterday, Tue 6 Oct");
    expect(dayText(at(12, 20, 3), at(18))).toBe("Sat 3 Oct");
  });

  test("the badge says what is replaying and how fast", () => {
    expect(replayBadge("today", 60)).toBe("Replaying today · 60× speed");
    expect(replayBadge("week", 600)).toBe("Replaying this week · 600× speed");
  });
});

describe("how fast a replay plays", () => {
  test("a day offers 1×, 10× and 60×; a week 60×, 600× and 3600×", () => {
    expect(REPLAY_SPEEDS.today).toEqual([1, 10, 60]);
    expect(REPLAY_SPEEDS.week).toEqual([60, 600, 3600]);
    expect(startReplay("today", at(18), at(8)).speed).toBe(DEFAULT_SPEED.today);
    expect(startReplay("week", at(18)).speed).toBe(600);
  });

  test("a working day at 60× is ten minutes; the week at 3600× is about three", () => {
    const day = startReplay("today", at(18), at(8));
    expect(playbackMs(day.from, day.to, 60)).toBe(10 * 60_000);
    const week = startReplay("week", at(18));
    const fastest = playbackMs(week.from, week.to, 3600);
    expect(fastest).toBeGreaterThan(2.5 * 60_000);
    expect(fastest).toBeLessThanOrEqual(3 * 60_000);
    // 600× is a week in under twenty minutes; a day's 60× would be hours.
    expect(playbackMs(week.from, week.to, 600)).toBeLessThan(20 * 60_000);
    expect(playbackMs(week.from, week.to, 60)).toBeGreaterThan(2 * HOUR_MS);
  });

  test("only a speed the range offers is taken, and a new range starts at its own", () => {
    let s = startReplay("week", at(18));
    s = replayReducer(s, { type: "speed", speed: 3600 });
    expect(s.speed).toBe(3600);
    expect(replayReducer(s, { type: "speed", speed: 1 })).toBe(s);
    s = replayReducer(s, { type: "start", range: "today", now: at(18), firstAt: at(8) });
    expect(s.speed).toBe(60);
    expect(replayReducer(s, { type: "speed", speed: 600 }).speed).toBe(60);
  });
});

describe("who was here, at the playhead", () => {
  const NOTE = "1-projects/launch.md";
  // Somebody working in bursts: a step at 12:00 and the next at 12:40.
  const events = [ev.edit(at(12), "ws-a", NOTE), ev.edit(at(12, 40), "ws-a", NOTE)];

  test("a day's replay keeps somebody half an hour after their last step", () => {
    expect(REPLAY_IDLE_MS.today).toBe(30 * 60_000);
    expect(actorsAt(events, at(12, 20), REPLAY_IDLE_MS.today).map((a) => a.name)).toEqual(["Maya"]);
    expect(actorsAt(events, at(13, 20), REPLAY_IDLE_MS.today)).toEqual([]);
  });

  test("a week's keeps them three hours, so a sped-up week is not an empty map", () => {
    expect(REPLAY_IDLE_MS.week).toBe(3 * HOUR_MS);
    expect(actorsAt(events, at(15), REPLAY_IDLE_MS.week)).toHaveLength(1);
    expect(actorsAt(events, at(16), REPLAY_IDLE_MS.week)).toEqual([]);
    expect(REPLAY_IDLE_MS.week).toBeGreaterThan(REPLAY_IDLE_MS.today);
  });
});

describe("what Today and This week cover", () => {
  test("today runs from the hour of the first change to now", () => {
    expect(replayWindow("today", at(18), at(8, 42))).toEqual({ from: at(8), to: at(18) });
    // With nothing to go by, from midnight.
    expect(replayWindow("today", at(18))).toEqual({ from: at(0), to: at(18) });
  });

  test("this week is the last seven days, today included", () => {
    expect(replayWindow("week", at(18))).toEqual({ from: at(0, 0, 1), to: at(18) });
  });

  test("a day is ticked in hours, at most seven of them; a week by its days", () => {
    expect(replayTicks("today", at(8), at(18)).map((t) => t.label)).toEqual(["8am", "10am", "12pm", "2pm", "4pm", "6pm"]);
    expect(replayTicks("today", at(9), at(12)).map((t) => t.label)).toEqual(["9am", "10am", "11am", "12pm"]);
    const week = replayTicks("week", at(0, 0, 1), at(18));
    expect(week.map((t) => t.label)).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
    expect(week[0]!.frac).toBe(0);
    for (const tick of week) expect(tick.frac).toBeGreaterThanOrEqual(0);
  });
});

describe("the playhead", () => {
  const start = (): ReplayState => startReplay("today", at(18), at(8, 30));

  test("starts at the beginning, playing at 60×", () => {
    expect(start()).toMatchObject({ from: at(8), to: at(18), at: at(8), seek: at(8), playing: true, speed: 60 });
  });

  test("play and pause; the engine's ticks move it without seeking", () => {
    let s = start();
    s = replayReducer(s, { type: "tick", at: at(9) });
    expect(s).toMatchObject({ at: at(9), seek: at(8), playing: true });
    s = replayReducer(s, { type: "toggle" });
    expect(s).toMatchObject({ playing: false, seek: at(9) });
    s = replayReducer(s, { type: "speed", speed: 10 });
    expect(s.speed).toBe(10);
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

  test("arrow keys step five minutes in a day, an hour with Shift; Home and End go to the ends", () => {
    let s = replayReducer(start(), { type: "scrub", at: at(12) });
    s = replayReducer(s, { type: "key", key: "ArrowRight" });
    expect(s.at).toBe(at(12, 5));
    s = replayReducer(s, { type: "key", key: "ArrowLeft", shift: true });
    expect(s.at).toBe(at(11, 5));
    expect(replayReducer(s, { type: "key", key: "End" }).at).toBe(at(18));
    expect(replayReducer(s, { type: "key", key: "Home" }).at).toBe(at(8));
    expect(replayReducer(s, { type: "key", key: "x" })).toBe(s);
  });

  test("a week steps an hour, a day with Shift", () => {
    let s = startReplay("week", at(18));
    s = replayReducer(s, { type: "key", key: "ArrowRight" });
    expect(s.at - s.from).toBe(HOUR_MS);
    s = replayReducer(s, { type: "key", key: "ArrowRight", shift: true });
    expect(s.at - s.from).toBe(HOUR_MS + DAY_MS);
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
