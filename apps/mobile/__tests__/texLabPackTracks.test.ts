/** Replay's compact timeline packs every bar into as few tracks as what ran at once needs (Dev2, 2026-11-14). */
import { describe, expect, test } from "@jest/globals";
import { packTracks } from "../features/tex/lab/engine/replaySteps";
import type { Bar } from "../features/tex/lab/engine/replay";

const bar = (start: number, end: number, label = "x"): Bar => ({ kind: "turn", start, end, label });

describe("packTracks", () => {
  test("bars that never overlap share one track; overlapping ones get as many tracks as run at once", () => {
    const rows = [
      { key: "Texts", label: "Texts", bars: [bar(0, 250, "hey")] },
      { key: "door", label: "Door steps", bars: [bar(300, 1800, "1.5 s")] },
      { key: "fd", label: "Front door", bars: [bar(1800, 12800, "11 s")] },
      { key: "tools", label: "Tools", bars: [bar(4000, 4800, "0.8 s")] },
      { key: "Sent", label: "Sent", bars: [bar(13000, 13400, "Done.")] },
    ];
    const tracks = packTracks(rows);
    expect(tracks.length).toBe(2);
    expect(tracks[0].map((b) => b.name)).toEqual(["hey", "Door steps · 1.5 s", "Front door · 11 s", "Done."]);
    expect(tracks[1].map((b) => b.name)).toEqual(["Tools · 0.8 s"]);
  });

  test("a bar too short to see still takes its minimum width, with a gap after it", () => {
    const rows = [{ key: "a", label: "A", bars: [bar(0, 1), bar(5, 10)] }];
    expect(packTracks(rows).length).toBe(1);
    expect(packTracks(rows, 20).length).toBe(2);
    expect(packTracks(rows, 0, 10).length).toBe(2);
  });
});
