import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { createCastClock, type Wall } from "../features/home/cast/castClock";
import { castTimeLabel, castTimeline, stepAt } from "../features/home/cast/castTimeline";
import { LIVELY, playCast } from "../features/home/cast/castRun";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import {
  STUDIO_FLAG,
  asStageEvent,
  asStudioCommand,
  isStudioStage,
  stageEvent,
  studioCommand,
} from "../features/home/cast/studioLink";
import { castPreviewFrom, castPreviewFragment, CAST_PREVIEW_BANNER } from "../features/home/castPreview";
import { describeStep, studioScript } from "../features/studio/studioScript";
import { fitScale, studioFrame } from "../features/studio/studioFrames";

/** A wall whose time only moves when the test says. */
function fakeWall() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let id = 0;
  const wall: Wall = {
    now: () => now,
    setTimeout: (run, ms) => {
      id += 1;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { wall, advance };
}

describe("castClock", () => {
  test("runs timers in order on the wall's time", () => {
    const { wall, advance } = fakeWall();
    const clock = createCastClock(wall);
    const ran: string[] = [];
    clock.schedule(200, () => ran.push("b"));
    clock.schedule(100, () => ran.push("a"));
    advance(150);
    expect(ran).toEqual(["a"]);
    advance(50);
    expect(ran).toEqual(["a", "b"]);
    expect(clock.now()).toBe(200);
  });

  test("a pause holds the show's time and every timer by exactly as long", () => {
    const { wall, advance } = fakeWall();
    const clock = createCastClock(wall);
    const ran: number[] = [];
    clock.schedule(100, () => ran.push(clock.now()));
    advance(60);
    clock.pause();
    advance(5_000);
    expect(ran).toEqual([]);
    expect(clock.now()).toBe(60);
    clock.resume();
    advance(39);
    expect(ran).toEqual([]);
    advance(1);
    expect(ran).toEqual([100]);
  });

  test("rush runs what is waiting at once, in order, until told to stop, then carries on in real time", () => {
    const { wall, advance } = fakeWall();
    const clock = createCastClock(wall);
    const ran: string[] = [];
    clock.schedule(1_000, () => ran.push("one"));
    clock.schedule(2_000, () => {
      ran.push("two");
      clock.schedule(500, () => ran.push("three"));
    });
    clock.schedule(10_000, () => ran.push("four"));
    let rushingInside = false;
    clock.schedule(1_500, () => {
      rushingInside = clock.rushing;
    });
    clock.rush(() => ran.includes("two"));
    expect(ran).toEqual(["one", "two"]);
    expect(rushingInside).toBe(true);
    expect(clock.rushing).toBe(false);
    expect(clock.now()).toBe(2_000);
    advance(499);
    expect(ran).toEqual(["one", "two"]);
    advance(1);
    expect(ran).toEqual(["one", "two", "three"]);
  });

  test("a cancelled timer never runs, and stop drops everything", () => {
    const { wall, advance } = fakeWall();
    const clock = createCastClock(wall);
    const ran: string[] = [];
    const off = clock.schedule(100, () => ran.push("cancelled"));
    clock.schedule(200, () => ran.push("stopped"));
    off();
    clock.stop();
    advance(1_000);
    expect(ran).toEqual([]);
  });
});

const SCENE = [
  "# Pricing",
  "",
  "Free is free, you cheapo.",
  "",
  "```cast",
  "@maya types: hi.",
  "@maya's Codex comments on \"you cheapo\": a little unprofessional?",
  "@jon replies: eh",
  "@jon resolves",
  "```",
  "",
].join("\n");

describe("castTimeline", () => {
  test("times the real show: the first step after the pause, typing taking its length", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    const timeline = castTimeline(markdown, steps);
    expect(timeline.starts[0]).toBe(LIVELY.startMs);
    // Each step starts after the one before it, and the show ends after the last.
    for (let i = 1; i < steps.length; i += 1) expect(timeline.starts[i]!).toBeGreaterThan(timeline.starts[i - 1]!);
    expect(timeline.total).toBeGreaterThan(timeline.starts[steps.length - 1]!);
    // Typing "hi." takes longer than an agent's comment landing whole.
    const typing = timeline.starts[1]! - timeline.starts[0]!;
    expect(typing).toBeGreaterThan(LIVELY.gapMs);
  });

  test("matches a show played on real timers, step for step", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    const timeline = castTimeline(markdown, steps);
    const { wall, advance } = fakeWall();
    const clock = createCastClock(wall);
    const shared = createSharedDoc({});
    seedSharedDoc(shared, markdown);
    const seen: number[] = [];
    let ended: number | null = null;
    playCast(steps, shared, {
      schedule: (ms, run) => clock.schedule(ms, run),
      instant: () => false,
      pageNamed: () => null,
      addNote: (name) => name,
      agentDid: () => {},
      room: () => {},
      step: () => seen.push(clock.now()),
      ended: () => {
        ended = clock.now();
      },
    });
    advance(120_000);
    expect(seen).toEqual(timeline.starts);
    expect(ended).toBe(timeline.total);
  });

  test("labels and the step at a moment", () => {
    expect(castTimeLabel(0)).toBe("0:00");
    expect(castTimeLabel(7_900)).toBe("0:07");
    expect(castTimeLabel(72_000)).toBe("1:12");
    const timeline = { starts: [1_000, null, 5_000], total: 9_000 };
    expect(stepAt(timeline, 500)).toBe(-1);
    expect(stepAt(timeline, 4_999)).toBe(0);
    expect(stepAt(timeline, 5_000)).toBe(2);
  });
});

