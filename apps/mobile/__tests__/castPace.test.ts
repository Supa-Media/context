import { describe, expect, test } from "@jest/globals";
import { setCastPace, splitWebsiteCast } from "@context/shared";
import { castTimeline } from "../features/home/cast/castTimeline";
import { castSite } from "../features/home/cast/castSite";
import { LIVELY, PACES, paceNamed } from "../features/home/cast/castRun";
import { studioScript } from "../features/studio/studioScript";
import { createSoundPlayer } from "../features/studio/sounds/soundPlayer";

/* A scene's pace (Dev2, 2026-09-29, "please implement pace"). */

const SCENE = ["# Pricing", "", "Free is free.", "", "```cast", "@maya types: hello there", "Claude writes: hi", "```", ""].join("\n");

describe("the pace line", () => {
  test("reads slow, lively or fast, written any way, and the last one wins", () => {
    expect(splitWebsiteCast(SCENE).pace).toBeUndefined();
    expect(splitWebsiteCast(SCENE.replace("```cast\n", "```cast\npace: slow\n")).pace).toBe("slow");
    expect(splitWebsiteCast(SCENE.replace("```cast\n", "```cast\nPace Fast\n")).pace).toBe("fast");
    const twice = SCENE.replace("```cast\n", "```cast\npace: slow\n").replace("Claude writes: hi\n", "Claude writes: hi\npace: lively\n");
    expect(splitWebsiteCast(twice).pace).toBe("lively");
    const { problems, steps } = splitWebsiteCast(SCENE.replace("```cast\n", "```cast\npace: slow\n"));
    expect(problems).toEqual([]);
    expect(steps).toHaveLength(2);
    // Anything else is a line the author gets told about, never a pace.
    expect(splitWebsiteCast(SCENE.replace("```cast\n", "```cast\npace: glacial\n")).problems).toHaveLength(1);
  });

  test("the studio writes it as the first line of the first block, once, and lively takes it away", () => {
    const slow = setCastPace(SCENE, "slow");
    expect(slow).toContain("```cast\npace: slow\n@maya types");
    const fast = setCastPace(slow, "fast");
    expect(fast.match(/pace:/g)).toHaveLength(1);
    expect(splitWebsiteCast(fast).pace).toBe("fast");
    expect(setCastPace(fast, "lively")).toBe(SCENE);
    // Nothing to put it in: the page is left alone.
    expect(setCastPace("# x\n", "slow")).toBe("# x\n");
    // A pace line in somebody's own code block is theirs.
    const code = "```text\npace: slow\n```\n" + SCENE;
    expect(setCastPace(code, "lively")).toBe(code);
    expect(setCastPace(code, "fast").startsWith("```text\npace: slow\n```\n")).toBe(true);
  });
});

describe("playing at a pace", () => {
  test("slow takes longer than lively, fast less, the same steps in the same order", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    const total = (name: "slow" | "lively" | "fast") => castTimeline(markdown, steps, {}, PACES[name]).total;
    expect(total("slow")).toBeGreaterThan(total("lively") * 1.4);
    expect(total("fast")).toBeLessThan(total("lively") * 0.7);
    expect(paceNamed(undefined)).toBe(LIVELY);
  });

  test("the studio times the scene at its own pace, and the homepage knows each page's", () => {
    const slow = setCastPace(SCENE, "slow");
    expect(studioScript(slow).pace).toBe("slow");
    expect(studioScript(SCENE).pace).toBe("lively");
    expect(studioScript(slow).timeline.total).toBeGreaterThan(studioScript(SCENE).timeline.total);
    const site = castSite([
      { path: "index.md", routePath: "/", title: "Home", markdown: slow },
      { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: SCENE },
    ] as never);
    expect([...site.paces]).toEqual([["/", "slow"]]);
  });
});

describe("waking the sound", () => {
  test("a press makes the audio context and resumes it, before any cue", () => {
    const calls: string[] = [];
    class FakeContext {
      state = "suspended";
      constructor() {
        calls.push("made");
      }
      resume() {
        calls.push("resumed");
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    const player = createSoundPlayer(FakeContext as unknown as new () => AudioContext);
    expect(calls).toEqual([]);
    player.wake();
    expect(calls).toEqual(["made", "resumed"]);
    expect(() => createSoundPlayer(undefined).wake()).not.toThrow();
  });
});
