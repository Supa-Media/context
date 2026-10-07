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
import { folderCountsAt } from "../features/console/map/live/engine";
import { mapFolderCount, setMapFolderCounts } from "../features/console/map/live/mapCounts";
import {
  DAY_MS,
  HOUR_MS,
  clockText,
  dayText,
  fractionOf,
  replayBadge,
  replayReducer,
  replayTicks,
  replayWindow,
  startReplay,
  type ReplayState,
} from "../features/console/map/live/replayClock";
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
    expect(replayBadge("week", 10)).toBe("Replaying this week · 10× speed");
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
