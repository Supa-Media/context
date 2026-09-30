import { describe, expect, test } from "@jest/globals";
import { castPreviewFrom, castPreviewHref } from "../features/home/castPreview";
import { sceneEmoji, sceneEmojiNames } from "../features/studio/sceneEmoji";

/* The studio's stage draws the workspace's emoji (Dev2, 2026-09-30: ":annoyed:" showed as text). */

const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const SCENE = "---\ntitle: x\n---\n# Pricing :annoyed:\n\n```cast\n@jon replies: :sob:\n```\n\n`:code:`\n";

describe("the scene's emoji", () => {
  test("names in the page and in what the cast types, never in code", () => {
    expect(sceneEmojiNames([SCENE, "# Team :wave: :annoyed:"])).toEqual(["annoyed", "sob", "wave"]);
  });

  test("read through the workspace, keeping only inline pictures, within the caps", async () => {
    const big = `data:image/png;base64,${"A".repeat(130 * 1024)}`;
    const answers: Record<string, string> = { annoyed: GIF, sob: "https://example.invalid/sob.png", wave: big };
    const found = await sceneEmoji(["annoyed", "sob", "wave", "missing"], async (name) => answers[name] ?? null);
    expect(found).toEqual({ annoyed: GIF });
    // A read that throws is the same as none.
    expect(await sceneEmoji(["annoyed"], async () => Promise.reject(new Error("offline")))).toEqual({});
  });

  test("they ride in the preview's address, and a crafted one cannot slip in a picture to fetch", () => {
    const href = castPreviewHref(SCENE, "Pricing", [], { annoyed: GIF });
    expect(castPreviewFrom(href.slice(href.indexOf("#")))!.emoji).toEqual({ annoyed: GIF });
    const crafted = btoa(JSON.stringify({ title: "t", markdown: "# t :x:", emoji: { x: "https://example.invalid/x.png", y: GIF } }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(castPreviewFrom(`#cast-preview=${crafted}`)!.emoji).toEqual({ y: GIF });
  });
});