describe("the studio's messages", () => {
  test("round-trip, and anything else is refused", () => {
    expect(asStudioCommand(studioCommand({ kind: "start", from: 3 }))).toEqual(studioCommand({ kind: "start", from: 3 }));
    expect(asStudioCommand(studioCommand({ kind: "pause" }))?.kind).toBe("pause");
    expect(asStageEvent(stageEvent({ kind: "time", ms: 1200 }))).toEqual(stageEvent({ kind: "time", ms: 1200 }));
    expect(asStageEvent(stageEvent({ kind: "step", index: 2 }))?.kind).toBe("step");
    for (const junk of [null, 3, "start", { kind: "start", from: 1 }, { tag: "context-cast-studio", kind: "start", from: -1 },
      { tag: "context-cast-studio", kind: "start", from: 1.5 }, { tag: "context-cast-studio", kind: "delete" }]) {
      expect(asStudioCommand(junk)).toBeNull();
    }
    expect(asStageEvent({ tag: "context-cast-studio", kind: "time", ms: Number.NaN })).toBeNull();
    expect(asStageEvent({ tag: "context-cast-studio", kind: "step", index: "1" })).toBeNull();
  });

  test("only a page inside our own studio is a stage", () => {
    const top = {} as Window & Record<string, unknown>;
    (top as unknown as { parent: unknown }).parent = top;
    expect(isStudioStage(top)).toBe(false);

    const studio = { [STUDIO_FLAG]: true } as unknown as Window;
    const inside = { parent: studio } as unknown as Window;
    expect(isStudioStage(inside)).toBe(true);

    const somebodyElse = { parent: {} } as unknown as Window;
    expect(isStudioStage(somebodyElse)).toBe(false);

    // Another origin: reading the parent throws, and that is a no.
    const foreign = {
      get parent(): Window {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;
    expect(isStudioStage(foreign)).toBe(false);
    expect(isStudioStage(undefined)).toBe(false);
  });

  test("the preview line is left out only when asked, for the studio's stage", () => {
    const hash = `#${castPreviewFragment(SCENE, "Pricing")}`;
    expect(castPreviewFrom(hash)?.pages[0]?.markdown.startsWith(CAST_PREVIEW_BANNER)).toBe(true);
    expect(castPreviewFrom(hash, { banner: true })?.pages[0]?.markdown.startsWith(CAST_PREVIEW_BANNER)).toBe(true);
    const bare = castPreviewFrom(hash, { banner: false })?.pages[0]?.markdown;
    expect(bare).toBeDefined();
    expect(bare).not.toContain("Preview of an unpublished draft");
    expect(bare!.startsWith("# Pricing")).toBe(true);
  });
});

describe("studioScript", () => {
  test("a row per step, in words, with its time", () => {
    const script = studioScript(`---\ntitle: Pricing\n---\n${SCENE}`);
    expect(script.rows.map((row) => [row.actor?.name ?? null, row.says])).toEqual([
      ["@maya", "types “hi.”"],
      ["@maya's Codex", "comments on “you cheapo”"],
      ["@jon", "replies “eh”"],
      ["@jon", "resolves the comment"],
    ]);
    expect(script.rows[0]!.at).toBe(LIVELY.startMs);
    expect(script.problems).toEqual([]);
  });

  test("says what each kind of step does", () => {
    const { steps } = splitWebsiteCast(
      "x\n\n```cast\nClaude writes: done\n@a adds to the line above: more\nClaude reads: pricing\nClaude reads\nClaude adds note: tour\n  # Tour\nwait 2.5s\n```\n",
    );
    expect(steps.map(describeStep)).toEqual([
      "writes “done”",
      "adds “more”",
      "reads pricing",
      "reads this note",
      "adds the note tour",
      "Wait 2.5s",
    ]);
  });

  test("a long line is cut in the rail", () => {
    const { steps } = splitWebsiteCast(`x\n\n\`\`\`cast\n@a types: ${"word ".repeat(40)}\n\`\`\`\n`);
    const says = describeStep(steps[0]!);
    expect(says.length).toBeLessThan(75);
    expect(says.endsWith("…”")).toBe(true);
  });
});

describe("studioFrames", () => {
  test("each frame is its aspect, and fits its box without reflowing", () => {
    const phone = studioFrame("phone");
    const desktop = studioFrame("desktop");
    const square = studioFrame("square");
    expect(phone.width / phone.height).toBeCloseTo(9 / 16);
    expect(desktop.width / desktop.height).toBeCloseTo(16 / 9);
    expect(square.width).toBe(square.height);
    expect(fitScale(desktop, { width: 640, height: 1000 })).toBe(0.5);
    expect(fitScale(phone, { width: 1000, height: 360 })).toBe(0.5);
    expect(fitScale(phone, { width: 0, height: 360 })).toBe(0);
  });
});
