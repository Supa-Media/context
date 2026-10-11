import { describe, expect, test } from "@jest/globals";
import { buildStory, ENTER, folderIndex, HG, lastStop, MOVE, SHOW } from "../features/landing/chaosStory";

/**
 * Page a's graph tells one story (Dev, 2026-10-11): a cluttered Personal
 * workspace gets sorted, a side project grows in it, and only when the first
 * co-founder joins does it move into its own shared workspace, Hangg, where
 * the co-founders' own assistants start working. `chaosDraw.ts` draws it.
 */

const story = buildStory();
const founderJoins = story.founders[0]!.at;

describe("page a's story", () => {
  test("is the same every visit", () => {
    const again = buildStory();
    expect(again.hold).toBe(story.hold);
    expect(again.jobs.map((j) => j.label)).toEqual(story.jobs.map((j) => j.label));
  });

  test("starts cluttered: most notes are already there before anything is filed", () => {
    const there = story.nodes.filter((n) => n.arrive < 0);
    expect(there.length).toBeGreaterThan(30);
    expect(story.nodes.length).toBeGreaterThanOrEqual(55);
  });

  test("Hangg is made only once the first co-founder joins, and the app moves over after that", () => {
    expect(story.form).toBeGreaterThan(founderJoins);
    for (const n of story.movers) {
      expect(n.stops[0]!.folder).toBe(folderIndex(0, "projects"));
      expect(n.stops[0]!.t).toBeLessThan(founderJoins);
      expect(n.stops[1]!.folder).toBeGreaterThanOrEqual(folderIndex(HG, "inbox"));
      expect(n.stops[1]!.t).toBeGreaterThanOrEqual(story.shift);
    }
    // Nothing else lands in Hangg before it exists.
    for (const n of story.nodes)
      for (const s of n.stops) if (story.folders[s.folder]!.ws === HG) expect(s.t).toBeGreaterThan(story.form);
  });

  test("the co-founders' notes land in Hangg's Inbox first, carried by their own assistants", () => {
    expect(story.late).toHaveLength(8);
    for (const n of story.late) {
      expect(n.stops[0]!.folder).toBe(folderIndex(HG, "inbox"));
      expect(n.arrive).toBeGreaterThanOrEqual(story.founders[n.founder!]!.at);
      for (const s of n.stops) expect(s.helper).toBe(2 + n.founder!);
    }
  });

  test("names the app's story, and no helper reads two named notes at once", () => {
    const labels = story.jobs.map((j) => j.label);
    for (const label of ["New app idea", "Friend hangout app?", "Let's call it Hangg", "Hangg pitch deck"]) expect(labels).toContain(label);
    for (const a of story.jobs)
      for (const b of story.jobs) {
        if (a === b || a.helper !== b.helper) continue;
        const overlap = a.t - SHOW < b.t + MOVE && b.t - SHOW < a.t + MOVE;
        expect(overlap).toBe(false);
      }
    // The co-founders' named notes wait until both "joined" cards are gone.
    const lateJobs = story.jobs.filter((j) => j.n.founder !== undefined);
    for (const j of lateJobs) expect(j.t - SHOW).toBeGreaterThanOrEqual(story.founders[1]!.at + ENTER + 800);
  });

  test("links never cross workspaces, and the loop holds a while after the last note is filed", () => {
    for (const [a, b] of story.links)
      expect(story.folders[lastStop(a).folder]!.ws).toBe(story.folders[lastStop(b).folder]!.ws);
    const last = Math.max(...story.nodes.map((n) => lastStop(n).t));
    expect(story.hold).toBeGreaterThan(last + MOVE);
  });
});
